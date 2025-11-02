declare module 'cloudflare:workflows' {
  export interface WorkflowContext<Env = unknown> {
    env: Env;
  }

  export interface WorkflowStep {
    do<T>(name: string, handler: () => Promise<T> | T): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Input = unknown> {
    protected readonly env: Env;
    constructor(ctx: WorkflowContext<Env>);
    abstract run(event: Input, step: WorkflowStep): Promise<unknown>;
  }
}
