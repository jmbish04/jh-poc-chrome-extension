Agent Overview
    •   Name: JobCoordinator
    •   Purpose: Receives broadcast commands from the scheduler and persists the last dispatch for coordination / debugging.
    •   Class: JobCoordinator (src/index.ts)
    •   Bindings: Durable Object namespace `JOB_COORDINATOR`, D1 database `JOB_SCHEDULE_DB`
    •   Dependencies: Hono (request routing), Cloudflare D1, Durable Objects
    •   Migration Tag: migrations/0001_job_schedule.sql
    •   Usage Example: Scheduler issues `POST` https://job-coordinator/broadcast with `{ "command": "scrapeLinkedInJobs", ... }` payload via Durable Object stub.

Notes
    •   Scheduled cron `0 * * * *` reads `job_schedule` from D1. If the stored `next_run_timestamp` is in the future the job exits early. Otherwise it dispatches `scrapeLinkedInJobs` to the JobCoordinator Durable Object and writes a jittered (1-3 hours) next run time back to D1.
    •   Update bindings in wrangler.toml and this manifest together when adding new storage or agents.
