#!/usr/bin/env node
// figd — the Fig companion daemon.
// Receives a page snapshot + annotations from the extension, dispatches a
// generation run on the USER'S OWN `claude` CLI (their `claude login` auth,
// the same lane Summon uses), and serves the revised page locally. An
// optional settings target deploys the result to the existing edits Vercel
// project instead.
//
// Binds 127.0.0.1 only. Requests must carry X-Fig-Token matching
// ~/.fig/settings.json (auto-generated on first run).

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const PORT = 41414;
const FIG_HOME = path.join(os.homedir(), ".fig");
const JOBS = path.join(FIG_HOME, "jobs");
const SETTINGS_PATH = path.join(FIG_HOME, "settings.json");

fs.mkdirSync(JOBS, { recursive: true });

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { /* first run */ }
  let dirty = false;
  if (!s.token) { s.token = crypto.randomBytes(16).toString("hex"); dirty = true; }
  if (!s.target) { s.target = "localhost"; dirty = true; } // "localhost" | "vercel"
  if (!s.vercelDir) { s.vercelDir = path.join(os.homedir(), "Desktop", "edits"); dirty = true; }
  if (!s.claudeArgs) { s.claudeArgs = ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit"]; dirty = true; }
  if (dirty) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  return s;
}

function slugify(title) {
  const base = (title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  return base + "-" + new Date().toISOString().slice(5, 16).replace(/[^0-9]/g, "");
}

function buildPrompt(job, payload) {
  const a = payload.annotations;
  const isPdf = payload.type === "pdf";
  const lines = [];
  if (isPdf) {
    lines.push("Revise the captured PDF document according to the reviewer's markings.");
    lines.push("");
    lines.push(`Source: ${payload.url}`);
    lines.push("Files in this directory: source.pdf (the captured document), annotations.json (the full markings data).");
    lines.push("");
    lines.push("Read source.pdf first. Markings reference PDF page numbers; `rx`/`ry` are fractions of the page width/height from the top-left corner.");
  } else {
    lines.push("Revise the captured web page according to the reviewer's markings.");
    lines.push("");
    lines.push(`Source: ${payload.url}`);
    lines.push("Files in this directory: snapshot.html (the captured page), annotations.json (the full markings data).");
  }
  lines.push("");
  lines.push("The markings and what each means:");
  if (a.comments.length) {
    lines.push("");
    lines.push("COMMENTS (each is an instruction anchored to a spot):");
    a.comments.forEach((c) => {
      const anchor = c.page
        ? `page ${c.page} at rx=${c.rx}, ry=${c.ry}`
        : `\`${c.targetPath}\` (element text starts: "${c.targetText}")`;
      lines.push(`- [${c.n}] "${c.text}" — anchored to ${anchor}`);
    });
  }
  if (a.highlights.length) {
    lines.push("");
    lines.push(isPdf
      ? "HIGHLIGHTS (flagged text in the document). A note, when present, says what to do; a highlight with no note means the text is wrong or needs rework, use judgment:"
      : "HIGHLIGHTS (flagged text; in snapshot.html each is wrapped in <mark data-fig-highlight>). A note, when present, says what to do; a highlight with no note means the text is wrong or needs rework, use judgment:");
    a.highlights.forEach((h) => {
      lines.push(`- "${h.text.slice(0, 160)}"${h.page ? ` (page ${h.page})` : ""}${h.note ? ` — note: "${h.note}"` : ""}`);
    });
  }
  if (a.strokes.length) {
    lines.push("");
    lines.push("DRAWN REGIONS (the reviewer circled/marked these areas; treat as attention flags on that spot):");
    a.strokes.forEach((s, i) => {
      const anchor = s.page
        ? `page ${s.page} around rx=${s.rx}, ry=${s.ry}`
        : `near \`${s.nearPath}\` (element text starts: "${s.nearText}")`;
      lines.push(`- region ${i + 1} ${anchor}`);
    });
  }
  lines.push("");
  lines.push("Rules:");
  if (isPdf) {
    lines.push("- Write the revised document to edited.html in this directory: a complete standalone HTML document that faithfully recreates the PDF's design (fonts, colors, layout, pagination as sections) with the requested changes applied.");
    lines.push("- Use print CSS (@page { size: Letter; margin: 0.5in }) so the result exports back to PDF cleanly.");
  } else {
    lines.push("- Write the revised page to edited.html in this directory: a complete standalone HTML document.");
    lines.push("- Preserve everything not covered by a marking exactly as it is, including all styling, layout, and the <base> tag.");
    lines.push("- Remove the <mark data-fig-highlight> wrappers in the output (apply the change, drop the marker).");
  }
  lines.push("- If a marking is ambiguous, make the most reasonable change AND add an HTML comment <!-- fig-question: ... --> at the spot explaining the open question.");
  lines.push('- Also write changes.json in this directory: a JSON array with one entry per marking IN THE ORDER GIVEN, each {"marking": "the marking text or [n]", "change": "one sentence: exactly what changed", "where": "short location in the revised document"}. If a marking produced no change, say why in "change".');
  lines.push("- Do not add scripts.");
  return lines.join("\n");
}

// figd may run under launchd, whose PATH has no user binaries — resolve
// the claude CLI explicitly (same candidates as Summon's ask lane).
function claudeBin() {
  const cands = [
    path.join(os.homedir(), ".local/bin/claude"),
    "/Applications/cmux.app/Contents/Resources/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of cands) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return "claude";
}

function runGeneration(jobDir, settings) {
  const prompt = fs.readFileSync(path.join(jobDir, "prompt.md"), "utf8");
  const log = fs.openSync(path.join(jobDir, "gen.log"), "a");
  const child = spawn(claudeBin(), ["-p", prompt, ...settings.claudeArgs], {
    cwd: jobDir,
    stdio: ["ignore", log, log],
    env: { ...process.env, PATH: [process.env.PATH, path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":") },
  });
  child.on("error", (e) => {
    fs.writeFileSync(path.join(jobDir, "error.txt"), "Could not launch claude CLI: " + e.message);
  });
  child.on("exit", (code) => {
    const edited = path.join(jobDir, "edited.html");
    if (code !== 0 && !fs.existsSync(edited)) {
      fs.writeFileSync(path.join(jobDir, "error.txt"), `claude exited ${code} without producing edited.html (see gen.log)`);
      return;
    }
    if (fs.existsSync(edited)) {
      if (fs.existsSync(path.join(jobDir, "source.pdf"))) printPdf(jobDir);
      const settingsNow = loadSettings();
      if (settingsNow.target === "vercel") deployToVercel(jobDir, settingsNow);
    }
  });
}

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// For PDF-sourced jobs, also export the revised page back to PDF.
function printPdf(jobDir) {
  if (!fs.existsSync(BRAVE)) return;
  execFile(
    BRAVE,
    ["--headless", "--print-to-pdf=" + path.join(jobDir, "edited.pdf"), "--no-pdf-header-footer",
      "--virtual-time-budget=4000", "file://" + path.join(jobDir, "edited.html")],
    () => { /* best-effort; edited.html remains the primary artifact */ }
  );
}

function deployToVercel(jobDir, settings) {
  try {
    const slug = path.basename(jobDir);
    const dest = path.join(settings.vercelDir, "public", slug);
    fs.mkdirSync(dest, { recursive: true });
    const html = injectChangelog(jobDir, fs.readFileSync(path.join(jobDir, "edited.html"), "utf8"));
    fs.writeFileSync(path.join(dest, "index.html"), html);
    execFile("vercel", ["--prod"], { cwd: settings.vercelDir }, (err, stdout) => {
      fs.writeFileSync(
        path.join(jobDir, "deploy.txt"),
        err ? "Deploy failed: " + err.message : "Deployed: " + (stdout || "").trim().split("\n").pop()
      );
    });
  } catch (e) {
    fs.writeFileSync(path.join(jobDir, "deploy.txt"), "Deploy failed: " + e.message);
  }
}

// Strip any change-log widget already IN the content: marked blocks from
// re-serving, and legacy unmarked ones that rode along in a snapshot of a
// served page (Fig run on a Fig result — the widget predated its
// data-fig-ui tag, so the serializer captured it, minus its script). The
// legacy block is nested divs with no reliable tail, so walk to the
// balanced close instead of regexing.
function stripChangelogBlocks(html) {
  html = html.replace(/<!--fig-changelog-start-->[\s\S]*?<!--fig-changelog-end-->/g, "");
  for (;;) {
    const i = html.indexOf('<div id="fig-changelog"');
    if (i === -1) break;
    const re = /<div\b|<\/div>/g;
    re.lastIndex = i;
    let depth = 0, end = -1, m;
    while ((m = re.exec(html))) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) { end = re.lastIndex; break; }
    }
    if (end === -1) break;
    const tail = html.slice(end, end + 400).match(/^\s*<script>[\s\S]*?<\/script>/);
    if (tail) end += tail[0].length;
    html = html.slice(0, i) + html.slice(end);
  }
  return html;
}

