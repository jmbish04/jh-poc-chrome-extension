# jh-poc-chrome-extension Worker

Cloudflare Worker that consumes an ingestion queue, snapshots raw payloads into D1, normalises jobs for staging, and kicks off Workers AI enrichment plus self-healing workflows.

## Prerequisites
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) >= 3.0
- Cloudflare account with:
  - D1 database bound as `DB`
  - Queue named `INGEST_QUEUE`
  - Workers AI enabled (`AI` binding)
  - Workflow named `self-heal-workflow` bound as `SELF_HEAL_WORKFLOW`

## Local Development
```bash
# Install dependencies
npm install

# Run the worker locally
wrangler dev
```

## Queue Testing
```bash
# Send a non-empty dataset
wrangler queues message send INGEST_QUEUE '{"companyId":"acme","sourceUrl":"https://acme.com/jobs","selectors":[".job-card"],"data":[{"id":"job-1","title":"Engineer","location":"Remote"}]}'

# Send an empty dataset to trigger self-healing
wrangler queues message send INGEST_QUEUE '{"companyId":"acme","sourceUrl":"https://acme.com/jobs","selectors":[".job-card"],"data":[]}'
```

## Deployment
```bash
wrangler deploy
```

## Health Endpoints
- `GET /` – service heartbeat
- `POST /healthcheck` – validates D1 connectivity
