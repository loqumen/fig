#!/usr/bin/env node
// Fig native messaging host.
//
// Chrome speaks to this over stdio (4-byte LE length + UTF-8 JSON), which is
// restricted by the browser to the extension IDs listed in the host manifest.
// That restriction replaces the old shared token: the host reads the token from
// ~/.fig/settings.json itself, so the extension never sees or stores a secret
// and the user never pastes one.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const SETTINGS = path.join(os.homedir(), ".fig", "settings.json");
const PORT = 41414;

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([len, buf]));
}

function token() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")).token || ""; }
  catch { return ""; }
}

function dispatch(payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/fig", method: "POST",
        headers: { "Content-Type": "application/json",
                   "Content-Length": body.length,
                   "X-Fig-Token": token() } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          let data; try { data = JSON.parse(out); } catch { data = { error: out.slice(0, 400) }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data });
        });
      }
    );
    req.on("error", (e) =>
      resolve({ ok: false, data: { error: "companion not running (" + e.code + "). Reinstall Fig Companion." } }));
    req.end(body);
  });
}


// ---- settings + BYO link ops (the gear popover's backend) ----
// The host has direct fs access, so settings never need tokens or pages.
const SETTINGS_FILE = path.join(os.homedir(), ".fig", "settings.json");
const PUBLISH_FILE = path.join(os.homedir(), ".fig", "publish.json");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// Generation model/effort choices (the gear popover's pickers). "" = the
// CLI's own default. Validated here so a bad value can never reach spawn.
const MODELS = ["", "fable", "opus", "sonnet", "haiku"];
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

function settingsGet() {
  const s = readJson(SETTINGS_FILE) || {};
  const ps = readJson(PUBLISH_FILE);
  // legacyVercel: the pre-BYO edits project is a valid publish destination
  // when its directory actually exists (or it is already the active target).
  let legacyVercel = s.target === "vercel";
  try { legacyVercel = legacyVercel || (s.vercelDir && fs.existsSync(s.vercelDir)); } catch { /* fine */ }
  return { ok: true, data: { target: s.target || "localhost", model: s.model || "", effort: s.effort || "", legacyVercel: !!legacyVercel, publish: ps } };
}

function settingsSet(patch) {
  const s = readJson(SETTINGS_FILE) || {};
  if (["localhost", "linked", "vercel"].includes(patch.target)) s.target = patch.target;
  if (MODELS.includes(patch.model)) s.model = patch.model;
  if (EFFORTS.includes(patch.effort)) s.effort = patch.effort;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return settingsGet();
}

function linkStart(provider) {
  // Spawning from THIS process would inherit Chrome's provenance context —
  // macOS then quarantines everything npx downloads and Gatekeeper blocks
  // the CLI's binaries (the 2026-07-30 esbuild prompt). figd runs under
  // launchd, whose children are clean, so the daemon does the spawning.
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ provider: provider === "vercel" ? "vercel" : "cloudflare" }));
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/link", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length, "X-Fig-Token": token() } },
      (res) => { res.resume(); res.on("end", () => resolve({ ok: res.statusCode === 200, data: { started: provider } })); }
    );
    req.on("error", () => resolve({ ok: false, data: { error: "companion daemon not running" } }));
    req.end(body);
  });
}

// stdin framing
let buf = Buffer.alloc(0);
process.stdin.on("data", async (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
    buf = buf.slice(4 + len);
    if (msg && msg.type === "ping") { send({ ok: true, data: { pong: true } }); continue; }
    if (msg && msg.type === "settings-get") { send(settingsGet()); continue; }
    if (msg && msg.type === "settings-set") { send(settingsSet(msg.settings || {})); continue; }
    if (msg && msg.type === "link-start") { send(await linkStart(msg.provider)); continue; }
    send(await dispatch(msg && msg.payload ? msg.payload : msg));
  }
});
process.stdin.on("end", () => process.exit(0));
