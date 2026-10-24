// Fig review API core — provider-agnostic.
// Implements the exact contract fig-comments.js speaks:
//   /api/comments  GET/POST/PATCH/DELETE (replies via parentId, idempotent creates,
//                  suggest-mode fields)
//   /api/strokes   GET/POST/DELETE (idempotent creates via client id)
//   /api/clear     POST: the trash button, everything one reviewer posted across pages
//   /api/versions  GET/POST/DELETE: page-version restore state
//
// A provider passes a `store`. Required (every provider):
//   listComments(version) -> [comment]        saveComment(version, c)
//   getComment(version,id) -> c|null          deleteComment(version, id)
//   deleteAllComments(version) -> count
//   getStrokes(version) -> [stroke]           putStrokes(version, arr)
//   deleteStrokes(version)
// Optional, used when present (a database provides these as single atomic statements,
// so concurrent reviewers never overwrite each other):
//   insertComment(version, c) -> { comment, created } (an existing id wins)
//   addReply(version, parentId, reply) -> "added" | "duplicate" | "missing"
//   deleteReply(version, replyId) -> boolean
//   patchComment(version, id, fields) -> c|null
//   addStroke(version, s)                     deleteStroke(version, id)
//   clearAuthor(author, versions, before) -> { comments, strokes }
//   getVersionState(key) -> obj|null  setVersionState(key, obj)  deleteVersionState(key)
// Without the optional methods the core falls back to read-modify-write, and the
// clear and versions endpoints answer 501.

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

// Any storage failure answers 503 with the CORS headers, so the browser sees a
// retryable error instead of a blocked request.
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("fig review api:", err);
    return json(503, { error: "storage busy, retry" });
  }
}

const has = (store, name) => typeof store[name] === "function";

function newComment(id, b) {
  const { x, y, text, author, context, kind, anchor, status, diagnosis } = b;
  const comment = {
    id,
    x: Number(x),
    y: Number(y),
    text: String(text).slice(0, 1000),
    author: String(author || "Anonymous").slice(0, 50),
    timestamp: Date.now(),
  };
  if (context && typeof context === "object") {
    comment.context = {
      ...(context.column && { column: String(context.column).slice(0, 10) }),
      ...(context.section && { section: String(context.section).slice(0, 200) }),
      ...(context.heading && { heading: String(context.heading).slice(0, 150) }),
      ...(context.nearbyText && { nearbyText: String(context.nearbyText).slice(0, 200) }),
    };
  }
  // Suggest mode: text-anchored accuracy feedback with an approval status.
  if (kind) comment.kind = String(kind).slice(0, 16);
  if (anchor && typeof anchor === "object") {
    comment.anchor = {
      quote: String(anchor.quote || "").slice(0, 2000),
      prefix: String(anchor.prefix || "").slice(0, 200),
      suffix: String(anchor.suffix || "").slice(0, 200),
    };
  }
  if (comment.kind === "suggest") comment.status = String(status || "open").slice(0, 16);
  else if (status) comment.status = String(status).slice(0, 16);
  if (diagnosis) comment.diagnosis = String(diagnosis).slice(0, 4000);
  return comment;
}

// req: { method, query: {v,id,all}, body: object|null }
export async function handleComments(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  return guarded(async () => {
    const version = req.query.v || (req.body && req.body.version) || "default";

    if (req.method === "GET") {
      const comments = await store.listComments(version);
      comments.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return json(200, comments);
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const { id: clientId, x, y, text, author, parentId } = b;

      if (parentId) {
        const reply = {
          id: clientId || genId(),
          text: String(text).slice(0, 1000),
          author: String(author || "Anonymous").slice(0, 50),
          timestamp: Date.now(),
        };
        if (has(store, "addReply")) {
          const r = await store.addReply(version, parentId, reply);
          if (r === "missing") return json(404, { error: "Parent comment not found" });
          return json(201, reply);
        }
        const parent = await store.getComment(version, parentId);
        if (!parent) return json(404, { error: "Parent comment not found" });
        if (!parent.replies) parent.replies = [];
        if (!parent.replies.find((r) => r.id === reply.id)) {
          parent.replies.push(reply);
          await store.saveComment(version, parent);
        }
        return json(201, reply);
      }

      if (x == null || y == null || !text) return json(400, { error: "x, y, and text are required" });

      const id = clientId || genId();
      if (has(store, "insertComment")) {
        // Idempotent: a retried create returns the comment that already exists.
        const { comment, created } = await store.insertComment(version, newComment(id, b));
        return json(created ? 201 : 200, comment);
      }
      const existing = await store.getComment(version, id);
      if (existing) return json(200, existing);
      const comment = newComment(id, b);
      await store.saveComment(version, comment);
      return json(201, comment);
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      const { id, x, y, text, status, diagnosis } = b;
      if (!id) return json(400, { error: "id is required" });
      const fields = {};
      if (x != null && y != null) { fields.x = Number(x); fields.y = Number(y); }
      if (text != null) fields.text = String(text).slice(0, 1000);
      if (status != null) fields.status = String(status).slice(0, 16);
      if (diagnosis != null) fields.diagnosis = String(diagnosis).slice(0, 4000);
      if (has(store, "patchComment")) {
        const comment = await store.patchComment(version, id, fields);
        if (!comment) return json(404, { error: "Comment not found" });
        return json(200, comment);
      }
      const comment = await store.getComment(version, id);
      if (!comment) return json(404, { error: "Comment not found" });
      Object.assign(comment, fields);
      await store.saveComment(version, comment);
      return json(200, comment);
    }

    if (req.method === "DELETE") {
      const { id, all } = req.query;
      if (all === "true") {
        const count = await store.deleteAllComments(version);
        return json(200, { deleted: "all", count });
      }
      if (!id) return json(400, { error: "id query param required" });
      const direct = await store.getComment(version, id);
      if (direct) {
        await store.deleteComment(version, id);
        return json(200, { deleted: id });
      }
      if (has(store, "deleteReply")) {
        return (await store.deleteReply(version, id))
          ? json(200, { deleted: id })
          : json(404, { error: "Comment not found" });
      }
      const all2 = await store.listComments(version);
      for (const c of all2) {
        if (c.replies && c.replies.some((r) => r.id === id)) {
          c.replies = c.replies.filter((r) => r.id !== id);
          await store.saveComment(version, c);
          return json(200, { deleted: id });
        }
      }
      return json(404, { error: "Comment not found" });
    }

    return json(405, { error: "Method not allowed" });
  });
}

