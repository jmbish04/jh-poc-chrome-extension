import { Hono } from 'hono';
import puppeteer, { Browser, Page } from '@cloudflare/puppeteer';
import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workflows';
import { z } from 'zod';

interface WorkflowStub<Input = unknown> {
  run(input: Input): Promise<unknown>;
}

interface Env {
  DB: D1Database;
  DEEP_SCRAPE_QUEUE: Queue<unknown>;
  SELECTOR_KV: KVNamespace;
  BROWSER: Fetcher;
  AI: AiBinding;
  SELF_HEALING: WorkflowStub<SelfHealingWorkflowInput>;
  EXTENSION_BRIDGE: DurableObjectNamespace;
}

interface AiBinding {
  run<TInput, TResult = unknown>(model: string, input: TInput): Promise<TResult>;
}

interface SelfHealingWorkflowInput {
  companyId: string;
  url: string;
  fallbackHtml: string;
  existingSelectors?: SelectorConfig;
}

type Nullable<T> = T | null | undefined;

type ScrapedJob = {
  title: string;
  url: string;
  location?: string;
  snippet?: string;
};

type CompanyConfigRow = {
  company_id: string;
  careers_page_url: Nullable<string>;
  override_selectors: Nullable<string>;
};

type SelectorConfig = z.infer<typeof selectorSchema>;

type QueuePayload = z.infer<typeof queuePayloadSchema>;

const selectorSchema = z.object({
  jobContainer: z.string().min(1),
  title: z.string().min(1),
  link: z.string().min(1),
  location: z.string().min(1).optional(),
  description: z.string().min(1).optional()
});

const queuePayloadSchema = z.object({
  companyId: z.string().min(1),
  linkedinUrl: z.string().url(),
  metadata: z.record(z.any()).optional(),
  overrideSelectors: selectorSchema.partial().optional()
});

const DEFAULT_SELECTORS: SelectorConfig = {
  jobContainer: '[data-job-card], .job-card, li, article',
  title: 'a, h2, h3',
  link: 'a',
  location: '.job-location, .location, [data-location]',
  description: 'p, .description'
};

const SELECTOR_KV_PREFIX = 'selectors';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/configs/:companyId', async (c) => {
  const companyId = c.req.param('companyId');
  await ensureSchema(c.env);
  const row = (await c.env.DB.prepare(
    'SELECT company_id, careers_page_url, override_selectors FROM company_configs WHERE company_id = ?'
  )
    .bind(companyId)
    .first()) as CompanyConfigRow | null;

  if (!row) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }

  const selectors = parseSelectorPayload(row.override_selectors);

  return c.json({
    companyId: row.company_id,
    careersPageUrl: row.careers_page_url,
    overrideSelectors: selectors
  });
});

app.get('/selectors/:companyId', async (c) => {
  const companyId = c.req.param('companyId');
  const kvValue = await c.env.SELECTOR_KV.get(buildSelectorKvKey(companyId));

  if (!kvValue) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }

  const selectors = parseSelectorPayload(kvValue);
  if (!selectors) {
    return c.json({ error: 'INVALID_SELECTORS' }, 422);
  }

  return c.json({ companyId, selectors });
});

