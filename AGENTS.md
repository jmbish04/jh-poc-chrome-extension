# Agent Overview

## Worker API
- **Name:** jh-poc-chrome-extension Worker
- **Purpose:** Provides staging endpoints for job opportunities and dispatches the promotion workflow.
- **Entry Module:** `src/index.ts`
- **Bindings:** `DB`, `VECTORIZE`, `AI`, `STAGE_TO_PRODUCTION`, `DEEP_SCRAPE_QUEUE`
- **Dependencies:** Hono, Zod
- **Usage Example:**
  ```bash
  curl -X POST "$WORKER/jobs/stage" \
    -H "content-type: application/json" \
    -d '{
      "companyName": "Acme Corp",
      "companyUrl": "https://acme.example",
      "candidateName": "Jane Doe",
      "candidateUrl": "https://linkedin.com/in/janedoe",
      "roleTitle": "Staff AI Engineer",
      "roleDescription": "Own foundation models",
      "notes": "Backchannel says comp flexible"
    }'
  ```

## Workflows
- **Name:** `stage-to-production`
- **Class:** `StageToProductionWorkflow`
- **File:** `workflows/stage-to-production.ts`
- **Purpose:** Promote staged jobs by vectorizing content, invoking Workers AI for fit scoring, persisting production jobs, and conditionally enqueueing deep scrape tasks.
- **Bindings:** `DB`, `VECTORIZE`, `AI`, `DEEP_SCRAPE_QUEUE`
- **Trigger:** Automatically dispatched after `/jobs/stage` is called.
- **Output:** `{ productionJobId, fitScore, salaryMin, salaryMax, salaryCurrency }`

## Data & Schema Notes
- **D1 Tables:**
  - `staged_jobs(id TEXT PRIMARY KEY, company_name TEXT, company_url TEXT, candidate_name TEXT, candidate_url TEXT, role_title TEXT, role_description TEXT, notes TEXT, vector_id TEXT, created_at TEXT)`
  - `production_jobs(id TEXT PRIMARY KEY, staged_job_id TEXT, fit_score REAL, salary_min REAL, salary_max REAL, salary_currency TEXT, ai_raw TEXT, created_at TEXT)`
- Ensure `vector_id` stores the Vectorize document identifier returned by the workflow.

## Queues
- **Producer Binding:** `DEEP_SCRAPE_QUEUE`
- **Payload:** `{ stagedJobId, productionJobId, companyUrl, candidateUrl }`
- **Dispatch Rule:** Fit score strictly greater than 8.

## Implementation Conventions
- Prefer Hono routing with explicit `Bindings` typing (`src/index.ts`).
- Workflows must use `step.run` wrappers for all side-effecting operations.
- AI responses must be parsed with Zod schema validation and null-safe salary handling.
