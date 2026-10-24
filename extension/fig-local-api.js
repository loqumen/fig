// Fig — the local review store. The /fig overlay (fig-ui/fig-comments.js) talks to its
// usual API at https://fig.local/api/...; this answers those requests inside the page,
// with the same review core the hosted /fig server runs (fig-ui/review-core.js), and
// keeps every page's marks in chrome.storage.local so a refresh never loses them.
// Nothing leaves the machine until the Fig button sends the markings to the companion.
(() => {
  if (window.__figLocalApi) return;

  const LOCAL = "https://fig.local/";
  const core = window.__figReviewCore;
  const pageKey = () => (window.__figPDF ? "pdf::" + window.__figPDF.src : location.href.split("#")[0]);
  const storageKey = "figStore::" + pageKey();

  // { comments: {version: {id: comment}}, strokes: {version: [stroke]} }
  let data = { comments: {}, strokes: {} };
  const ready = new Promise((resolve) => {
    try {
      chrome.storage.local.get(storageKey, (res) => {
        const saved = res && res[storageKey];
        if (saved && typeof saved === "object") data = { comments: saved.comments || {}, strokes: saved.strokes || {} };
        resolve();
      });
    } catch { resolve(); }   // no extension context (tests): memory only
  });
  const persist = () => new Promise((resolve) => {
    try { chrome.storage.local.set({ [storageKey]: data }, () => resolve()); } catch { resolve(); }
  });

  const copy = (x) => JSON.parse(JSON.stringify(x));
  const cm = (v) => (data.comments[v] = data.comments[v] || {});
  const store = {
    async listComments(v) { return Object.values(cm(v)).map(copy); },
    async getComment(v, id) { const c = cm(v)[id]; return c ? copy(c) : null; },
    async saveComment(v, c) { cm(v)[c.id] = copy(c); },
    async deleteComment(v, id) { delete cm(v)[id]; },
    async deleteAllComments(v) { const n = Object.keys(cm(v)).length; data.comments[v] = {}; return n; },
    async getStrokes(v) { return copy(data.strokes[v] || []); },
    async putStrokes(v, arr) { data.strokes[v] = copy(arr); },
    async deleteStrokes(v) { delete data.strokes[v]; },
    async clearAuthor(author, versions, before) {
      let comments = 0, strokes = 0;
      const mine = (x) => x && x.author === author && (Number(x.timestamp) || 0) <= before;
      for (const v of versions) {
        for (const [id, c] of Object.entries(cm(v))) if (mine(c)) { delete cm(v)[id]; comments++; }
        const keep = (data.strokes[v] || []).filter((s) => !mine(s));
        strokes += (data.strokes[v] || []).length - keep.length;
        data.strokes[v] = keep;
      }
      return { comments, strokes };
    },
  };
  const ROUTES = { "/api/comments": core.handleComments, "/api/strokes": core.handleStrokes, "/api/clear": core.handleClear };

  // Content scripts have their own window: this replaces fetch for the overlay only,
  // never for the page's own scripts.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input && input.url;
    if (!url || !url.startsWith(LOCAL)) return realFetch(input, init);
    await ready;
    const u = new URL(url);
    const route = ROUTES[u.pathname];
    if (!route) return new Response("Not found", { status: 404 });
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
    const method = (init.method || "GET").toUpperCase();
    const r = await route({ method, query: Object.fromEntries(u.searchParams.entries()), body }, store);
    if (method !== "GET" && method !== "OPTIONS" && r.status < 400) await persist();
    return new Response(r.body, { status: r.status, headers: r.headers });
  };

  window.__figLocalApi = {
    ready,
    // everything marked on this page, for the Fig button
    async snapshot(version) {
      await ready;
      return { comments: await store.listComments(version), strokes: await store.getStrokes(version) };
    },
  };
})();
