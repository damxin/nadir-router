/**
 * Tier → Model Selection for LiteLLM
 *
 * Maps classification tier to configured model.
 * Simplified version without pricing (LiteLLM handles that).
 */

import type { Tier, TierConfig, RoutingDecision } from "./types.js";

/**
 * Select the primary model for a tier and build the RoutingDecision.
 */
export function selectModel(
  tier: Tier,
  confidence: number,
  method: "rules" | "llm",
  reasoning: string,
  tierConfigs: Record<Tier, TierConfig>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  routingProfile?: "free" | "eco" | "auto" | "premium",
): RoutingDecision {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;

  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate: 0,  // LiteLLM handles pricing
    baselineCost: 0,
    savings: 0,
  };
}

/**
 * Get the ordered fallback chain for a tier: [primary, ...fallbacks].
 */
export function getFallbackChain(tier: Tier, tierConfigs: Record<Tier, TierConfig>): string[] {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}

/**
 * Get the fallback chain filtered by context length.
 */
export function getFallbackChainFiltered(
  tier: Tier,
  tierConfigs: Record<Tier, TierConfig>,
  estimatedTotalTokens: number,
  getContextWindow: (modelId: string) => number | undefined,
): string[] {
  const fullChain = getFallbackChain(tier, tierConfigs);

  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === undefined) {
      return true;  // Unknown model - include it
    }
    return contextWindow >= estimatedTotalTokens * 1.1;
  });

  return filtered.length > 0 ? filtered : fullChain;
}

/**
 * Calculate cost (stub - LiteLLM handles pricing)
 */
export function calculateModelCost(
  model: string,
  modelPricing: Map<string, { inputPrice: number; outputPrice: number }>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  routingProfile?: "free" | "eco" | "auto" | "premium",
): { costEstimate: number; baselineCost: number; savings: number } {
  return { costEstimate: 0, baselineCost: 0, savings: 0 };
}