app.post('/selectors/:companyId', async (c) => {
  const companyId = c.req.param('companyId');
  const payload = await c.req.json();
  const parsed = selectorSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json({ error: 'INVALID_PAYLOAD', details: parsed.error.flatten() }, 422);
  }

  const now = new Date().toISOString();
  const serialized = JSON.stringify(parsed.data);

  await c.env.SELECTOR_KV.put(buildSelectorKvKey(companyId), serialized);
  await ensureSchema(c.env);
  await c.env.DB.prepare(
    `INSERT INTO company_configs (company_id, careers_page_url, override_selectors, updated_at)
     VALUES (?, COALESCE((SELECT careers_page_url FROM company_configs WHERE company_id = ?), NULL), ?, ?)
     ON CONFLICT(company_id) DO UPDATE SET override_selectors = excluded.override_selectors, updated_at = excluded.updated_at`
  )
    .bind(companyId, companyId, serialized, now)
    .run();

  return c.json({ ok: true });
});

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS company_configs (
      company_id TEXT PRIMARY KEY,
      careers_page_url TEXT,
      override_selectors TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS production_jobs (
      job_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      url TEXT NOT NULL,
      snippet TEXT,
      scraped_at TEXT NOT NULL,
      raw_payload TEXT,
      UNIQUE(company_id, url)
    );
  `);
}

function parseSelectorPayload(serialized: Nullable<string>): SelectorConfig | undefined {
  if (!serialized) {
    return undefined;
  }
  try {
    const parsed = selectorSchema.safeParse(typeof serialized === 'string' ? JSON.parse(serialized) : serialized);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    console.error('Failed to parse selector payload', error);
    return undefined;
  }
}

function mergeSelectors(overrides?: Partial<SelectorConfig> | null, fallback: SelectorConfig = DEFAULT_SELECTORS): SelectorConfig {
  if (!overrides) {
    return fallback;
  }
  return {
    ...fallback,
    ...overrides
  };
}

async function handleQueueMessage(message: Message<unknown>, env: Env): Promise<void> {
  const parsed = queuePayloadSchema.safeParse(message.body);
  if (!parsed.success) {
    console.error('Invalid queue payload', parsed.error);
    message.ack();
    return;
  }

  const payload: QueuePayload = parsed.data;
  await ensureSchema(env);

  const configRow = (await env.DB.prepare(
    'SELECT company_id, careers_page_url, override_selectors FROM company_configs WHERE company_id = ?'
  )
    .bind(payload.companyId)
    .first()) as CompanyConfigRow | null;

  let selectors: SelectorConfig | undefined;

  if (payload.overrideSelectors) {
    selectors = mergeSelectors(payload.overrideSelectors);
  }

  if (!selectors && configRow?.override_selectors) {
    selectors = parseSelectorPayload(configRow.override_selectors);
  }

  if (!selectors) {
    const kvValue = await env.SELECTOR_KV.get(buildSelectorKvKey(payload.companyId));
    selectors = parseSelectorPayload(kvValue);
  }

  if (!selectors) {
    selectors = DEFAULT_SELECTORS;
  }

  const targetUrl = configRow?.careers_page_url ?? payload.linkedinUrl;

  const browser: Browser = await puppeteer.launch(env.BROWSER);
  const page: Page = await browser.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle0' });
    await page.waitForTimeout(1000);

    const html = await page.content();
    const extracted = await extractJobsFromPage(page, selectors);
    const now = new Date().toISOString();

    if ((!configRow || !configRow.careers_page_url) && html) {
      const canonical = await deriveCanonicalViaAI(env, html, targetUrl);
      if (canonical) {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO company_configs (company_id, careers_page_url, override_selectors, updated_at)
           VALUES (?, ?, COALESCE(?, override_selectors), ?)`
        )
          .bind(payload.companyId, canonical, selectors ? JSON.stringify(selectors) : null, now)
          .run();
      }
    }

    if (extracted.length === 0) {
      await triggerSelfHealing(env, {
        companyId: payload.companyId,
        url: targetUrl,
        fallbackHtml: html,
        existingSelectors: selectors
      });
      message.ack();
      return;
    }

    await storeJobs(env, payload.companyId, targetUrl, extracted, now);
    message.ack();
  } catch (error) {
    console.error('Failed to process deep scrape message', error);
    message.retry();
  } finally {
    await page.close();
    await browser.close();
  }
}

async function extractJobsFromPage(page: Page, selectors: SelectorConfig): Promise<ScrapedJob[]> {
  const rawJobs = await page.evaluate((sel) => {
    const containers = Array.from(document.querySelectorAll(sel.jobContainer)) as Element[];
    return containers
      .map((container) => {
        const titleNode = sel.title ? container.querySelector(sel.title) : null;
        const linkNode = sel.link ? container.querySelector(sel.link) : null;
        const locationNode = sel.location ? container.querySelector(sel.location) : null;
        const descriptionNode = sel.description ? container.querySelector(sel.description) : null;

        const title = titleNode?.textContent?.trim() ?? '';
        const href = (linkNode instanceof HTMLAnchorElement ? linkNode.href : linkNode?.getAttribute('href')) ?? '';
        const location = locationNode?.textContent?.trim() ?? '';
        const snippet = descriptionNode?.textContent?.trim() ?? container.textContent?.trim()?.slice(0, 400) ?? '';

        return { title, href, location, snippet };
      })
      .filter((job) => job.title && job.href);
  }, selectors);

  return rawJobs.map((job) => ({
    title: job.title,
    url: job.href,
    location: job.location || undefined,
    snippet: job.snippet || undefined
  }));
}

async function storeJobs(env: Env, companyId: string, baseUrl: string, jobs: ScrapedJob[], scrapedAt: string): Promise<void> {
  for (const job of jobs) {
    try {
      const absoluteUrl = normalizeUrl(job.url, baseUrl);
      const payload = JSON.stringify(job);
      await env.DB.prepare(
        `INSERT INTO production_jobs (job_id, company_id, title, location, url, snippet, scraped_at, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, url) DO UPDATE SET
           title = excluded.title,
           location = excluded.location,
           snippet = excluded.snippet,
           scraped_at = excluded.scraped_at,
           raw_payload = excluded.raw_payload`
      )
        .bind(
          crypto.randomUUID(),
          companyId,
          job.title,
          job.location || null,
          absoluteUrl,
          job.snippet || null,
          scrapedAt,
          payload
        )
        .run();
    } catch (error) {
      console.error('Failed to persist job', { companyId, job, error });
    }
  }
}

