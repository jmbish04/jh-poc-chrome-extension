-- Migration: initialize job schedule storage
CREATE TABLE IF NOT EXISTS job_schedule (
  id TEXT PRIMARY KEY,
  next_run_timestamp INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO job_schedule (id, next_run_timestamp, updated_at)
VALUES ('linkedin-jobs', 0, 0);
