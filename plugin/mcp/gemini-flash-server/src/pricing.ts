/**
 * Cost computation utilities.
 * Pricing values come from the loaded Policy (so they stay in sync with
 * whichever policy YAML the user picked) — this module only does the math.
 */

import type { ModelPricing } from "./types.js";

export function computeCostUsd(
  tokens: { input: number; input_cached: number; output: number },
  pricing: ModelPricing
): number {
  // CONVENTION: `tokens.input` is the FRESH-priced count (Anthropic's
  // `input_tokens` + `cache_creation_input_tokens` summed by the adapter).
  // `tokens.input_cached` is the discounted-priced cache-read count.
  // The two are DISJOINT — never subtract one from the other.
  //
  // The previous formula subtracted `input_cached` from `input` thinking
  // the adapter passed a combined total. It didn't. With effective caching
  // (cached > fresh, which is the goal), the subtraction went negative
  // and produced impossible per-call costs.
  const inputFreshCost  = (tokens.input        / 1_000_000) * pricing.input;
  const inputCachedCost = (tokens.input_cached / 1_000_000) * pricing.input_cached;
  const outputCost      = (tokens.output       / 1_000_000) * pricing.output;
  return round6(inputFreshCost + inputCachedCost + outputCost);
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Approximate token count for a string.
 * Calibrated to be within ~10% of true tokenizer output for English + code,
 * which is good enough for telemetry & cost estimation. Avoids pulling
 * a heavy tokenizer dependency into the MCP server.
 *
 * Rule: 1 token ~= 4 chars of English, ~3.5 chars of code.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Slight bias toward code-like content (denser tokens).
  return Math.ceil(text.length / 3.8);
}
