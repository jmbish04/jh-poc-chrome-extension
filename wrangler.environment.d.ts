import type { StageToProductionInput, StageToProductionResult } from "./types";

interface WorkflowDispatchResult {
  id: string;
}

declare module "cloudflare:workflows" {
  export interface WorkflowStep {
    <T>(name: string, handler: () => Promise<T> | T): Promise<T>;
    run<T>(name: string, handler: () => Promise<T> | T): Promise<T>;
  }

  export interface WorkflowEvent<T = unknown> {
    payload: T;
  }

  export interface WorkflowContext {
    executionId: string;
  }

  export interface WorkflowStub<Input = unknown> {
    dispatch(payload: Input): Promise<WorkflowDispatchResult>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Input = unknown, Output = unknown> {
    abstract run(event: Input, step: WorkflowStep, env: Env, ctx: WorkflowContext): Promise<Output>;
  }
}
