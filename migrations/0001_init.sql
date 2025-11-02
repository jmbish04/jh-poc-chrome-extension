CREATE TABLE IF NOT EXISTS raw_ingest (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  selectors TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staged_jobs (
  id TEXT PRIMARY KEY,
  raw_ingest_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  department TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (raw_ingest_id) REFERENCES raw_ingest(id)
);

CREATE TABLE IF NOT EXISTS production_jobs (
  id TEXT PRIMARY KEY,
  staged_job_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  FOREIGN KEY (staged_job_id) REFERENCES staged_jobs(id)
);

CREATE TABLE IF NOT EXISTS company_configs (
  company_id TEXT PRIMARY KEY,
  workflow_name TEXT,
  ai_model TEXT,
  selectors TEXT,
  metadata TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staged_jobs_company ON staged_jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_production_jobs_company ON production_jobs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_raw_ingest_company ON raw_ingest(company_id, received_at);
