const CLOUDFLARE_WORKER_URL = "https://colbyadmin-agent-worker.hacolby.workers.dev";

export interface CloudflareCommandMessage {
  command: string;
  payload?: unknown;
}

export interface CloudflareWorkerSuccessResponse {
  status: "success";
  data: unknown;
}

export interface CloudflareWorkerErrorResponse {
  status: "error";
  error: string;
}

export type CloudflareWorkerResponse =
  | CloudflareWorkerSuccessResponse
  | CloudflareWorkerErrorResponse;

export function initCloudflareWorkerListener(): void {
  chrome.runtime.onMessage.addListener(
    (message: CloudflareCommandMessage, _sender, sendResponse) => {
      (async () => {
        try {
          const response = await fetch(CLOUDFLARE_WORKER_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(message),
          });

          if (!response.ok) {
            throw new Error(`Cloudflare Worker request failed with status ${response.status}`);
          }

          const data: CloudflareWorkerResponse = await response.json();
          sendResponse(data);
        } catch (error) {
          console.error("Failed to send message to Cloudflare Worker", error);
          const fallbackResponse: CloudflareWorkerErrorResponse = {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          };
          sendResponse(fallbackResponse);
        }
      })();

      return true;
    }
  );
}
