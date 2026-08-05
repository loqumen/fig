// Fig review site — /api/strokes (Vercel serverless, Blob-backed).
import { handleStrokes } from "../lib/review-api-core.js";
import { blobStore } from "../lib/blob-store.js";

export default async function handler(req, res) {
  const r = await handleStrokes(
    { method: req.method, query: req.query || {}, body: req.body || null },
    blobStore()
  );
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.status).send(r.body);
}
