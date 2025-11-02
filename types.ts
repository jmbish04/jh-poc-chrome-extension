import type { WorkflowStub } from "cloudflare:workflows";

export interface StageToProductionInput {
  stagedJobId: string;
}

export interface StageToProductionResult {
  productionJobId: string;
  fitScore: number;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}

export interface DeepScrapePayload {
  stagedJobId: string;
  productionJobId: string;
  companyUrl: string;
  candidateUrl: string;
}

export interface StagedJobRow {
  id: string;
  company_name: string;
  company_url: string;
  candidate_name: string;
  candidate_url: string;
  role_title: string;
  role_description: string;
  notes: string | null;
  vector_id: string | null;
  created_at: string;
}

export interface ProductionJobRow {
  id: string;
  staged_job_id: string;
  fit_score: number;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  ai_raw: string;
  created_at: string;
}

export interface Bindings {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  STAGE_TO_PRODUCTION: WorkflowStub<StageToProductionInput>;
  DEEP_SCRAPE_QUEUE: Queue<DeepScrapePayload>;
}

export type WorkflowBindings = Omit<Bindings, "STAGE_TO_PRODUCTION"> & {
  run: {
    AI: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
};
