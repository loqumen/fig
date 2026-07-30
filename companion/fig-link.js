#!/usr/bin/env node
// Fig — link a review site ("bring your own hosting").
// Scaffolds and deploys the user's OWN review site on their chosen provider:
//   cloudflare: Worker (static assets + comments API) + D1  [recommended]
//   vercel:     serverless functions + Vercel Blob
// Usage: node fig-link.js <cloudflare|vercel>
// Progress + result land in ~/.fig/publish.json (figd's /settings reads it).
// CLIs are PINNED (no @latest — supply-chain policy) and run via npx.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const WRANGLER = "wrangler@4.112.0";
const VERCEL = "vercel@56.3.2";
const FIG_HOME = path.join(os.homedir(), ".fig");
const PUBLISH = path.join(FIG_HOME, "publish.json");
const SCAFFOLD = [
  path.join(__dirname, "..", "scaffold"),   // repo layout
  path.join(__dirname, "scaffold"),          // installed layout
].find((d) => fs.existsSync(d));

let _logFd = null;
function logFd() {
  if (_logFd == null) {
    fs.mkdirSync(FIG_HOME, { recursive: true });
    _logFd = fs.openSync(path.join(FIG_HOME, "link.log"), "a");
  }
  return _logFd;
}

function state(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(PUBLISH, "utf8")); } catch { /* first link */ }
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(FIG_HOME, { recursive: true });
  fs.writeFileSync(PUBLISH, JSON.stringify(next, null, 2));
  return next;
}

function step(msg) {
  state({ step: msg });
  process.stdout.write(msg + "\n");
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], ...opts });
}

function npx(pkgAndArgs, opts = {}) {
  return run("npx", ["--yes", ...pkgAndArgs], opts);
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function placeholderIndex() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fig review site</title>
<style>body{font-family:system-ui,sans-serif;background:#fafaf8;color:#1a1a1a;max-width:560px;margin:80px auto;padding:0 24px;line-height:1.7}</style>
</head><body><h1 style="font-weight:500">Fig review site</h1>
<p>This site hosts pages published from Fig for team review. Published pages appear at their own links.</p></body></html>`;
}

// ---------------- Cloudflare ----------------
function linkCloudflare() {
  const dir = path.join(FIG_HOME, "review-site-cloudflare");
  state({ provider: "cloudflare", status: "linking", dir, error: null });

  step("Preparing the site files…");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  copy(path.join(SCAFFOLD, "cloudflare", "worker.js"), path.join(dir, "worker.js"));
  copy(path.join(SCAFFOLD, "shared", "review-api-core.js"), path.join(dir, "review-api-core.js"));
  copy(path.join(SCAFFOLD, "cloudflare", "schema.sql"), path.join(dir, "schema.sql"));
  fs.writeFileSync(path.join(dir, "public", "index.html"), placeholderIndex());

  step("Getting the deployment tool ready (first time can take a minute)…");
  try { npx([WRANGLER, "--version"], { cwd: dir }); } catch { /* cache warm only */ }
  step("Signing in to Cloudflare (a browser window may open)…");
  try { npx([WRANGLER, "whoami"], { cwd: dir }); }
  catch { npx([WRANGLER, "login"], { cwd: dir, stdio: ["ignore", logFd(), logFd()] }); }

  step("Creating the comments database…");
  let dbId = null;
  const dbName = "fig-review-db";
  try {
    const out = npx([WRANGLER, "d1", "create", dbName], { cwd: dir });
    const m = out.match(/"database_id":\s*"([0-9a-f-]+)"/) || out.match(/database_id\s*=\s*"([0-9a-f-]+)"/);
    dbId = m && m[1];
  } catch (e) {
    // Already exists from a previous link — look it up instead.
    const listed = npx([WRANGLER, "d1", "list", "--json"], { cwd: dir });
    const arr = JSON.parse(listed);
    const hit = arr.find((d) => d.name === dbName);
    dbId = hit && (hit.uuid || hit.database_id);
    if (!dbId) throw e;
  }
  if (!dbId) throw new Error("could not determine the D1 database id");

  const cfg = fs.readFileSync(path.join(SCAFFOLD, "cloudflare", "wrangler.template.jsonc"), "utf8")
    .replace("__NAME__", "fig-review")
    .replace("__DB_NAME__", dbName)
    .replace("__DB_ID__", dbId);
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), cfg);

  step("Setting up the database tables…");
  npx([WRANGLER, "d1", "execute", dbName, "--remote", "--file", "schema.sql", "-y"], { cwd: dir });

  step("Deploying the review site…");
  const out = npx([WRANGLER, "deploy"], { cwd: dir });
  const um = out.match(/https:\/\/[^\s]+\.workers\.dev/);
  const url = um ? um[0] : null;
  if (!url) throw new Error("deploy succeeded but no workers.dev URL found in output");

  state({ status: "linked", url, step: "Done" });
  process.stdout.write(`Linked: ${url}\n`);
}

// ---------------- Vercel ----------------
function linkVercel() {
  const dir = path.join(FIG_HOME, "review-site-vercel");
  state({ provider: "vercel", status: "linking", dir, error: null });

  step("Preparing the site files…");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  copy(path.join(SCAFFOLD, "vercel", "api-comments.js"), path.join(dir, "api", "comments.js"));
  copy(path.join(SCAFFOLD, "vercel", "api-strokes.js"), path.join(dir, "api", "strokes.js"));
  copy(path.join(SCAFFOLD, "shared", "review-api-core.js"), path.join(dir, "lib", "review-api-core.js"));
  copy(path.join(SCAFFOLD, "vercel", "blob-store.js"), path.join(dir, "lib", "blob-store.js"));
  copy(path.join(SCAFFOLD, "vercel", "package.template.json"), path.join(dir, "package.json"));
  fs.writeFileSync(path.join(dir, "public", "index.html"), placeholderIndex());

  step("Getting the deployment tool ready (first time can take a minute)…");
  try { npx([VERCEL, "--version"], { cwd: dir }); } catch { /* cache warm only */ }
  step("Signing in to Vercel (a browser window may open)…");
  try { npx([VERCEL, "whoami"], { cwd: dir }); }
  catch { npx([VERCEL, "login"], { cwd: dir, stdio: ["ignore", logFd(), logFd()] }); }

  step("Creating the project…");
  npx([VERCEL, "link", "--yes", "--project", "fig-review"], { cwd: dir });

  step("Creating the comments store…");
  try { npx([VERCEL, "blob", "store", "add", "fig-review-store"], { cwd: dir, stdio: ["ignore", logFd(), logFd()] }); }
  catch { /* store may already exist — the env pull below is what matters */ }

  step("Deploying the review site…");
  const out = npx([VERCEL, "deploy", "--prod", "--yes"], { cwd: dir });
  const um = out.match(/https:\/\/[^\s]+\.vercel\.app/);
  const url = um ? um[0] : null;
  if (!url) throw new Error("deploy succeeded but no vercel.app URL found in output");

  state({ status: "linked", url, step: "Done" });
  process.stdout.write(`Linked: ${url}\n`);
}

const provider = process.argv[2];
try {
  if (provider === "cloudflare") linkCloudflare();
  else if (provider === "vercel") linkVercel();
  else { console.error("usage: fig-link.js <cloudflare|vercel>"); process.exit(2); }
} catch (e) {
  state({ status: "error", error: String(e.message || e).slice(0, 500) });
  console.error("Link failed:", e.message);
  process.exit(1);
}
