// Fig — the extension's page script. Runs the /fig review tools (fig-ui/, built from the
// /fig templates) on the current page with marks kept on this computer, plus the green
// Fig button, which sends the page and its markings to the companion to generate the
// revised page. Injected on demand; pressing ⌥⇧F again hides or shows the tools.
// Load order (background.js): fig-ui/review-core.js, fig-local-api.js, fig-ui/toolbar.js,
// fig-ui/fig-comments.js, then this file.
(() => {
  const FIG_EXT_VERSION = 1;
  if (window.__figExtToggle && window.__figExtVersion === FIG_EXT_VERSION) { window.__figExtToggle(); return; }
  window.__figExtVersion = FIG_EXT_VERSION;

  const root = document.documentElement;
  // the /fig overlay's own elements (fig-comments.js FIG_UI), plus the toast and font link
  const FIG_UI = ".fig-toolbar,.comment-detail,.comment-popover,.comment-pin,.author-overlay,.fig-onboard,.draw-colors,.fig-draw-canvas,.fig-pending-hl,.fig-toast,#fig-font,[data-fig-ext]";
  const bodyStyleBefore = document.body.getAttribute("style");
  let version = "";

  // ---------- helpers ----------
  const cssPath = (el) => {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + "#" + CSS.escape(el.id)); break; }
      const sibs = Array.from(el.parentNode ? el.parentNode.children : []).filter((s) => s.tagName === el.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  };
  const snippet = (el) => (el && el.textContent ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 140) : "");
  const isFigUi = (el) => !!(el && el.closest && el.closest(FIG_UI));

  // The deepest page element under a document point, without scrolling: walk down from
  // <body>, at each level taking the last child whose box contains the point (the one
  // painted on top in normal flow). Fig's own elements are skipped.
  const elementAtDocPoint = (x, y) => {
    const contains = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return false;
      const left = r.left + window.scrollX, top = r.top + window.scrollY;
      return x >= left && x <= left + r.width && y >= top && y <= top + r.height;
    };
    let el = document.body;
    for (;;) {
      const next = [...el.children].reverse().find((c) => !isFigUi(c) && c.tagName !== "SCRIPT" && c.tagName !== "STYLE" && contains(c));
      if (!next) return el;
      el = next;
    }
  };

  // PDF viewer: a document point -> {page, rx, ry}
  const pageInfo = (x, y) => {
    if (!window.__figPDF) return null;
    for (const el of document.querySelectorAll(".fig-pdf-page")) {
      const r = el.getBoundingClientRect();
      const left = r.left + window.scrollX, top = r.top + window.scrollY;
      if (x >= left && x <= left + r.width && y >= top && y <= top + r.height) {
        return {
          page: Number(el.dataset.page),
          rx: Math.round(((x - left) / r.width) * 1000) / 1000,
          ry: Math.round(((y - top) / r.height) * 1000) / 1000,
        };
      }
    }
    return null;
  };

  // /fig's notice style; sticky notices stay until replaced
  let toastEl = null, toastTimer = 0;
  const toast = (msg, sticky) => {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "fig-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("data-fig-ext", "1");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { if (toastEl) toastEl.remove(); toastEl = null; }, 6000);
  };

  // ---------- the Fig button: collect, snapshot, send ----------
  const docPoint = (pctX, pctY) => ({
    x: (pctX / 100) * document.body.clientWidth,
    y: (pctY / 100) * document.body.clientHeight,
  });

  async function collect() {
    const { comments, strokes } = await window.__figLocalApi.snapshot(version);
    comments.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const replies = (c) => (c.replies || []).map((r) => r.text);
    const out = { comments: [], highlights: [], strokes: [] };
    let n = 0;
    for (const c of comments) {
      if (c.kind === "suggest") {
        const mark = document.querySelector(`mark.fig-suggest[data-comment-id="${CSS.escape(c.id)}"]`);
        const host = mark ? mark.parentElement : null;
        const r = mark && mark.getBoundingClientRect();
        out.highlights.push({
          id: c.id,
          text: (c.anchor && c.anchor.quote) || (mark ? mark.textContent : ""),
          note: c.text,
          targetPath: cssPath(host),
          replies: replies(c),
          ...(r ? pageInfo(r.left + window.scrollX + r.width / 2, r.top + window.scrollY + r.height / 2) || {} : {}),
        });
      } else {
        n++;
        const { x, y } = docPoint(c.x, c.y);
        const el = elementAtDocPoint(x, y);
        out.comments.push({
          id: c.id, n, text: c.text, x: Math.round(x), y: Math.round(y),
          targetPath: cssPath(el), targetText: snippet(el), replies: replies(c),
          ...(pageInfo(x, y) || {}),
        });
      }
    }
    const canvas = document.querySelector(".fig-draw-canvas");
    const cw = canvas ? canvas.width : document.body.clientWidth;
    const ch = canvas ? canvas.height : document.body.scrollHeight;
    for (const s of strokes) {
      const pts = (s.points || []).map((p) => ({ x: (p.x / 100) * cw, y: (p.y / 100) * ch }));
      if (!pts.length) continue;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const box = { x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)), w: Math.round(Math.max(...xs) - Math.min(...xs)), h: Math.round(Math.max(...ys) - Math.min(...ys)) };
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const el = elementAtDocPoint(cx, cy);
      out.strokes.push({ box, color: s.color, nearPath: cssPath(el), nearText: snippet(el), ...(pageInfo(cx, cy) || {}) });
    }
    return out;
  }

  // The page as the reader sees it, minus Fig: no toolbar, pins, cards, or canvas, no
  // scripts, suggestions as <mark data-fig-highlight> (what the companion's prompt expects),
  // and a <base> so relative assets still resolve.
  const serializePage = () => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(FIG_UI + ", script").forEach((n) => n.remove());
    clone.querySelectorAll("mark.fig-suggest").forEach((m) => {
      const mark = document.createElement("mark");
      mark.setAttribute("data-fig-highlight", "");
      mark.append(...m.childNodes);
      m.replaceWith(mark);
    });
    clone.classList.remove("fig-ext-off");
    const body = clone.querySelector("body");
    if (body) {
      body.removeAttribute("data-fig-version");
      ["comment-mode", "suggest-mode", "draw-mode", "fig-inert"].forEach((c) => body.classList.remove(c));
      if (!body.classList.length) body.removeAttribute("class");
      if (bodyStyleBefore === null) body.removeAttribute("style"); else body.setAttribute("style", bodyStyleBefore);
    }
    let head = clone.querySelector("head");
    if (!head) { head = document.createElement("head"); clone.prepend(head); }
    if (!head.querySelector("base")) {
      const base = document.createElement("base");
      base.href = document.baseURI;
      head.prepend(base);
    }
    return "<!doctype html>\n" + clone.outerHTML;
  };

  // Script-driven pages arrive dead in a DOM snapshot, so the page's true source rides
  // along when it has scripts (the companion uses it as the edit base). Best-effort.
  const withSource = (payload, done) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; done(payload); } };
    if (payload.type === "pdf" || !document.querySelector("script")) { finish(); return; }
    const cap = setTimeout(finish, 4000);
    fetch(location.href, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => {
        clearTimeout(cap);
        if (t && t.length < 8 * 1024 * 1024 && /<script[\s>]/i.test(t)) payload.sourceHtml = t;
        finish();
      })
      .catch(() => { clearTimeout(cap); finish(); });
  };

  let busy = false;
  const setBusy = (on) => {
    busy = on;
    const go = document.getElementById("figGo");
    if (go) { go.disabled = on; go.classList.toggle("fig-go-busy", on); }
  };

  async function dispatch() {
    if (busy) return;   // a double press would start a second job
    const annotations = await collect();
    const total = annotations.comments.length + annotations.highlights.length + annotations.strokes.length;
    if (!total) { toast("Nothing marked up yet"); return; }
    setBusy(true);
    toast("Sending to Fig…", true);
    // serializing a big page is synchronous work: let the notice paint first
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
        annotations,
      };
      withSource(payload, (p) => {
        // a dead service worker never calls back; don't leave the button stuck
        let settled = false;
        const settle = (fn) => { if (!settled) { settled = true; clearTimeout(cap); setBusy(false); fn(); } };
        const cap = setTimeout(() => settle(() => toast("Fig didn't answer. Reload the extension and try again.")), 25000);
        try {
          chrome.runtime.sendMessage({ type: "fig-dispatch", payload: p }, (res) => {
            void chrome.runtime.lastError;
            settle(() => {
              if (res && res.ok) toast("Fig is generating. A status tab opened.");
              else {
                const detail = (res && ((res.data && res.data.error) || res.error)) || "";
                toast("The Fig companion isn't running on this Mac" + (detail ? ` (${detail})` : "") + ". Start it, then press Fig again.");
              }
            });
          });
        } catch {
          settle(() => toast("Fig was updated. Press ⌥⇧F twice to reload the tools, then press Fig again."));
        }
      });
    }, 0);
  }

  // ---------- on / off ----------
  const setOff = (off) => {
    if (off) {
      // turn any active tool off first, so the page is fully interactive again
      for (const id of ["commentToggle", "suggestToggle", "drawToggle"]) {
        const b = document.getElementById(id);
        if (b && b.classList.contains("active")) b.click();
      }
    }
    root.classList.toggle("fig-ext-off", off);
    rememberPrefs();
  };

  // The name and the first-visit card are per site in /fig (localStorage). The
  // extension remembers them once for every site.
  const PREFS = "figExtPrefs";
  const rememberPrefs = () => {
    try {
      const author = localStorage.getItem("fig-comment-author");
      const onboarded = localStorage.getItem("fig-onboarded") === "1";
      chrome.storage.local.get(PREFS, (res) => {
        const p = (res && res[PREFS]) || {};
        const next = { author: author || p.author || "", onboarded: onboarded || !!p.onboarded };
        if (next.author !== p.author || next.onboarded !== p.onboarded) chrome.storage.local.set({ [PREFS]: next });
      });
    } catch { /* no extension context */ }
  };
  const loadPrefs = () => new Promise((resolve) => {
    try {
      chrome.storage.local.get(PREFS, (res) => {
        const p = (res && res[PREFS]) || {};
        try {
          if (p.author && !localStorage.getItem("fig-comment-author")) localStorage.setItem("fig-comment-author", p.author);
          if (p.onboarded) localStorage.setItem("fig-onboarded", "1");
        } catch { /* page forbids storage */ }
        resolve();
      });
    } catch { resolve(); }
  });

  // DM Sans ships with the extension: many sites' security rules block Google Fonts
  const addFont = () => {
    if (document.querySelector("style[data-fig-ext-font]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-fig-ext-font", "1");
    style.setAttribute("data-fig-ext", "1");
    style.textContent = `@font-face { font-family: 'DM Sans'; src: url('${chrome.runtime.getURL("vendor/dm-sans-var-latin.woff2")}') format('woff2'); font-weight: 300 500; font-style: normal; font-display: swap; }`;
    (document.head || document.documentElement).appendChild(style);
  };

  async function start() {
    // one stable store name per page; the trash and sync code expect [A-Za-z0-9._-]
    const key = window.__figPDF ? "pdf::" + window.__figPDF.src : location.href.split("#")[0];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
    version = "ext-" + (h >>> 0).toString(36);
    document.body.dataset.figVersion = version;
    try { addFont(); } catch { /* no extension context */ }
    await loadPrefs();
    await window.__figLocalApi.ready;
    document.body.insertAdjacentHTML("beforeend", window.__figToolbarHTML);
    window.__figInit();
    document.getElementById("figGo").addEventListener("click", dispatch);
    window.addEventListener("pagehide", rememberPrefs);
  }

  let started = false;
  window.__figExtToggle = () => {
    if (!started) { started = true; start(); return; }
    setOff(!root.classList.contains("fig-ext-off"));
  };
  window.__figExtToggle();
})();
