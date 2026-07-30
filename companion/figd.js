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


// The Fig badge as the tab favicon on everything figd serves, including the
// revised page (injected at serve time; edited.html on disk stays clean).
const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221024%22%20height%3D%221024%22%20viewBox%3D%220%200%201024%201024%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22base%22%20x1%3D%220.1349%22%20y1%3D%22-0.0843%22%20x2%3D%220.8651%22%20y2%3D%221.0843%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2348c742%22%2F%3E%3Cstop%20offset%3D%220.52%22%20stop-color%3D%22%232C9F28%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%231c761a%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22bev%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%220.30%22%2F%3E%3Cstop%20offset%3D%220.05%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%220.07%22%2F%3E%3Cstop%20offset%3D%220.55%22%20stop-color%3D%22%23ffffff%22%20stop-opacity%3D%220%22%2F%3E%3Cstop%20offset%3D%220.93%22%20stop-color%3D%22%23000000%22%20stop-opacity%3D%220.10%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23000000%22%20stop-opacity%3D%220.30%22%2F%3E%3C%2FlinearGradient%3E%3Cmask%20id%3D%22knock%22%20maskUnits%3D%22userSpaceOnUse%22%20x%3D%220%22%20y%3D%220%22%20width%3D%221024%22%20height%3D%221024%22%3E%3Crect%20width%3D%221024%22%20height%3D%221024%22%20fill%3D%22%23000%22%2F%3E%3Cg%20transform%3D%22translate%28152%2C152%29%20scale%281.5%29%22%3E%3Ccircle%20cx%3D%22240%22%20cy%3D%22240%22%20r%3D%22208%22%20fill%3D%22%23fff%22%2F%3E%3Cg%20transform%3D%22translate%2870%2C410%29%20rotate%28-45%29%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M%209.0%20-31.7%20L%20323.0%20-15.9%20Q%20330.0%20-15.5%20330.0%20-8.5%20L%20330.0%208.5%20Q%20330.0%2015.5%20323.0%2015.9%20L%209.0%2031.7%20Q%200.0%2032.0%200.0%2023.0%20L%200.0%20-23.0%20Q%200.0%20-32.0%209.0%20-31.7%20Z%22%2F%3E%3C%2Fg%3E%3Cellipse%20cx%3D%22235%22%20cy%3D%22123%22%20rx%3D%2236%22%20ry%3D%2253%22%20fill%3D%22%23000%22%20transform%3D%22rotate%287%20235%20123%29%22%2F%3E%3Cpath%20d%3D%22M%20288.20%20275.25%20C%20289.92%20275.08%20291.69%20275.13%20293.44%20275.25%20C%20295.18%20275.38%20296.98%20275.62%20298.67%20275.99%20C%20300.37%20276.36%20301.98%20276.94%20303.61%20277.47%20C%20305.23%20278.00%20306.86%20278.55%20308.44%20279.19%20C%20310.02%20279.83%20311.55%20280.60%20313.10%20281.32%20C%20314.65%20282.05%20316.22%20282.72%20317.72%20283.54%20C%20319.23%20284.37%20320.70%20285.29%20322.14%20286.26%20C%20323.59%20287.24%20324.99%20288.32%20326.39%20289.40%20C%20327.79%20290.48%20329.17%20291.60%20330.54%20292.75%20C%20331.91%20293.90%20333.31%20295.08%20334.62%20296.30%20C%20335.92%20297.52%20337.19%20298.75%20338.38%20300.07%20C%20339.58%20301.39%20340.70%20302.81%20341.78%20304.21%20C%20342.87%20305.61%20343.89%20307.03%20344.89%20308.47%20C%20345.88%20309.90%20346.87%20311.34%20347.76%20312.82%20C%20348.66%20314.30%20349.49%20315.80%20350.26%20317.33%20C%20351.02%20318.86%20351.73%20320.42%20352.38%20322.00%20C%20353.03%20323.58%20353.62%20325.18%20354.15%20326.81%20C%20354.68%20328.44%20355.20%20330.07%20355.57%20331.76%20C%20355.95%20333.46%20356.27%20335.22%20356.41%20336.96%20C%20356.55%20338.70%20356.57%20340.47%20356.41%20342.20%20C%20356.26%20343.92%20355.93%20345.66%20355.48%20347.31%20C%20355.03%20348.97%20354.46%20350.58%20353.71%20352.12%20C%20352.96%20353.66%20352.05%20355.20%20351.00%20356.54%20C%20349.95%20357.88%20348.73%20359.12%20347.38%20360.16%20C%20346.04%20361.20%20344.50%20362.11%20342.92%20362.77%20C%20341.35%20363.43%20339.64%20363.84%20337.94%20364.13%20C%20336.24%20364.42%20334.48%20364.51%20332.72%20364.50%20C%20330.96%20364.49%20329.13%20364.34%20327.39%20364.09%20C%20325.66%20363.83%20323.97%20363.20%20322.31%20362.98%20C%20320.64%20362.75%20318.88%20362.52%20317.41%20362.74%20C%20315.94%20362.95%20314.65%20363.41%20313.47%20364.28%20C%20312.29%20365.16%20311.33%20366.65%20310.33%20367.99%20C%20309.33%20369.34%20308.50%20370.94%20307.46%20372.35%20C%20306.41%20373.76%20305.31%20375.21%20304.04%20376.45%20C%20302.78%20377.68%20301.33%20378.81%20299.87%20379.76%20C%20298.42%20380.71%20296.92%20381.56%20295.31%20382.14%20C%20293.71%20382.72%20291.95%20383.07%20290.23%20383.25%20C%20288.51%20383.44%20286.71%20383.44%20284.99%20383.25%20C%20283.27%20383.07%20281.52%20382.72%20279.91%20382.14%20C%20278.29%20381.57%20276.79%20380.75%20275.32%20379.82%20C%20273.86%20378.89%20272.44%20377.76%20271.13%20376.56%20C%20269.81%20375.36%20268.57%20373.99%20267.43%20372.63%20C%20266.29%20371.26%20265.21%20369.85%20264.29%20368.38%20C%20263.38%20366.91%20262.67%20365.36%20261.94%20363.81%20C%20261.22%20362.26%20260.55%20360.69%20259.96%20359.09%20C%20259.37%20357.48%20258.89%20355.83%20258.39%20354.19%20C%20257.89%20352.55%20257.40%20350.91%20256.98%20349.23%20C%20256.55%20347.56%20256.17%20345.87%20255.87%20344.15%20C%20255.56%20342.43%20255.31%20340.68%20255.13%20338.91%20C%20254.94%20337.14%20254.82%20335.34%20254.76%20333.52%20C%20254.69%20331.70%20254.69%20329.80%20254.76%20327.97%20C%20254.82%20326.15%20254.94%20324.35%20255.13%20322.58%20C%20255.31%20320.81%20255.56%20319.07%20255.87%20317.34%20C%20256.17%20315.62%20256.58%20313.95%20256.98%20312.26%20C%20257.37%20310.57%20257.76%20308.89%20258.21%20307.23%20C%20258.66%20305.57%20259.14%20303.91%20259.69%20302.30%20C%20260.24%20300.68%20260.84%20299.07%20261.54%20297.52%20C%20262.24%20295.96%20263.04%20294.44%20263.89%20292.95%20C%20264.75%20291.45%20265.65%20289.98%20266.67%20288.55%20C%20267.70%20287.13%20268.83%20285.69%20270.03%20284.42%20C%20271.24%20283.14%20272.53%20281.96%20273.91%20280.91%20C%20275.29%20279.87%20276.78%20278.92%20278.31%20278.15%20C%20279.84%20277.38%20281.44%20276.78%20283.09%20276.30%20C%20284.73%20275.82%20286.47%20275.43%20288.20%20275.25%20Z%22%20fill%3D%22%23000%22%20transform%3D%22translate%28-4.95%2C-4.95%29%22%2F%3E%3C%2Fg%3E%3C%2Fmask%3E%3C%2Fdefs%3E%3Crect%20width%3D%221024%22%20height%3D%221024%22%20rx%3D%22232%22%20fill%3D%22url%28%23base%29%22%2F%3E%3Crect%20width%3D%221024%22%20height%3D%221024%22%20rx%3D%22232%22%20fill%3D%22url%28%23bev%29%22%2F%3E%3Crect%20width%3D%221024%22%20height%3D%221024%22%20fill%3D%22%23ffffff%22%20mask%3D%22url%28%23knock%29%22%2F%3E%3C%2Fsvg%3E";
const FAV_TAG = `<link rel="icon" type="image/svg+xml" href="${FAVICON}">`;
function injectFavicon(html) {
  if (/rel="icon"[^>]*svg\+xml/.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + FAV_TAG);
  return FAV_TAG + html;
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
  lines.push("- If a marking calls for a real asset from the web (a logo, an image, a brand mark), GET THE REAL ONE: WebFetch the named site and read its HTML for the asset (the header/footer logo <img>, srcset, og:image, or CDN url() references), then curl the file into this directory. Prefer SVG over PNG, the variant designed for the page's background (a light page gets the on-light/dark-text version), and the largest resolution served — never a thumbnail. Embed it in edited.html as inline SVG or a data: URI — never as a local file path (the page is served standalone) and never a hand-drawn or typographic look-alike. If the real asset truly cannot be fetched, keep a labeled placeholder and say so in a fig-question comment.");
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
  // Stream claude's activity so the status page can narrate it live. Only
  // added when the args don't already pick an output format (custom setups
  // keep their behavior; the parser below tolerates plain text silently).
  const args = ["-p", prompt, ...settings.claudeArgs];
  if (!settings.claudeArgs.includes("--output-format")) {
    args.push("--output-format", "stream-json", "--verbose");
  }
  const child = spawn(claudeBin(), args, {
    cwd: jobDir,
    stdio: ["ignore", "pipe", log],
    env: { ...process.env, PATH: [process.env.PATH, path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":") },
  });

  // Translate the event stream to short plain-English status lines, written
  // into job state — the SSE channel pushes each one to the status page.
  const ctr = { edits: 0 };
  const rl = require("readline").createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try { fs.writeSync(log, line + "\n"); } catch { /* log closed */ }
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const status = statusFromEvent(ev, ctr);
    if (status) {
      const cur = readState(jobDir);
      if (!cur || cur.status !== status) writeState(jobDir, { status });
    }
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
    if (settingsNow.target === "vercel") deployToVercel(jobDir, settingsNow); // legacy edits-project mode
    else if (settingsNow.target === "linked") publishToLinked(jobDir);
  });
}

