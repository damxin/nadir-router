/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the best model.
 * Based on ClawRouter's intelligent routing logic.
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types.js";
import { classifyByRules } from "./rules.js";
import { selectModel, type ModelPricing } from "./selector.js";

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing?: Map<string, ModelPricing>;
  routingProfile?: "free" | "eco" | "auto" | "premium";
};

/**
 * Route a request to the best model.
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const { config, routingProfile } = options;

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);

  // Rule-based classification
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);

  // Select tier configs based on routing profile
  let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
  let profileSuffix = "";

  if (routingProfile === "eco" && config.ecoTiers) {
    tierConfigs = config.ecoTiers;
    profileSuffix = " | eco";
  } else if (routingProfile === "premium" && config.premiumTiers) {
    tierConfigs = config.premiumTiers;
    profileSuffix = " | premium";
  } else {
    // Auto profile - check agentic mode
    const agenticScore = ruleResult.agenticScore ?? 0;
    const isAutoAgentic = agenticScore >= 0.5;
    const isExplicitAgentic = config.overrides.agenticMode ?? false;
    const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
    tierConfigs = useAgenticTiers ? config.agenticTiers! : config.tiers;
    profileSuffix = useAgenticTiers ? " | agentic" : "";
  }

  // Override: large context → force COMPLEX
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
      tierConfigs,
      estimatedTokens,
      maxOutputTokens,
      routingProfile,
    );
  }

  // Structured output detection
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;

  let tier: Tier;
  let confidence: number;
  const method: "rules" | "llm" = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }

  // Apply structured output minimum tier
  if (hasStructuredOutput) {
    const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }

  reasoning += profileSuffix;

  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    estimatedTokens,
    maxOutputTokens,
    routingProfile,
  );
}

export { getFallbackChain, getFallbackChainFiltered, calculateModelCost } from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./types.js";
export type { ModelPricing } from "./selector.js";
