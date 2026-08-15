CREATE TABLE IF NOT EXISTS run_logs (
  id TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL,
  game TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  result INTEGER NOT NULL,
  survived_sec REAL NOT NULL,
  kills INTEGER NOT NULL,
  elite_kills INTEGER NOT NULL,
  segment INTEGER NOT NULL,
  boss_killed_at_sec REAL NOT NULL,
  peak_dps REAL NOT NULL,
  event_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_logs_received_at ON run_logs(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_logs_seed ON run_logs(seed);
