# LinkedIn Job Scraper Scheduler

This Worker periodically broadcasts a `scrapeLinkedInJobs` command to a Durable Object so additional agents can harvest job data from LinkedIn search pages. Scheduling state is tracked in D1 to prevent duplicate work.

## Features

- Hourly cron (`0 * * * *`) with jittered (1–3 hour) rescheduling.
- Durable Object broadcast endpoint to fan out scrape commands.
- D1-backed `job_schedule` table (seeded via migration) to coordinate run cadence.
- Hono API exposing `/status` for debugging the persisted schedule.

## Environment Bindings

| Binding | Type | Purpose |
| --- | --- | --- |
| `JOB_SCHEDULE_DB` | D1 | Stores the `job_schedule` row controlling the cron timing. |
| `JOB_COORDINATOR` | Durable Object | Receives broadcast commands. |
| `LINKEDIN_SEARCH_URL` | (optional) string | Override the LinkedIn search URL included in broadcasts. |
| `LINKEDIN_LISTING_SELECTOR` | (optional) string | Override the CSS selector used to locate listings. |
| `LINKEDIN_TITLE_SELECTOR` | (optional) string | Override the CSS selector for job titles. |
| `LINKEDIN_COMPANY_SELECTOR` | (optional) string | Override the CSS selector for company names. |

## Development

### Install dependencies

```bash
npm install
```

### Run migrations locally

```bash
npx wrangler d1 migrations apply job-schedule-db --local
```

Durable Object classes are registered through wrangler migrations (`[[migrations]]` in wrangler.toml); deploy after adding new classes.

### Start the worker

```bash
npx wrangler dev
```

### Check schedule status

```bash
curl http://127.0.0.1:8787/status
```

## Deployment

```bash
npx wrangler deploy
```
