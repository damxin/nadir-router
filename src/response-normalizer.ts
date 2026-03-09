/**
 * Response Normalizer - 统一不同后端模型的响应格式
 * 
 * 问题：某些模型（如 nvidiakimi-k2.5）在 max_tokens 较小时，
 * 会把所有 token 用在 reasoning_content 上，导致 content 为 null。
 * 
 * 解决：当 content 为 null/空但 reasoning_content 有值时，
 * 把 reasoning_content 复制到 content。
 */

import type { ChatCompletion, ChatCompletionChunk } from "./index.js";

/**
 * 标准化非流式响应
 */
export function normalizeCompletionResponse(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return data;
    }

    let modified = false;
    const normalizedChoices = choices.map((choice) => {
      const message = choice.message as Record<string, unknown> | undefined;
      if (!message) {
        return choice;
      }

      const content = message.content as string | null | undefined;
      const reasoningContent = message.reasoning_content as string | null | undefined;

      // 当 content 为空但 reasoning_content 有值时，复制 reasoning_content 到 content
      if ((!content || content.trim() === "") && reasoningContent && reasoningContent.trim() !== "") {
        modified = true;
        return {
          ...choice,
          message: {
            ...message,
            content: reasoningContent.trim(),
          },
        };
      }

      return choice;
    });

    if (modified) {
      console.log("[ResponseNormalizer] Normalized response: copied reasoning_content to content");
      return {
        ...data,
        choices: normalizedChoices,
      };
    }

    return data;
  } catch (err) {
    console.error("[ResponseNormalizer] Failed to normalize response:", err);
    return data;
  }
}

/**
 * 标准化流式响应 chunk
 */
export function normalizeChunk(chunk: string): string {
  try {
    // 跳过 [DONE] 和心跳等特殊行
    if (chunk.trim() === "" || chunk.includes("[DONE]") || chunk.includes("heartbeat")) {
      return chunk;
    }

    // 提取 data: 前缀后的 JSON
    const dataPrefix = "data: ";
    if (!chunk.startsWith(dataPrefix)) {
      return chunk;
    }

    const jsonStr = chunk.slice(dataPrefix.length).trim();
    if (!jsonStr) {
      return chunk;
    }

    const data = JSON.parse(jsonStr) as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return chunk;
    }

    let modified = false;
    const normalizedChoices = choices.map((choice) => {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) {
        return choice;
      }

      const content = delta.content as string | null | undefined;
      const reasoningContent = delta.reasoning_content as string | null | undefined;

      // 流式响应中，reasoning_content 通常先于 content 到达
      // 我们不做强制复制，因为后续 chunk 可能会有 content
      // 但如果这是最后一个 chunk（有 finish_reason）且 content 仍为空，则复制
      const finishReason = choice.finish_reason as string | null | undefined;
      if (
        finishReason &&
        (!content || content.trim() === "") &&
        reasoningContent &&
        reasoningContent.trim() !== ""
      ) {
        modified = true;
        return {
          ...choice,
          delta: {
            ...delta,
            content: reasoningContent.trim(),
          },
        };
      }

      return choice;
    });

    if (modified) {
      console.log("[ResponseNormalizer] Normalized chunk: copied reasoning_content to content");
      return dataPrefix + JSON.stringify({
        ...data,
        choices: normalizedChoices,
      });
    }

    return chunk;
  } catch (err) {
    // JSON 解析失败，原样返回
    return chunk;
  }
}
