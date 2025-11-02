import { getToolHandler } from '../../tools';

const WORKER_WEBSOCKET_URL = 'wss://colbyadmin-agent-worker.hacolby.workers.dev/websocket';
const FALLBACK_INGEST_URL = 'https://colbyadmin-agent-worker.hacolby.workers.dev/api/v1/ingest/fallback';
const RECONNECT_DELAY_MS = 5_000;
const FALLBACK_ALARM_NAME = 'fallbackScrape';
const FALLBACK_INTERVAL_MINUTES = 240;

type CommandName = 'scrapeLinkedInJobs' | string;

type WorkerCommandMessage = {
  command: CommandName;
  payload?: unknown;
  requestId?: string;
};

type WorkerResponsePayload = {
  command: CommandName;
  requestId?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

let socket: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

const logPrefix = '[background::worker]';

const clearReconnectTimeout = () => {
  if (reconnectTimeout !== null) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
};

const scheduleReconnect = () => {
  clearReconnectTimeout();
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectToWorker();
  }, RECONNECT_DELAY_MS);
};

async function postFallbackIngest(payload: string): Promise<void> {
  try {
    await fetch(FALLBACK_INGEST_URL, {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
      },
    });
  } catch (error) {
    console.error(`${logPrefix} Failed to post fallback ingest`, error);
  }
}

const sendThroughSocket = async (payload: WorkerResponsePayload): Promise<void> => {
  const serialized = JSON.stringify(payload);

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn(`${logPrefix} Socket not open, using fallback ingest`);
    await postFallbackIngest(serialized);
    return;
  }

  try {
    socket.send(serialized);
  } catch (error) {
    console.error(`${logPrefix} Failed to send message over socket`, error);
    await postFallbackIngest(serialized);
  }
};

const handleToolExecution = async (command: CommandName, message: WorkerCommandMessage) => {
  const handler = getToolHandler(command);

  if (!handler) {
    await sendThroughSocket({
      command,
      requestId: message.requestId,
      ok: false,
      error: `No tool handler registered for command: ${command}`,
    });
    return;
  }

  try {
    const result = await Promise.resolve(handler(message.payload));
    await sendThroughSocket({
      command,
      requestId: message.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    await sendThroughSocket({
      command,
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export function connectToWorker(): WebSocket | null {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.info(`${logPrefix} WebSocket already ${socket.readyState === WebSocket.OPEN ? 'open' : 'connecting'}`);
    return socket;
  }

  console.info(`${logPrefix} Connecting to worker WebSocket at ${WORKER_WEBSOCKET_URL}`);
  socket = new WebSocket(WORKER_WEBSOCKET_URL);

  socket.onopen = () => {
    console.info(`${logPrefix} WebSocket connection established`);
    clearReconnectTimeout();
  };

  socket.onerror = (event) => {
    console.error(`${logPrefix} WebSocket error`, event);
  };

  socket.onclose = (event) => {
    console.warn(`${logPrefix} WebSocket closed`, event);
    socket = null;
    scheduleReconnect();
  };

  socket.onmessage = async (event) => {
    let message: WorkerCommandMessage | null = null;

    try {
      message = JSON.parse(event.data as string);
    } catch (error) {
      console.error(`${logPrefix} Unable to parse message from worker`, error, event.data);
      return;
    }

    if (!message || typeof message.command !== 'string') {
      console.warn(`${logPrefix} Received malformed command message`, message);
      return;
    }

    switch (message.command) {
      case 'scrapeLinkedInJobs':
        await handleToolExecution('scrapeLinkedInJobs', message);
        break;
      default:
        console.warn(`${logPrefix} No handler for command: ${message.command}`);
        await sendThroughSocket({
          command: message.command,
          requestId: message.requestId,
          ok: false,
          error: `Unsupported command: ${message.command}`,
        });
        break;
    }
  };

  return socket;
}

const handleFallbackAlarm: Parameters<typeof chrome.alarms.onAlarm.addListener>[0] = async (alarm) => {
  if (alarm.name !== FALLBACK_ALARM_NAME) {
    return;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    console.info(`${logPrefix} Skipping fallback scrape, socket is open`);
    return;
  }

  console.info(`${logPrefix} Executing fallback scrape for ${FALLBACK_ALARM_NAME}`);
  const handler = getToolHandler('scrapeLinkedInJobs');

  if (!handler) {
    console.warn(`${logPrefix} No fallback handler registered for scrapeLinkedInJobs`);
    return;
  }

  try {
    const result = await Promise.resolve(handler(undefined));
    await postFallbackIngest(
      JSON.stringify({
        command: 'scrapeLinkedInJobs',
        ok: true,
        result,
      })
    );
  } catch (error) {
    await postFallbackIngest(
      JSON.stringify({
        command: 'scrapeLinkedInJobs',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
};

function initializeBackground() {
  if (initialized) {
    return;
  }

  initialized = true;
  connectToWorker();
  chrome.alarms.create(FALLBACK_ALARM_NAME, { periodInMinutes: FALLBACK_INTERVAL_MINUTES });
  chrome.alarms.onAlarm.addListener(handleFallbackAlarm);
}

initializeBackground();
