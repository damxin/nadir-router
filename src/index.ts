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
 * - Analytics and auto-optimization (Phase 1)
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
import { startOptimizer, stopOptimizer } from "./optimizer.js";
import { 
  analyzeRequest, 
  reanalyzeWithAnswers, 
  formatClarificationQuestions,
  shouldClarify,
  getDefaultClarifierConfig, 
  type ClarifierConfig, 
  type ClarifierResult 
} from "./clarifier.js";
import {
  generateSessionId,
  getOrCreateSession,
  updateSession,
  addAnswer,
  markReady,
  getSession,
  type ClarificationState,
} from "./session.js";

import {
  route,
  getFallbackChain,
  DEFAULT_ROUTING_CONFIG,
  type RoutingDecision,
  type RoutingConfig,
} from "./router/index.js";
import {
  normalizeChunk,
  normalizeCompletionResponse,
} from "./response-normalizer.js";

// Load configuration from config.yaml
const config = getGlobalConfig();

// Configuration
const LITELLM_BASE_URL = config.litellm.base_url;
const LITELLM_API_KEY = config.litellm.api_key;
const PORT = config.server.port;
const HOST = config.server.host;
const AUTH_TOKEN = config.server.auth_token;  // 可选认证 token
const REQUEST_TIMEOUT_MS = config.litellm.timeout_ms;
const HEARTBEAT_INTERVAL_MS = 2_000; // 2 seconds

// Clarifier config - use config.yaml or defaults
const CLARIFIER_CONFIG: ClarifierConfig = config.clarifier || getDefaultClarifierConfig();

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

/**
 * 检测消息中是否包含多模态内容（如图片）
 */
