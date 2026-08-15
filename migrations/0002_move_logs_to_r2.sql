DROP INDEX IF EXISTS idx_run_logs_received_at;
DROP INDEX IF EXISTS idx_run_logs_seed;
DROP TABLE IF EXISTS run_logs;

CREATE TABLE IF NOT EXISTS monthly_log_quota (
  month TEXT PRIMARY KEY NOT NULL,
  object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  updated_at TEXT NOT NULL
);
