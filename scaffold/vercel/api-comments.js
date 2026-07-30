// Fig review site — /api/comments (Vercel serverless, Blob-backed).
import { handleComments } from "../lib/review-api-core.js";
import { blobStore } from "../lib/blob-store.js";

export default async function handler(req, res) {
  const r = await handleComments(
    { method: req.method, query: req.query || {}, body: req.body || null },
    blobStore()
  );
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.status).send(r.body);
}
