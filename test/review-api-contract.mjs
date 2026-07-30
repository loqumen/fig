// Contract test: the shared review API core must speak the exact protocol
// fig-comments.js expects, against ANY store. Runs the same suite twice:
// (1) an in-memory reference store, (2) the REAL D1 SQL from worker.js
// executed on node:sqlite through a D1-shaped shim.
import { handleComments, handleStrokes } from "../scaffold/shared/review-api-core.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ---- store 1: in-memory reference ----
function memStore() {
  const comments = new Map(); // version -> Map(id -> c)
  const strokes = new Map();
  const cm = (v) => { if (!comments.has(v)) comments.set(v, new Map()); return comments.get(v); };
  return {
    async listComments(v) { return [...cm(v).values()].map((c) => JSON.parse(JSON.stringify(c))); },
    async getComment(v, id) { const c = cm(v).get(id); return c ? JSON.parse(JSON.stringify(c)) : null; },
    async saveComment(v, c) { cm(v).set(c.id, JSON.parse(JSON.stringify(c))); },
    async deleteComment(v, id) { cm(v).delete(id); },
    async deleteAllComments(v) { const n = cm(v).size; cm(v).clear(); return n; },
    async getStrokes(v) { return JSON.parse(JSON.stringify(strokes.get(v) || [])); },
    async putStrokes(v, arr) { strokes.set(v, JSON.parse(JSON.stringify(arr))); },
    async deleteStrokes(v) { strokes.delete(v); },
  };
}

// ---- store 2: the real worker.js d1Store over node:sqlite ----
function d1Shim() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(here, "../scaffold/cloudflare/schema.sql"), "utf8"));
  return {
    prepare(sql) {
      // D1's ?N markers may REPEAT (e.g. ?3 in an upsert's VALUES and SET).
      // node:sqlite only takes anonymous ?, so record the occurrence order
      // and expand the bound args to match.
      const order = [];
      const norm = sql.replace(/\?(\d+)/g, (_, n) => { order.push(Number(n) - 1); return "?"; });
      const stmt = db.prepare(norm);
      let bound = [];
      const api = {
        bind(...args) { bound = order.length ? order.map((i) => args[i]) : args; return api; },
        async all() { return { results: stmt.all(...bound) }; },
        async first() { return stmt.get(...bound) || null; },
        async run() { const r = stmt.run(...bound); return { meta: { changes: r.changes } }; },
      };
      return api;
    },
  };
}
// import worker.js's d1Store by evaluating its source with the import stripped
const workerSrc = readFileSync(join(here, "../scaffold/cloudflare/worker.js"), "utf8");
const d1StoreSrc = workerSrc.slice(workerSrc.indexOf("function d1Store"), workerSrc.indexOf("async function readReq"));
const d1Store = new Function(`${d1StoreSrc}; return d1Store;`)();

// ---- the suite ----
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗", name); } };
const req = (method, query = {}, body = null) => ({ method, query, body });
const parse = (r) => JSON.parse(r.body);

async function suite(label, store) {
  const V = "test-v";
  // create (idempotent)
  let r = await handleComments(req("POST", {}, { version: V, id: "c1", x: 10, y: 20, text: "first", author: "Ann" }), store);
  ok(`${label}: create 201`, r.status === 201 && parse(r).id === "c1");
  r = await handleComments(req("POST", {}, { version: V, id: "c1", x: 10, y: 20, text: "first", author: "Ann" }), store);
  ok(`${label}: idempotent re-create 200`, r.status === 200);
  // suggest with anchor
  r = await handleComments(req("POST", {}, { version: V, id: "c2", x: 1, y: 2, text: "wrong fact", author: "Bob", kind: "suggest", anchor: { quote: "q", prefix: "p", suffix: "s" } }), store);
  ok(`${label}: suggest gets status open`, parse(r).status === "open" && parse(r).anchor.quote === "q");
  // reply
  r = await handleComments(req("POST", {}, { version: V, parentId: "c1", text: "a reply", author: "Bob" }), store);
  ok(`${label}: reply 201 returns reply obj`, r.status === 201 && parse(r).text === "a reply");
  r = await handleComments(req("GET", { v: V }), store);
  let all = parse(r);
  ok(`${label}: GET lists 2, sorted, reply attached`, all.length === 2 && all[0].id === "c1" && all[0].replies.length === 1);
  // patch
  r = await handleComments(req("PATCH", {}, { version: V, id: "c2", status: "diagnosed", diagnosis: "fix X" }), store);
  ok(`${label}: PATCH status+diagnosis`, parse(r).status === "diagnosed" && parse(r).diagnosis === "fix X");
  // delete a reply by id
  const replyId = all[0].replies[0].id;
  r = await handleComments(req("DELETE", { v: V, id: replyId }), store);
  ok(`${label}: DELETE reply by id`, r.status === 200);
  r = await handleComments(req("GET", { v: V }), store);
  ok(`${label}: reply gone`, parse(r)[0].replies.length === 0);
  // version isolation
  r = await handleComments(req("GET", { v: "other" }), store);
  ok(`${label}: version isolation`, parse(r).length === 0);
  // delete all
  r = await handleComments(req("DELETE", { v: V, all: "true" }), store);
  ok(`${label}: clear-all count`, parse(r).count === 2);
  // strokes
  r = await handleStrokes(req("POST", {}, { version: V, points: [{ x: 1, y: 2 }], color: "#000", width: 3, author: "Ann" }), store);
  const sid = parse(r).id;
  ok(`${label}: stroke create`, r.status === 201 && !!sid);
  await handleStrokes(req("POST", {}, { version: V, points: [{ x: 9, y: 9 }], author: "Bob" }), store);
  r = await handleStrokes(req("GET", { v: V }), store);
  ok(`${label}: strokes list 2`, parse(r).length === 2);
  r = await handleStrokes(req("DELETE", { v: V, id: sid }), store);
  r = await handleStrokes(req("GET", { v: V }), store);
  ok(`${label}: per-stroke delete`, parse(r).length === 1 && parse(r)[0].author === "Bob");
  r = await handleStrokes(req("DELETE", { v: V, all: "true" }), store);
  r = await handleStrokes(req("GET", { v: V }), store);
  ok(`${label}: strokes clear-all`, parse(r).length === 0);
  // error paths
  r = await handleComments(req("POST", {}, { version: V, text: "no coords" }), store);
  ok(`${label}: 400 without x/y`, r.status === 400);
  r = await handleComments(req("POST", {}, { version: V, parentId: "nope", text: "orphan" }), store);
  ok(`${label}: 404 reply to missing parent`, r.status === 404);
}

await suite("mem", memStore());
await suite("d1", d1Store(d1Shim()));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