// Revealable change log, injected at serve/deploy time so edited.html stays
// clean (the PDF export reads the raw file and never carries the widget).
// Hidden by default; a small pill toggles it.
function injectChangelog(jobDir, html) {
  const p = path.join(jobDir, "changes.json");
  if (!fs.existsSync(p)) return html;
  let items;
  try { items = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return html; }
  if (!Array.isArray(items) || !items.length) return html;
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = items.map((c, i) => `
    <li style="display:flex;gap:10px;padding:10px 0;align-items:flex-start;${i ? "box-shadow:0 -1px 0 #e8e6e1;" : ""}">
      <span style="flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#2C9F28;color:#fafaf8;font-size:11px;display:flex;align-items:center;justify-content:center;">${i + 1}</span>
      <span style="display:block;min-width:0;">
        <span style="display:block;color:#1a1a1a;">${esc(c.change)}</span>
        ${c.marking ? `<span style="display:block;color:#9a9790;font-size:11px;margin-top:2px;">marking: ${esc(c.marking)}</span>` : ""}
        ${c.where ? `<span style="display:block;color:#9a9790;font-size:11px;">${esc(c.where)}</span>` : ""}
      </span>
    </li>`).join("");
  const widget = `
<!--fig-changelog-start-->
<div id="fig-changelog" data-fig-ui="1" style="position:fixed;left:24px;bottom:24px;z-index:2147483000;font-family:'DM Sans',-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.5;">
  <div id="fig-changelog-panel" style="display:none;width:340px;max-height:55vh;overflow:auto;background:#fafaf8;color:#1a1a1a;border:1px solid #e8e6e1;border-radius:12px;box-shadow:0 6px 24px rgba(26,26,26,.18);padding:14px 16px;margin:0 0 10px;">
    <div style="font-weight:500;margin-bottom:2px;">What changed</div>
    <ul style="list-style:none;margin:0;padding:0;">${rows}</ul>
  </div>
  <button id="fig-changelog-btn" type="button" style="border:none;cursor:pointer;background:#2C9F28;color:#fafaf8;border-radius:999px;padding:9px 16px;font-family:inherit;font-size:13px;box-shadow:0 4px 16px rgba(26,26,26,.2);">Changes · ${items.length}</button>
</div>
<script>(function(){var b=[...document.querySelectorAll("#fig-changelog-btn")].pop(),p=[...document.querySelectorAll("#fig-changelog-panel")].pop();b.addEventListener("click",function(){p.style.display=p.style.display==="none"?"block":"none";});})();</script>
<!--fig-changelog-end-->`;
  html = stripChangelogBlocks(html);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, widget + "\n</body>") : html + widget;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#fafaf8;color:#1a1a1a;max-width:640px;margin:80px auto;padding:0 24px;line-height:1.7}
