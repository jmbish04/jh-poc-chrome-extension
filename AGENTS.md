Agent Overview
• Name: Agent Hub Durable Object
• Purpose: Coordinate WebSocket clients (browser extensions) and relay commands/events via Cloudflare Queues.
• Class: AgentHub (src/index.ts)
• Bindings: AGENT_HUB (Durable Object), INGEST_QUEUE, DEEP_SCRAPE_QUEUE, DB, VECTORIZE, WORKFLOWS, AI, BROWSER
• Dependencies: Hono router, Cloudflare Durable Objects, Queues, Workers AI (reserved), Browser Rendering (reserved)
• Migration Tag: v1
• Usage Example:
  ```ts
  import { broadcastCommand } from './src/index';
  await broadcastCommand(env, { type: 'ping' });
  ```

Worker Surface
- `GET /websocket`: Retrieves the `AgentHub` Durable Object stub and forwards the request to establish a WebSocket session.
- `POST /api/v1/ingest/fallback`: Optional Bearer token auth via `FALLBACK_AUTH_TOKEN`; enqueues JSON payloads onto `INGEST_QUEUE` with `kind: "fallback"`.
- `scheduled` handler: Randomized broadcast (50% chance) using `broadcastCommand` to push a heartbeat command to all connected clients.

Durable Object Behavior (`AgentHub`)
- Accepts WebSocket connections via `this.ctx.acceptWebSocket` and tracks active sockets in a `Map<string, WebSocket>`.
- Handles `webSocketMessage` by parsing JSON and pushing the payload to `INGEST_QUEUE` with `kind: "extension"`.
- Provides internal `/broadcast` endpoint used by `broadcastCommand` helper to send commands to all sockets, removing stale sockets on failure.
- Implements `webSocketClose` and `webSocketError` for cleanup and logging.

Queues & Integrations
- `INGEST_QUEUE`: Receives both fallback HTTP payloads and extension WebSocket messages for asynchronous processing.
- `DEEP_SCRAPE_QUEUE`: Reserved for future deep-scrape orchestration (producer binding configured).
- `DB` (D1), `VECTORIZE`, `WORKFLOWS`, `AI`, and `BROWSER` bindings are provisioned for downstream agent workflows and must be configured in `wrangler.toml` before deployment.

Testing & Usage
- Establish a WebSocket session via `/websocket` (upgrade handled by Durable Object).
- Trigger fallback ingest: `curl -X POST https://<worker>/api/v1/ingest/fallback -H "Content-Type: application/json" -d '{"events":[]}'` (include `Authorization: Bearer <token>` when configured).
- Cron-triggered broadcasts rely on Workers Cron Triggers hitting the exported `scheduled` handler.
