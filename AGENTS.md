# Agent Overview
- **Name:** Ingest Worker
- **Purpose:** Consume `INGEST_QUEUE` payloads, persist raw data, normalise staged jobs, and orchestrate AI-assisted analysis and self-healing workflows.
- **Class:** `src/index.ts` (Hono app with Queue consumer export)
- **Bindings:** `DB` (D1), `AI` (Workers AI), `SELF_HEAL_WORKFLOW` (Cloudflare Workflows dispatcher), `INGEST_QUEUE` (Queue consumer)
- **Dependencies:** [`hono`](https://github.com/honojs/hono)
- **Migration Tag:** `migrations/0001_init.sql`
- **Usage Example:**
  ```bash
  # Enqueue a sample ingest payload
  wrangler queues message send INGEST_QUEUE '{"companyId":"acme","sourceUrl":"https://acme.com/jobs","selectors":[".job-card"],"data":[{"id":"job-1","title":"Engineer"}]}'
  ```

## Queue Consumer Flow
1. Persist every payload in `raw_ingest` for observability.
2. Detect empty datasets (`data.length === 0`) and trigger the `SELF_HEAL_WORKFLOW` with crawl metadata.
3. Normalise non-empty datasets into deterministic job rows and bulk insert into `staged_jobs`.
4. Kick off the Workers AI analysis pipeline for categorisation and anomaly detection.
5. All exceptions are logged and bubbled to leverage automatic Queue retries.

## D1 Schema
- `raw_ingest`: append-only ledger of inbound queue payloads.
- `staged_jobs`: normalised staging area awaiting downstream promotion.
- `production_jobs`: stable table for production-ready job documents.
- `company_configs`: operational metadata (workflow + AI preferences) per company.

## Workflows Integration
- Binding `SELF_HEAL_WORKFLOW` should reference a workflow named `self-heal-workflow` that remediates empty crawls.
- Queue consumer forwards crawl metadata (`companyId`, `sourceUrl`, `selectors`, `rawIngestId`).

## Workers AI Pipeline
- Binding `AI` executes `@cf/meta/llama-3-8b-instruct` with sample job context to initiate downstream enrichment.

## HTTP Surface
- `GET /` returns a service heartbeat payload.
- `POST /healthcheck` verifies D1 connectivity.
