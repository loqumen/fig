// Make a published page SELF-CONTAINED.
//
// A fig capture keeps assets by reference: the snapshot carries a <base>
// pointing at the captured URL and leaves `src="../assets/logo.svg"` alone.
// That works while you view the result on the machine that captured it, and
// breaks completely for everyone else — a page captured from a dev server
// publishes with every image resolving to http://localhost:PORT/..., which
// exists on nobody else's machine. The designer reviewing the Digital
// Custody preview saw exactly that: 16 images, all dead (2026-08-05).
//
// So at publish time every referenced asset is fetched (from THIS machine,
// where the dev server is reachable) and embedded as a data: URI. Failures
// are reported, never silently left as a broken reference.

const http = require("http");
const https = require("https");

const MAX_ONE = 4 * 1024 * 1024;    // per asset
const MAX_TOTAL = 24 * 1024 * 1024; // whole page

function fetchBuf(url, cb, redirects) {
  let u;
  try { u = new URL(url); } catch { return cb(new Error("bad url")); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return cb(new Error("unsupported scheme"));
  const lib = u.protocol === "https:" ? https : http;
  const req = lib.get(u, { timeout: 15000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if ((redirects || 0) >= 4) return cb(new Error("too many redirects"));
      return fetchBuf(new URL(res.headers.location, u).href, cb, (redirects || 0) + 1);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error("HTTP " + res.statusCode)); }
    const chunks = [];
    let size = 0;
    res.on("data", (c) => {
      size += c.length;
      if (size > MAX_ONE) { req.destroy(); return cb(new Error("larger than 4 MB")); }
      chunks.push(c);
    });
    res.on("end", () => cb(null, Buffer.concat(chunks), res.headers["content-type"] || ""));
  });
  req.on("timeout", () => { req.destroy(); cb(new Error("timed out")); });
  req.on("error", (e) => cb(e));
}

const TYPE_BY_EXT = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", css: "text/css",
};

const typeFor = (url, headerType) => {
  const clean = String(headerType || "").split(";")[0].trim();
  if (clean && clean !== "application/octet-stream" && clean !== "text/plain") return clean;
  const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1];
  return TYPE_BY_EXT[(ext || "").toLowerCase()] || "application/octet-stream";
};

// Every asset reference in the document, with the surrounding syntax kept so
// each one can be swapped in place: img/source/video/audio src, srcset
// candidates, and url(...) in <style> blocks and style="" attributes.
function collectRefs(html) {
  const refs = new Set();
  const add = (u) => {
    const v = String(u || "").trim();
    if (!v || v.startsWith("data:") || v.startsWith("#") || /^(about|blob|javascript|mailto):/i.test(v)) return;
    refs.add(v);
  };
  for (const m of html.matchAll(/<(?:img|source|video|audio|embed)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*?\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const cand of m[1].split(",")) add(cand.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/<link\b[^>]*?\brel\s*=\s*["'](?:stylesheet|icon|shortcut icon|apple-touch-icon)["'][^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)) add(m[2]);
  return [...refs];
}

// html: the page. baseUrl: what relative refs resolve against (the <base> the
// capture injected, or the captured URL). done({html, inlined, failed, notes}).
function inlineAssets(html, baseUrl, done) {
  const refs = collectRefs(html);
  if (!refs.length || !baseUrl) return done({ html, inlined: 0, failed: 0, notes: [] });

  const results = new Map();
  let left = refs.length, total = 0;
  const notes = [];

  const finish = () => {
    let out = html;
    let inlined = 0;
    for (const [ref, dataUri] of results) {
      if (!dataUri) continue;
      // Replace the reference wherever it appears, quoted or inside url().
      const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = out;
      out = out.replace(new RegExp('(["\'(])' + esc + '(["\')])', "g"), (mm, a, b) => a + dataUri + b);
      if (out !== before) inlined += 1;
    }
    // With every asset embedded, a <base> pointing at a machine-local dev
    // server is worse than useless: it would still capture any ref that
    // could not be inlined AND makes relative links dead for the reader.
    // Keep it only when it points somewhere publicly reachable.
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/i.test(baseUrl)) {
      out = out.replace(/<base\b[^>]*>/i, "");
      notes.push("removed the localhost <base>");
    }
    done({ html: out, inlined, failed: refs.length - inlined, notes });
  };

  for (const ref of refs) {
    let abs;
    try { abs = new URL(ref, baseUrl).href; } catch { results.set(ref, null); if (--left === 0) finish(); continue; }
    fetchBuf(abs, (err, buf, ctype) => {
      if (!err && buf && total + buf.length <= MAX_TOTAL) {
        total += buf.length;
        results.set(ref, `data:${typeFor(abs, ctype)};base64,${buf.toString("base64")}`);
      } else {
        results.set(ref, null);
        if (err) notes.push(ref.split("/").pop() + ": " + err.message);
      }
      if (--left === 0) finish();
    });
  }
}

module.exports = { inlineAssets, collectRefs };
