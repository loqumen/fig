// Fig — content-script overlay. Injected on demand; idempotent; toggles.
// Annotations are INPUTS to generation (they inform what the new page should
// be); they are not carried onto the spawned page.
// Toolbar mirrors the standard /fig review toolbar (draw / comment / suggest,
// divider, clear, help), plus the amethyst Fig dispatch button.
// PDF mode: viewer.html sets window.__figPDF; annotations then carry page
// numbers + page-relative coordinates instead of a DOM snapshot.

(() => {
  // Version-stamped injection: after an extension reload, the OLD overlay
  // closure still owns window.__figToggle on already-open pages, so a plain
  // guard would keep running stale code forever. On a version mismatch,
  // tear the old overlay down (its toggle detaches its own listeners) and
  // let this file rebuild fresh.
  const FIG_VERSION = 9;
  if (window.__figToggle && window.__figVersion !== FIG_VERSION) {
    if (document.querySelector(".fig-toolbar")) { try { window.__figToggle(); } catch { /* stale */ } }
    window.__figToggle = null;
  }
  window.__figVersion = FIG_VERSION;
  if (window.__figToggle) { window.__figToggle(); return; }

  const JEWELS = ["#1a1a1a", "#F76D18", "#2C9F28", "#8C89E7", "#2268FF"];

  const state = {
    on: false,
    mode: null, // 'comment' | 'highlight' | 'draw'
    erasing: false, // draw-mode submode: pointer removes individual strokes
    drawColor: JEWELS[0],
    comments: [], // {id, n, text, x, y, targetPath, targetText, page?, rx?, ry?}
    highlights: [], // {id, text, note, targetPath, page?}
    strokes: [], // {points, box, color, nearPath, nearText, page?, rx?, ry?}
    ui: {},
  };
  let nextId = 1;

  // ---------- helpers ----------

  const ICONS = {
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  };

  const iconSvg = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const cssPath = (el) => {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + "#" + CSS.escape(el.id)); break; }
      const sibs = Array.from(el.parentNode ? el.parentNode.children : []).filter(
        (s) => s.tagName === el.tagName
      );
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  };

  const snippet = (el) => (el && el.textContent ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 140) : "");

  // PDF mode: map a document-coordinate point to {page, rx, ry}.
  const pageInfo = (xDoc, yDoc) => {
    if (!window.__figPDF) return null;
    for (const el of document.querySelectorAll(".fig-pdf-page")) {
      const r = el.getBoundingClientRect();
      const left = r.left + window.scrollX, top = r.top + window.scrollY;
      if (xDoc >= left && xDoc <= left + r.width && yDoc >= top && yDoc <= top + r.height) {
        return {
          page: Number(el.dataset.page),
          rx: Math.round(((xDoc - left) / r.width) * 1000) / 1000,
          ry: Math.round(((yDoc - top) / r.height) * 1000) / 1000,
        };
      }
    }
    return null;
  };

  const toast = (msg, sticky) => {
    let t = state.ui.toast;
    if (!t) {
      t = document.createElement("div");
      t.className = "fig-toast";
      t.setAttribute("data-fig-ui", "1");
      document.body.appendChild(t);
      state.ui.toast = t;
    }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t.__hid);
    if (!sticky) t.__hid = setTimeout(() => { t.style.display = "none"; }, 2800);
  };

  const setMode = (mode) => {
    // Leaving a mode dismisses its floating editors: an unsaved comment box
    // (or highlight note — closeNote cancels the provisional highlight) must
    // not stay hovering after the tool is switched.
    closeNote();
    closeDetail();
    state.mode = state.mode === mode ? null : mode;
    document.body.classList.toggle("fig-mode-comment", state.mode === "comment");
    document.body.classList.toggle("fig-mode-highlight", state.mode === "highlight");
    document.body.classList.toggle("fig-mode-draw", state.mode === "draw");
    for (const [m, btn] of Object.entries(state.ui.modeButtons)) {
      btn.classList.toggle("fig-active", state.mode === m);
    }
    state.ui.drawColors.classList.toggle("fig-visible", state.mode === "draw");
    if (state.mode !== "draw" && state.erasing) setErasing(false);
    if (state.mode === "highlight") toast("Select text to flag it");
    if (state.mode === "comment") toast("Click anywhere to drop a comment");
    if (state.mode === "draw") toast("Drag to draw. The eraser removes only what it touches.");
  };

  const setErasing = (on) => {
    state.erasing = on;
    document.body.classList.toggle("fig-erasing", on);
    if (state.ui.eraserBtn) state.ui.eraserBtn.classList.toggle("fig-active", on);
  };

  const ensureLayerHeight = () => {
    if (state.ui.pinLayer) state.ui.pinLayer.style.height = document.documentElement.scrollHeight + "px";
  };

  // ---------- note editor ----------

  // opts: {value: prefill text, onDelete: shows a Delete button}
  // Enter posts; Shift+Enter inserts a newline; Escape cancels.
  const openNote = (x, y, onSave, opts) => {
    closeNote();
    const box = document.createElement("div");
    box.className = "fig-note";
    box.setAttribute("data-fig-ui", "1");
    box.style.left = Math.min(x, window.scrollX + window.innerWidth - 290) + "px";
    box.style.top = y + 8 + "px";
    const ta = document.createElement("textarea");
    ta.placeholder = "What should change here?";
    if (opts && opts.value) ta.value = opts.value;
    const actions = document.createElement("div");
    actions.className = "fig-note-actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.textContent = "Save";
    save.className = "fig-save";
    if (opts && opts.onDelete) {
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "fig-delete";
      del.addEventListener("click", () => {
        box.remove();
        state.ui.note = null;
        opts.onDelete();
      });
      actions.append(del);
    }
    actions.append(cancel, save);
    box.append(ta, actions);
    document.body.appendChild(box);
    state.ui.noteCancel = (opts && opts.onCancel) || null;
    ta.focus();
    const finish = (commit) => {
      const v = ta.value.trim();
      box.remove();
      state.ui.note = null;
      state.ui.noteCancel = null;
      if (commit && v) onSave(v);
      // Not saved (cancelled, Escape, or empty): let the caller undo any
      // provisional visuals — an unsaved highlight must not stick.
      else if (opts && opts.onCancel) opts.onCancel();
    };
    save.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); return; }
      if (e.key === "Escape") finish(false);
    });
    state.ui.note = box;
  };

  // Closing an unsaved note fires its onCancel, so a provisional highlight
  // whose editor gets dismissed any way at all (new note opened, detail
  // opened, teardown) is removed rather than stranded noteless.
  const closeNote = () => {
    if (!state.ui.note) return;
    state.ui.note.remove();
    state.ui.note = null;
    const c = state.ui.noteCancel;
    state.ui.noteCancel = null;
    if (c) c();
  };

  // ---------- detail popover (mirrors the /fig skill's comment detail) ----------
  // One popover for pins AND highlights: the saved note, its replies, a reply
  // input, and Edit / Delete. Opened by clicking a pin or a highlight mark.

  const closeDetail = () => { if (state.ui.detail) { state.ui.detail.remove(); state.ui.detail = null; } };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    n.setAttribute("data-fig-ui", "1");
    return n;
  };

  // item: a comment ({text, replies}) or a highlight ({text: quote, note, replies}).
  // opts: {kind: 'comment'|'highlight', anchorRect, onDelete, getBody, setBody}
  const openDetail = (item, opts) => {
    closeNote();
    closeDetail();
    if (!item.replies) item.replies = [];
    const box = el("div", "fig-note fig-detail");
    const r = opts.anchorRect;
    box.style.left = Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - 300) + "px";
    box.style.top = window.scrollY + r.bottom + 8 + "px";

    const render = () => {
      box.replaceChildren();
      if (opts.kind === "highlight") {
        box.appendChild(el("div", "fig-detail-quote", "“" + (item.text || "").slice(0, 160) + "”"));
      }
      const body = el("div", "fig-detail-text", opts.getBody());
      box.appendChild(body);
      if (item.replies.length) {
        const list = el("div", "fig-detail-replies");
        item.replies.forEach((rep, i) => {
          const row = el("div", "fig-detail-reply");
          row.appendChild(el("span", "fig-detail-reply-text", rep));
          const x = el("button", "fig-detail-reply-x", "×");
          x.title = "Delete reply";
          x.addEventListener("click", () => { item.replies.splice(i, 1); render(); });
          row.appendChild(x);
          list.appendChild(row);
        });
        box.appendChild(list);
      }
      const reply = document.createElement("textarea");
      reply.setAttribute("data-fig-ui", "1");
      reply.className = "fig-detail-replybox";
      reply.rows = 1;
      reply.placeholder = "Reply…";
      reply.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = reply.value.trim();
          if (v) { item.replies.push(v); render(); }
        }
        if (e.key === "Escape") closeDetail();
      });
      box.appendChild(reply);

      const actions = el("div", "fig-note-actions");
      const del = el("button", "fig-delete", "Delete");
      del.addEventListener("click", () => { closeDetail(); opts.onDelete(); });
      const edit = el("button", null, "Edit");
      edit.addEventListener("click", () => {
        // Swap the body for an editor in place (the /fig skill's Edit flow).
        const ta = document.createElement("textarea");
        ta.setAttribute("data-fig-ui", "1");
        ta.value = opts.getBody();
        body.replaceWith(ta);
        actions.style.display = "none";
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        const done = (commit) => {
          const v = ta.value.trim();
          if (commit && v) opts.setBody(v);
          render();
        };
        const eActions = el("div", "fig-note-actions");
        const cancel = el("button", null, "Cancel");
        cancel.addEventListener("click", () => done(false));
        const save = el("button", "fig-save", "Save");
        save.addEventListener("click", () => done(true));
        eActions.append(cancel, save);
        actions.after(eActions);
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
          if (e.key === "Escape") { e.preventDefault(); done(false); }
        });
      });
      actions.append(del, edit);
      box.appendChild(actions);
    };

    render();
    document.body.appendChild(box);
    state.ui.detail = box;
  };

  const highlightById = (id) => state.highlights.find((h) => String(h.id) === String(id));

  // Click a highlight mark → open its comment (any mode; draw is unreachable
  // because the canvas owns the pointer there).
  const openHighlightDetail = (mark) => {
    const h = highlightById(mark.getAttribute("data-fig-highlight"));
    if (!h) return;
    openDetail(h, {
      kind: "highlight",
      anchorRect: mark.getBoundingClientRect(),
      getBody: () => h.note || "",
      setBody: (v) => { h.note = v; },
      onDelete: () => removeHighlight(h.id),
    });
  };

  const unwrapMarks = (id) => {
    document.querySelectorAll('mark[data-fig-highlight="' + id + '"]').forEach((m) => {
      const p = m.parentNode;
      m.replaceWith(...m.childNodes);
      if (p) p.normalize();
    });
  };

  const removeHighlight = (id) => {
    state.highlights = state.highlights.filter((h) => h.id !== id);
    unwrapMarks(id);
    toast("Highlight removed");
  };

  // ---------- comments ----------

  const renumberPins = () => {
    state.comments.forEach((k, i) => {
      k.n = i + 1;
      const el = state.ui.pins && state.ui.pins.get(k.id);
      if (el) el.textContent = String(k.n);
    });
  };

  const addPin = (c) => {
    const pin = document.createElement("div");
    pin.className = "fig-pin";
    pin.setAttribute("data-fig-ui", "1");
    pin.style.left = c.x + "px";
    pin.style.top = c.y + "px";
    pin.textContent = String(c.n);
    pin.title = c.text + " (click to open)";
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(c, {
        kind: "comment",
        anchorRect: pin.getBoundingClientRect(),
        getBody: () => c.text,
        setBody: (v) => { c.text = v; pin.title = v + " (click to open)"; },
        onDelete: () => {
          state.comments = state.comments.filter((k) => k.id !== c.id);
          state.ui.pins.delete(c.id);
          pin.remove();
          renumberPins();
          toast("Comment removed");
        },
      });
    });
    if (!state.ui.pins) state.ui.pins = new Map();
    state.ui.pins.set(c.id, pin);
    state.ui.pinLayer.appendChild(pin);
  };

  const onPageClick = (e) => {
    if (!state.on) return;
    if (e.target.closest("[data-fig-ui]")) return;
    // A highlight is clickable in every mode: the green mark opens its
    // comment (highlight mode handles this at mousedown instead).
    const mk = e.target.closest && e.target.closest("mark[data-fig-highlight]");
    if (mk && state.mode !== "highlight") {
      e.preventDefault();
      e.stopPropagation();
      openHighlightDetail(mk);
      return;
    }
    // Clicking anywhere else dismisses an open comment popover.
    if (state.ui.detail) closeDetail();
    // In highlight mode the page must not react to the selection gesture
    // (links navigating, accordions toggling mid-drag).
    if (state.mode === "highlight") { e.preventDefault(); e.stopPropagation(); return; }
    if (state.mode !== "comment") return;
    e.preventDefault();
    e.stopPropagation();
    ensureLayerHeight();
    const x = e.pageX, y = e.pageY;
    const target = e.target;
    openNote(x, y, (text) => {
      const c = {
        id: nextId++, n: state.comments.length + 1, text, x, y,
        targetPath: cssPath(target), targetText: snippet(target),
        ...(pageInfo(x, y) || {}),
      };
      state.comments.push(c);
      addPin(c);
    });
  };

  const onKeydown = (e) => {
    if (e.key !== "Escape") return;
    // The note editor's own textarea handles its Escape (and stops here via
    // the editor being focused); this catches Esc pressed on the page.
    if (e.target && e.target.closest && e.target.closest("[data-fig-ui]")) return;
    if (state.ui.detail) { closeDetail(); e.stopPropagation(); }
  };

  // ---------- highlights (suggest) ----------

  const wrapRangeTextNodes = (range, id) => {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === 3 ? root.parentNode : root,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (range.intersectsNode(n) && n.data.trim() ? 1 : 2) }
    );
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const marks = [];
    for (const node of nodes) {
      if (node.parentElement && node.parentElement.closest("[data-fig-ui]")) continue;
      // Never nest a mark inside an existing highlight — re-highlighting a
      // highlighted stretch opens the existing comment instead (see onMouseUp).
      if (node.parentElement && node.parentElement.closest("mark[data-fig-highlight]")) continue;
      let start = 0, end = node.data.length;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (start >= end) continue;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      const mark = document.createElement("mark");
      mark.setAttribute("data-fig-highlight", String(id));
      try { r.surroundContents(mark); marks.push(mark); } catch { /* split-node edge; skip */ }
    }
    return marks;
  };

  // Native selection is unreliable under an annotation tool: Chrome refuses
  // to start selections inside <button> text, and pages that preventDefault
  // on mousedown kill it entirely. So highlight mode (a) shields mousedown /
  // mouseup from page handlers (stopPropagation at document capture — their
  // preventDefault never runs), and (b) when native selection still comes
  // back empty, computes the range GEOMETRICALLY from the drag start/end
  // points via caretRangeFromPoint.
  let hlDown = null;

  const onMouseDown = (e) => {
    if (!state.on || state.mode !== "highlight") return;
    if (e.target && e.target.closest && e.target.closest("[data-fig-ui]")) return;
    // Starting a highlight ON an existing highlight opens its comment instead
    // of layering a new one.
    const existing = e.target && e.target.closest && e.target.closest("mark[data-fig-highlight]");
    if (existing) {
      e.preventDefault();
      e.stopPropagation();
      openHighlightDetail(existing);
      return;
    }
    clearHlPreview();
    hlDown = { x: e.clientX, y: e.clientY };
    e.stopPropagation();
  };

  // ---- PDF-mode precision selection -------------------------------------
  // caretRangeFromPoint is too coarse over a PDF.js text layer: endpoints
  // between glyphs snap to container corners (selecting huge swaths) and
  // tiny drags snap to one caret (selecting nothing). So in the viewer,
  // selection is computed geometrically against the text-layer spans:
  // per-character offsets via binary search on real glyph rects, line-banded
  // span collection for multi-line drags, and word-snap for near-clicks.

  const charIndexAt = (node, x) => {
    const r = document.createRange();
    let lo = 0, hi = node.data.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      r.setStart(node, mid);
      r.setEnd(node, mid + 1);
      const cr = r.getBoundingClientRect();
      if ((cr.left + cr.right) / 2 <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // All text nodes of a span (a span that already holds a <mark> has several).
  const spanTextNodes = (span) => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.data.trim()) nodes.push(walker.currentNode);
    }
    return nodes;
  };

  const nodeRect = (node) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    return r.getBoundingClientRect();
  };

  const pdfPieces = (x1, y1, x2, y2) => {
    let a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    if (b.y < a.y - 4 || (Math.abs(b.y - a.y) <= 4 && b.x < a.x)) { const t = a; a = b; b = t; }
    const out = [];
    for (const span of document.querySelectorAll(".fig-pdf-page .textLayer span")) {
      for (const node of spanTextNodes(span)) {
        const r = nodeRect(node);
        if (!r.width || r.bottom < a.y || r.top > b.y) continue;
        const onStartLine = a.y >= r.top && a.y <= r.bottom;
        const onEndLine = b.y >= r.top && b.y <= r.bottom;
        if (onStartLine && r.right < a.x) continue;
        if (onEndLine && r.left > b.x) continue;
        let start = 0, end = node.data.length;
        if (onStartLine) start = charIndexAt(node, a.x);
        if (onEndLine) end = charIndexAt(node, b.x);
        if (start >= end) continue;
        out.push({ span, node, start, end, top: r.top, left: r.left });
      }
    }
    out.sort((p, q) => (Math.abs(p.top - q.top) > 4 ? p.top - q.top : p.left - q.left));
    return out;
  };

  const wordPieceAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const span = el && el.closest ? el.closest(".textLayer span") : null;
    if (!span) return [];
    const node = spanTextNodes(span).find((n) => {
      const r = nodeRect(n);
      return x >= r.left - 2 && x <= r.right + 2;
    });
    if (!node) return [];
    const s = node.data;
    let i = Math.min(charIndexAt(node, x), s.length - 1);
    // A click can land on a space (letter-spaced text is half spaces):
    // snap to the nearest non-space neighbor instead of giving up.
    if (!/\S/.test(s[i] || "")) {
      if (i > 0 && /\S/.test(s[i - 1])) i -= 1;
      else if (i < s.length - 1 && /\S/.test(s[i + 1])) i += 1;
      else return [];
    }
    let st = i, en = i;
    while (st > 0 && /\S/.test(s[st - 1])) st--;
    while (en < s.length && /\S/.test(s[en])) en++;
    const r = nodeRect(node);
    return [{ span, node, start: st, end: en, top: r.top, left: r.left }];
  };

  const wrapPiece = (node, start, end, id) => {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const mark = document.createElement("mark");
    mark.setAttribute("data-fig-highlight", String(id));
    try { r.surroundContents(mark); return mark; } catch { return null; }
  };

  // Live emerald preview while dragging, so the selection is visible even
  // though the text layer itself is transparent.
  let hlPreviewEl = null, hlRaf = 0;
  const clearHlPreview = () => {
    if (hlRaf) { cancelAnimationFrame(hlRaf); hlRaf = 0; }
    if (hlPreviewEl) { hlPreviewEl.remove(); hlPreviewEl = null; }
  };
  const renderHlPreview = (x, y) => {
    if (hlPreviewEl) hlPreviewEl.remove();
    const box = document.createElement("div");
    box.setAttribute("data-fig-ui", "1");
    box.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483643;";
    const pieces = pdfPieces(hlDown.x, hlDown.y, x, y);
    const r = document.createRange();
    for (const p of pieces) {
      r.setStart(p.node, p.start);
      r.setEnd(p.node, p.end);
      for (const cr of r.getClientRects()) {
        const d = document.createElement("div");
        d.style.cssText = "position:absolute;background:rgba(44,159,40,.28);"
          + `left:${window.scrollX + cr.left}px;top:${window.scrollY + cr.top}px;`
          + `width:${cr.width}px;height:${cr.height}px;`;
        box.appendChild(d);
      }
    }
    document.body.appendChild(box);
    hlPreviewEl = box;
  };
  const onHlMouseMove = (e) => {
    if (!state.on || state.mode !== "highlight" || !hlDown || !window.__figPDF) return;
    if (hlRaf) return;
    const x = e.clientX, y = e.clientY;
    hlRaf = requestAnimationFrame(() => { hlRaf = 0; if (hlDown) renderHlPreview(x, y); });
  };

  const pdfHighlightFromDrag = (x2, y2) => {
    if (!hlDown) return;
    let pieces = pdfPieces(hlDown.x, hlDown.y, x2, y2);
    if (!pieces.length && Math.hypot(x2 - hlDown.x, y2 - hlDown.y) < 6) {
      pieces = wordPieceAt(x2, y2);
    }
    // Pieces already inside a highlight belong to that highlight — never
    // double-wrap. If the whole drag was over one, open its comment.
    const fresh = pieces.filter((p) => !(p.node.parentElement && p.node.parentElement.closest("mark[data-fig-highlight]")));
    if (!fresh.length) {
      const over = pieces.length
        ? pieces[0].node.parentElement.closest("mark[data-fig-highlight]")
        : (document.elementFromPoint(x2, y2) || {}).closest?.("mark[data-fig-highlight]");
      if (over) openHighlightDetail(over);
      return;
    }
    const text = fresh.map((p) => p.node.data.slice(p.start, p.end)).join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    const id = nextId++;
    const marks = [];
    for (const p of fresh) {
      const m = wrapPiece(p.node, p.start, p.end, id);
      if (m) marks.push(m);
    }
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    const firstSpan = fresh[0].span;
    const pageEl = firstSpan.closest(".fig-pdf-page");
    const h = {
      id, text: text.slice(0, 500), note: "", replies: [], targetPath: cssPath(firstSpan),
      ...(pageEl ? { page: Number(pageEl.dataset.page) } : {}),
    };
    const anchor = (marks[marks.length - 1] || firstSpan).getBoundingClientRect();
    commitHighlight(h, marks, anchor);
  };
  // ------------------------------------------------------------------------

  const caretAt = (x, y) => {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p || !p.offsetNode) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  };

  const rangeFromDrag = (upX, upY) => {
    if (!hlDown) return null;
    const a = caretAt(hlDown.x, hlDown.y), b = caretAt(upX, upY);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.startContainer, a.startOffset);
      r.setEnd(b.startContainer, b.startOffset);
      if (r.collapsed) {
        r.setStart(b.startContainer, b.startOffset);
        r.setEnd(a.startContainer, a.startOffset);
      }
    } catch { return null; }
    return r.collapsed ? null : r;
  };

  const onMouseUp = (e) => {
    if (!state.on || state.mode !== "highlight") return;
    if (e.target && e.target.closest && e.target.closest("[data-fig-ui]")) return;
    e.stopPropagation();
    if (window.__figPDF) {
      clearHlPreview();
      pdfHighlightFromDrag(e.clientX, e.clientY);
      hlDown = null;
      return;
    }
    const sel = window.getSelection();
    let range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range) range = rangeFromDrag(e.clientX, e.clientY);
    hlDown = null;
    if (!range) return;
    const text = range.toString().trim();
    if (!text) return;
    const selRect = range.getBoundingClientRect();
    const id = nextId++;
    const anchorEl = range.commonAncestorContainer.nodeType === 3
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const marks = wrapRangeTextNodes(range, id);
    if (sel) sel.removeAllRanges();
    // Everything in the drag was already highlighted → open that comment.
    if (!marks.length) {
      const hit = [...document.querySelectorAll("mark[data-fig-highlight]")].find((mk) => {
        try { return range.intersectsNode(mk); } catch { return false; }
      });
      if (hit) { openHighlightDetail(hit); return; }
    }
    const pageEl = anchorEl && anchorEl.closest ? anchorEl.closest(".fig-pdf-page") : null;
    const h = {
      id, text: text.slice(0, 500), note: "", replies: [], targetPath: cssPath(anchorEl),
      ...(pageEl ? { page: Number(pageEl.dataset.page) } : {}),
    };
    commitHighlight(h, marks, marks.length ? marks[marks.length - 1].getBoundingClientRect() : selRect);
  };

  // The note is what makes a highlight real (mirrors the /fig skill's Suggest
  // mode): the marks paint immediately as a preview, the note editor opens,
  // and cancel/empty REMOVES the highlight — an accidental drag leaves
  // nothing behind. Saved marks become clickable to reopen the comment.
  const commitHighlight = (h, marks, rect) => {
    openNote(window.scrollX + rect.left, window.scrollY + rect.bottom, (note) => {
      h.note = note;
      state.highlights.push(h);
      marks.forEach((mk) => {
        mk.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openHighlightDetail(mk);
        });
      });
      if (!marks.length) toast("Text flagged (it spans markup, so it won't paint here)");
    }, {
      onCancel: () => { unwrapMarks(h.id); },
    });
  };

  // ---------- drawing ----------

  const initCanvas = () => {
    const canvas = document.createElement("canvas");
    canvas.className = "fig-draw-canvas";
    canvas.setAttribute("data-fig-ui", "1");
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let live = null;
    const drawPath = (points, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      points.forEach((p, i) => {
        const vx = p.x - window.scrollX, vy = p.y - window.scrollY;
        if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      });
      ctx.stroke();
    };
    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of state.strokes) drawPath(s.points, s.color);
      if (live) drawPath(live, state.drawColor);
    };
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      redraw();
    };
    // True erasing: only the parts of a stroke under the eraser disappear;
    // the surviving pieces continue as independent strokes. The path is
    // densified first so fast-drawn (sparse-point) segments erase cleanly.
    const densify = (points, maxGap) => {
      const out = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const gap = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.floor(gap / maxGap);
        for (let k = 1; k <= steps; k++) {
          out.push({ x: a.x + ((b.x - a.x) * k) / (steps + 1), y: a.y + ((b.y - a.y) * k) / (steps + 1) });
        }
        out.push(b);
      }
      return out;
    };
    const bbox = (points) => {
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      return {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      };
    };
    const ERASE_R = 14;
    const eraseAt = (x, y) => {
      let changed = false;
      const out = [];
      for (const s of state.strokes) {
        const pts = densify(s.points, 6);
        const keep = pts.map((p) => Math.hypot(p.x - x, p.y - y) > ERASE_R);
        if (keep.every(Boolean)) { out.push(s); continue; }
        changed = true;
        let run = [];
        const flush = () => {
          if (run.length >= 2) out.push({ ...s, points: run, box: bbox(run) });
          run = [];
        };
        pts.forEach((p, i) => { if (keep[i]) run.push(p); else flush(); });
        flush();
      }
      if (changed) { state.strokes = out; redraw(); }
    };
    let erasingDrag = false;
    canvas.addEventListener("pointerdown", (e) => {
      if (state.mode !== "draw") return;
      if (state.erasing) {
        erasingDrag = true;
        canvas.setPointerCapture(e.pointerId);
        eraseAt(e.pageX, e.pageY);
        return;
      }
      live = [{ x: e.pageX, y: e.pageY }];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (erasingDrag) { eraseAt(e.pageX, e.pageY); return; }
      if (!live) return;
      live.push({ x: e.pageX, y: e.pageY });
      redraw();
    });
    canvas.addEventListener("pointerup", () => {
      if (erasingDrag) { erasingDrag = false; return; }
      if (!live || live.length < 2) { live = null; return; }
      const xs = live.map((p) => p.x), ys = live.map((p) => p.y);
      const box = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      };
      const cxDoc = box.x + box.w / 2, cyDoc = box.y + box.h / 2;
      const cx = cxDoc - window.scrollX, cy = cyDoc - window.scrollY;
      canvas.style.pointerEvents = "none";
      const under = document.elementFromPoint(
        Math.max(0, Math.min(cx, window.innerWidth - 1)),
        Math.max(0, Math.min(cy, window.innerHeight - 1))
      );
      canvas.style.pointerEvents = "";
      state.strokes.push({
        points: live, box, color: state.drawColor,
        nearPath: cssPath(under), nearText: snippet(under),
        ...(pageInfo(cxDoc, cyDoc) || {}),
      });
      live = null;
      redraw();
    });
    window.addEventListener("scroll", redraw, { passive: true });
    window.addEventListener("resize", resize);
    resize();
    state.ui.canvas = canvas;
  };

  // ---------- capture + dispatch ----------

  const serializePage = () => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("[data-fig-ui], script").forEach((n) => n.remove());
    let head = clone.querySelector("head");
    if (!head) { head = document.createElement("head"); clone.prepend(head); }
    if (!head.querySelector("base")) {
      const base = document.createElement("base");
      base.href = document.baseURI;
      head.prepend(base);
    }
    return "<!doctype html>\n" + clone.outerHTML;
  };

  const setBusy = (on) => {
    state.ui.busy = on;
    const go = state.ui.goBtn;
    if (go) {
      go.disabled = on;
      go.classList.toggle("fig-go-busy", on);
    }
  };

  const dispatch = () => {
    if (state.ui.busy) return; // double-press = duplicate job
    const total = state.comments.length + state.highlights.length + state.strokes.length;
    if (!total) { toast("Nothing annotated yet"); return; }
    setBusy(true);
    toast("Sending to Fig…", true);
    // Serializing a big page is sync work; yield a frame first so the toast
    // and the button's busy state actually paint before it starts.
    setTimeout(() => {
      const pdf = window.__figPDF || null;
      const payload = {
        type: pdf ? "pdf" : "html",
        url: pdf ? pdf.src : location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        capturedAt: new Date().toISOString(),
        html: pdf ? "" : serializePage(),
        pdfBase64: pdf ? pdf.b64 : undefined,
        annotations: {
          comments: state.comments,
          highlights: state.highlights,
          strokes: state.strokes.map((s) => ({
            box: s.box, color: s.color, nearPath: s.nearPath, nearText: s.nearText,
            page: s.page, rx: s.rx, ry: s.ry,
          })),
        },
      };
      // A dead service worker means the callback never fires; without this
      // cap the sticky "Sending…" toast and the disabled button are forever.
      let settled = false;
      const settle = (fn) => { if (!settled) { settled = true; clearTimeout(cap); setBusy(false); fn(); } };
      const cap = setTimeout(() => settle(() => toast("Fig didn't answer — reload the extension and try again", true)), 25000);
      try {
        chrome.runtime.sendMessage({ type: "fig-dispatch", payload }, (res) => {
          settle(() => {
            if (res && res.ok) {
              toast("Fig is generating — a status tab opened");
            } else {
              const detail = (res && ((res.data && res.data.error) || res.error)) ? " (" + ((res.data && res.data.error) || res.error) + ")" : "";
              toast("Fig companion not reachable on 127.0.0.1:41414" + detail, true);
            }
          });
        });
      } catch (e) {
        // Extension was reloaded while this page was open: the old overlay's
        // runtime handle is dead. Say so instead of failing silently.
        settle(() => toast("Fig was updated — press ⌥⇧F to reload the tools, then press Fig again", true));
      }
    }, 0);
  };

  const clearAll = () => {
    closeDetail();
    if (state.ui.pins) state.ui.pins.clear();
    state.comments = [];
    state.highlights = [];
    state.strokes = [];
    if (state.ui.pinLayer) state.ui.pinLayer.replaceChildren();
    document.querySelectorAll("mark[data-fig-highlight]").forEach((m) => m.replaceWith(...m.childNodes));
    if (state.ui.canvas) {
      const ctx = state.ui.canvas.getContext("2d");
      ctx.clearRect(0, 0, state.ui.canvas.width, state.ui.canvas.height);
    }
    toast("All markings cleared");
  };

  // ---------- toolbar ----------

  const buildToolbar = () => {
    const bar = document.createElement("div");
    bar.className = "fig-toolbar";
    bar.setAttribute("data-fig-ui", "1");

    const drawColors = document.createElement("div");
    drawColors.className = "fig-draw-colors";
    drawColors.setAttribute("data-fig-ui", "1");
    for (const color of JEWELS) {
      const dot = document.createElement("button");
      dot.className = "fig-color" + (color === state.drawColor ? " fig-active" : "");
      dot.style.background = color;
      dot.title = "Draw color";
      dot.addEventListener("click", () => {
        state.drawColor = color;
        setErasing(false);
        drawColors.querySelectorAll(".fig-color").forEach((d) => d.classList.toggle("fig-active", d === dot));
      });
      drawColors.appendChild(dot);
    }
    const eraser = document.createElement("button");
    eraser.className = "fig-eraser";
    eraser.title = "Eraser — click or drag over a stroke to remove it";
    eraser.innerHTML = iconSvg("eraser");
    eraser.addEventListener("click", () => setErasing(!state.erasing));
    drawColors.appendChild(eraser);
    state.ui.eraserBtn = eraser;

    const mkIcon = (icon, title) => {
      const b = document.createElement("button");
      b.className = "fig-btn";
      b.title = title;
      b.innerHTML = iconSvg(icon);
      return b;
    };
    const draw = mkIcon("pencil", "Draw — freehand annotation");
    const comment = mkIcon("chat", "Comment — design & layout feedback");
    const highlight = mkIcon("highlighter", "Suggest — highlight text & flag changes");
    const div1 = document.createElement("span");
    div1.className = "fig-divider";
    const clear = mkIcon("trash", "Clear all markings");
    clear.classList.add("fig-clear");
    const help = mkIcon("help", "How to use these tools");
    const div2 = document.createElement("span");
    div2.className = "fig-divider";
    const go = document.createElement("button");
    go.className = "fig-go";
    go.innerHTML = "<svg viewBox=\"40 60 320 380\" fill=\"none\" aria-hidden=\"true\"><g transform=\"translate(70,410) rotate(-45)\" fill=\"currentColor\"><path d=\"M 9.0 -31.7 L 323.0 -15.9 Q 330.0 -15.5 330.0 -8.5 L 330.0 8.5 Q 330.0 15.5 323.0 15.9 L 9.0 31.7 Q 0.0 32.0 0.0 23.0 L 0.0 -23.0 Q 0.0 -32.0 9.0 -31.7 Z\"/></g><ellipse cx=\"235\" cy=\"123\" rx=\"36\" ry=\"53\" fill=\"currentColor\" transform=\"rotate(7 235 123)\"/><path d=\"M 288.20 275.25 C 289.92 275.08 291.69 275.13 293.44 275.25 C 295.18 275.38 296.98 275.62 298.67 275.99 C 300.37 276.36 301.98 276.94 303.61 277.47 C 305.23 278.00 306.86 278.55 308.44 279.19 C 310.02 279.83 311.55 280.60 313.10 281.32 C 314.65 282.05 316.22 282.72 317.72 283.54 C 319.23 284.37 320.70 285.29 322.14 286.26 C 323.59 287.24 324.99 288.32 326.39 289.40 C 327.79 290.48 329.17 291.60 330.54 292.75 C 331.91 293.90 333.31 295.08 334.62 296.30 C 335.92 297.52 337.19 298.75 338.38 300.07 C 339.58 301.39 340.70 302.81 341.78 304.21 C 342.87 305.61 343.89 307.03 344.89 308.47 C 345.88 309.90 346.87 311.34 347.76 312.82 C 348.66 314.30 349.49 315.80 350.26 317.33 C 351.02 318.86 351.73 320.42 352.38 322.00 C 353.03 323.58 353.62 325.18 354.15 326.81 C 354.68 328.44 355.20 330.07 355.57 331.76 C 355.95 333.46 356.27 335.22 356.41 336.96 C 356.55 338.70 356.57 340.47 356.41 342.20 C 356.26 343.92 355.93 345.66 355.48 347.31 C 355.03 348.97 354.46 350.58 353.71 352.12 C 352.96 353.66 352.05 355.20 351.00 356.54 C 349.95 357.88 348.73 359.12 347.38 360.16 C 346.04 361.20 344.50 362.11 342.92 362.77 C 341.35 363.43 339.64 363.84 337.94 364.13 C 336.24 364.42 334.48 364.51 332.72 364.50 C 330.96 364.49 329.13 364.34 327.39 364.09 C 325.66 363.83 323.97 363.20 322.31 362.98 C 320.64 362.75 318.88 362.52 317.41 362.74 C 315.94 362.95 314.65 363.41 313.47 364.28 C 312.29 365.16 311.33 366.65 310.33 367.99 C 309.33 369.34 308.50 370.94 307.46 372.35 C 306.41 373.76 305.31 375.21 304.04 376.45 C 302.78 377.68 301.33 378.81 299.87 379.76 C 298.42 380.71 296.92 381.56 295.31 382.14 C 293.71 382.72 291.95 383.07 290.23 383.25 C 288.51 383.44 286.71 383.44 284.99 383.25 C 283.27 383.07 281.52 382.72 279.91 382.14 C 278.29 381.57 276.79 380.75 275.32 379.82 C 273.86 378.89 272.44 377.76 271.13 376.56 C 269.81 375.36 268.57 373.99 267.43 372.63 C 266.29 371.26 265.21 369.85 264.29 368.38 C 263.38 366.91 262.67 365.36 261.94 363.81 C 261.22 362.26 260.55 360.69 259.96 359.09 C 259.37 357.48 258.89 355.83 258.39 354.19 C 257.89 352.55 257.40 350.91 256.98 349.23 C 256.55 347.56 256.17 345.87 255.87 344.15 C 255.56 342.43 255.31 340.68 255.13 338.91 C 254.94 337.14 254.82 335.34 254.76 333.52 C 254.69 331.70 254.69 329.80 254.76 327.97 C 254.82 326.15 254.94 324.35 255.13 322.58 C 255.31 320.81 255.56 319.07 255.87 317.34 C 256.17 315.62 256.58 313.95 256.98 312.26 C 257.37 310.57 257.76 308.89 258.21 307.23 C 258.66 305.57 259.14 303.91 259.69 302.30 C 260.24 300.68 260.84 299.07 261.54 297.52 C 262.24 295.96 263.04 294.44 263.89 292.95 C 264.75 291.45 265.65 289.98 266.67 288.55 C 267.70 287.13 268.83 285.69 270.03 284.42 C 271.24 283.14 272.53 281.96 273.91 280.91 C 275.29 279.87 276.78 278.92 278.31 278.15 C 279.84 277.38 281.44 276.78 283.09 276.30 C 284.73 275.82 286.47 275.43 288.20 275.25 Z\" fill=\"currentColor\" transform=\"translate(-4.95,-4.95)\"/></svg>" + "<span>Fig</span>";
    go.title = "Generate the revised page from these markings";

    bar.append(drawColors, draw, comment, highlight, div1, clear, help, div2, go);
    document.body.appendChild(bar);

    draw.addEventListener("click", () => setMode("draw"));
    comment.addEventListener("click", () => setMode("comment"));
    highlight.addEventListener("click", () => setMode("highlight"));
    clear.addEventListener("click", clearAll);
    help.addEventListener("click", () =>
      toast("Draw (the eraser rubs out just the parts it touches), drop comment pins (click a pin to open it), or drag across text to flag it. Enter posts a comment; Shift+Enter is a new line. Press Fig and the markings become a revised page. ⌥⇧F toggles the tools.", true)
    );
    go.addEventListener("click", dispatch);
    state.ui.bar = bar;
    state.ui.goBtn = go;
    state.ui.drawColors = drawColors;
    state.ui.modeButtons = { draw, comment, highlight };
  };

  const buildPinLayer = () => {
    const layer = document.createElement("div");
    layer.className = "fig-pin-layer";
    layer.setAttribute("data-fig-ui", "1");
    document.body.appendChild(layer);
    state.ui.pinLayer = layer;
    ensureLayerHeight();
  };

  // Loqumen logo font for the Fig button, served from the extension bundle
  // (web_accessible_resources) so it loads inside any page.
  const injectFont = () => {
    // Must never kill setup(): getURL is missing in some contexts.
    try {
      injectFontInner();
    } catch { /* toolbar falls back to system fonts */ }
  };

  const injectFontInner = () => {
    if (document.querySelector("style[data-fig-font]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-fig-ui", "1");
    style.setAttribute("data-fig-font", "1");
    style.textContent = `@font-face {
      font-family: 'Fig Josefin';
      src: url('${chrome.runtime.getURL("vendor/josefin-sans-500.woff2")}') format('woff2');
      font-weight: 500;
      font-style: normal;
    }`;
    document.head.appendChild(style);
  };

  const setup = () => {
    state.on = true;
    injectFont();
    buildToolbar();
    buildPinLayer();
    initCanvas();
    document.addEventListener("click", onPageClick, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onHlMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    const ver = (() => { try { return chrome.runtime.getManifest().version; } catch { return ""; } })();
    toast("Fig " + ver + " on — Draw, Comment, or Suggest, then press Fig");
  };

  const teardown = () => {
    state.on = false;
    state.mode = null;
    document.body.classList.remove("fig-mode-comment", "fig-mode-highlight", "fig-mode-draw");
    document.removeEventListener("click", onPageClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mousemove", onHlMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    clearHlPreview();
    hlDown = null;
    closeNote();
    closeDetail();
    for (const el of document.querySelectorAll("[data-fig-ui]")) el.remove();
    document.querySelectorAll("mark[data-fig-highlight]").forEach((m) => m.replaceWith(...m.childNodes));
    state.comments = [];
    state.highlights = [];
    state.strokes = [];
    state.erasing = false;
    document.body.classList.remove("fig-erasing");
    state.ui = {};
  };

  window.__figToggle = () => (state.on ? teardown() : setup());
  setup();
})();
