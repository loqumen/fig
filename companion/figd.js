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
//
// Speed protocol (2026-07-30): for HTML jobs figd pre-copies snapshot.html
// to edited.html and the prompt asks for TARGETED Edit operations, so
// generation output scales with the size of the changes, not the page.
// Because edited.html therefore exists from t=0, job completion is tracked
// in .fig-state.json (written by figd on claude's exit), never inferred
// from edited.html's existence. Jobs without a state file are legacy jobs
// and keep the old existence semantics.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const PORT = Number(process.env.FIG_PORT) || 41414;
const FIG_HOME = path.join(os.homedir(), ".fig");
const JOBS = path.join(FIG_HOME, "jobs");
const SETTINGS_PATH = path.join(FIG_HOME, "settings.json");
const STATE = ".fig-state.json";

fs.mkdirSync(JOBS, { recursive: true });

// Generation tool grant. Read/Write/Edit do the page work; WebFetch/WebSearch
// + curl-only Bash let a marking like "use the ACTUAL logo from x.com" be
// satisfied with the real asset (2026-07-30: a logo marking failed honestly
// because every network tool was denied). curl is the ONLY Bash allowed —
// trade-off stated in CLAUDE.md: marked-up page content is prompt input, so
// network tools widen the injection surface; the grant stays this narrow.
const CLAUDE_ARGS = ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit,WebFetch,WebSearch,Bash(curl:*)"];
const CLAUDE_ARGS_LEGACY = ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Write,Edit"];

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { /* first run */ }
  let dirty = false;
  if (!s.token) { s.token = crypto.randomBytes(16).toString("hex"); dirty = true; }
  if (!s.target) { s.target = "localhost"; dirty = true; } // "localhost" | "vercel"
  if (!s.vercelDir) { s.vercelDir = path.join(os.homedir(), "Desktop", "edits"); dirty = true; }
  if (!s.claudeArgs) { s.claudeArgs = CLAUDE_ARGS; dirty = true; }
  // Migrate a stored copy of the old default; hand-customized args are kept.
  else if (JSON.stringify(s.claudeArgs) === JSON.stringify(CLAUDE_ARGS_LEGACY)) { s.claudeArgs = CLAUDE_ARGS; dirty = true; }
  if (dirty) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  return s;
}

