CREATE TABLE IF NOT EXISTS states (
  id      TEXT PRIMARY KEY,   -- sha256("todomate:" + sync code)
  data    TEXT NOT NULL,      -- full app state as JSON
  updated INTEGER NOT NULL DEFAULT 0   -- last-write-wins timestamp (ms)
);
