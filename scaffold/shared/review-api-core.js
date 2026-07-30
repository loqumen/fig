// Fig review API core — provider-agnostic.
// Implements the exact contract fig-comments.js speaks (same as the original
// edits-project API): GET/POST/PATCH/DELETE /api/comments (replies via
// parentId, idempotent creates, suggest-mode fields) and GET/POST/DELETE
// /api/strokes. A provider passes a `store` with:
//   listComments(version) -> [comment]        saveComment(version, c)
//   getComment(version,id) -> c|null          deleteComment(version, id)
//   deleteAllComments(version) -> count
//   getStrokes(version) -> [stroke]           putStrokes(version, arr)
//   deleteStrokes(version)
// All mutations may be called concurrently; providers with CAS should retry
// internally. Values are small JSON records.

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

// req: { method, query: {v,id,all}, body: object|null }
export async function handleComments(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  const version = req.query.v || (req.body && req.body.version) || "default";

  if (req.method === "GET") {
    const comments = await store.listComments(version);
    comments.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return json(200, comments);
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const { id: clientId, x, y, text, author, context, parentId, kind, anchor, status, diagnosis } = b;

    if (parentId) {
      const parent = await store.getComment(version, parentId);
      if (!parent) return json(404, { error: "Parent comment not found" });
      const reply = {
        id: clientId || genId(),
        text: String(text).slice(0, 1000),
        author: String(author || "Anonymous").slice(0, 50),
        timestamp: Date.now(),
      };
      if (!parent.replies) parent.replies = [];
      if (!parent.replies.find((r) => r.id === reply.id)) {
        parent.replies.push(reply);
        await store.saveComment(version, parent);
      }
      return json(201, reply);
    }

    if (x == null || y == null || !text) return json(400, { error: "x, y, and text are required" });

    const id = clientId || genId();
    const existing = await store.getComment(version, id);
    if (existing) return json(200, existing);

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
    await store.saveComment(version, comment);
    return json(201, comment);
  }

  if (req.method === "PATCH") {
    const b = req.body || {};
    const { id, x, y, text, status, diagnosis } = b;
    if (!id) return json(400, { error: "id is required" });
    const comment = await store.getComment(version, id);
    if (!comment) return json(404, { error: "Comment not found" });
    if (x != null && y != null) { comment.x = Number(x); comment.y = Number(y); }
    if (text != null) comment.text = String(text).slice(0, 1000);
    if (status != null) comment.status = String(status).slice(0, 16);
    if (diagnosis != null) comment.diagnosis = String(diagnosis).slice(0, 4000);
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
}

export async function handleStrokes(req, store) {
  if (req.method === "OPTIONS") return { status: 200, headers: CORS, body: "" };
  const version = req.query.v || (req.body && req.body.version) || "default";

  if (req.method === "GET") return json(200, await store.getStrokes(version));

  if (req.method === "POST") {
    const b = req.body || {};
    const { points, color, width, author } = b;
    if (!points || !points.length) return json(400, { error: "points are required" });
    const stroke = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      points,
      color: color || "#FF1493",
      width: width || 3,
      author: String(author || "Anonymous").slice(0, 50),
      timestamp: Date.now(),
    };
    const arr = await store.getStrokes(version);
    arr.push(stroke);
    await store.putStrokes(version, arr);
    return json(201, stroke);
  }

  if (req.method === "DELETE") {
    const { id, all } = req.query;
    if (all === "true") { await store.deleteStrokes(version); return json(200, { cleared: true }); }
    if (!id) return json(400, { error: "id query param required" });
    const arr = (await store.getStrokes(version)).filter((s) => s.id !== id);
    await store.putStrokes(version, arr);
    return json(200, { deleted: id });
  }

  return json(405, { error: "Method not allowed" });
}
