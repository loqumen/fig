// fig-host settings ops over real native-messaging stdio framing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const home = process.argv[2];
const host = join(dirname(fileURLToPath(import.meta.url)), "../companion/fig-host.js");
const p = spawn(process.execPath, [host], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });

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
p.kill();
process.exit(0);
