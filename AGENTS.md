# Agent Overview

## Worker: `jh-poc-chrome-extension`
- **Purpose:** Consume the `DEEP_SCRAPE_QUEUE`, run Cloudflare Browser Rendering jobs for company career pages, and persist canonical URLs plus scraped postings with AI-assisted fallbacks.
- **Entry Point:** `src/index.ts`
- **Bindings:**
  - `DB` (D1) – `company_configs` + `production_jobs` tables.
  - `DEEP_SCRAPE_QUEUE` (Queue consumer) – deep scrape work items.
  - `SELECTOR_KV` (KV) – override + AI suggested selector payloads (`selectors:<companyId>`).
  - `BROWSER` (Browser Rendering) – `@cloudflare/puppeteer` sessions for job pages.
  - `AI` (Workers AI) – canonical URL + selector inference using `@cf/meta/llama-3.1-8b-instruct`.
  - `SELF_HEALING` (Workflow) – orchestrates fallback selector recovery.
  - `EXTENSION_BRIDGE` (Durable Object) – routes `{ action: 'getFullPageHTML', url }` commands to the Chrome extension and receives HTML payloads.
- **Durable Objects:** `ExtensionBridge` stores the latest command + HTML snapshot for extension clients.
- **Workflow:** `SelfHealingWorkflow` issues extension commands, requests Worker AI selector recommendations, and persists overrides in KV + D1.
- **Queues:** `DEEP_SCRAPE_QUEUE` must deliver payloads shaped like `{ companyId, linkedinUrl, metadata?, overrideSelectors? }`.
- **Tables:**
  - `company_configs(company_id TEXT PRIMARY KEY, careers_page_url TEXT, override_selectors TEXT, updated_at TEXT)`.
  - `production_jobs(job_id TEXT PRIMARY KEY, company_id TEXT, title TEXT, location TEXT, url TEXT, snippet TEXT, scraped_at TEXT, raw_payload TEXT, UNIQUE(company_id, url))`.

## Fallback + Self-Healing Flow
1. Queue consumer resolves the target URL: prefer `company_configs.careers_page_url`, fallback to message `linkedinUrl`.
2. Render page with Browser Rendering + selectors (default → KV → D1 → payload).
3. Zero results triggers `SELF_HEALING` workflow:
   - Posts `{ action: 'getFullPageHTML', url }` to `ExtensionBridge`.
   - Awaits `/html` payload from extension (or uses browser HTML when unavailable).
   - Sends HTML + existing selectors to Workers AI for selector JSON.
   - Stores selectors in KV (`selectors:<companyId>`) and D1 `company_configs.override_selectors`.
   - Future runs automatically merge overrides.
4. If `company_configs` record missing, queue consumer sends Browser HTML to Workers AI for canonical careers URL discovery and upserts the table.
5. Scraped jobs append/merge into `production_jobs` with `UNIQUE(company_id, url)` ensuring idempotency.

## Operational Notes
- **Selector overrides:** Use `POST /selectors/:companyId` with a JSON body matching `selectorSchema` to seed overrides manually.
- **Extension polling:** Extension should `GET /command` for instructions and `POST /html` with `{ html }` once data is captured.
- **Schema management:** `ensureSchema` runs lazily inside the worker before reads/writes; no explicit migrations required yet.
- **Testing:** `npm run lint` runs `tsc --noEmit` to type-check the worker.
- **Configuration:** Update `wrangler.toml` IDs (`database_id`, `kv id`) before deploying.