// One stream event -> one short plain-English line, or null to keep the last.
// Assistant narration wins (it names the specific change); tool calls give
// the reliable skeleton when there is no narration.
function statusFromEvent(ev, ctr) {
  if (ev.type !== "assistant" || !ev.message || !Array.isArray(ev.message.content)) return null;
  let toolLine = null;
  for (const b of ev.message.content) {
    if (b.type === "text" && b.text) {
      const line = b.text.trim().split("\n")[0].replace(/[*_`#]/g, "").trim();
      if (line.length >= 8) return line.length > 90 ? line.slice(0, 87) + "…" : line;
    }
    if (b.type === "tool_use" && !toolLine) {
      const inp = b.input || {};
      const f = String(inp.file_path || "").split("/").pop();
      switch (b.name) {
        case "Read":
          toolLine = f === "annotations.json" ? "Reading the markings…"
            : f === "snapshot.html" || f === "edited.html" ? "Reading the captured page…"
            : f === "source.pdf" ? "Reading the PDF…" : `Reading ${f || "a file"}…`;
          break;
        case "Edit":
        case "MultiEdit":
          ctr.edits += 1;
          toolLine = `Applying change ${ctr.edits}…`;
          break;
        case "Write":
          toolLine = f === "changes.json" ? "Writing the change log…" : `Writing ${f || "a file"}…`;
          break;
        case "WebFetch":
          try { toolLine = `Looking at ${new URL(inp.url).hostname}…`; }
          catch { toolLine = "Looking something up…"; }
          break;
        case "WebSearch": toolLine = "Searching the web…"; break;
        case "Bash": toolLine = /\bcurl\b/.test(inp.command || "") ? "Downloading an asset…" : "Running a command…"; break;
      }
    }
  }
  return toolLine;
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

// Deploy the revised page to the shared edits project. With the review
// overlay (default on), the deployed page carries the /fig skill's shared
// comment system — pins, highlights, draw — backed by the project's
// /api/comments store, so teammates leave feedback on the SAME page from a
// plain URL, no install. The overlay is injected by the canonical
// build-overlay.py (sentinel split, stabilizer CSS, load-time init — rules
// that each carry failure history live THERE, not re-implemented here).
// data-fig-version is the job slug, so comments persist across redeploys.
const { injectOverlay } = require("./inject-overlay.js");
const PUBLISH_STATE = path.join(FIG_HOME, "publish.json");
const PIN = { cloudflare: "wrangler@4.112.0", vercel: "vercel@56.3.2" };

function publishState() {
  try { return JSON.parse(fs.readFileSync(PUBLISH_STATE, "utf8")); } catch { return null; }
}

// Publish a finished job to the user's LINKED review site (BYO hosting:
// their own Cloudflare or Vercel account, scaffolded by fig-link.js).
function publishToLinked(jobDir) {
  const ps = publishState();
  if (!ps || ps.status !== "linked" || !ps.dir) return;
  try {
    const slug = path.basename(jobDir);
    let html = injectFavicon(injectChangelog(jobDir, fs.readFileSync(path.join(jobDir, "edited.html"), "utf8")));
    html = injectOverlay(html, { version: slug, clearMine: true });
    const dest = path.join(ps.dir, "public", slug);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "index.html"), html);
    const args = ps.provider === "cloudflare"
      ? ["--yes", PIN.cloudflare, "deploy"]
      : ["--yes", PIN.vercel, "deploy", "--prod", "--yes"];
    execFile("npx", args, { cwd: ps.dir }, (err, stdout) => {
      const url = ps.url ? `${ps.url.replace(/\/$/, "")}/${slug}/` : "";
      fs.writeFileSync(
        path.join(jobDir, "deploy.txt"),
        err ? "Publish failed: " + String(err.message).slice(0, 300)
            : `Published: ${url} \u00b7 team review comments enabled`
      );
    });
  } catch (e) {
    fs.writeFileSync(path.join(jobDir, "deploy.txt"), "Publish failed: " + e.message);
  }
}

const BUILD_OVERLAY = path.join(os.homedir(), "CLAUDE/tools/fig/build-overlay.py");
const EDITS_DIR_DEFAULT = path.join(os.homedir(), "Desktop", "edits");

function deployToVercel(jobDir, settings) {
  try {
    const slug = path.basename(jobDir);
    const html = injectFavicon(injectChangelog(jobDir, fs.readFileSync(path.join(jobDir, "edited.html"), "utf8")));
    const src = path.join(jobDir, "deploy-src.html");
    fs.writeFileSync(src, html);

    const runVercel = (note) => {
      execFile("vercel", ["--prod"], { cwd: settings.vercelDir }, (err, stdout) => {
        fs.writeFileSync(
          path.join(jobDir, "deploy.txt"),
          err ? "Deploy failed: " + err.message
              : "Deployed: " + (stdout || "").trim().split("\n").pop() + note
        );
      });
    };

    // The overlay builder writes to ~/Desktop/edits/public/<slug>/ by design;
    // only route through it when that IS the deploy target.
    const wantOverlay = settings.reviewOverlay !== false
      && settings.vercelDir === EDITS_DIR_DEFAULT
      && fs.existsSync(BUILD_OVERLAY);
    if (!wantOverlay) {
      const dest = path.join(settings.vercelDir, "public", slug);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "index.html"), html);
      runVercel("");
      return;
    }
    execFile("python3", [BUILD_OVERLAY, src, slug, "--version", slug, "--clear-mine"], (err) => {
      if (err) {
        // fall back to a plain copy rather than losing the deploy
        const dest = path.join(settings.vercelDir, "public", slug);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "index.html"), html);
        runVercel(" (review overlay skipped: " + String(err.message || err).slice(0, 120) + ")");
        return;
      }
      runVercel(" · team review comments enabled");
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
  let current = [];
  try { current = JSON.parse(fs.readFileSync(path.join(jobDir, "changes.json"), "utf8")); } catch { /* none */ }
  if (!Array.isArray(current)) current = [];
  let history = [];
  try { history = JSON.parse(fs.readFileSync(path.join(jobDir, "history.json"), "utf8")); } catch { /* first round */ }
  if (!Array.isArray(history)) history = [];
  const rounds = [...history.map((h) => h.changes), current].filter((r) => Array.isArray(r) && r.length);
  if (!rounds.length) return html;
  const multi = rounds.length > 1;
  let n = 0;
  const blocks = rounds.map((changes, ri) => {
    const label = multi
      ? `<li style="padding:12px 0 2px;${ri ? "box-shadow:0 -1px 0 #e8e6e1;" : ""}"><span style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#9a9790;">Round ${ri + 1}${ri === rounds.length - 1 ? " · latest" : ""}</span></li>`
      : "";
    const rows = changes.map((c, i) => {
      n += 1;
      return `
    <li style="display:flex;gap:10px;padding:10px 0;align-items:flex-start;${(i || multi) ? "" : (n > 1 ? "box-shadow:0 -1px 0 #e8e6e1;" : "")}">
      <span style="flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#2C9F28;color:#fafaf8;font-size:11px;display:flex;align-items:center;justify-content:center;">${n}</span>
      <span style="display:block;min-width:0;">
        <span style="display:block;color:#1a1a1a;">${esc(c.change)}</span>
        ${c.marking ? `<span style="display:block;color:#9a9790;font-size:11px;margin-top:2px;">marking: ${esc(c.marking)}</span>` : ""}
        ${c.where ? `<span style="display:block;color:#9a9790;font-size:11px;">${esc(c.where)}</span>` : ""}
      </span>
    </li>`;
    }).join("");
    return label + rows;
  }).join("");
  const widget = `
<!--fig-changelog-start-->
<div id="fig-changelog" data-fig-ui="1" style="position:fixed;left:24px;bottom:24px;z-index:2147483000;font-family:'DM Sans',-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.5;">
  <div id="fig-changelog-panel" style="display:none;width:340px;max-height:55vh;overflow:auto;background:#fafaf8;color:#1a1a1a;border:1px solid #e8e6e1;border-radius:12px;box-shadow:0 6px 24px rgba(26,26,26,.18);padding:14px 16px;margin:0 0 10px;">
    <div style="font-weight:500;margin-bottom:2px;">What changed${multi ? ` <span style="color:#9a9790;font-weight:300;">· ${rounds.length} rounds</span>` : ""}</div>
    <ul style="list-style:none;margin:0;padding:0;">${blocks}</ul>
  </div>
  <button id="fig-changelog-btn" type="button" style="border:none;cursor:pointer;background:#2C9F28;color:#fafaf8;border-radius:9px;padding:9px 16px;font-family:inherit;font-size:13px;box-shadow:0 4px 16px rgba(26,26,26,.2);">Changes · ${n}</button>
</div>
<script>(function(){var b=[...document.querySelectorAll("#fig-changelog-btn")].pop(),p=[...document.querySelectorAll("#fig-changelog-panel")].pop();b.addEventListener("click",function(){p.style.display=p.style.display==="none"?"block":"none";});})();</script>
<!--fig-changelog-end-->`;
  html = stripChangelogBlocks(html);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, widget + "\n</body>") : html + widget;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">${FAV_TAG}<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#fafaf8;color:#1a1a1a;max-width:640px;margin:80px auto;padding:0 24px;line-height:1.7}
a{color:#2C9F28}h1{font-size:20px;font-weight:600}.muted{color:#4a4a46}</style></head><body>${body}</body></html>`;
}

// The generating page: the approved loading design (companion/loading-demo.html
// is the reference). The Fig badge assembles — ring draws, branch grows,
// fruit + leaf pop — while the status line narrates the generation live from
// the stream (SSE push, poll fallback). On done, NO auto-redirect: the mark
// freezes fully drawn and a "View revised page" button appears; the whole
// flow stays in this one tab.
function generatingPage(slug, st) {
  const marks = st.marks || {};
  const total = (marks.comments || 0) + (marks.highlights || 0) + (marks.strokes || 0);
  const initial = st.status || (total
    ? `Applying ${total} marking${total === 1 ? "" : "s"} to \u201C${esc(st.title || "the page")}\u201D\u2026`
    : "Getting started\u2026");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${FAV_TAG}<title>Fig \u2014 generating</title>
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
  h1 { font-size: 20px; font-weight: 400; margin: 10px 0 2px; }
  .scene { width: 300px; height: 300px; margin: 0 auto; }

  /* One shared 9s clock. Ring draws 0-26%, branch grows 30-48%, fruit pops
     52-60%, leaf pops 62-70%, hold to 90%, breathe out, restart. */
  .cycle { animation: cycle 9s linear infinite; }
  @keyframes cycle {
    0%, 91% { opacity: 1; }
    /* hold 0 through the wrap: the restart snaps opacity back while every
       shape is at its EMPTY start state, so nothing can flash. Ramping back
       to 1 before 100% blinked the fully-drawn logo for a few ms. */
    97%, 100% { opacity: 0; }
  }

  .ring {
    fill: none;
    stroke: #2C9F28;
    stroke-width: 10;
    stroke-linecap: round;
    stroke-dasharray: 1307;
    animation: ring 9s linear infinite;
    transform: rotate(-90deg);
    transform-origin: 240px 240px;
  }
  @keyframes ring {
    0% { stroke-dashoffset: 1307; }
    26% { stroke-dashoffset: 0; }
    100% { stroke-dashoffset: 0; }
  }

  /* The branch is a filled taper along its local x axis; scaleX from its
     base (fill-box left edge) grows it out of the bottom-left, exactly the
     direction the -45° wrapper points it. */
  .branch {
    transform-box: fill-box;
    transform-origin: 0% 50%;
    transform: scaleX(0);
    animation: branch 9s cubic-bezier(0.33, 0, 0.2, 1) infinite;
  }
  @keyframes branch {
    0%, 30% { transform: scaleX(0); }
    48% { transform: scaleX(1); }
    100% { transform: scaleX(1); }
  }

  .pop {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    transform: scale(0);
  }
  .fruit { animation: fruit 9s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes fruit {
    0%, 52% { transform: scale(0); }
    58% { transform: scale(1.08); }
    60%, 100% { transform: scale(1); }
  }
  .leaf { animation: leafpop 9s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
  @keyframes leafpop {
    0%, 62% { transform: scale(0); }
    68% { transform: scale(1.08); }
    70%, 100% { transform: scale(1); }
  }

  /* Live status line: what claude is doing right now, plain English. */
  .status {
    color: #4a4a46;
    font-size: 14px;
    margin: 2px 0 0;
    min-height: 24px;
    transition: opacity 0.25s ease;
  }
  .status.swap { opacity: 0; }
  .elapsed { color: #9a9790; font-size: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  
  /* Ready state: the branch finishes growing and STAYS — the cycle stops on
     the complete mark — and the view button pops in. No auto-redirect. */
  .ready .cycle { animation: none; opacity: 1; }
  .ready .ring { animation: none; stroke-dashoffset: 0; }
  .ready .branch { animation: none; transform: scaleX(1); }
  .ready .fruit, .ready .leaf { animation: none; transform: scale(1); }
  .ready .dots { display: none; }

  .view-btn {
    display: none;
    margin: 18px auto 0;
    background: #2C9F28;
    color: #fafaf8;
    border: none;
    border-radius: 10px;
    padding: 15px 30px;
    font-family: inherit;
    font-size: 17px;
    font-weight: 500;
    letter-spacing: 0.01em;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(44, 159, 40, 0.35);
    transition: background 150ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .view-btn:hover { background: #26881f; }
  .ready .view-btn {
    display: block;
    animation: btn-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  @keyframes btn-in {
    from { opacity: 0; transform: scale(0.88) translateY(6px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .calm {
    position: fixed; right: 16px; bottom: 12px;
    font-size: 11px; color: #9a9790; background: none; border: none;
    font-family: inherit; cursor: pointer; text-decoration: underline;
    text-underline-offset: 3px;
  }
  html.paused * { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style></head>
<body>
<svg class="scene" viewBox="0 0 480 480" aria-hidden="true">
    <g class="cycle">
      <circle class="ring" cx="240" cy="240" r="208"/>
      <g transform="translate(70,410) rotate(-45)" fill="#2C9F28">
        <path class="branch" d="M 9.0 -31.7 L 323.0 -15.9 Q 330.0 -15.5 330.0 -8.5 L 330.0 8.5 Q 330.0 15.5 323.0 15.9 L 9.0 31.7 Q 0.0 32.0 0.0 23.0 L 0.0 -23.0 Q 0.0 -32.0 9.0 -31.7 Z"/>
      </g>
      <g class="fruit pop"><ellipse cx="235" cy="123" rx="36" ry="53" fill="#2C9F28" transform="rotate(7 235 123)"/></g>
      <path class="leaf pop" d="M 288.20 275.25 C 289.92 275.08 291.69 275.13 293.44 275.25 C 295.18 275.38 296.98 275.62 298.67 275.99 C 300.37 276.36 301.98 276.94 303.61 277.47 C 305.23 278.00 306.86 278.55 308.44 279.19 C 310.02 279.83 311.55 280.60 313.10 281.32 C 314.65 282.05 316.22 282.72 317.72 283.54 C 319.23 284.37 320.70 285.29 322.14 286.26 C 323.59 287.24 324.99 288.32 326.39 289.40 C 327.79 290.48 329.17 291.60 330.54 292.75 C 331.91 293.90 333.31 295.08 334.62 296.30 C 335.92 297.52 337.19 298.75 338.38 300.07 C 339.58 301.39 340.70 302.81 341.78 304.21 C 342.87 305.61 343.89 307.03 344.89 308.47 C 345.88 309.90 346.87 311.34 347.76 312.82 C 348.66 314.30 349.49 315.80 350.26 317.33 C 351.02 318.86 351.73 320.42 352.38 322.00 C 353.03 323.58 353.62 325.18 354.15 326.81 C 354.68 328.44 355.20 330.07 355.57 331.76 C 355.95 333.46 356.27 335.22 356.41 336.96 C 356.55 338.70 356.57 340.47 356.41 342.20 C 356.26 343.92 355.93 345.66 355.48 347.31 C 355.03 348.97 354.46 350.58 353.71 352.12 C 352.96 353.66 352.05 355.20 351.00 356.54 C 349.95 357.88 348.73 359.12 347.38 360.16 C 346.04 361.20 344.50 362.11 342.92 362.77 C 341.35 363.43 339.64 363.84 337.94 364.13 C 336.24 364.42 334.48 364.51 332.72 364.50 C 330.96 364.49 329.13 364.34 327.39 364.09 C 325.66 363.83 323.97 363.20 322.31 362.98 C 320.64 362.75 318.88 362.52 317.41 362.74 C 315.94 362.95 314.65 363.41 313.47 364.28 C 312.29 365.16 311.33 366.65 310.33 367.99 C 309.33 369.34 308.50 370.94 307.46 372.35 C 306.41 373.76 305.31 375.21 304.04 376.45 C 302.78 377.68 301.33 378.81 299.87 379.76 C 298.42 380.71 296.92 381.56 295.31 382.14 C 293.71 382.72 291.95 383.07 290.23 383.25 C 288.51 383.44 286.71 383.44 284.99 383.25 C 283.27 383.07 281.52 382.72 279.91 382.14 C 278.29 381.57 276.79 380.75 275.32 379.82 C 273.86 378.89 272.44 377.76 271.13 376.56 C 269.81 375.36 268.57 373.99 267.43 372.63 C 266.29 371.26 265.21 369.85 264.29 368.38 C 263.38 366.91 262.67 365.36 261.94 363.81 C 261.22 362.26 260.55 360.69 259.96 359.09 C 259.37 357.48 258.89 355.83 258.39 354.19 C 257.89 352.55 257.40 350.91 256.98 349.23 C 256.55 347.56 256.17 345.87 255.87 344.15 C 255.56 342.43 255.31 340.68 255.13 338.91 C 254.94 337.14 254.82 335.34 254.76 333.52 C 254.69 331.70 254.69 329.80 254.76 327.97 C 254.82 326.15 254.94 324.35 255.13 322.58 C 255.31 320.81 255.56 319.07 255.87 317.34 C 256.17 315.62 256.58 313.95 256.98 312.26 C 257.37 310.57 257.76 308.89 258.21 307.23 C 258.66 305.57 259.14 303.91 259.69 302.30 C 260.24 300.68 260.84 299.07 261.54 297.52 C 262.24 295.96 263.04 294.44 263.89 292.95 C 264.75 291.45 265.65 289.98 266.67 288.55 C 267.70 287.13 268.83 285.69 270.03 284.42 C 271.24 283.14 272.53 281.96 273.91 280.91 C 275.29 279.87 276.78 278.92 278.31 278.15 C 279.84 277.38 281.44 276.78 283.09 276.30 C 284.73 275.82 286.47 275.43 288.20 275.25 Z" fill="#2C9F28" stroke="#2C9F28" stroke-width="6" stroke-linejoin="round" transform="translate(-4.95,-4.95)"/>
    </g>
  </svg>
  <h1 id="title">Fig is generating<span class="dots"><span>.</span><span>.</span><span>.</span></span></h1>
  <p class="status" id="status">${esc(initial)}</p>
  <p class="elapsed" id="elapsed"></p>
  <button class="view-btn" id="viewBtn">View revised page</button>
  <button class="calm" onclick="document.documentElement.classList.toggle('paused')">Pause</button>
<script>
(function () {
  var slug = ${JSON.stringify(slug)};
  var startedAt = ${JSON.stringify(st.startedAt || null)};
  var t0 = startedAt ? new Date(startedAt).getTime() : Date.now();
  var ready = false;
  var st = document.getElementById("status");
  var el = document.getElementById("elapsed");
  setInterval(function () {
    if (ready) return;
    var s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
    el.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 1000);

  function setStatus(text) {
    if (!text || st.textContent === text || ready) return;
    st.classList.add("swap");
    setTimeout(function () { st.textContent = text; st.classList.remove("swap"); }, 250);
  }
  function finish(state) {
    if (ready) return;
    if (state.phase === "error") { location.reload(); return; } // figd serves the error page
    ready = true;
    document.body.classList.add("ready");
    document.getElementById("title").textContent = "Your fig is ready";
    st.classList.remove("swap");
    st.textContent = "The revised page is waiting.";
  }
  function check(state) {
    if (!state) return;
    if (state.phase === "done" || state.phase === "error") finish(state);
    else setStatus(state.status);
  }
  document.getElementById("viewBtn").addEventListener("click", function () {
    location.href = "/pages/" + slug + "/";
  });

  // Push: instant. Poll: safety net.
  try {
    var es = new EventSource("/jobs/" + slug + "/events");
    es.onmessage = function (e) {
      try { check(JSON.parse(e.data)); } catch (err) { /* heartbeat */ }
    };
  } catch (e) { /* fall through to polling */ }
  setInterval(function () {
    if (ready) return;
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
    // Fig on a Fig result: the change log tracks EVERY round, page to page.
    // The parent's accumulated history + its own changes ride forward.
    try {
      const seg = String(payload.url || "").match(/\/([a-z0-9-]+)\/?(?:[?#].*)?$/);
      const parent = seg && seg[1] !== slug ? path.join(JOBS, seg[1]) : null;
      if (parent && fs.existsSync(path.join(parent, "annotations.json"))) {
        const hist = [];
        try { hist.push(...JSON.parse(fs.readFileSync(path.join(parent, "history.json"), "utf8"))); } catch { /* first chain link */ }
        try {
          const pc = JSON.parse(fs.readFileSync(path.join(parent, "changes.json"), "utf8"));
          if (Array.isArray(pc) && pc.length) hist.push({ job: seg[1], changes: pc });
        } catch { /* parent had no changelog */ }
        if (hist.length) fs.writeFileSync(path.join(jobDir, "history.json"), JSON.stringify(hist, null, 2));
      }
    } catch { /* history is best-effort, never blocks a dispatch */ }
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



  // Link a review site (called by the native host — the daemon spawns the
  // scaffolder so downloaded CLIs never inherit a browser provenance context).
  if (req.method === "POST" && url.pathname === "/link") {
    if (req.headers["x-fig-token"] !== settings.token) { res.writeHead(403); res.end(); return; }
    let prov = "cloudflare";
    try { prov = JSON.parse(await readBody(req, 4096)).provider === "vercel" ? "vercel" : "cloudflare"; } catch { /* default */ }
    const script = [path.join(__dirname, "fig-link.js"), path.join(__dirname, "..", "companion", "fig-link.js")].find((f) => fs.existsSync(f));
    if (!script) { res.writeHead(500); res.end("fig-link.js missing"); return; }
    const child = spawn(process.execPath, [script, prov], {
      detached: true, stdio: "ignore",
      env: { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].join(":") },
    });
    child.unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: prov }));
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
    html = injectFavicon(html);
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
    res.end(page("Fig", `<h1>Fig</h1><p class="muted">Results open: ${settings.target === "localhost" ? "this computer only" : "here + published for team review"} · settings live in the Fig toolbar (the gear)</p><ul>${rows || "<li class='muted'>No figs yet</li>"}</ul>`));
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
