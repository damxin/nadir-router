/**
 * 任务澄清器 - 主动澄清模式
 * 
 * 流程：
 * 1. 用户提出需求 → 判断是否明确
 * 2. 不明确 → 返回澄清问题，与用户交互
 * 3. 明确 → 总结需求，交给复杂模型处理
 * 
 * 目标：让复杂模型收到清晰的需求，减少交互轮次，节省 token
 */

import type { Tier } from "./config.js";
import type { ClarificationState } from "./session.js";

export type ClarifierConfig = {
  enabled: boolean;
  model: string;              // 预处理用的便宜模型
  max_tokens: number;         // 预处理输出限制
  timeout_ms: number;         // 预处理超时
  max_rounds: number;         // 最大澄清轮次
  trigger: {
    min_tier: Tier;           // 触发预处理的最低 tier
    max_input_tokens: number; // 输入太长跳过预处理
  };
};

export type ClarifierResult = {
  action: "clarify" | "proceed" | "skip";
  needsClarification: boolean;
  questions?: string[];          // 澄清问题列表
  summary?: string;              // 需求摘要（明确后）
  enhancedPrompt?: string;       // 增强后的完整 prompt
  taskType?: string;             // 任务类型
  keyPoints?: string[];          // 关键点
  skipped: boolean;
  reason: string;
  latencyMs?: number;
};

// 分析需求明确性的 prompt
const ANALYSIS_PROMPT = `你是一个需求分析助手。分析用户的需求是否足够明确，以便高级 AI 处理。

判断标准：
- 明确：需求描述完整，有足够信息可以直接开始工作
- 不明确：缺少关键信息，需要进一步询问

你需要：
1. 判断需求是否明确
2. 如果不明确，列出 2-3 个关键问题
3. 如果明确，总结需求要点

输出严格的 JSON 格式：
{
  "is_clear": true或false,
  "task_type": "代码|分析|设计|问答|调试|其他",
  "key_points": ["已明确的关键点"],
  "missing_info": ["缺少的信息"],
  "questions": ["需要问用户的问题（如果不明确）"],
  "summary": "需求摘要（如果明确）"
}

注意：questions 只在不明确时填写，summary 只在明确时填写。`;

// 根据用户回答重新分析的 prompt
const REANALYSIS_PROMPT = `你是一个需求分析助手。用户已经回答了澄清问题，请重新判断需求是否明确。

原始需求：{original_request}

已提问的问题：
{questions}

用户的回答：
{answers}

你需要：
1. 结合用户的回答，判断需求现在是否明确
2. 如果仍然不明确，继续追问
3. 如果明确，生成完整的需求摘要

输出严格的 JSON 格式：
{
  "is_clear": true或false,
  "task_type": "代码|分析|设计|问答|调试|其他",
  "key_points": ["已明确的关键点"],
  "still_missing": ["仍然缺少的信息"],
  "questions": ["继续追问的问题（如果仍不明确）"],
  "summary": "完整需求摘要（如果明确，包含用户回答的所有信息）"
}`;

export function getDefaultClarifierConfig(): ClarifierConfig {
  return {
    enabled: true,
    model: "doubao-seed-code",
    max_tokens: 300,
    timeout_ms: 8000,
    max_rounds: 3,
    trigger: {
      min_tier: "COMPLEX",
      max_input_tokens: 2000,
    },
  };
}

/**
 * 检查是否应该触发澄清流程
 */
export function shouldClarify(
  tier: Tier,
  estimatedTokens: number,
  config: ClarifierConfig,
): { should: boolean; reason: string } {
  if (!config.enabled) {
    return { should: false, reason: "clarifier disabled" };
  }

  const tierRank: Record<Tier, number> = {
    SIMPLE: 0,
    MEDIUM: 1,
    COMPLEX: 2,
    REASONING: 3,
  };

  const minTierRank = tierRank[config.trigger.min_tier];
  const currentTierRank = tierRank[tier];

  if (currentTierRank < minTierRank) {
    return { should: false, reason: `tier ${tier} below ${config.trigger.min_tier}` };
  }

  if (estimatedTokens > config.trigger.max_input_tokens) {
    return { should: false, reason: `input too long (${estimatedTokens} > ${config.trigger.max_input_tokens})` };
  }

  return { should: true, reason: `tier=${tier}, tokens=${estimatedTokens}` };
}

/**
 * 解析 LLM 返回的 JSON
 */
function parseAnalysisResponse(content: string, session?: ClarificationState): {
  is_clear: boolean;
  task_type?: string;
  key_points?: string[];
  missing_info?: string[];
  questions?: string[];
  summary?: string;
  still_missing?: string[];
} {
  try {
    // 尝试提取 JSON（可能被 markdown 包裹）
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error("[Clarifier] Failed to parse JSON:", e);
  }
  
  // 解析失败时，如果有会话信息（用户已回答），用用户回答构建摘要
  if (session && session.answers.length > 0) {
    return {
      is_clear: true,
      task_type: "待确认",
      key_points: session.answers,
      summary: `基于用户回答的需求：${session.originalRequest}\n用户补充信息：${session.answers.join("；")}`,
    };
  }
  
  // 第一次分析时 JSON 解析失败，返回不明确，触发澄清
  return { 
    is_clear: false, 
    questions: [
      "请详细描述您的具体需求是什么？",
      "有没有特定的技术要求或约束条件？",
    ],
    missing_info: ["需求描述不够详细"],
  };
}

