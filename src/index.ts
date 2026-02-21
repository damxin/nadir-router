/**
 * Nadir Router - Smart LLM Router for LiteLLM
 *
 * A lightweight proxy that uses ClawRouter's intelligent routing
 * to route requests to LiteLLM.
 *
 * Key design:
 * - Direct SSE passthrough (like LiteLLM)
 * - SSE heartbeat during upstream wait (prevents OpenClaw timeout)
 * - Configuration from config.yaml
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getGlobalConfig, type Tier, type Profile } from "./config.js";

import {
  route,
  getFallbackChain,
  DEFAULT_ROUTING_CONFIG,
  type RoutingDecision,
  type RoutingConfig,
} from "./router/index.js";

// Load configuration from config.yaml
const config = getGlobalConfig();

// Configuration
const LITELLM_BASE_URL = config.litellm.base_url;
const LITELLM_API_KEY = config.litellm.api_key;
const PORT = config.server.port;
const HOST = config.server.host;
const REQUEST_TIMEOUT_MS = config.litellm.timeout_ms;
const HEARTBEAT_INTERVAL_MS = 2_000; // 2 seconds

const ROUTING_PROFILES = new Set([
  "nadir/auto", "auto",
  "nadir/eco", "eco",
  "nadir/premium", "premium",
  "nadir/free", "free",
]);

// Build model context windows from config
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {};
for (const [modelId, modelConfig] of Object.entries(config.models)) {
  MODEL_CONTEXT_WINDOWS[modelId] = modelConfig.context_window;
}

type ChatMessage = { role: string; content: string | unknown };

function getLastUserMessage(messages: ChatMessage[] | undefined): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      return typeof content === "string" ? content : "";
    }
  }
  return "";
}

function getSystemMessage(messages: ChatMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  const sysMsg = messages.find((m) => m.role === "system");
  const content = sysMsg?.content;
  return typeof content === "string" ? content : undefined;
}

function canWrite(res: ServerResponse): boolean {
  return (
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket?.destroyed &&
    res.socket?.writable !== false
  );
}

function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) {
    return false;
  }
  try {
    const written = res.write(data);
    // Flush immediately for streaming
    if (res.socket && typeof res.socket.uncork === 'function') {
      res.socket.uncork();
    }
    return written;
  } catch {
    return false;
  }
}

async function makeLiteLLMRequest(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${LITELLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LITELLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function buildModelList() {
  const models = Object.keys(MODEL_CONTEXT_WINDOWS).map((id) => ({
    id,
    object: "model",
    created: Date.now(),
    owned_by: "nadir-router",
  }));

  const profileModels = [
    { id: "nadir/auto", object: "model", created: Date.now(), owned_by: "nadir-router" },
    { id: "nadir/eco", object: "model", created: Date.now(), owned_by: "nadir-router" },
    { id: "nadir/premium", object: "model", created: Date.now(), owned_by: "nadir-router" },
    { id: "nadir/free", object: "model", created: Date.now(), owned_by: "nadir-router" },
  ];

  return [...profileModels, ...models];
}

/**
 * Pipe SSE stream from upstream to client directly.
 * Just pass through - LiteLLM returns proper OpenAI-compatible SSE.
 */
