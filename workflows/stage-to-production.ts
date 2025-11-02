import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workflows";
import { z } from "zod";

import type {
  StageToProductionInput,
  StageToProductionResult,
  WorkflowBindings,
  StagedJobRow,
  DeepScrapePayload,
} from "../types.js";

const evaluationSchema = z.object({
  fit_score: z.number().min(0).max(10),
  salary_min: z.number().nullable().optional(),
  salary_max: z.number().nullable().optional(),
  salary_currency: z.string().nullable().optional(),
  notes: z.string().optional(),
});

type Evaluation = z.infer<typeof evaluationSchema>;

const DEFAULT_SALARY = {
  salary_min: null,
  salary_max: null,
  salary_currency: null,
};

function buildEmbeddingText(staged: StagedJobRow): string {
  const segments = [
    `Company: ${staged.company_name}`,
    `Company URL: ${staged.company_url}`,
    `Candidate: ${staged.candidate_name}`,
    `Candidate URL: ${staged.candidate_url}`,
    `Role: ${staged.role_title}`,
    `Description: ${staged.role_description}`,
  ];
  if (staged.notes) {
    segments.push(`Notes: ${staged.notes}`);
  }
  return segments.join("\n");
}

function extractAssistantText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }
  const result = response as { result?: unknown; response?: unknown };
  const candidate = ("result" in result ? result.result : result.response) as
    | { output_text?: string[]; messages?: Array<{ content: Array<{ text?: string }> }> }
    | undefined;

  if (!candidate) {
    return "";
  }

  const outputText = (candidate as { output_text?: string[] }).output_text;
  if (Array.isArray(outputText) && outputText.length > 0) {
    return outputText.join("\n");
  }

  const messages = (candidate as { messages?: Array<{ content: Array<{ text?: string }> }> }).messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message?.content) continue;
      for (const part of message.content) {
        if (typeof part?.text === "string" && part.text.trim().length > 0) {
          return part.text;
        }
      }
    }
  }

  return "";
}

async function ensureVector(step: WorkflowStep, env: WorkflowBindings, staged: StagedJobRow, embeddingText: string): Promise<string> {
  return step.run("vectorize staged job", async () => {
    const vectorId = staged.vector_id ?? crypto.randomUUID();

    const embeddingResponse = (await env.run.AI("@cf/baai/bge-large-en-v1.5", {
      text: [embeddingText],
    })) as { data?: number[][] };

    const values = embeddingResponse.data?.[0];
    if (!values) {
      throw new Error("Embedding model did not return a vector");
    }

    await env.VECTORIZE.upsert([
      {
        id: vectorId,
        values,
        metadata: {
          stagedJobId: staged.id,
          companyName: staged.company_name,
          roleTitle: staged.role_title,
        },
      },
    ]);

    if (!staged.vector_id) {
      await env.DB.prepare(`UPDATE staged_jobs SET vector_id = ?1 WHERE id = ?2`)
        .bind(vectorId, staged.id)
        .run();
    }

    return vectorId;
  });
}

async function evaluateFit(step: WorkflowStep, env: WorkflowBindings, staged: StagedJobRow): Promise<{ evaluation: Evaluation; raw: string }> {
  return step.run("evaluate job fit", async () => {
    const prompt = `You are an experienced technical recruiter. Review the company and candidate information below and respond with strict JSON.\n\n` +
      `Company Name: ${staged.company_name}\nCompany URL: ${staged.company_url}\n` +
      `Candidate Name: ${staged.candidate_name}\nCandidate URL: ${staged.candidate_url}\n` +
      `Role Title: ${staged.role_title}\nRole Description: ${staged.role_description}\n` +
      `Notes: ${staged.notes ?? "(none)"}\n\n` +
      `Return a JSON object with keys: fit_score (0-10), salary_min, salary_max, salary_currency, notes. Use null when salary data is missing.`;

    const aiResponse = await env.run.AI("@cf/openai/gpt-4o-mini", {
      messages: [
        {
          role: "system",
          content: "You evaluate hiring fit and always respond with JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
    });

    const text = extractAssistantText(aiResponse);
    if (!text) {
      throw new Error("AI response did not contain text");
    }

    const parsed = evaluationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`AI response schema mismatch: ${parsed.error.message}`);
    }

    const { fit_score, salary_min, salary_max, salary_currency, notes } = parsed.data;

    return {
      evaluation: {
        fit_score,
        salary_min: salary_min ?? null,
        salary_max: salary_max ?? null,
        salary_currency: salary_currency ?? null,
        notes,
      },
      raw: text,
    };
  });
}

export class StageToProductionWorkflow extends WorkflowEntrypoint<WorkflowBindings, StageToProductionInput, StageToProductionResult> {
  override async run(event: StageToProductionInput, step: WorkflowStep, env: WorkflowBindings): Promise<StageToProductionResult> {
    const stagedJob = await step.run("load staged job", async () => {
      const record = await env.DB.prepare(`SELECT * FROM staged_jobs WHERE id = ?1`)
        .bind(event.stagedJobId)
        .first<StagedJobRow>();
      if (!record) {
        throw new Error(`Staged job ${event.stagedJobId} not found`);
      }
      return record;
    });

    const embeddingText = buildEmbeddingText(stagedJob);
    const vectorId = await ensureVector(step, env, stagedJob, embeddingText);

    const { evaluation, raw } = await evaluateFit(step, env, stagedJob);

    const productionJobId = await step.run("persist production job", async () => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO production_jobs (
          id,
          staged_job_id,
          fit_score,
          salary_min,
          salary_max,
          salary_currency,
          ai_raw,
          created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))`,
      )
        .bind(
          id,
          stagedJob.id,
          evaluation.fit_score,
          evaluation.salary_min ?? DEFAULT_SALARY.salary_min,
          evaluation.salary_max ?? DEFAULT_SALARY.salary_max,
          evaluation.salary_currency ?? DEFAULT_SALARY.salary_currency,
          JSON.stringify({
            vectorId,
            embeddingText,
            evaluation,
            raw,
          }),
        )
        .run();
      return id;
    });

    if (evaluation.fit_score > 8) {
      await step.run("enqueue deep scrape", async () => {
        const payload: DeepScrapePayload = {
          stagedJobId: stagedJob.id,
          productionJobId,
          companyUrl: stagedJob.company_url,
          candidateUrl: stagedJob.candidate_url,
        };
        await env.DEEP_SCRAPE_QUEUE.send(payload);
      });
    }

    return {
      productionJobId,
      fitScore: evaluation.fit_score,
      salaryMin: evaluation.salary_min ?? null,
      salaryMax: evaluation.salary_max ?? null,
      salaryCurrency: evaluation.salary_currency ?? null,
    };
  }
}