a{color:#2C9F28}h1{font-size:20px;font-weight:600}.muted{color:#4a4a46}</style></head><body>${body}</body></html>`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The extension's service worker POSTs with a custom X-Fig-Token header,
// which makes the browser send a CORS preflight first. Without these
// headers the preflight 404s and every dispatch fails as "not reachable".
// Loopback-only + token-gated, so reflecting extension origins is safe.
function corsHeaders(req) {
  const origin = req.headers.origin || "";
  if (!origin.startsWith("chrome-extension://")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Fig-Token",
    "Access-Control-Max-Age": "600",
  };
}

const server = http.createServer(async (req, res) => {
  const settings = loadSettings();
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  // Dispatch endpoint (extension only, token-gated).
  if (req.method === "POST" && url.pathname === "/fig") {
    if (req.headers["x-fig-token"] !== settings.token) {
      res.writeHead(403, { "Content-Type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ error: "bad token — paste the token from ~/.fig/settings.json into the extension popup" }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req, 50 * 1024 * 1024));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ error: String(e.message || e) }));
      return;
    }
    const slug = slugify(payload.title);
    const jobDir = path.join(JOBS, slug);
    fs.mkdirSync(jobDir, { recursive: true });
    if (payload.type === "pdf" && payload.pdfBase64) {
      fs.writeFileSync(path.join(jobDir, "source.pdf"), Buffer.from(payload.pdfBase64, "base64"));
    } else {
      fs.writeFileSync(path.join(jobDir, "snapshot.html"), payload.html || "");
    }
    const { html, pdfBase64, ...meta } = payload;
    fs.writeFileSync(path.join(jobDir, "annotations.json"), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(jobDir, "prompt.md"), buildPrompt(slug, payload));
    runGeneration(jobDir, settings);
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders(req) });
    res.end(JSON.stringify({ job: slug, statusUrl: `http://127.0.0.1:${PORT}/jobs/${slug}/` }));
    return;
  }

  // Job status page — refreshes until edited.html exists, then redirects.
  let m = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/?$/);
  if (m) {
    const jobDir = path.join(JOBS, m[1]);
    if (!fs.existsSync(jobDir)) { res.writeHead(404); res.end("no such job"); return; }
    if (fs.existsSync(path.join(jobDir, "edited.html"))) {
      res.writeHead(302, { Location: `/pages/${m[1]}/` });
      res.end();
      return;
    }
    const errPath = path.join(jobDir, "error.txt");
    if (fs.existsSync(errPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Fig — failed", `<h1>Generation failed</h1><p class="muted">${fs.readFileSync(errPath, "utf8")}</p>`));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", Refresh: "3" });
    res.end(page("Fig — generating", `<h1>Fig is generating…</h1><p class="muted">Applying your markings to the page. This page refreshes itself.</p>`));
    return;
  }

  // Serve results.
  m = url.pathname.match(/^\/pages\/([a-z0-9-]+)\/(original|edited\.pdf|original\.pdf)?$/);
  if (m) {
    const jobDir = path.join(JOBS, m[1]);
    if (m[2] === "edited.pdf" || m[2] === "original.pdf") {
      const pdf = path.join(jobDir, m[2] === "edited.pdf" ? "edited.pdf" : "source.pdf");
      if (!fs.existsSync(pdf)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(fs.readFileSync(pdf));
      return;
    }
    let file = path.join(jobDir, m[2] ? "snapshot.html" : "edited.html");
    if (m[2] === "original" && !fs.existsSync(file) && fs.existsSync(path.join(jobDir, "source.pdf"))) {
      res.writeHead(302, { Location: `/pages/${m[1]}/original.pdf` });
      res.end();
      return;
    }
    if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    let html = fs.readFileSync(file, "utf8");
    if (!m[2]) html = injectChangelog(jobDir, html);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // Index of jobs.
  if (url.pathname === "/") {
    const rows = fs.readdirSync(JOBS)
      .filter((d) => fs.existsSync(path.join(JOBS, d, "annotations.json")))
      .sort().reverse()
      .map((d) => {
        const done = fs.existsSync(path.join(JOBS, d, "edited.html"));
        let deploy = "";
        const dp = path.join(JOBS, d, "deploy.txt");
        if (fs.existsSync(dp)) deploy = ` <span class="muted">· ${fs.readFileSync(dp, "utf8")}</span>`;
        const pdf = fs.existsSync(path.join(JOBS, d, "edited.pdf")) ? ` <a class="muted" href="/pages/${d}/edited.pdf">pdf</a>` : "";
        return `<li><a href="${done ? "/pages/" + d + "/" : "/jobs/" + d + "/"}">${d}</a> <span class="muted">${done ? "" : "(generating)"}</span>${pdf}${deploy} <a class="muted" href="/pages/${d}/original">original</a></li>`;
      })
      .join("\n");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page("Fig", `<h1>Fig</h1><p class="muted">Target: ${settings.target}</p><ul>${rows || "<li class='muted'>No figs yet</li>"}</ul>`));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const settings = loadSettings();
  console.log(`figd listening on http://127.0.0.1:${PORT}`);
  console.log("extension token: in ~/.fig/settings.json (never logged) — paste it into the Fig popup once");
  console.log(`spawn target: ${settings.target} (edit ${SETTINGS_PATH})`);
});
