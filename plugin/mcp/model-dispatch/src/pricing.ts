import type { ModelPricing } from "./types.js";

/**
 * Anthropic bills prompt-cache WRITES at a premium over fresh input (25% for
 * the default 5-minute TTL). Used as the fallback multiplier when a model's
 * pricing block does not declare an explicit `input_cache_write` rate.
 */
export const CACHE_WRITE_PREMIUM = 1.25;

export function computeCostUsd(
  tokens: { input: number; input_cached: number; output: number; input_cache_write?: number },
  pricing: ModelPricing
): number {
  // `tokens.input` is the FRESH-priced count; `tokens.input_cached` is the
  // discounted cache-read count; `tokens.input_cache_write` is the
  // premium-priced cache-write count. All three are DISJOINT — never
  // subtract one from another.
  //
  // `input_cache_write` is optional (default 0) so every caller written
  // before the bucket existed keeps its dollars bit-for-bit. Before this
  // bucket, BuiltinAnthropicAdapter folded cache writes into `input` and
  // priced them at the FRESH rate — a systematic ~20% undercount on the
  // written tokens. The explicit per-model rate wins when declared;
  // otherwise fresh-rate × CACHE_WRITE_PREMIUM matches Anthropic's billing.
  const cacheWriteRate  = pricing.input_cache_write ?? pricing.input * CACHE_WRITE_PREMIUM;
  const inputFreshCost  = (tokens.input                  / 1_000_000) * pricing.input;
  const inputCachedCost = (tokens.input_cached           / 1_000_000) * pricing.input_cached;
  const cacheWriteCost  = ((tokens.input_cache_write ?? 0) / 1_000_000) * cacheWriteRate;
  const outputCost      = (tokens.output                 / 1_000_000) * pricing.output;
  return round6(inputFreshCost + inputCachedCost + cacheWriteCost + outputCost);
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Approximate token count for a string, within ~10% of true tokenizer output
 * for English + code. Used only for telemetry and cost estimation on the
 * direct tier, where per-call vendor `usage` is not visible.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}
