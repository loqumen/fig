// fig-host settings ops over real native-messaging stdio framing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const home = process.argv[2];
const port = process.argv[3] || "";
const host = join(dirname(fileURLToPath(import.meta.url)), "../companion/fig-host.js");
const p = spawn(process.execPath, [host], { env: { ...process.env, HOME: home, ...(port ? { FIG_PORT: port } : {}) }, stdio: ["pipe", "pipe", "inherit"] });

const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
let buf = Buffer.alloc(0); const queue = [];
p.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    queue.push(JSON.parse(buf.slice(4, 4 + n).toString()));
    buf = buf.slice(4 + n);
  }
});
const next = () => new Promise((res) => { const t = setInterval(() => { if (queue.length) { clearInterval(t); res(queue.shift()); } }, 20); });

p.stdin.write(frame({ type: "settings-get" }));
const g = await next();
if (!(g.ok && g.data.target)) { console.log("  ✗ settings-get"); process.exit(1); }
console.log("  ✓ host settings-get");

p.stdin.write(frame({ type: "settings-set", settings: { target: "linked" } }));
const s2 = await next();
const onDisk = JSON.parse(fs.readFileSync(join(home, ".fig/settings.json"), "utf8"));
if (!(s2.ok && s2.data.target === "linked" && onDisk.target === "linked")) { console.log("  ✗ settings-set"); process.exit(1); }
console.log("  ✓ host settings-set persists");

p.stdin.write(frame({ type: "settings-set", settings: { target: "localhost" } }));
await next();
console.log("  ✓ host settings toggle back");

p.stdin.write(frame({ type: "settings-set", settings: { model: "sonnet", effort: "high" } }));
const s3 = await next();
const disk3 = JSON.parse(fs.readFileSync(join(home, ".fig/settings.json"), "utf8"));
if (!(s3.ok && s3.data.model === "sonnet" && s3.data.effort === "high" && disk3.model === "sonnet" && disk3.effort === "high")) {
  console.log("  ✗ model/effort set"); process.exit(1);
}
console.log("  ✓ host model/effort set persists");

p.stdin.write(frame({ type: "settings-set", settings: { model: "gpt-5", effort: "ludicrous" } }));
const s4 = await next();
if (!(s4.ok && s4.data.model === "sonnet" && s4.data.effort === "high")) {
  console.log("  ✗ invalid model/effort should be rejected"); process.exit(1);
}
console.log("  ✓ host rejects invalid model/effort values");

p.stdin.write(frame({ type: "settings-set", settings: { model: "", effort: "" } }));
const s5 = await next();
if (!(s5.ok && s5.data.model === "" && s5.data.effort === "")) {
  console.log("  ✗ model/effort reset to default"); process.exit(1);
}
console.log("  ✓ host model/effort reset to default");

// The "All figs" list must come through the HOST (Brave blocks the
// extension's own localhost fetch — 2026-08-05 "not reachable" bug).
p.stdin.write(frame({ type: "jobs" }));
const j = await next();
if (!(j.ok && Array.isArray(j.data) && j.data.some((x) => x.title && x.url))) {
  console.log("  ✗ host jobs op", JSON.stringify(j).slice(0, 200)); process.exit(1);
}
console.log("  ✓ host jobs op returns the human-readable list");
p.kill();
process.exit(0);
