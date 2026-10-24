// Contract test: the shared review API core must speak the exact protocol
// fig-comments.js expects, against ANY store. Runs the same suite twice:
// (1) an in-memory reference store with only the required methods (the
// read-modify-write fallbacks), (2) the REAL D1 SQL from d1-store.js executed
// on node:sqlite through a D1-shaped shim (the atomic paths). Then D1-only
// checks: concurrency, the trash endpoint, version state, request routing.
// Run with Node 22.5+ (node:sqlite): node test/review-api-contract.mjs
import { handleComments, handleStrokes, handleClear, handleVersions, handleRequest } from "../scaffold/shared/review-api-core.js";
import { d1Store } from "../scaffold/cloudflare/d1-store.js";
import { DatabaseSync } from "node:sqlite";

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
  const shim = {
    prepare(sql) {
      // D1's ?N markers may REPEAT (e.g. ?3 in an upsert's VALUES and SET).
      // node:sqlite only takes anonymous ?, so record the occurrence order
      // and expand the bound args to match.
      const order = [];
      const norm = sql.replace(/\?(\d+)/g, (_, n) => { order.push(Number(n) - 1); return "?"; });
      let bound = [];
      const api = {
        bind(...args) { bound = order.length ? order.map((i) => args[i]) : args; return api; },
        async all() { return { results: db.prepare(norm).all(...bound) }; },
        async first() { return db.prepare(norm).get(...bound) || null; },
        async run() { const r = db.prepare(norm).run(...bound); return { meta: { changes: Number(r.changes) } }; },
        _run() { const r = db.prepare(norm).run(...bound); return { meta: { changes: Number(r.changes) } }; },
      };
      return api;
    },
    // D1 batches run as one transaction
    async batch(stmts) {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s._run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    raw: db,
  };
  return shim;
}

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
  ok(`${label}: reply gone`, Array.isArray(parse(r)[0].replies) && parse(r)[0].replies.length === 0);
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

