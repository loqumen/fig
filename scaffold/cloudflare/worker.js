// Fig review site — Cloudflare Worker.
// Serves the published pages as static assets and the review API backed by D1
// (first-party, free tier: 5M reads / 100k writes per day).
import { handleRequest } from "./review-api-core.js";
import { d1Store } from "./d1-store.js";

export default {
  async fetch(request, env) {
    const api = await handleRequest(request, d1Store(env.DB));
    if (api) return api;
    // everything else: the published pages
    return env.ASSETS.fetch(request);
  },
};