async function pipeSSEStream(
  res: ServerResponse,
  upstream: Response,
  modelId: string,
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();

  try {
    while (true) {
      if (!canWrite(res)) {
        console.log(`[NadirRouter] Client disconnected`);
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (!safeWrite(res, chunk)) {
        console.log(`[NadirRouter] Write failed`);
        break;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[NadirRouter] Stream error: ${error.message}`);
  } finally {
    reader.releaseLock();
    if (canWrite(res)) {
      res.end();
    }
  }
}

/**
 * Get tier config from config.yaml routing profiles
 */
function getTierConfig(profile: Profile, tier: Tier) {
  const profileConfig = config.routing[profile];
  if (profileConfig && profileConfig[tier]) {
    return profileConfig[tier];
  }
  // Fallback to auto profile
  return config.routing.auto[tier];
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routingConfig: RoutingConfig,
): Promise<void> {
  const startTime = Date.now();

  // Handle /v1/models locally
  if (req.url === "/v1/models" && req.method === "GET") {
    const models = buildModelList();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  if (!req.url?.startsWith("/v1")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Collect request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);

  if (body.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Empty request body" }));
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const isStreaming = parsed.stream === true;
  const maxTokens = (parsed.max_tokens as number) || 4096;
  let modelId = (parsed.model as string) || "";
  let routingDecision: RoutingDecision | undefined;
  let routingProfile: Profile | null = null;

  // Check for routing profile
  const normalizedModel = modelId.trim().toLowerCase();
  const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel);

  if (isRoutingProfile) {
    const profileName = normalizedModel.replace("nadir/", "");
    routingProfile = profileName as Profile;

    if (routingProfile === "free") {
      // Free profile - use first available model from config
      const freeConfig = config.routing.free.SIMPLE;
      modelId = freeConfig.primary;
      console.log(`[NadirRouter] Free profile - using ${modelId}`);
    } else {
      const messages = parsed.messages as ChatMessage[] | undefined;
      const prompt = getLastUserMessage(messages);
      const systemPrompt = getSystemMessage(messages);

      routingDecision = route(prompt, systemPrompt, maxTokens, {
        config: routingConfig,
        routingProfile: routingProfile ?? undefined,
      });

      // Get model from config.yaml routing profile
      const tierConfig = getTierConfig(routingProfile, routingDecision.tier);
      modelId = tierConfig.primary;

      console.log(
        `[NadirRouter] ${routingProfile} profile -> tier=${routingDecision.tier} model=${modelId} | ${routingDecision.reasoning}`,
      );
    }

    parsed.model = modelId;
  }

  // Build fallback chain from config
  let modelsToTry: string[];
  if (routingDecision && routingProfile) {
    const tierConfig = getTierConfig(routingProfile, routingDecision.tier);
    modelsToTry = [tierConfig.primary, ...tierConfig.fallback];
  } else {
    modelsToTry = [modelId];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // === CRITICAL: SSE heartbeat for streaming requests ===
  // Prevents OpenClaw's 10-15s timeout while waiting for upstream
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    // Send 200 + SSE headers IMMEDIATELY, before upstream request
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    headersSentEarly = true;

    // First heartbeat immediately
    safeWrite(res, ": heartbeat\n\n");

    // Continue heartbeats every 2s while waiting for upstream
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) {
        safeWrite(res, ": heartbeat\n\n");
      } else {
        clearInterval(heartbeatInterval!);
        heartbeatInterval = undefined;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Cleanup on client disconnect
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
  });

  // Try each model in fallback chain
  let upstream: Response | undefined;
  let lastError: string | undefined;

  // Keep original stream setting - direct passthrough like LiteLLM

  for (const tryModel of modelsToTry) {
    try {
      parsed.model = tryModel;
      console.log(`[NadirRouter] Trying model: ${tryModel}`);

      upstream = await makeLiteLLMRequest(parsed, controller.signal);

      if (upstream.ok) {
        modelId = tryModel;
        console.log(`[NadirRouter] Success with model: ${tryModel}`);
        break;
      }

      const errorText = await upstream.text();
      lastError = errorText;
      console.log(`[NadirRouter] Model ${tryModel} failed: ${upstream.status}`);
      upstream = undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error.message;
      console.log(`[NadirRouter] Model ${tryModel} error: ${error.message}`);
    }
  }

  // Clear heartbeat - real data is about to flow
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }
  clearTimeout(timeoutId);

  // Handle all models failed
  if (!upstream) {
    if (isStreaming && headersSentEarly) {
      safeWrite(res, `data: ${JSON.stringify({ error: { message: lastError || "All models failed" } })}\n\n`);
      safeWrite(res, "data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: lastError || "All models failed" } }));
    }
    return;
  }

  const latencyMs = Date.now() - startTime;

  if (isStreaming) {
    // Direct SSE passthrough - LiteLLM returns proper SSE format
    const contentType = upstream.headers.get("content-type") || "";
    
    if (contentType.includes("text/event-stream")) {
      // Upstream returned SSE stream - pipe directly (like LiteLLM does)
      console.log(`[NadirRouter] Piping SSE stream directly, latency=${latencyMs}ms`);
      await pipeSSEStream(res, upstream, modelId);
    } else {
      // Fallback: upstream returned JSON (some models don't support streaming)
      console.log(`[NadirRouter] Converting JSON to SSE, latency=${latencyMs}ms`);
      const responseText = await upstream.text();
      try {
        const rsp = JSON.parse(responseText);
        // Simple JSON to SSE conversion
        const baseChunk = {
          id: rsp.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: rsp.created || Math.floor(Date.now() / 1000),
          model: rsp.model || modelId,
        };
        
        safeWrite(res, `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`);
        
        const content = rsp.choices?.[0]?.message?.content || "";
        if (content) {
          safeWrite(res, `data: ${JSON.stringify({
            ...baseChunk,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`);
        }
        
        safeWrite(res, `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
        
        console.log(`[NadirRouter] Streamed ${content.length} chars`);
      } catch (err) {
        console.error(`[NadirRouter] Failed to parse response:`, err);
        safeWrite(res, `data: ${JSON.stringify({ error: { message: "Failed to parse response" } })}\n\n`);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
      }
    }
  } else {
    // Non-streaming: forward as-is
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    res.writeHead(upstream.status, headers);
    const responseBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(responseBuffer));
    console.log(`[NadirRouter] Response ${upstream.status}, latency=${latencyMs}ms`);
  }
}

async function main() {
  const routingConfig = DEFAULT_ROUTING_CONFIG;

  const server = createServer((req, res) => {
    handleRequest(req, res, routingConfig).catch((err) => {
      console.error(`[NadirRouter] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Internal server error" } }));
      }
    });
  });

  // Handle client connection errors
  server.on("clientError", (err, socket) => {
    console.error(`[NadirRouter] Client error: ${err.message}`);
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  // Track connections and set timeouts
  server.on("connection", (socket) => {
    // Set 5-minute timeout for streaming requests
    socket.setTimeout(300_000);

    socket.on("timeout", () => {
      console.error(`[NadirRouter] Socket timeout, destroying connection`);
      socket.destroy();
    });

    socket.on("error", (err) => {
      console.error(`[NadirRouter] Socket error: ${err.message}`);
    });
  });

  server.listen(PORT, HOST, () => {
    const addr = server.address() as AddressInfo;
    console.log(`[NadirRouter] Smart LLM router running on http://${HOST}:${addr.port}`);
    console.log(`[NadirRouter] LiteLLM backend: ${LITELLM_BASE_URL}`);
    console.log(`[NadirRouter] Routing profiles: nadir/auto, nadir/eco, nadir/premium, nadir/free`);
    console.log(`[NadirRouter] Config: config.yaml`);
  });

  server.on("error", (err) => {
    console.error(`[NadirRouter] Server error:`, err);
  });
}

main().catch(console.error);