async function d1Only() {
  const store = d1Store(d1Shim());
  const V = "conc";
  await handleComments(req("POST", {}, { version: V, id: "p", x: 1, y: 1, text: "parent", author: "Ann" }), store);
  // 25 replies at once: an atomic append keeps every one
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    handleComments(req("POST", {}, { version: V, parentId: "p", id: "r" + i, text: "reply " + i, author: "R" + i }), store)));
  let r = await handleComments(req("GET", { v: V }), store);
  ok("d1: 25 concurrent replies all kept", parse(r)[0].replies.length === 25);
  r = await handleComments(req("POST", {}, { version: V, parentId: "p", id: "r3", text: "retry", author: "R3" }), store);
  r = await handleComments(req("GET", { v: V }), store);
  ok("d1: retried reply not duplicated", parse(r)[0].replies.filter((x) => x.id === "r3").length === 1);
  // 25 strokes at once, then a retried stroke id
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    handleStrokes(req("POST", {}, { version: V, id: "s" + i, points: [{ x: i, y: i }], author: "Ann" }), store)));
  await handleStrokes(req("POST", {}, { version: V, id: "s0", points: [{ x: 0, y: 0 }], author: "Ann" }), store);
  r = await handleStrokes(req("GET", { v: V }), store);
  ok("d1: 25 concurrent strokes kept, retry not duplicated", parse(r).length === 25);
  ok("d1: strokes keep insertion order", parse(r)[0].id === "s0");
  // PATCH touches only the named fields
  r = await handleComments(req("PATCH", {}, { version: V, id: "p", status: "approved" }), store);
  ok("d1: PATCH keeps replies and text", parse(r).replies.length === 25 && parse(r).text === "parent" && parse(r).status === "approved");
  r = await handleComments(req("PATCH", {}, { version: V, id: "p", x: 5, y: 6 }), store);
  ok("d1: PATCH moves pin with numbers", parse(r).x === 5 && parse(r).y === 6);
  r = await handleComments(req("PATCH", {}, { version: V, id: "nope", text: "x" }), store);
  ok("d1: PATCH missing 404", r.status === 404);
  r = await handleComments(req("DELETE", { v: V, id: "missing-anything" }), store);
  ok("d1: DELETE unknown id 404", r.status === 404);

  // trash: one author's items on listed pages, only up to the cutoff
  const T = Date.now();
  await handleComments(req("POST", {}, { version: "pg1", id: "a1", x: 1, y: 1, text: "mine", author: "Zed" }), store);
  await handleComments(req("POST", {}, { version: "pg2", id: "a2", x: 1, y: 1, text: "mine too", author: "Zed" }), store);
  await handleComments(req("POST", {}, { version: "pg1", id: "b1", x: 1, y: 1, text: "theirs", author: "Amy" }), store);
  await handleStrokes(req("POST", {}, { version: "pg2", id: "zs", points: [{ x: 1, y: 1 }], author: "Zed" }), store);
  await handleStrokes(req("POST", {}, { version: "pg2", id: "as", points: [{ x: 1, y: 1 }], author: "Amy" }), store);
  r = await handleClear(req("POST", {}, { author: "Zed", versions: ["pg1", "pg2"], before: T - 60000 }), store);
  ok("d1: clear respects the cutoff", parse(r).comments === 0 && parse(r).strokes === 0);
  r = await handleClear(req("POST", {}, { author: "Zed", versions: ["pg1", "pg2"], before: Date.now() + 1000 }), store);
  ok("d1: clear removes the author's items", parse(r).comments === 2 && parse(r).strokes === 1 && parse(r).commit === null);
  r = await handleComments(req("GET", { v: "pg1" }), store);
  const s2 = await handleStrokes(req("GET", { v: "pg2" }), store);
  ok("d1: clear keeps other reviewers", parse(r).length === 1 && parse(r)[0].author === "Amy" && parse(s2).length === 1);
  r = await handleClear(req("POST", {}, { versions: ["pg1"] }), store);
  ok("d1: clear needs an author", r.status === 400);

  // version state
  r = await handleVersions(req("GET", { key: "page-a" }), store);
  ok("d1: versions empty is {}", r.status === 200 && JSON.stringify(parse(r)) === "{}");
  r = await handleVersions(req("POST", {}, { key: "page-a", v: 3, label: "v3", author: "Ann" }), store);
  ok("d1: versions set", r.status === 201 && parse(r).v === 3);
  r = await handleVersions(req("GET", { key: "page-a" }), store);
  ok("d1: versions read back", parse(r).label === "v3");
  r = await handleVersions(req("DELETE", { key: "page-a" }), store);
  r = await handleVersions(req("GET", { key: "page-a" }), store);
  ok("d1: versions cleared", JSON.stringify(parse(r)) === "{}");
  r = await handleVersions(req("GET", { key: "Bad Key!" }), store);
  ok("d1: versions rejects bad keys", r.status === 400);

  // routing through Request/Response, as the worker and Pages functions call it
  let res = await handleRequest(new Request("https://x.test/api/comments?v=pg1"), store);
  ok("route: GET comments", res.status === 200 && (await res.json()).length === 1);
  res = await handleRequest(new Request("https://x.test/api/comments", { method: "OPTIONS" }), store);
  ok("route: preflight CORS", res.status === 200 && res.headers.get("access-control-allow-origin") === "*");
  res = await handleRequest(new Request("https://x.test/api/strokes", { method: "POST", body: JSON.stringify({ version: "rt", points: [{ x: 1, y: 1 }] }) }), store);
  ok("route: POST stroke", res.status === 201 && res.headers.get("cache-control") === "no-store");
  res = await handleRequest(new Request("https://x.test/my-review/"), store);
  ok("route: page paths fall through", res === null);

  // a failing store answers 503 with CORS, never a thrown error
  const broken = { ...store, listComments: async () => { throw new Error("down"); } };
  r = await handleComments(req("GET", { v: "x" }), broken);
  ok("errors: 503 with CORS", r.status === 503 && r.headers["Access-Control-Allow-Origin"] === "*");
}

await suite("mem", memStore());
await suite("d1", d1Store(d1Shim()));
await d1Only();
{
  const r = await handleClear(req("POST", {}, { author: "a", versions: ["v"] }), memStore());
  ok("mem: clear without store support is 501", r.status === 501);
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
