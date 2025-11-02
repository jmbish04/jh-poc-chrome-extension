import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { Bindings, StageToProductionInput, StagedJobRow, ProductionJobRow } from "../types.js";

const stageJobSchema = z.object({
  stagedJobId: z.string().uuid().optional(),
  companyName: z.string().min(1),
  companyUrl: z.string().url(),
  candidateName: z.string().min(1),
  candidateUrl: z.string().url(),
  roleTitle: z.string().min(1),
  roleDescription: z.string().min(1),
  notes: z.string().optional(),
});

type StageJobInput = z.infer<typeof stageJobSchema>;

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

app.post("/jobs/stage", async (c) => {
  const payload = await c.req.json<StageJobInput>().catch(() => {
    throw new HTTPException(400, { message: "Invalid JSON payload" });
  });

  const parsed = stageJobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: "Validation failed",
      cause: parsed.error.flatten(),
    });
  }

  const {
    stagedJobId: providedId,
    companyName,
    companyUrl,
    candidateName,
    candidateUrl,
    roleTitle,
    roleDescription,
    notes,
  } = parsed.data;

  const stagedJobId = providedId ?? crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO staged_jobs (
      id,
      company_name,
      company_url,
      candidate_name,
      candidate_url,
      role_title,
      role_description,
      notes,
      vector_id,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      company_name = excluded.company_name,
      company_url = excluded.company_url,
      candidate_name = excluded.candidate_name,
      candidate_url = excluded.candidate_url,
      role_title = excluded.role_title,
      role_description = excluded.role_description,
      notes = excluded.notes
    `,
  )
    .bind(
      stagedJobId,
      companyName,
      companyUrl,
      candidateName,
      candidateUrl,
      roleTitle,
      roleDescription,
      notes ?? null,
    )
    .run();

  const workflowPayload: StageToProductionInput = { stagedJobId };

  await c.env.STAGE_TO_PRODUCTION.dispatch(workflowPayload);

  return c.json({ stagedJobId, dispatched: true }, 202);
});

app.get("/jobs/:stagedJobId", async (c) => {
  const stagedJobId = c.req.param("stagedJobId");

  const stagedJob = (await c.env.DB.prepare(
    `SELECT * FROM staged_jobs WHERE id = ?1`,
  )
    .bind(stagedJobId)
    .first<StagedJobRow>()) ?? null;

  if (!stagedJob) {
    throw new HTTPException(404, { message: "Staged job not found" });
  }

  const productionJob = (await c.env.DB.prepare(
    `SELECT * FROM production_jobs WHERE staged_job_id = ?1 ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(stagedJobId)
    .first<ProductionJobRow>()) ?? null;

  const ai = productionJob ? JSON.parse(productionJob.ai_raw) : null;

  return c.json({
    staged: {
      id: stagedJob.id,
      companyName: stagedJob.company_name,
      companyUrl: stagedJob.company_url,
      candidateName: stagedJob.candidate_name,
      candidateUrl: stagedJob.candidate_url,
      roleTitle: stagedJob.role_title,
      roleDescription: stagedJob.role_description,
      notes: stagedJob.notes,
      createdAt: stagedJob.created_at,
    },
    production: productionJob
      ? {
          id: productionJob.id,
          stagedJobId: productionJob.staged_job_id,
          fitScore: productionJob.fit_score,
          salaryMin: productionJob.salary_min,
          salaryMax: productionJob.salary_max,
          salaryCurrency: productionJob.salary_currency,
          ai,
          createdAt: productionJob.created_at,
        }
      : null,
  });
});

app.onError((err, c) => {
  console.error("Unhandled error", err);
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  return c.json({ message: "Internal Server Error" }, 500);
});

app.notFound((c) => c.json({ message: "Not Found" }, 404));

export default app;
