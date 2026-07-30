// Fig review site — Cloudflare Worker.
// Serves the published pages as static assets and the comments/strokes API
// backed by D1 (first-party, free tier: 5M reads / 100k writes per day).
import { handleComments, handleStrokes } from "./review-api-core.js";

function d1Store(db) {
  return {
    async listComments(version) {
      const { results } = await db.prepare("SELECT data FROM comments WHERE version = ?").bind(version).all();
      return results.map((r) => JSON.parse(r.data));
    },
    async getComment(version, id) {
      const row = await db.prepare("SELECT data FROM comments WHERE version = ? AND id = ?").bind(version, id).first();
      return row ? JSON.parse(row.data) : null;
    },
    async saveComment(version, c) {
      await db.prepare(
        "INSERT INTO comments (version, id, data) VALUES (?1, ?2, ?3) ON CONFLICT(version, id) DO UPDATE SET data = ?3"
      ).bind(version, c.id, JSON.stringify(c)).run();
    },
    async deleteComment(version, id) {
      await db.prepare("DELETE FROM comments WHERE version = ? AND id = ?").bind(version, id).run();
    },
    async deleteAllComments(version) {
      const r = await db.prepare("DELETE FROM comments WHERE version = ?").bind(version).run();
      return (r.meta && r.meta.changes) || 0;
    },
    async getStrokes(version) {
      const row = await db.prepare("SELECT data FROM strokes WHERE version = ?").bind(version).first();
      return row ? JSON.parse(row.data) : [];
    },
    async putStrokes(version, arr) {
      await db.prepare(
        "INSERT INTO strokes (version, data) VALUES (?1, ?2) ON CONFLICT(version) DO UPDATE SET data = ?2"
      ).bind(version, JSON.stringify(arr)).run();
    },
    async deleteStrokes(version) {
      await db.prepare("DELETE FROM strokes WHERE version = ?").bind(version).run();
    },
  };
}

async function readReq(request, url) {
  let body = null;
  if (request.method === "POST" || request.method === "PATCH") {
    try { body = await request.json(); } catch { body = null; }
  }
  return {
    method: request.method,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = d1Store(env.DB);
    if (url.pathname === "/api/comments") {
      const r = await handleComments(await readReq(request, url), store);
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
    if (url.pathname === "/api/strokes") {
      const r = await handleStrokes(await readReq(request, url), store);
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
    // everything else: the published pages
    return env.ASSETS.fetch(request);
  },
};
