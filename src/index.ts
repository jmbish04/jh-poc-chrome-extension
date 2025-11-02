import { Hono } from 'hono';
import type { D1Database, DurableObjectNamespace, DurableObjectState, ExecutionContext, ScheduledEvent } from '@cloudflare/workers-types';

export interface Env {
  JOB_SCHEDULE_DB: D1Database;
  JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  LINKEDIN_SEARCH_URL?: string;
  LINKEDIN_LISTING_SELECTOR?: string;
  LINKEDIN_TITLE_SELECTOR?: string;
  LINKEDIN_COMPANY_SELECTOR?: string;
}

interface JobScheduleRow {
  id: string;
  next_run_timestamp: number;
  updated_at: number;
}

const JOB_SCHEDULE_ID = 'linkedin-jobs';

const app = new Hono<{ Bindings: Env }>();

app.get('/status', async (c) => {
  const row = await getJobSchedule(c.env.JOB_SCHEDULE_DB);

  return c.json({
    ok: true,
    schedule: row,
  });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduledDispatch(env));
  },
};

async function handleScheduledDispatch(env: Env): Promise<void> {
  const now = Date.now();
  const schedule = await getJobSchedule(env.JOB_SCHEDULE_DB);

  if (!schedule) {
    await bootstrapSchedule(env.JOB_SCHEDULE_DB, now);
    return;
  }

  if (now < schedule.next_run_timestamp) {
    console.log(
      `Job schedule not ready. next_run_timestamp=${schedule.next_run_timestamp}, now=${now}`,
    );
    return;
  }

  const payload = buildBroadcastPayload(env);
  const stub = env.JOB_COORDINATOR.get(env.JOB_COORDINATOR.idFromName('global'));
  const response = await stub.fetch('https://job-coordinator/broadcast', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to broadcast scrapeLinkedInJobs command: ${response.status} ${text}`);
  }

  const randomHours = 1 + Math.random() * 2; // between 1 and 3 hours
  const nextRun = now + Math.round(randomHours * 60 * 60 * 1000);

  await env.JOB_SCHEDULE_DB.prepare(
    `UPDATE job_schedule SET next_run_timestamp = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(nextRun, now, JOB_SCHEDULE_ID)
    .run();

  console.log(`Broadcasted scrapeLinkedInJobs command. next run scheduled at ${nextRun}.`);
}

async function getJobSchedule(db: D1Database): Promise<JobScheduleRow | null> {
  const row = await db
    .prepare(
      `SELECT id, next_run_timestamp, updated_at FROM job_schedule WHERE id = ? LIMIT 1`,
    )
    .bind(JOB_SCHEDULE_ID)
    .first<JobScheduleRow>();

  if (!row) {
    return null;
  }

  return {
    ...row,
    next_run_timestamp: Number(row.next_run_timestamp ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

async function bootstrapSchedule(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_schedule (id, next_run_timestamp, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(JOB_SCHEDULE_ID, now, now)
    .run();
}

function buildBroadcastPayload(env: Env) {
  return {
    command: 'scrapeLinkedInJobs',
    payload: {
      url:
        env.LINKEDIN_SEARCH_URL ??
        'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=United%20States',
      selectors: {
        listing: env.LINKEDIN_LISTING_SELECTOR ?? 'ul.jobs-search__results-list li',
        title: env.LINKEDIN_TITLE_SELECTOR ?? '.job-card-list__title',
        company: env.LINKEDIN_COMPANY_SELECTOR ?? '.job-card-container__company-name',
      },
    },
    dispatchedAt: Date.now(),
  } as const;
}

export class JobCoordinator {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const body = await readJson(request);

      if (!body || typeof body.command !== 'string') {
        return new Response('Invalid broadcast payload', { status: 400 });
      }

      await this.state.storage.put('lastBroadcast', {
        body,
        receivedAt: Date.now(),
      });

      console.log('Broadcast received by JobCoordinator', body);

      return Response.json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/last-dispatch') {
      const payload = await this.state.storage.get('lastBroadcast');
      return Response.json(payload ?? null);
    }

    return new Response('Not Found', { status: 404 });
  }
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch (error) {
    console.error('Failed to parse JSON payload from request', error);
    return null;
  }
}
