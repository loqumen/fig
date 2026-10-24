// Fig review store on Cloudflare D1. Every write is a single SQL statement (or one
// batch), so two reviewers acting at the same moment never overwrite each other.
//
// Tables (created on first use, see schema.sql):
//   comments       (version, id, data)  one row per top-level comment; replies live in data.replies
//   stroke_items   (version, id, data)  one row per drawing stroke, kept in insertion order
//   version_states (key, data)          page-version restore state
// `comments` keeps the shape of the first scaffold, so older review sites keep their data.

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS comments (version TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (version, id))",
  "CREATE TABLE IF NOT EXISTS stroke_items (version TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (version, id))",
  "CREATE TABLE IF NOT EXISTS version_states (key TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL)",
];

const ready = new WeakMap();   // one schema check per database per isolate
export function ensureSchema(db) {
  if (!ready.has(db)) ready.set(db, db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((e) => { ready.delete(db); throw e; }));
  return ready.get(db);
}

const parse = (rows) => rows.map((r) => JSON.parse(r.data));
const changes = (r) => (r && r.meta && r.meta.changes) || 0;

export function d1Store(db) {
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const all = async (sql, ...args) => (await q(sql, ...args).all()).results || [];
  const first = (sql, ...args) => q(sql, ...args).first();
  const run = async (sql, ...args) => { await ensureSchema(db); return q(sql, ...args).run(); };
  const read = async (fn) => { await ensureSchema(db); return fn(); };

  const getComment = (version, id) => read(async () => {
    const row = await first("SELECT data FROM comments WHERE version = ?1 AND id = ?2", version, id);
    return row ? JSON.parse(row.data) : null;
  });

  return {
    // ---- comments
    listComments: (version) => read(async () => parse(await all("SELECT data FROM comments WHERE version = ?1", version))),
    getComment,
    async saveComment(version, c) {
      await run("INSERT INTO comments (version, id, data) VALUES (?1, ?2, ?3) ON CONFLICT(version, id) DO UPDATE SET data = ?3", version, c.id, JSON.stringify(c));
    },
    async insertComment(version, c) {
      const r = await run("INSERT INTO comments (version, id, data) VALUES (?1, ?2, ?3) ON CONFLICT(version, id) DO NOTHING", version, c.id, JSON.stringify(c));
      if (changes(r)) return { comment: c, created: true };
      return { comment: await getComment(version, c.id), created: false };
    },
    async addReply(version, parentId, reply) {
      const r = await run(
        `UPDATE comments
            SET data = json_set(data, '$.replies', json_insert(COALESCE(json_extract(data, '$.replies'), json('[]')), '$[#]', json(?3)))
          WHERE version = ?1 AND id = ?2
            AND NOT EXISTS (SELECT 1 FROM json_each(comments.data, '$.replies') WHERE json_extract(value, '$.id') = ?4)`,
        version, parentId, JSON.stringify(reply), reply.id);
      if (changes(r)) return "added";
      return (await getComment(version, parentId)) ? "duplicate" : "missing";
    },
    async deleteReply(version, replyId) {
      const r = await run(
        `UPDATE comments
            SET data = json_set(data, '$.replies',
                  json((SELECT json_group_array(json(value)) FROM json_each(comments.data, '$.replies') WHERE json_extract(value, '$.id') <> ?2)))
          WHERE version = ?1
            AND EXISTS (SELECT 1 FROM json_each(comments.data, '$.replies') WHERE json_extract(value, '$.id') = ?2)`,
        version, replyId);
      return changes(r) > 0;
    },
    async patchComment(version, id, fields) {
      const keys = Object.keys(fields);
      if (keys.length) {
        // json_set(data, '$.k1', ?3, '$.k2', ?4, ...): one atomic update of just these fields
        const sets = keys.map((k, i) => `'$.${k}', ?${i + 3}`).join(", ");
        await run(`UPDATE comments SET data = json_set(data, ${sets}) WHERE version = ?1 AND id = ?2`, version, id, ...keys.map((k) => fields[k]));
      }
      return getComment(version, id);
    },
    async deleteComment(version, id) {
      await run("DELETE FROM comments WHERE version = ?1 AND id = ?2", version, id);
    },
    async deleteAllComments(version) {
      return changes(await run("DELETE FROM comments WHERE version = ?1", version));
    },

    // ---- strokes
    getStrokes: (version) => read(async () => parse(await all("SELECT data FROM stroke_items WHERE version = ?1 ORDER BY rowid", version))),
    async putStrokes(version, arr) {
      await ensureSchema(db);
      await db.batch([
        q("DELETE FROM stroke_items WHERE version = ?1", version),
        ...arr.map((s) => q("INSERT INTO stroke_items (version, id, data) VALUES (?1, ?2, ?3) ON CONFLICT(version, id) DO NOTHING", version, s.id, JSON.stringify(s))),
      ]);
    },
    async addStroke(version, s) {
      await run("INSERT INTO stroke_items (version, id, data) VALUES (?1, ?2, ?3) ON CONFLICT(version, id) DO NOTHING", version, s.id, JSON.stringify(s));
    },
    async deleteStroke(version, id) {
      await run("DELETE FROM stroke_items WHERE version = ?1 AND id = ?2", version, id);
    },
    async deleteStrokes(version) {
      await run("DELETE FROM stroke_items WHERE version = ?1", version);
    },

    // ---- the trash button: one batch, so it can't half-finish
    async clearAuthor(author, versions, before) {
      await ensureSchema(db);
      if (!versions.length) return { comments: 0, strokes: 0 };
      const marks = versions.map((_, i) => `?${i + 3}`).join(", ");
      const mine = `json_extract(data, '$.author') = ?1 AND COALESCE(json_extract(data, '$.timestamp'), 0) <= ?2 AND version IN (${marks})`;
      const [c, s] = await db.batch([
        q(`DELETE FROM comments WHERE ${mine}`, author, before, ...versions),
        q(`DELETE FROM stroke_items WHERE ${mine}`, author, before, ...versions),
      ]);
      return { comments: changes(c), strokes: changes(s) };
    },

    // ---- page-version restore state
    getVersionState: (key) => read(async () => {
      const row = await first("SELECT data FROM version_states WHERE key = ?1", key);
      return row ? JSON.parse(row.data) : null;
    }),
    async setVersionState(key, state) {
      await run("INSERT INTO version_states (key, data) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET data = ?2", key, JSON.stringify(state));
    },
    async deleteVersionState(key) {
      await run("DELETE FROM version_states WHERE key = ?1", key);
    },
  };
}
