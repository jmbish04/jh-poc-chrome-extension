import { Hono } from 'hono';

type QueueMessageBody = IngestMessage | string | ArrayBuffer;

export interface Env {
  DB: D1Database;
  AI: AiBinding;
  SELF_HEAL_WORKFLOW: WorkflowDispatcher;
}

interface Message<T = unknown> {
  id: string;
  body: T;
  timestamp: number;
}

interface QueueBatch<T = unknown> {
  queue: string;
  messages: Message<T>[];
  retry(message: Message<T>): void;
}

interface IngestMessage {
  id?: string;
  companyId: string;
  sourceUrl: string;
  selectors: string[];
  data: unknown[];
  receivedAt?: string;
}

interface NormalizedJob {
  jobId: string;
  companyId: string;
  rawIngestId: string;
  sourceUrl: string;
  title: string;
  location?: string;
  department?: string;
  metadata: Record<string, unknown>;
}

interface AiBinding {
  run<TModelInput extends Record<string, unknown>, TModelOutput = unknown>(
    model: string,
    options: TModelInput
  ): Promise<TModelOutput>;
}

interface WorkflowDispatcher {
  createRun(input: WorkflowRunInput): Promise<WorkflowRunResult>;
}

interface WorkflowRunInput {
  params?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface WorkflowRunResult {
  id: string;
  status: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    ok: true,
    service: 'jh-poc-chrome-extension worker',
    timestamp: new Date().toISOString(),
  })
);

app.post('/healthcheck', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT 1 as success').first<{ success: number } | null>();
    return c.json({ ok: result?.success === 1 });
  } catch (error) {
    console.error('Healthcheck failed', error);
    return c.json({ ok: false, error: (error as Error).message }, 500);
  }
});

async function handleQueueMessage(message: Message<QueueMessageBody>, env: Env): Promise<void> {
  const parsed = parseMessageBody(message);
  validateMessage(parsed);

  const rawIngestId = parsed.id ?? crypto.randomUUID();
  await insertRawIngest(env, rawIngestId, parsed);

  if (parsed.data.length === 0) {
    await enqueueSelfHealingWorkflow(env, parsed, rawIngestId);
    return;
  }

  const normalizedJobs = normalizeDataset(parsed, rawIngestId);
  await stageJobs(env, normalizedJobs);
  await triggerAnalysisPipeline(env, normalizedJobs, parsed);
}

function parseMessageBody(message: Message<QueueMessageBody>): IngestMessage {
  const body = message.body;

  if (typeof body === 'string') {
    return JSON.parse(body) as IngestMessage;
  }

  if (body instanceof ArrayBuffer) {
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(body)) as IngestMessage;
  }

  return body as IngestMessage;
}

function validateMessage(message: IngestMessage): void {
  if (!message) {
    throw new Error('Queue message is empty');
  }

  if (typeof message.companyId !== 'string' || message.companyId.length === 0) {
    throw new Error('Invalid companyId in ingest payload');
  }

  if (typeof message.sourceUrl !== 'string' || message.sourceUrl.length === 0) {
    throw new Error('Invalid sourceUrl in ingest payload');
  }

  if (!Array.isArray(message.selectors)) {
    throw new Error('Invalid selectors in ingest payload');
  }

  if (!Array.isArray(message.data)) {
    throw new Error('Invalid data array in ingest payload');
  }
}

async function insertRawIngest(env: Env, rawIngestId: string, message: IngestMessage): Promise<void> {
  const statement = env.DB.prepare(
    `INSERT INTO raw_ingest (id, company_id, source_url, selectors, payload, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, CURRENT_TIMESTAMP))`
  );

  await statement
    .bind(
      rawIngestId,
      message.companyId,
      message.sourceUrl,
      JSON.stringify(message.selectors),
      JSON.stringify(message.data),
      message.receivedAt
    )
    .run();
}

async function enqueueSelfHealingWorkflow(env: Env, message: IngestMessage, rawIngestId: string): Promise<void> {
  try {
    await env.SELF_HEAL_WORKFLOW.createRun({
      params: {
        companyId: message.companyId,
        sourceUrl: message.sourceUrl,
        selectors: message.selectors,
        rawIngestId,
        triggeredAt: new Date().toISOString(),
        reason: 'EMPTY_DATASET',
      },
      metadata: {
        type: 'self-heal-ingest',
      },
    });
  } catch (error) {
    console.error('Failed to trigger self-healing workflow', {
      companyId: message.companyId,
      sourceUrl: message.sourceUrl,
      error,
    });
    throw error;
  }
}

function normalizeDataset(message: IngestMessage, rawIngestId: string): NormalizedJob[] {
  return message.data.map((entry) => {
    const base: Record<string, unknown> = isObject(entry) ? (entry as Record<string, unknown>) : { raw: entry };

    const jobId = typeof base.id === 'string' && base.id.length > 0 ? (base.id as string) : crypto.randomUUID();
    const title = typeof base.title === 'string' && base.title.length > 0 ? (base.title as string) : 'Untitled Role';
    const location = typeof base.location === 'string' ? (base.location as string) : undefined;
    const department = typeof base.department === 'string' ? (base.department as string) : undefined;

    return {
      jobId,
      companyId: message.companyId,
      rawIngestId,
      sourceUrl: message.sourceUrl,
      title,
      location,
      department,
      metadata: base,
    } satisfies NormalizedJob;
  });
}

async function stageJobs(env: Env, jobs: NormalizedJob[]): Promise<void> {
  if (jobs.length === 0) {
    return;
  }

  const statements = jobs.map((job) =>
    env.DB.prepare(
      `INSERT INTO staged_jobs (id, raw_ingest_id, company_id, source_url, title, location, department, payload, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staged')`
    ).bind(
      job.jobId,
      job.rawIngestId,
      job.companyId,
      job.sourceUrl,
      job.title,
      job.location,
      job.department,
      JSON.stringify(job.metadata)
    )
  );

  await env.DB.batch(statements);
}

async function triggerAnalysisPipeline(env: Env, jobs: NormalizedJob[], message: IngestMessage): Promise<void> {
  try {
    const preview = jobs.slice(0, 3).map((job) => ({ title: job.title, location: job.location }));
    await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are an assistant that analyses job ingestion data for anomalies and categorisation.',
        },
        {
          role: 'user',
          content: JSON.stringify({ companyId: message.companyId, sample: preview, total: jobs.length }),
        },
      ],
    });
  } catch (error) {
    console.error('Worker AI analysis pipeline failed', {
      companyId: message.companyId,
      sourceUrl: message.sourceUrl,
      error,
    });
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export default {
  fetch: app.fetch,
  queue: async (batch: QueueBatch<QueueMessageBody>, env: Env): Promise<void> => {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(message, env);
      } catch (error) {
        console.error('Failed to process ingest message', {
          messageId: message.id,
          error,
        });
        batch.retry(message);
      }
    }
  },
};