function hasMultimodalContent(messages: ChatMessage[] | undefined): boolean {
  if (!messages) return false;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "object" && item !== null && "type" in item) {
          const itemType = (item as { type: string }).type;
          if (itemType && itemType !== "text") {
            return true;
          }
        }
      }
    }
  }
  return false;
}

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
 * Normalize chunks to handle different model response formats.
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
  let buffer = ""; // 用于累积不完整的 chunk

  try {
    while (true) {
      if (!canWrite(res)) {
        console.log(`[NadirRouter] Client disconnected`);
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // 按行处理，确保每行都是完整的 SSE 事件
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // 保留最后一个可能不完整的行

      for (const line of lines) {
        if (!line.trim()) continue;
        
        // 标准化每个 chunk
        const normalizedLine = normalizeChunk(line + "\n");
        if (!safeWrite(res, normalizedLine)) {
          console.log(`[NadirRouter] Write failed`);
          break;
        }
      }
    }

    // 处理剩余的 buffer
    if (buffer.trim()) {
      const normalizedLine = normalizeChunk(buffer + "\n");
      safeWrite(res, normalizedLine);
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

  // 认证检查（如果配置了 auth_token）
  if (AUTH_TOKEN) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.headers["x-api-key"] as string;
    if (token !== AUTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing API key" }));
      return;
    }
  }

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
  const messages = parsed.messages as ChatMessage[] | undefined;
  const userPrompt = getLastUserMessage(messages);
  const systemPrompt = getSystemMessage(messages);
  const estimatedTokens = Math.ceil(`${systemPrompt ?? ""} ${userPrompt}`.length / 4);

  // === 多模态检测 ===
  // 如果检测到多模态内容，强制使用支持多模态的模型
  const hasMultimodal = hasMultimodalContent(messages);
  
  if (hasMultimodal) {
    const multimodalModels = config.multimodal_models;
    if (multimodalModels && multimodalModels.length > 0) {
      modelId = multimodalModels[0];
      console.log(`[NadirRouter] Multimodal content detected, forcing model: ${modelId}`);
      parsed.model = modelId;
      // 跳过正常的路由逻辑，直接使用多模态模型
    } else {
      console.warn(`[NadirRouter] Multimodal content detected but no multimodal_models configured`);
    }
  }

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

  // === 主动澄清模式 ===
  // 对所有非简单请求（有实质内容），先用便宜模型判断需求是否明确
  // 不明确 → 返回澄清问题
  // 明确 → 总结需求 → 根据复杂度选择模型
  
  // 只对有实质内容的请求触发澄清（跳过超短和超长）
  if (userPrompt.length > 10 && estimatedTokens <= CLARIFIER_CONFIG.trigger.max_input_tokens) {
    // 生成会话 ID
    const sessionId = generateSessionId((messages || []).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    })));
    
    // 获取会话状态
    const session = getOrCreateSession(sessionId, userPrompt);
    
    let clarifierResult: ClarifierResult;
    
    if (session.questions.length > 0 && session.answers.length < session.questions.length) {
      // 用户在回答澄清问题
      addAnswer(sessionId, userPrompt);
      
      // 直接用用户回答构建摘要，跳过二次分析（节省时间）
      const summary = `基于用户回答的需求：${session.originalRequest}\n用户补充信息：${session.answers.join("；")}`;
      
      clarifierResult = {
        action: "proceed",
        needsClarification: false,
        summary,
        enhancedPrompt: summary,
        skipped: false,
        reason: "user answered, proceeding directly",
        latencyMs: 0,
      };
      
      console.log(`[NadirRouter] Clarifier user answered | round=${session.answers.length} | proceeding directly`);
    } else {
      // 第一轮分析
      clarifierResult = await analyzeRequest(
        userPrompt,
        systemPrompt,
        CLARIFIER_CONFIG,
        LITELLM_BASE_URL,
        LITELLM_API_KEY,
      );
      
      console.log(`[NadirRouter] Clarifier analysis | action=${clarifierResult.action} | latency=${clarifierResult.latencyMs}ms`);
    }
    
    if (clarifierResult.action === "clarify" && clarifierResult.questions) {
      // 需要澄清 - 返回问题给用户
      updateSession(sessionId, {
        questions: clarifierResult.questions,
      });
      
      const clarificationResponse = formatClarificationQuestions(clarifierResult.questions, clarifierResult.taskType);
      
      // 构造一个"假"的 LLM 响应，返回澄清问题
      const fakeResponse = {
        id: `clarify-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: CLARIFIER_CONFIG.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: clarificationResponse,
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: estimatedTokens,
          completion_tokens: Math.ceil(clarificationResponse.length / 4),
          total_tokens: estimatedTokens + Math.ceil(clarificationResponse.length / 4),
        },
      };
      
      if (isStreaming) {
        // 流式返回
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        safeWrite(res, `data: ${JSON.stringify({ id: fakeResponse.id, object: fakeResponse.object, created: fakeResponse.created, model: fakeResponse.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
        safeWrite(res, `data: ${JSON.stringify({ id: fakeResponse.id, object: fakeResponse.object, created: fakeResponse.created, model: fakeResponse.model, choices: [{ index: 0, delta: { content: clarificationResponse }, finish_reason: null }] })}\n\n`);
        safeWrite(res, `data: ${JSON.stringify({ id: fakeResponse.id, object: fakeResponse.object, created: fakeResponse.created, model: fakeResponse.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
      } else {
        // 非流式返回
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(fakeResponse));
      }
      
      return; // 不继续调用模型
    }
    
    if (clarifierResult.action === "proceed" && clarifierResult.enhancedPrompt) {
      // 需求明确 - 注入增强上下文
      markReady(sessionId, clarifierResult.summary || "");
      
      const enhancedSystemContent = `[需求已明确]\n${clarifierResult.summary || ""}\n\n${clarifierResult.keyPoints ? "关键点：\n" + clarifierResult.keyPoints.map(p => "- " + p).join("\n") : ""}`;
      
      const msgArray = (parsed.messages as ChatMessage[]) || [];
      const sysIndex = msgArray.findIndex((m) => m.role === "system");
      
      if (sysIndex >= 0) {
        const originalSystem = typeof msgArray[sysIndex].content === "string" 
          ? msgArray[sysIndex].content 
          : "";
        msgArray[sysIndex] = {
          role: "system",
          content: `${originalSystem}\n\n${enhancedSystemContent}`
        };
      } else {
        msgArray.unshift({
          role: "system",
          content: enhancedSystemContent
        });
      }
      
      parsed.messages = msgArray;
      
      console.log(`[NadirRouter] Clarifier proceeding with enhanced context | summary=${clarifierResult.summary?.slice(0, 50)}...`);
    }
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
    // Non-streaming: normalize response format, then forward
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    res.writeHead(upstream.status, headers);
    const responseBuffer = await upstream.arrayBuffer();
    const responseText = Buffer.from(responseBuffer).toString();
    
    // 标准化响应格式（处理 content 为 null 但 reasoning_content 有值的情况）
    let normalizedText = responseText;
    try {
      const rsp = JSON.parse(responseText);
      const normalizedRsp = normalizeCompletionResponse(rsp);
      normalizedText = JSON.stringify(normalizedRsp);
    } catch {
      // JSON 解析失败，使用原始响应
    }
    res.end(normalizedText);
    
    // Log token usage and record to DB
    try {
      const rsp = JSON.parse(normalizedText);
      const usage = rsp.usage;
      if (usage) {
        console.log(`[NadirRouter] Response ${upstream.status} | model=${modelId} | tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} | latency=${latencyMs}ms`);
        
        // Record to database
        recordRequest({
          promptHash: hashPrompt(JSON.stringify(parsed.messages)),
          promptLength: JSON.stringify(parsed.messages).length,
          systemPromptLength: 0,
          profile: routingProfile || "direct",
          score: routingDecision?.confidence || 0,
          predictedTier: routingDecision?.tier || "UNKNOWN",
          selectedModel: modelId,
          fallbackUsed: false,
          latencyMs,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
          success: upstream.ok,
          errorType: undefined,
        });
      } else {
        console.log(`[NadirRouter] Response ${upstream.status}, latency=${latencyMs}ms`);
      }
    } catch {
      console.log(`[NadirRouter] Response ${upstream.status}, latency=${latencyMs}ms`);
    }
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
    
    // Start auto-optimizer
    startOptimizer();
  });

  server.on("error", (err) => {
    console.error(`[NadirRouter] Server error:`, err);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[NadirRouter] SIGTERM received, shutting down...");
    stopOptimizer();
    server.close(() => {
      console.log("[NadirRouter] Server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("[NadirRouter] SIGINT received, shutting down...");
    stopOptimizer();
    server.close(() => {
      console.log("[NadirRouter] Server closed");
      process.exit(0);
    });
  });
}

main().catch(console.error);
