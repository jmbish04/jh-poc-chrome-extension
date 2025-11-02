# Job Workflow Automation Worker

This Worker promotes staged job opportunities into production-ready records by orchestrating Cloudflare Workflows, Workers AI, Vectorize, D1, and Queues.

## Overview
- `POST /jobs/stage` persists a candidate/company pairing to D1 and dispatches the `stage-to-production` workflow.
- The workflow enriches the staging record by generating embeddings, invoking Workers AI for fit scoring and compensation guidance, writing to `production_jobs`, and optionally enqueueing deeper research tasks when the fit score is above 8.
- `GET /jobs/:stagedJobId` provides a consolidated view of the staged and production records, including the persisted AI payload.

## Workflow: `stage-to-production`
| Property | Details |
| --- | --- |
| Trigger | Automatically dispatched by `/jobs/stage` |
| Input Payload | `{ "stagedJobId": string }` |
| Steps |
| 1. | Load staged job row from `staged_jobs`. |
| 2. | Build embedding text, request an embedding vector via `env.run.AI("@cf/baai/bge-large-en-v1.5")`, and `env.VECTORIZE.upsert` it. |
| 3. | Invoke `env.run.AI("@cf/openai/gpt-4o-mini")` with a JSON-enforced prompt to obtain `fit_score`, optional salary data, and recruiter notes. |
| 4. | Insert a linked row into `production_jobs`, storing structured fields and the full AI response (including embedding metadata). |
| 5. | When `fit_score > 8`, enqueue a message onto `DEEP_SCRAPE_QUEUE` with `{ stagedJobId, productionJobId, companyUrl, candidateUrl }`. |
| Output | `{ productionJobId, fitScore, salaryMin, salaryMax, salaryCurrency }` |

Missing salary data is normalized to `null` before persistence so downstream systems can rely on explicit nullability instead of absent keys.

## Data Model
```sql
CREATE TABLE IF NOT EXISTS staged_jobs (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_url TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  candidate_url TEXT NOT NULL,
  role_title TEXT NOT NULL,
  role_description TEXT NOT NULL,
  notes TEXT,
  vector_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_jobs (
  id TEXT PRIMARY KEY,
  staged_job_id TEXT NOT NULL,
  fit_score REAL NOT NULL,
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  ai_raw TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (staged_job_id) REFERENCES staged_jobs(id)
);
```

## Environment Requirements
| Binding | Purpose | Configuration |
| --- | --- | --- |
| `DB` | D1 database holding `staged_jobs` and `production_jobs`. | Update `database_id` and `database_name` in `wrangler.toml`. |
| `VECTORIZE` | Vectorize index storing embedding vectors for staged jobs. | Provide an existing index name. |
| `AI` | Workers AI binding for embeddings and structured evaluation. | No additional configuration. |
| `STAGE_TO_PRODUCTION` | Workflow binding defined in `workflows/stage-to-production.ts`. | Requires Workflows GA access. |
| `DEEP_SCRAPE_QUEUE` | Queue for downstream scraping. | Create a queue named `deep-scrape` or adjust `wrangler.toml`. |

Ensure the Vectorize index supports metadata fields `stagedJobId`, `companyName`, and `roleTitle`.

## Running Locally
```bash
npm install
npm run dev
```

Example staging request:
```bash
curl -X POST http://127.0.0.1:8787/jobs/stage \
  -H "content-type: application/json" \
  -d '{
    "companyName": "Acme Corp",
    "companyUrl": "https://acme.example",
    "candidateName": "Jane Doe",
    "candidateUrl": "https://linkedin.com/in/janedoe",
    "roleTitle": "Staff AI Engineer",
    "roleDescription": "Lead the foundation model strategy"
  }'
```

Query the promoted record:
```bash
curl http://127.0.0.1:8787/jobs/<stagedJobId>
```
