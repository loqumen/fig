// Publishing must produce a page that works on someone else's machine.
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { inlineAssets, collectRefs } = require("../companion/inline-assets.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const srv = http.createServer((req, res) => {
  if (req.url === "/assets/a.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); }
  else if (req.url === "/assets/b.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end("<svg/>"); }
  else if (req.url === "/assets/c.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); }
  else { res.writeHead(404); res.end(); }
});

const fail = (m) => { console.log("  ✗", m); srv.close(); process.exit(1); };
const ok = (m) => console.log("  ✓", m);

srv.listen(48412, "127.0.0.1", () => {
  const base = "http://127.0.0.1:48412/v2/";
  const html = '<html><head><base href="' + base + '">'
    + '<style>.x{background:url(../assets/b.svg)}</style></head><body>'
    + '<img src="../assets/a.png">'
    + '<img srcset="../assets/c.png 1x" src="../assets/c.png">'
    + '<img src="../assets/gone.png">'
    + '<img src="data:image/gif;base64,R0lGOD">'
    + "</body></html>";

  const refs = collectRefs(html);
  if (refs.includes("data:image/gif;base64,R0lGOD")) fail("data: URIs must not be re-fetched");
  ok("collectRefs skips data: URIs");

  inlineAssets(html, base, (r) => {
    if (!r.html.includes("data:image/png;base64")) fail("png not embedded");
    if (!r.html.includes("data:image/svg+xml;base64")) fail("css url() not embedded");
    ok("images and css url() assets are embedded");
    if (/<base\b/i.test(r.html)) fail("localhost <base> survived (would still point at this machine)");
    ok("localhost <base> is removed");
    if (!r.html.includes("../assets/gone.png")) fail("an unreachable asset must be left alone, not mangled");
    if (r.failed !== 1 || !r.notes.some((n) => /gone\.png/.test(n))) fail("unreachable asset not reported");
    ok("an unreachable asset is reported, never silently dropped");
    srv.close();
    process.exit(0);
  });
});
