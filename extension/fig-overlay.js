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
  const FIG_VERSION = 4;
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
    ta.focus();
    const finish = (commit) => {
      const v = ta.value.trim();
      box.remove();
      state.ui.note = null;
      if (commit && v) onSave(v);
    };
    save.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); return; }
      if (e.key === "Escape") finish(false);
    });
    state.ui.note = box;
  };

  const closeNote = () => { if (state.ui.note) { state.ui.note.remove(); state.ui.note = null; } };

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
      openNote(c.x, c.y, (text) => {
        c.text = text;
        pin.title = text + " (click to open)";
      }, {
        value: c.text,
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
    hlDown = { x: e.clientX, y: e.clientY };
    e.stopPropagation();
  };

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
    const pageEl = anchorEl && anchorEl.closest ? anchorEl.closest(".fig-pdf-page") : null;
    const h = {
      id, text: text.slice(0, 500), note: "", targetPath: cssPath(anchorEl),
      ...(pageEl ? { page: Number(pageEl.dataset.page) } : {}),
    };
    // Record even when the visual paint fails (split-node markup edge): the
    // highlight is an input to generation, not decoration.
    state.highlights.push(h);
    if (!marks.length) toast("Text flagged (it spans markup, so it won't paint here)");
    const rect = marks.length ? marks[marks.length - 1].getBoundingClientRect() : selRect;
    openNote(window.scrollX + rect.left, window.scrollY + rect.bottom, (note) => {
      h.note = note;
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

  const dispatch = () => {
    const total = state.comments.length + state.highlights.length + state.strokes.length;
    if (!total) { toast("Nothing annotated yet"); return; }
    toast("Sending to Fig…", true);
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
    chrome.runtime.sendMessage({ type: "fig-dispatch", payload }, (res) => {
      if (res && res.ok) {
        toast("Fig is generating — a status tab opened");
      } else {
        const detail = res && res.data && res.data.error ? " (" + res.data.error + ")" : "";
        toast("Fig companion not reachable on 127.0.0.1:41414" + detail, true);
      }
    });
  };

  const clearAll = () => {
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
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    const ver = (() => { try { return chrome.runtime.getManifest().version; } catch { return ""; } })();
    toast("Fig " + ver + " on — Draw, Comment, or Suggest, then press Fig");
  };

  const teardown = () => {
    state.on = false;
    state.mode = null;
    document.body.classList.remove("fig-mode-comment", "fig-mode-highlight", "fig-mode-draw");
    document.removeEventListener("click", onPageClick, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    closeNote();
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