async function deriveCanonicalViaAI(env: Env, html: string, fallbackUrl: string): Promise<string | null> {
  try {
    const truncated = html.slice(0, 15000);
    const aiResponse = await env.AI.run<Record<string, unknown>, { response?: string }>('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You extract canonical careers URLs from HTML pages. Respond with JSON: {"canonical_url": ""}.'
        },
        {
          role: 'user',
          content: `HTML (truncated): ${truncated}\nLinkedIn fallback: ${fallbackUrl}`
        }
      ],
      max_output_tokens: 256
    });

    const text = aiResponse?.response ?? '';
    const json = extractJson(text);
    const parsed = JSON.parse(json) as { canonical_url?: string };
    if (parsed.canonical_url && isValidUrl(parsed.canonical_url)) {
      return parsed.canonical_url;
    }
  } catch (error) {
    console.error('Failed to derive canonical URL via AI', error);
  }
  return null;
}

async function triggerSelfHealing(env: Env, input: SelfHealingWorkflowInput): Promise<void> {
  try {
    await env.SELF_HEALING.run(input);
  } catch (error) {
    console.error('Failed to trigger self-healing workflow', error);
  }
}

function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON payload detected');
  }
  return text.slice(start, end + 1);
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(candidate: string, baseUrl: string): string {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return candidate;
  }
}

function buildSelectorKvKey(companyId: string): string {
  return `${SELECTOR_KV_PREFIX}:${companyId}`;
}

async function suggestSelectorsWithAI(env: Env, html: string, url: string, previous?: SelectorConfig): Promise<SelectorConfig | null> {
  try {
    const truncated = html.slice(0, 20000);
    const response = await env.AI.run<Record<string, unknown>, { response?: string }>('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'Return CSS selectors in JSON with keys jobContainer, title, link, location (optional), description (optional).'
        },
        {
          role: 'user',
          content: `Current URL: ${url}\nExisting selectors: ${previous ? JSON.stringify(previous) : 'none'}\nHTML (truncated): ${truncated}`
        }
      ],
      max_output_tokens: 400
    });

    const text = response?.response ?? '';
    const rawJson = extractJson(text);
    const parsed = JSON.parse(rawJson);
    const validation = selectorSchema.safeParse(parsed);
    if (validation.success) {
      return validation.data;
    }
    console.warn('AI selectors failed validation', validation.error);
  } catch (error) {
    console.error('Failed to suggest selectors via AI', error);
  }
  return null;
}

export class SelfHealingWorkflow extends WorkflowEntrypoint<Env, SelfHealingWorkflowInput> {
  async run(event: SelfHealingWorkflowInput, step: WorkflowStep): Promise<void> {
    const { companyId, url, fallbackHtml, existingSelectors } = event;

    await step.do('dispatch-extension-command', async () => {
      const id = this.env.EXTENSION_BRIDGE.idFromName(companyId);
      const stub = this.env.EXTENSION_BRIDGE.get(id);
      await stub.fetch('https://extension-bridge/command', {
        method: 'POST',
        body: JSON.stringify({ action: 'getFullPageHTML', url }),
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const html = await step.do('await-extension-html', async () => {
      const id = this.env.EXTENSION_BRIDGE.idFromName(companyId);
      const stub = this.env.EXTENSION_BRIDGE.get(id);
      const response = await stub.fetch('https://extension-bridge/html');
      if (response.ok) {
        return await response.text();
      }
      return fallbackHtml;
    });

    const selectors = await step.do('ai-selector-suggestion', async () => {
      const suggested = await suggestSelectorsWithAI(this.env, html, url, existingSelectors);
      return suggested ?? existingSelectors ?? DEFAULT_SELECTORS;
    });

    const serialized = JSON.stringify(selectors);

    await step.do('persist-selector-updates', async () => {
      await this.env.SELECTOR_KV.put(buildSelectorKvKey(companyId), serialized);
      await ensureSchema(this.env);
      await this.env.DB.prepare(
        `INSERT INTO company_configs (company_id, careers_page_url, override_selectors, updated_at)
         VALUES (?, COALESCE((SELECT careers_page_url FROM company_configs WHERE company_id = ?), ?), ?, ?)
         ON CONFLICT(company_id) DO UPDATE SET override_selectors = excluded.override_selectors, updated_at = excluded.updated_at`
      )
        .bind(companyId, companyId, url, serialized, new Date().toISOString())
        .run();
    });
  }
}

export class ExtensionBridge {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/command':
        if (request.method === 'GET') {
          const command = await this.state.storage.get<string>('command');
          return command
            ? new Response(command, { headers: { 'Content-Type': 'application/json' } })
            : new Response('Not Found', { status: 404 });
        }

        if (request.method === 'POST') {
          const body = await request.text();
          await this.state.storage.put('command', body);
          return new Response('OK');
        }
        break;
      case '/html':
        if (request.method === 'POST') {
          const payload = await request.json<{ html: string }>();
          await this.state.storage.put('html', payload.html);
          return Response.json({ ok: true });
        }
        if (request.method === 'GET') {
          const html = await this.state.storage.get<string>('html');
          if (!html) {
            return new Response('Not Found', { status: 404 });
          }
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        break;
      default:
        return new Response('Not Found', { status: 404 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      ctx.waitUntil(
        handleQueueMessage(message, env).catch((error) => {
          console.error('Unhandled queue error', error);
          message.retry();
        })
      );
    }
  }
};
