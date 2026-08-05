// Vercel Blob-backed store for the Fig review API.
// One JSON blob per comment (comments/<version>/<id>.json) so concurrent
// writes to different comments never clash; one array blob for strokes.
// Requires @vercel/blob (auto-authed in a linked project via OIDC).
import { put, del, list } from "@vercel/blob";

const opts = { access: "public", addRandomSuffix: false, contentType: "application/json", allowOverwrite: true };

async function readJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

export function blobStore() {
  const cPrefix = (v) => `fig/comments/${v}/`;
  const sPath = (v) => `fig/strokes/${v}.json`;
  return {
    async listComments(version) {
      const { blobs } = await list({ prefix: cPrefix(version) });
      const out = await Promise.all(blobs.map((b) => readJson(b.url)));
      return out.filter(Boolean);
    },
    async getComment(version, id) {
      const { blobs } = await list({ prefix: `${cPrefix(version)}${id}.json` });
      if (!blobs.length) return null;
      return readJson(blobs[0].url);
    },
    async saveComment(version, c) {
      await put(`${cPrefix(version)}${c.id}.json`, JSON.stringify(c), opts);
    },
    async deleteComment(version, id) {
      const { blobs } = await list({ prefix: `${cPrefix(version)}${id}.json` });
      await Promise.all(blobs.map((b) => del(b.url)));
    },
    async deleteAllComments(version) {
      const { blobs } = await list({ prefix: cPrefix(version) });
      await Promise.all(blobs.map((b) => del(b.url)));
      return blobs.length;
    },
    async getStrokes(version) {
      const { blobs } = await list({ prefix: sPath(version) });
      if (!blobs.length) return [];
      const arr = await readJson(blobs[0].url);
      return Array.isArray(arr) ? arr : [];
    },
    async putStrokes(version, arr) {
      await put(sPath(version), JSON.stringify(arr), opts);
    },
    async deleteStrokes(version) {
      const { blobs } = await list({ prefix: sPath(version) });
      await Promise.all(blobs.map((b) => del(b.url)));
    },
  };
}
