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
 * - Analytics and auto-optimization
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getGlobalConfig, type Tier, type Profile } from "./config.js";
import { 
  recordRequest, 
  hashPrompt, 
  getOverallStats, 
  getModelStats, 
  getTierStats,
  getRecentRequests 
} from "./db.js";

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
 * Also tracks token usage from the last chunk.
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
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;

  try {
    while (true) {
      if (!canWrite(res)) {
        console.log(`[NadirRouter] Client disconnected`);
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      
      // Try to extract usage from chunk (usually in last chunk)
      try {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            const data = line.slice(6).trim();
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
      
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
    // Log token usage if available
    if (lastUsage && lastUsage.total_tokens) {
      console.log(`[NadirRouter] Stream done | model=${modelId} | tokens: prompt=${lastUsage.prompt_tokens || 0} completion=${lastUsage.completion_tokens || 0} total=${lastUsage.total_tokens}`);
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

  // Handle /stats endpoint for analytics
  if (req.url === "/stats" && req.method === "GET") {
    const stats = {
      overall: getOverallStats(),
      models: getModelStats(),
      tiers: getTierStats(),
      recent: getRecentRequests(20),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
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
    parsed = JSON.parse(body.toString()));
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

  // === 收集请求特征用于数据记录
  let requestInfo: {
    promptHash: string;
    promptLength: number;
    systemPromptLength: number;
    profile: string;
    score: number;
    predictedTier: string;
    selectedModel: string;
    fallbackUsed: boolean;
  } | null = null;

  // Check for routing profile
  const normalizedModel = modelId.trim().toLowerCase());
  const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel));

  if (isRoutingProfile) {
    const profileName = normalizedModel.replace("nadir/", "");
    routingProfile = profileName as Profile;

    const messages = parsed.messages as ChatMessage[] | undefined;
    const prompt = getLastUserMessage(messages);
    const systemPrompt = getSystemMessage(messages);

    // === 保存请求特征用于数据收集
    requestInfo = {
      promptHash: hashPrompt(prompt),
      promptLength: prompt.length,
      systemPromptLength: systemPrompt?.length || 0,
      profile: profileName,
      score: 0,
      predictedTier: "UNKNOWN",
      selectedModel: "",
      fallbackUsed: false,
    };

    if (routingProfile === "free") {
      const freeConfig = config.routing.free.SIMPLE;
      modelId = freeConfig.primary;
      requestInfo.selectedModel = modelId;
      requestInfo.predictedTier = "SIMPLE";
      console.log(`[NadirRouter] Free profile - using ${modelId}`);
    } else {
      const tierConfig = getTierConfig(routingProfile, "SIMPLE");
      modelId = tierConfig.primary;
      requestInfo.selectedModel = modelId;

      routingDecision = route(prompt, systemPrompt, maxTokens, {
        config: routingConfig,
        routingProfile: routingProfile ?? undefined,
      });

      requestInfo.score = routingDecision.score;
      requestInfo.predictedTier = routingDecision.tier;

      // Get model from config.yaml routing profile
      const tierConfigFromConfig = getTierConfig(routingProfile, routingDecision.tier);
      requestInfo.selectedModel = tierConfigFromConfig.primary;
      modelId = tierConfigFromConfig.primary;

      console.log(
        `[NadirRouter] ${routingProfile} profile -> tier=${routingDecision.tier} model=${modelId} | ${routingDecision.reasoning}`
      );
    }

    parsed.model = modelId;
  } else {
    // Direct model use
    requestInfo = {
      promptHash: "",
      promptLength: 0,
      systemPromptLength: 0,
      profile: "direct",
      score: 0,
      predictedTier: "UNKNOWN",
      selectedModel: modelId,
      fallbackUsed: false,
    };
  }

  // Build fallback chain from config
  let modelsToTry: string[];
  if (routingDecision && routingProfile) {
    const tierConfig = getTierConfig(routingProfile, routingDecision.tier));
    modelsToTry = [tierConfig.primary, ...tierConfig.fallback];
  } else {
    modelsToTry = [modelId];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // === For streaming, enable usage reporting ===
  if (isStreaming) {
    parsed.stream_options = { include_usage: true };
  }

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
        clearInterval(heartbeatInterval!));
        heartbeatInterval = undefined;
      }
    }, HEARTBEAT_INTERVAL_MS));
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
  let usedFallback = false;

  // Keep original stream setting - direct passthrough like LiteLLM

  for (const tryModel of modelsToTry) {
    try {
      parsed.model = tryModel;
      console.log(`[NadirRouter] Trying model: ${tryModel}`);

      upstream = await makeLiteLLMRequest(parsed, controller.signal));

      if (upstream.ok) {
        modelId = tryModel;
        console.log(`[NadirRouter] Success with model: ${tryModel}`);
        break;
      }

      const errorText = await upstream.text());
      lastError = errorText;
      console.log(`[NadirRouter] Model ${tryModel} failed: ${upstream.status}`);
      upstream = undefined;
      usedFallback = true;
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

  // === 数据收集：保存响应指标 ===
  let finalUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  };
  let success = true;
  let errorType: string | undefined;

  if (isStreaming) {
    // Direct SSE passthrough - LiteLLM returns proper SSE format
    const contentType = upstream.headers.get("content-type") || "";
    
    if (contentType.includes("text/event-stream")) {
      // Upstream returned SSE stream - pipe directly (like LiteLLM does)
      console.log(`[NadirRouter] Piping SSE stream directly, latency=${latencyMs}ms`);
      await pipeSSEStream(res, upstream, modelId));
    } else {
      // Fallback: upstream returned JSON (some models don't support streaming)
      console.log(`[NadirRouter] Converting JSON to SSE, latency=${latencyMs}ms`);
      const responseText = await upstream.text());
      try {
        const rsp = JSON.parse(responseText));
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
        if (requestInfo) {
          const usage = rsp.usage;
          if (usage) {
            finalUsage = {
              promptTokens: usage.prompt_tokens || 0,
              completionTokens: usage.completion_tokens || 0,
              totalTokens: usage.total_tokens || 0,
              reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
            };
          }
          recordRequest({
            ...requestInfo,
            latencyMs,
            promptTokens: finalUsage.promptTokens,
            completionTokens: finalUsage.completionTokens,
            totalTokens: finalUsage.totalTokens,
            reasoningTokens: finalUsage.reasoningTokens,
            success,
            errorType,
            selectedModel: modelId,
            fallbackUsed: usedFallback,
          });
        }
      } catch (err) {
        console.error(`[NadirRouter] Failed to parse response:`, err);
        safeWrite(res, `data: ${JSON.stringify({ error: { message: "Failed to parse response" } })}\n\n`);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
        success = false;
        errorType = "parse_error";
      }
    }
  } else {
    // Non-streaming: forward as-is, log token usage
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    res.writeHead(upstream.status, headers);
    const responseBuffer = await upstream.arrayBuffer());
    const responseText = Buffer.from(responseBuffer)).toString();
    res.end(responseText);
    
    // Log token usage and record to DB
    try {
      const rsp = JSON.parse(responseText));
      const usage = rsp.usage;
      if (usage) {
        console.log(`[NadirRouter] Response ${upstream.status} | model=${modelId} | tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} | latency=${latencyMs}ms`);
        if (requestInfo) {
          finalUsage = {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
          };
          recordRequest({
            ...requestInfo,
            latencyMs,
            promptTokens: finalUsage.promptTokens,
            completionTokens: finalUsage.completionTokens,
            totalTokens: finalUsage.totalTokens,
            reasoningTokens: finalUsage.reasoningTokens,
            success,
            errorType,
            selectedModel: modelId,
            fallbackUsed: usedFallback,
          });
        }
      } else {
        console.log(`[NadirRouter] Response ${upstream.status}, latency=${latencyMs}ms`);
      }
    } catch {
      console.log(`[NadirRouter] Response ${upstream.status}, latency=${latencyMs}ms`);
    }
  }

  // 如果还没有记录（流式响应），在 finally 块记录
  if (requestInfo && !isStreaming) {
    recordRequest({
      ...requestInfo,
      latencyMs,
      promptTokens: finalUsage.promptTokens,
      completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens,
      reasoningTokens: finalUsage.reasoningTokens,
      success,
      errorType,
      selectedModel: modelId,
      fallbackUsed: usedFallback,
    });
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
    console.log(`[NadirRouter] Analytics: /stats endpoint available`);
  });

  server.on("error", (err) => {
    console.error(`[NadirRouter] Server error:`, err);
  });
}

main().catch(console.error);
