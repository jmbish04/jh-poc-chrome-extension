import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import type {
  Ai,
  D1Database,
  DurableObjectNamespace,
  DurableObjectState,
  ExportedHandlerScheduledHandler,
  Queue,
  VectorizeIndex,
  Workflows,
} from '@cloudflare/workers-types';

interface BrowserRenderingBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface AgentCommand {
  type: string;
  payload?: unknown;
  issuedAt?: string;
}

export interface ExtensionMessage {
  type: string;
  payload?: unknown;
  sentAt?: string;
}

export interface Env {
  AGENT_HUB: DurableObjectNamespace<AgentHub>;
  INGEST_QUEUE: Queue<IngestQueueMessage>;
  DEEP_SCRAPE_QUEUE: Queue<DeepScrapeMessage>;
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  WORKFLOWS: Workflows;
  AI: Ai;
  BROWSER: BrowserRenderingBinding;
  FALLBACK_AUTH_TOKEN?: string;
}

export interface IngestQueueMessage {
  kind: 'extension' | 'fallback';
  payload: unknown;
  receivedAt: string;
}

export interface DeepScrapeMessage {
  url: string;
  priority?: 'low' | 'normal' | 'high';
}

const app = new Hono<{ Bindings: Env }>();

app.get('/websocket', async (c) => {
  const id = c.env.AGENT_HUB.idFromName('global');
  const stub = c.env.AGENT_HUB.get(id);
  return stub.fetch(c.req.raw);
});

app.post('/api/v1/ingest/fallback', async (c) => {
  const authToken = c.env.FALLBACK_AUTH_TOKEN;
  if (authToken) {
    const header = c.req.header('authorization');
    if (!header || header !== `Bearer ${authToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch (error) {
    console.error('Failed to parse fallback payload', error);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  await c.env.INGEST_QUEUE.send({
    kind: 'fallback',
    payload,
    receivedAt: new Date().toISOString(),
  });

  return c.json({ ok: true }, 202);
});

export const fetch = app.fetch;

export const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  _controller,
  env,
  ctx,
) => {
  // Randomized dispatch to avoid flooding clients.
  const shouldDispatch = Math.random() > 0.5;
  if (!shouldDispatch) {
    return;
  }

  const command: AgentCommand = {
    type: 'workflow:heartbeat',
    payload: {
      note: 'Scheduled broadcast',
    },
    issuedAt: new Date().toISOString(),
  };

  ctx.waitUntil(broadcastCommand(env, command));
};

export async function broadcastCommand(env: Env, command: AgentCommand) {
  const id = env.AGENT_HUB.idFromName('global');
  const stub = env.AGENT_HUB.get(id);
  await stub.fetch('https://agent-hub.internal/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
}

export class AgentHub extends DurableObject<Env> {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly socketIds = new WeakMap<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    for (const socket of this.ctx.getWebSockets()) {
      this.ensureSocket(socket);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { url } = request;
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const socketId = crypto.randomUUID();

      this.socketIds.set(server, socketId);
      this.sockets.set(socketId, server);

      this.ctx.acceptWebSocket(server, [request]);
      return new Response(null, { status: 101, webSocket: client });
    }

    const pathname = new URL(url).pathname;
    if (request.method === 'POST' && pathname === '/broadcast') {
      let command: AgentCommand;
      try {
        command = await request.json<AgentCommand>();
      } catch (error) {
        console.error('Failed to parse broadcast command', error);
        return new Response('Invalid command', { status: 400 });
      }

      await this.broadcast(command);
      return new Response(null, { status: 202 });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketOpen(ws: WebSocket) {
    this.ensureSocket(ws);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const socketId = this.ensureSocket(ws);
    try {
      const text = typeof message === 'string'
        ? message
        : new TextDecoder().decode(message);
      const payload: unknown = JSON.parse(text);
      await this.env.INGEST_QUEUE.send({
        kind: 'extension',
        payload,
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to enqueue message from socket', socketId, error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const socketId = this.socketIds.get(ws);
    if (socketId) {
      this.sockets.delete(socketId);
      this.socketIds.delete(ws);
    }

    console.log('Socket closed', { socketId, code, reason, wasClean });
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const socketId = this.socketIds.get(ws);
    console.error('Socket error', { socketId, error });
    if (socketId) {
      this.sockets.delete(socketId);
      this.socketIds.delete(ws);
    }
  }

  private ensureSocket(ws: WebSocket): string {
    let socketId = this.socketIds.get(ws);
    if (!socketId) {
      socketId = crypto.randomUUID();
      this.socketIds.set(ws, socketId);
      this.sockets.set(socketId, ws);
    }
    return socketId;
  }

  private async broadcast(command: AgentCommand) {
    const serialized = JSON.stringify(command);
    const stale: string[] = [];

    for (const [socketId, socket] of this.sockets.entries()) {
      try {
        socket.send(serialized);
      } catch (error) {
        console.error('Failed to send command to socket', socketId, error);
        stale.push(socketId);
      }
    }

    for (const socketId of stale) {
      const socket = this.sockets.get(socketId);
      if (socket) {
        try {
          socket.close(1011, 'Stale socket');
        } catch (error) {
          console.error('Failed to close stale socket', socketId, error);
        }
      }
      this.sockets.delete(socketId);
    }
  }
}