export async function handleStrokes(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  return guarded(async () => {
    const version = req.query.v || (req.body && req.body.version) || "default";

    if (req.method === "GET") return json(200, await store.getStrokes(version));

    if (req.method === "POST") {
      const b = req.body || {};
      const { id: clientId, points, color, width, author } = b;
      if (!points || !points.length) return json(400, { error: "points are required" });
      const stroke = {
        // A client-supplied id makes a retried POST idempotent (no duplicate stroke).
        id: (clientId && String(clientId).slice(0, 40)) || Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        points,
        color: color || "#FF1493",
        width: width || 3,
        author: String(author || "Anonymous").slice(0, 50),
        timestamp: Date.now(),
      };
      if (has(store, "addStroke")) {
        await store.addStroke(version, stroke);
      } else {
        const arr = await store.getStrokes(version);
        if (!arr.some((s) => s.id === stroke.id)) arr.push(stroke);
        await store.putStrokes(version, arr);
      }
      return json(201, stroke);
    }

    if (req.method === "DELETE") {
      const { id, all } = req.query;
      if (all === "true") { await store.deleteStrokes(version); return json(200, { cleared: true }); }
      if (!id) return json(400, { error: "id query param required" });
      if (has(store, "deleteStroke")) await store.deleteStroke(version, id);
      else await store.putStrokes(version, (await store.getStrokes(version)).filter((s) => s.id !== id));
      return json(200, { deleted: id });
    }

    return json(405, { error: "Method not allowed" });
  });
}

// POST { author, versions: [...], before }
// The trash button: delete everything one reviewer posted (comments, suggestions,
// drawings) on every listed page at once. Only items stamped at or before `before`
// go, so a retried clear never takes feedback posted after the button was pressed.
export async function handleClear(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!has(store, "clearAuthor")) return json(501, { error: "clear is not supported by this store" });
  const { author, versions, before } = req.body || {};
  if (!author || !Array.isArray(versions) || !versions.length) {
    return json(400, { error: "author and versions are required" });
  }
  const list = versions.map(String).filter((v) => /^[A-Za-z0-9._-]{1,120}$/.test(v)).slice(0, 200);
  const cutoff = Number(before) || Date.now();
  return guarded(async () => {
    const r = await store.clearAuthor(String(author), list, cutoff);
    return json(200, { comments: r.comments, strokes: r.strokes, commit: null });
  });
}

// Page-version restore state: one record per page key -> {v, label, author, at}
export async function handleVersions(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  if (!has(store, "getVersionState")) return json(501, { error: "versions are not supported by this store" });
  const key = req.query.key || (req.body && req.body.key);
  if (!key || !/^[a-z0-9-]{2,120}$/.test(String(key))) return json(400, { error: "valid key required" });
  return guarded(async () => {
    if (req.method === "GET") return json(200, (await store.getVersionState(key)) || {});
    if (req.method === "POST") {
      const { v, label, author } = req.body || {};
      if (!v || !Number.isFinite(Number(v))) return json(400, { error: "v required" });
      const state = {
        v: Number(v),
        label: String(label || "").slice(0, 200),
        author: String(author || "Reviewer").slice(0, 50),
        at: Date.now(),
      };
      await store.setVersionState(key, state);
      return json(201, state);
    }
    if (req.method === "DELETE") {
      await store.deleteVersionState(key);
      return json(200, { cleared: key });
    }
    return json(405, { error: "Method not allowed" });
  });
}

const ROUTES = {
  "/api/comments": handleComments,
  "/api/strokes": handleStrokes,
  "/api/clear": handleClear,
  "/api/versions": handleVersions,
};

// Request -> Response for the four API paths; null for anything else, so the
// caller can serve the page instead.
export async function handleRequest(request, store) {
  const url = new URL(request.url);
  const route = ROUTES[url.pathname.replace(/\/+$/, "")];
  if (!route) return null;
  let body = null;
  if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
    const text = await request.text();
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  }
  const r = await route({ method: request.method, query: Object.fromEntries(url.searchParams.entries()), body }, store);
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
}
