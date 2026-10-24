-- Fig review store (D1). d1-store.js also creates these on first use.
CREATE TABLE IF NOT EXISTS comments (version TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (version, id));
CREATE TABLE IF NOT EXISTS stroke_items (version TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (version, id));
CREATE TABLE IF NOT EXISTS version_states (key TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL);