// Second-resolution stamp + random suffix: two Figs on the same page in the
// same minute used to collide into ONE job dir (the second dispatch
// overwrote the first mid-generation).
function slugify(title) {
  const base = (title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  const stamp = new Date().toISOString().slice(5, 19).replace(/[^0-9]/g, "");
  let slug = `${base}-${stamp}`;
  while (fs.existsSync(path.join(JOBS, slug))) {
    slug = `${base}-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
  }
  return slug;
}

function readState(jobDir) {
  try { return JSON.parse(fs.readFileSync(path.join(jobDir, STATE), "utf8")); }
  catch { return null; }
}

function writeState(jobDir, patch) {
  const cur = readState(jobDir) || {};
  const next = { ...cur, ...patch };
  fs.writeFileSync(path.join(jobDir, STATE), JSON.stringify(next, null, 2));
  return next;
}

const fileHash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

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
    lines.push("Files in this directory: edited.html (an exact copy of the captured page — this is the file you change), snapshot.html (the untouched capture, for reference), annotations.json (the full markings data).");
  }
  lines.push("");
  lines.push("The markings and what each means:");
  if (a.comments.length) {
    lines.push("");
    lines.push("COMMENTS (each is an instruction anchored to a spot; replies refine or extend the instruction):");
    a.comments.forEach((c) => {
      const anchor = c.page
        ? `page ${c.page} at rx=${c.rx}, ry=${c.ry}`
        : `\`${c.targetPath}\` (element text starts: "${c.targetText}")`;
      lines.push(`- [${c.n}] "${c.text}" — anchored to ${anchor}`);
      (c.replies || []).forEach((r) => lines.push(`  - reply: "${String(r).slice(0, 300)}"`));
    });
  }
  if (a.highlights.length) {
    lines.push("");
    lines.push(isPdf
      ? "HIGHLIGHTS (flagged text in the document). A note, when present, says what to do; a highlight with no note means the text is wrong or needs rework, use judgment:"
      : "HIGHLIGHTS (flagged text; in edited.html each is wrapped in <mark data-fig-highlight>). A note, when present, says what to do; a highlight with no note means the text is wrong or needs rework, use judgment:");
    a.highlights.forEach((h) => {
      lines.push(`- "${h.text.slice(0, 160)}"${h.page ? ` (page ${h.page})` : ""}${h.note ? ` — note: "${h.note}"` : ""}`);
      (h.replies || []).forEach((r) => lines.push(`  - reply: "${String(r).slice(0, 300)}"`));
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
    lines.push("- edited.html already IS the page. Read it, then apply the markings with TARGETED Edit operations on edited.html. Do NOT rewrite the whole file and do NOT use Write on it — everything not covered by a marking (styling, layout, the <base> tag) must survive byte-for-byte.");
    lines.push("- Remove each <mark data-fig-highlight> wrapper as you apply its change (apply the change, drop the marker).");
  }
  lines.push("- If a marking calls for a real asset from the web (a logo, an image, a brand mark), GET THE REAL ONE: use WebFetch to locate it on the named site and curl to download it into this directory. Embed it in edited.html as inline SVG or a data: URI — never as a local file path (the page is served standalone) and never a hand-drawn or typographic look-alike. If the real asset truly cannot be fetched, keep a labeled placeholder and say so in a fig-question comment.");
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
  const fail = (msg) => {
    fs.writeFileSync(path.join(jobDir, "error.txt"), msg);
    writeState(jobDir, { phase: "error", error: msg, finishedAt: new Date().toISOString() });
  };
  child.on("error", (e) => fail("Could not launch claude CLI: " + e.message));
  child.on("exit", (code) => {
    const st = readState(jobDir) || {};
    const edited = path.join(jobDir, "edited.html");
    if (!fs.existsSync(edited)) {
      fail(`claude exited ${code} without producing edited.html (see gen.log)`);
      return;
    }
    // HTML jobs start from a pre-copied edited.html — "exists" proves
    // nothing. Done means the file actually changed from its base hash.
    if (st.baseHash && fileHash(edited) === st.baseHash) {
      fail(`claude exited ${code} without changing the page (see gen.log)`);
      return;
    }
    writeState(jobDir, { phase: "done", finishedAt: new Date().toISOString() });
    if (fs.existsSync(path.join(jobDir, "source.pdf"))) printPdf(jobDir);
    const settingsNow = loadSettings();
    if (settingsNow.target === "vercel") deployToVercel(jobDir, settingsNow);
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

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Revealable change log, injected at serve/deploy time so edited.html stays
// clean (the PDF export reads the raw file and never carries the widget).
// Hidden by default; a small pill toggles it.
function injectChangelog(jobDir, html) {
  const p = path.join(jobDir, "changes.json");
  if (!fs.existsSync(p)) return html;
  let items;
  try { items = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return html; }
  if (!Array.isArray(items) || !items.length) return html;
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

// The generating page: the fig-branch growth animation (the approved badge
// leaf, verbatim from mark/fig-badge.svg) wired to live job state. SSE
// pushes "done"/"error" the moment figd records it — the redirect to the
// finished page is instant instead of waiting out a refresh interval; a 1.5s
// poll is the fallback when EventSource drops.
function generatingPage(slug, st) {
  const marks = st.marks || {};
  const total = (marks.comments || 0) + (marks.highlights || 0) + (marks.strokes || 0);
  const what = total
    ? `Applying ${total} marking${total === 1 ? "" : "s"} to “${esc(st.title || "the page")}”`
    : `Applying the markings to “${esc(st.title || "the page")}”`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fig — generating</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  body {
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    font-weight: 300;
    background: #fafaf8;
    color: #1a1a1a;
    max-width: 640px;
    margin: 48px auto 0;
    padding: 0 24px;
    line-height: 1.7;
    text-align: center;
  }
  h1 { font-size: 20px; font-weight: 400; margin: 8px 0 4px; }
  .muted { color: #4a4a46; font-size: 14px; margin: 0; }
  .elapsed { color: #9a9790; font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .scene { width: 340px; height: 340px; margin: 0 auto; }
  #wrap { transition: opacity 0.2s ease; }

  .grow { animation: cycle 10s linear infinite; }
  @keyframes cycle {
    0%, 94% { opacity: 1; }
    98%, 100% { opacity: 0; }
  }
  .sway {
    transform-origin: 60px 300px;
    animation: sway 5s ease-in-out infinite alternate;
  }
  @keyframes sway {
    from { transform: rotate(-0.7deg); }
    to { transform: rotate(1deg); }
  }
  .branch, .twig {
    fill: none;
    stroke: #2C9F28;
    stroke-linecap: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
  }
  .branch { stroke-width: 7; animation: draw-branch 10s linear infinite; }
  .twig { stroke-width: 4; }
  @keyframes draw-branch {
    0% { stroke-dashoffset: 1; }
    32% { stroke-dashoffset: 0; }
    100% { stroke-dashoffset: 0; }
  }
  .t1 { animation: draw-t1 10s linear infinite; }
  @keyframes draw-t1 {
    0%, 11.9% { stroke-dashoffset: 1; opacity: 0; }
    12% { stroke-dashoffset: 1; opacity: 1; }
    22% { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  .t2 { animation: draw-t2 10s linear infinite; }
  @keyframes draw-t2 {
    0%, 21.9% { stroke-dashoffset: 1; opacity: 0; }
    22% { stroke-dashoffset: 1; opacity: 1; }
    32% { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  .t3 { animation: draw-t3 10s linear infinite; }
  @keyframes draw-t3 {
    0%, 29.9% { stroke-dashoffset: 1; opacity: 0; }
    30% { stroke-dashoffset: 1; opacity: 1; }
    40% { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  .pop {
    fill: #2C9F28;
    transform-box: fill-box;
    transform-origin: 50% 100%;
  }
  .p1 { animation: pop1 10s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes pop1 { 0%, 24% { transform: scale(0); } 30% { transform: scale(1.1); } 33%, 100% { transform: scale(1); } }
  .p2 { animation: pop2 10s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes pop2 { 0%, 32% { transform: scale(0); } 38% { transform: scale(1.1); } 41%, 100% { transform: scale(1); } }
  .p3 { animation: pop3 10s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes pop3 { 0%, 40% { transform: scale(0); } 46% { transform: scale(1.1); } 49%, 100% { transform: scale(1); } }
  .p4 { animation: pop4 10s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes pop4 { 0%, 48% { transform: scale(0); } 54% { transform: scale(1.1); } 57%, 100% { transform: scale(1); } }
  .p5 { animation: pop5 10s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes pop5 { 0%, 56% { transform: scale(0); } 62% { transform: scale(1.1); } 64%, 100% { transform: scale(1); } }

  .dots span {
    display: inline-block;
    animation: dot 1.8s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.3s; }
  .dots span:nth-child(3) { animation-delay: 0.6s; }
  @keyframes dot { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }

  .calm {
    position: fixed; right: 16px; bottom: 12px;
    font-size: 11px; color: #9a9790; background: none; border: none;
    font-family: inherit; cursor: pointer; text-decoration: underline;
    text-underline-offset: 3px;
  }
  html.paused * { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
  }
</style></head>
<body>
  <div id="wrap">
  <svg class="scene" viewBox="0 0 400 400" aria-hidden="true">
    <defs>
      <path id="figleaf" d="M 288.20 275.25 C 289.92 275.08 291.69 275.13 293.44 275.25 C 295.18 275.38 296.98 275.62 298.67 275.99 C 300.37 276.36 301.98 276.94 303.61 277.47 C 305.23 278.00 306.86 278.55 308.44 279.19 C 310.02 279.83 311.55 280.60 313.10 281.32 C 314.65 282.05 316.22 282.72 317.72 283.54 C 319.23 284.37 320.70 285.29 322.14 286.26 C 323.59 287.24 324.99 288.32 326.39 289.40 C 327.79 290.48 329.17 291.60 330.54 292.75 C 331.91 293.90 333.31 295.08 334.62 296.30 C 335.92 297.52 337.19 298.75 338.38 300.07 C 339.58 301.39 340.70 302.81 341.78 304.21 C 342.87 305.61 343.89 307.03 344.89 308.47 C 345.88 309.90 346.87 311.34 347.76 312.82 C 348.66 314.30 349.49 315.80 350.26 317.33 C 351.02 318.86 351.73 320.42 352.38 322.00 C 353.03 323.58 353.62 325.18 354.15 326.81 C 354.68 328.44 355.20 330.07 355.57 331.76 C 355.95 333.46 356.27 335.22 356.41 336.96 C 356.55 338.70 356.57 340.47 356.41 342.20 C 356.26 343.92 355.93 345.66 355.48 347.31 C 355.03 348.97 354.46 350.58 353.71 352.12 C 352.96 353.66 352.05 355.20 351.00 356.54 C 349.95 357.88 348.73 359.12 347.38 360.16 C 346.04 361.20 344.50 362.11 342.92 362.77 C 341.35 363.43 339.64 363.84 337.94 364.13 C 336.24 364.42 334.48 364.51 332.72 364.50 C 330.96 364.49 329.13 364.34 327.39 364.09 C 325.66 363.83 323.97 363.20 322.31 362.98 C 320.64 362.75 318.88 362.52 317.41 362.74 C 315.94 362.95 314.65 363.41 313.47 364.28 C 312.29 365.16 311.33 366.65 310.33 367.99 C 309.33 369.34 308.50 370.94 307.46 372.35 C 306.41 373.76 305.31 375.21 304.04 376.45 C 302.78 377.68 301.33 378.81 299.87 379.76 C 298.42 380.71 296.92 381.56 295.31 382.14 C 293.71 382.72 291.95 383.07 290.23 383.25 C 288.51 383.44 286.71 383.44 284.99 383.25 C 283.27 383.07 281.52 382.72 279.91 382.14 C 278.29 381.57 276.79 380.75 275.32 379.82 C 273.86 378.89 272.44 377.76 271.13 376.56 C 269.81 375.36 268.57 373.99 267.43 372.63 C 266.29 371.26 265.21 369.85 264.29 368.38 C 263.38 366.91 262.67 365.36 261.94 363.81 C 261.22 362.26 260.55 360.69 259.96 359.09 C 259.37 357.48 258.89 355.83 258.39 354.19 C 257.89 352.55 257.40 350.91 256.98 349.23 C 256.55 347.56 256.17 345.87 255.87 344.15 C 255.56 342.43 255.31 340.68 255.13 338.91 C 254.94 337.14 254.82 335.34 254.76 333.52 C 254.69 331.70 254.69 329.80 254.76 327.97 C 254.82 326.15 254.94 324.35 255.13 322.58 C 255.31 320.81 255.56 319.07 255.87 317.34 C 256.17 315.62 256.58 313.95 256.98 312.26 C 257.37 310.57 257.76 308.89 258.21 307.23 C 258.66 305.57 259.14 303.91 259.69 302.30 C 260.24 300.68 260.84 299.07 261.54 297.52 C 262.24 295.96 263.04 294.44 263.89 292.95 C 264.75 291.45 265.65 289.98 266.67 288.55 C 267.70 287.13 268.83 285.69 270.03 284.42 C 271.24 283.14 272.53 281.96 273.91 280.91 C 275.29 279.87 276.78 278.92 278.31 278.15 C 279.84 277.38 281.44 276.78 283.09 276.30 C 284.73 275.82 286.47 275.43 288.20 275.25 Z"/>
    </defs>
    <g class="grow">
      <g class="sway">
        <path class="branch" pathLength="1"
          d="M 60 352 C 110 330, 150 296, 186 254 S 258 158, 330 108"/>
        <path class="twig t1" pathLength="1" d="M 148 300 C 134 286, 124 268, 120 250"/>
        <path class="twig t2" pathLength="1" d="M 214 220 C 230 214, 248 212, 262 216"/>
        <path class="twig t3" pathLength="1" d="M 282 148 C 274 132, 270 114, 270 100"/>
        <g class="pop p1"><use href="#figleaf" transform="translate(120,252) rotate(-44) scale(0.44) translate(-305.7,-380)"/></g>
        <g class="pop p2"><ellipse cx="178" cy="246" rx="12" ry="17" transform="rotate(9 178 262)"/></g>
        <g class="pop p3"><use href="#figleaf" transform="translate(263,217) rotate(48) scale(0.38) translate(-305.7,-380)"/></g>
        <g class="pop p4"><ellipse cx="269" cy="82" rx="13" ry="18" transform="rotate(-7 269 98)"/></g>
        <g class="pop p5"><ellipse cx="336" cy="92" rx="14" ry="19" transform="rotate(7 336 110)"/></g>
      </g>
    </g>
  </svg>
  <h1>Fig is generating<span class="dots"><span>.</span><span>.</span><span>.</span></span></h1>
  <p class="muted">${what}</p>
  <p class="elapsed" id="elapsed"></p>
  </div>
  <button class="calm" onclick="document.documentElement.classList.toggle('paused')">Pause</button>
<script>
(function () {
  var slug = ${JSON.stringify(slug)};
  var startedAt = ${JSON.stringify(st.startedAt || null)};
  var t0 = startedAt ? new Date(startedAt).getTime() : Date.now();
  var el = document.getElementById("elapsed");
  setInterval(function () {
    var s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
    el.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 1000);

  var finished = false;
  function finish(phase) {
    if (finished) return;
    finished = true;
    if (phase === "done") {
      document.getElementById("wrap").style.opacity = "0";
      setTimeout(function () { location.replace("/pages/" + slug + "/"); }, 180);
    } else {
      location.reload(); // figd serves the error page once state is error
    }
  }
  function check(state) {
    if (state && (state.phase === "done" || state.phase === "error")) finish(state.phase);
  }

  // Push: instant. Poll: safety net.
  try {
    var es = new EventSource("/jobs/" + slug + "/events");
    es.onmessage = function (e) {
      try { check(JSON.parse(e.data)); } catch (err) { /* heartbeat */ }
    };
  } catch (e) { /* fall through to polling */ }
  setInterval(function () {
    fetch("/jobs/" + slug + "/state").then(function (r) { return r.json(); }).then(check).catch(function () {});
  }, 1500);
})();
</script>
</body></html>`;
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

// Effective job status, tolerant of legacy jobs from before the state
// protocol (no .fig-state.json): there, edited.html existing means done.
function jobPhase(jobDir) {
  const st = readState(jobDir);
  if (st && st.phase) return st;
  if (fs.existsSync(path.join(jobDir, "error.txt"))) {
    return { phase: "error", error: fs.readFileSync(path.join(jobDir, "error.txt"), "utf8"), legacy: true };
  }
  if (fs.existsSync(path.join(jobDir, "edited.html"))) return { phase: "done", legacy: true };
  return { phase: "generating", legacy: true };
}

async function handle(req, res) {
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
    // Validate the payload shape instead of crashing on it mid-handler: a
    // malformed dispatch (extension bug, stray local client) used to throw
    // in buildPrompt and take the whole daemon down with it.
    const bad = (msg) => {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ error: msg }));
    };
    if (!payload || typeof payload !== "object") return bad("payload is not an object");
    const a = payload.annotations;
    if (!a || typeof a !== "object") return bad("payload.annotations missing");
    a.comments = Array.isArray(a.comments) ? a.comments : [];
    a.highlights = Array.isArray(a.highlights) ? a.highlights : [];
    a.strokes = Array.isArray(a.strokes) ? a.strokes : [];
    const isPdf = payload.type === "pdf";
    if (isPdf && !payload.pdfBase64) return bad("pdf job without pdfBase64");
    if (!isPdf && !(payload.html && payload.html.trim())) return bad("html job with an empty snapshot");

    const slug = slugify(payload.title);
    const jobDir = path.join(JOBS, slug);
    fs.mkdirSync(jobDir, { recursive: true });
    let baseHash = null;
    if (isPdf) {
      fs.writeFileSync(path.join(jobDir, "source.pdf"), Buffer.from(payload.pdfBase64, "base64"));
    } else {
      fs.writeFileSync(path.join(jobDir, "snapshot.html"), payload.html);
      // Pre-copy: generation makes targeted edits to this file instead of
      // rewriting the page, so output scales with the changes.
      fs.writeFileSync(path.join(jobDir, "edited.html"), payload.html);
      baseHash = fileHash(path.join(jobDir, "edited.html"));
    }
    const { html, pdfBase64, ...meta } = payload;
    fs.writeFileSync(path.join(jobDir, "annotations.json"), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(jobDir, "prompt.md"), buildPrompt(slug, payload));
    writeState(jobDir, {
      phase: "generating",
      type: isPdf ? "pdf" : "html",
      title: String(payload.title || "").slice(0, 200),
      startedAt: new Date().toISOString(),
      marks: { comments: a.comments.length, highlights: a.highlights.length, strokes: a.strokes.length },
      ...(baseHash ? { baseHash } : {}),
    });
    runGeneration(jobDir, settings);
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders(req) });
    res.end(JSON.stringify({ job: slug, statusUrl: `http://127.0.0.1:${PORT}/jobs/${slug}/` }));
    return;
  }

  // Job state as JSON (the status page's poll fallback).
  let m = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/state$/);
  if (m) {
    const jobDir = path.join(JOBS, m[1]);
    if (!fs.existsSync(jobDir)) { res.writeHead(404); res.end("no such job"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jobPhase(jobDir)));
    return;
  }

  // Job state as SSE: the moment figd records done/error, the status page
  // hears it and swaps to the result — no refresh interval to wait out.
  m = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/events$/);
  if (m) {
    const jobDir = path.join(JOBS, m[1]);
    if (!fs.existsSync(jobDir)) { res.writeHead(404); res.end("no such job"); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = () => res.write(`data: ${JSON.stringify(jobPhase(jobDir))}\n\n`);
    send();
    let watcher = null;
    try { watcher = fs.watch(jobDir, send); } catch { /* poll covers it */ }
    const heartbeat = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      if (watcher) watcher.close();
    });
    return;
  }

  // Job status page — animated while generating; redirects when done.
  m = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/?$/);
  if (m) {
    const jobDir = path.join(JOBS, m[1]);
    if (!fs.existsSync(jobDir)) { res.writeHead(404); res.end("no such job"); return; }
    const st = jobPhase(jobDir);
    if (st.phase === "done") {
      res.writeHead(302, { Location: `/pages/${m[1]}/` });
      res.end();
      return;
    }
    if (st.phase === "error") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Fig — failed", `<h1>Generation failed</h1><p class="muted">${esc(st.error || "unknown error")}</p><p class="muted"><a href="/">All figs</a></p>`));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generatingPage(m[1], st));
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
        const st = jobPhase(path.join(JOBS, d));
        const done = st.phase === "done";
        const label = st.phase === "error" ? "(failed)" : done ? "" : "(generating)";
        let deploy = "";
        const dp = path.join(JOBS, d, "deploy.txt");
        if (fs.existsSync(dp)) deploy = ` <span class="muted">· ${esc(fs.readFileSync(dp, "utf8"))}</span>`;
        const pdf = fs.existsSync(path.join(JOBS, d, "edited.pdf")) ? ` <a class="muted" href="/pages/${d}/edited.pdf">pdf</a>` : "";
        return `<li><a href="${done ? "/pages/" + d + "/" : "/jobs/" + d + "/"}">${d}</a> <span class="muted">${label}</span>${pdf}${deploy} <a class="muted" href="/pages/${d}/original">original</a></li>`;
      })
      .join("\n");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page("Fig", `<h1>Fig</h1><p class="muted">Target: ${settings.target}</p><ul>${rows || "<li class='muted'>No figs yet</li>"}</ul>`));
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

// A thrown error in a handler answers 500 and keeps the daemon alive — an
// unhandled rejection here used to kill the process (KeepAlive respawn or
// not, every in-flight request died with it).
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    } catch { /* headers already sent */ }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const settings = loadSettings();
  console.log(`figd listening on http://127.0.0.1:${PORT}`);
  console.log("extension token: in ~/.fig/settings.json (never logged) — paste it into the Fig popup once");
  console.log(`spawn target: ${settings.target} (edit ${SETTINGS_PATH})`);
});
