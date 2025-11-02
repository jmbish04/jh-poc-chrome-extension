export type ToolHandler = (payload: unknown) => Promise<unknown> | unknown;

const registry = new Map<string, ToolHandler>();

export function registerTool(name: string, handler: ToolHandler): void {
  registry.set(name, handler);
}

registerTool('scrapeLinkedInJobs', async () => ({ jobs: [] }));

export function getToolHandler(name: string): ToolHandler | undefined {
  return registry.get(name);
}