/**
 * 第一轮分析：判断需求是否明确
 */
export async function analyzeRequest(
  prompt: string,
  systemPrompt: string | undefined,
  config: ClarifierConfig,
  litellmBaseUrl: string,
  litellmApiKey: string,
): Promise<ClarifierResult> {
  const startTime = Date.now();

  const userContent = systemPrompt
    ? `[系统角色]\n${systemPrompt.slice(0, 300)}\n\n[用户需求]\n${prompt}`
    : prompt;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms);

    const response = await fetch(`${litellmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${litellmApiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: ANALYSIS_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: config.max_tokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        action: "skip",
        needsClarification: false,
        skipped: true,
        reason: `clarifier API error: ${response.status}`,
        latencyMs,
      };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content || "";
    const analysis = parseAnalysisResponse(content);  // 第一次分析不需要 session

    if (!analysis.is_clear && analysis.questions && analysis.questions.length > 0) {
      // 需要澄清
      return {
        action: "clarify",
        needsClarification: true,
        questions: analysis.questions,
        taskType: analysis.task_type,
        keyPoints: analysis.key_points,
        skipped: false,
        reason: "needs clarification",
        latencyMs,
      };
    } else {
      // 需求明确，可以处理
      const summary = analysis.summary || prompt;
      return {
        action: "proceed",
        needsClarification: false,
        summary,
        taskType: analysis.task_type,
        keyPoints: analysis.key_points,
        enhancedPrompt: buildEnhancedPrompt(prompt, summary, analysis.key_points, analysis.task_type),
        skipped: false,
        reason: "task is clear",
        latencyMs,
      };
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      action: "skip",
      needsClarification: false,
      skipped: true,
      reason: `clarifier error: ${errorMessage}`,
      latencyMs,
    };
  }
}

/**
 * 后续轮次：根据用户回答重新分析
 */
export async function reanalyzeWithAnswers(
  session: ClarificationState,
  latestAnswer: string,
  config: ClarifierConfig,
  litellmBaseUrl: string,
  litellmApiKey: string,
): Promise<ClarifierResult> {
  const startTime = Date.now();

  const prompt = REANALYSIS_PROMPT
    .replace("{original_request}", session.originalRequest)
    .replace("{questions}", session.questions.join("\n"))
    .replace("{answers}", session.answers.join("\n") + "\n" + latestAnswer);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms);

    const response = await fetch(`${litellmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${litellmApiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "user", content: prompt },
        ],
        max_tokens: config.max_tokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        action: "skip",
        needsClarification: false,
        skipped: true,
        reason: `clarifier API error: ${response.status}`,
        latencyMs,
      };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content || "";
    const analysis = parseAnalysisResponse(content, session);  // 重新分析时传入 session

    // 检查是否达到最大轮次
    const currentRound = session.answers.length;
    if (currentRound >= config.max_rounds) {
      // 强制认为明确，用当前信息总结
      const summary = `基于 ${currentRound} 轮对话的需求：${session.originalRequest}\n用户补充信息：${session.answers.join("; ")}`;
      return {
        action: "proceed",
        needsClarification: false,
        summary,
        enhancedPrompt: summary,
        skipped: false,
        reason: "max rounds reached, proceeding with available info",
        latencyMs,
      };
    }

    if (!analysis.is_clear && analysis.questions && analysis.questions.length > 0) {
      // 仍需澄清
      return {
        action: "clarify",
        needsClarification: true,
        questions: analysis.questions,
        keyPoints: analysis.key_points,
        skipped: false,
        reason: "still needs clarification",
        latencyMs,
      };
    } else {
      // 现在明确了
      const summary = analysis.summary || `需求：${session.originalRequest}\n补充信息：${session.answers.join("; ")}`;
      return {
        action: "proceed",
        needsClarification: false,
        summary,
        enhancedPrompt: buildEnhancedPrompt(session.originalRequest, summary, analysis.key_points, analysis.task_type),
        skipped: false,
        reason: "task is now clear",
        latencyMs,
      };
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      action: "skip",
      needsClarification: false,
      skipped: true,
      reason: `clarifier error: ${errorMessage}`,
      latencyMs,
    };
  }
}

/**
 * 构建增强后的 prompt
 */
function buildEnhancedPrompt(
  original: string,
  summary: string,
  keyPoints?: string[],
  taskType?: string,
): string {
  let enhanced = `[需求摘要]\n${summary}\n\n`;
  
  if (taskType) {
    enhanced += `[任务类型] ${taskType}\n\n`;
  }
  
  if (keyPoints && keyPoints.length > 0) {
    enhanced += `[关键点]\n${keyPoints.map(p => `- ${p}`).join("\n")}\n\n`;
  }
  
  enhanced += `[原始请求]\n${original}`;
  
  return enhanced;
}

/**
 * 格式化澄清问题为用户友好的文本
 */
export function formatClarificationQuestions(questions: string[], taskType?: string): string {
  let response = "好的，在开始处理之前，我需要确认几个问题：\n\n";
  
  questions.forEach((q, i) => {
    response += `${i + 1}. ${q}\n`;
  });
  
  response += "\n请回答这些问题，我会根据你的回答来处理。";
  
  return response;
}
