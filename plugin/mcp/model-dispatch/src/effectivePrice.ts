/**
 * The effective price of a policy model: the one rule every adapter, the
 * what-if replay and pre-flight use to turn a policy entry into a rate.
 *
 * Why this exists: a policy `pricing:` block used to be the price. Blocks are
 * hand-copied into every policy file and carry no dates, so a wrong copy
 * (a 3.5 Flash card pasted into another policy, a Sonnet 5 card left at a
 * cancelled price increase) billed silently, and a dated change (Gemini 3.7
 * Flash's introductory card ends on 2026-12-31) could not be expressed at all.
 *
 * The rule, in order:
 *   1. `pricing_override: true` bills the policy block, labelled `custom`.
 *      It applies to the leaf's own model only (a `claude-cli` worker's
 *      helpers and side calls are still priced from the list).
 *   2. Otherwise the dated list (prices.ts) prices the model on the dispatch
 *      day. A block that differs from the list's standard card by more than
 *      0.5% on any rate it declares is ignored, and a warning names both.
 *   3. A model the list cannot price, without an override, is unpriced: the
 *      caller refuses to dispatch it (or, for tokens already billed, records
 *      them as unpriced). A rate is never borrowed or remembered.
 *
 * Pure: warnings are returned, and each caller decides where to log them.
 */

import type { ModelConfig, ModelPricing, PriceBasis } from "./types.js";
import {
  lookupPrice,
  resolveModel,
  type AppliedModifiers,
  type PeriodRef,
  type PriceModifiers,
} from "./prices.js";
import { IN_SESSION_ADAPTER, type AuthMode, type PriceCheck } from "./preflight.js";

// PriceCheck is declared in preflight.ts, which consumes it, so that module
// stays free of imports; re-exported here beside the function that builds it.
export type { PriceCheck };

/** A declared block rate further than this fraction from the list's rate is a mismatch. */
export const POLICY_PRICE_TOLERANCE = 0.005;

const RATE_KEYS = ["input", "input_cached", "output", "input_cache_write", "input_cache_write_1h"] as const;
type RateKey = (typeof RATE_KEYS)[number];

export type PricedModel = Pick<ModelConfig, "id" | "model_name" | "pricing" | "pricing_override">;

export interface EffectivePriced {
  unpriced: false;
  basis: PriceBasis;
  /** The name that was priced (the leaf's model_name unless the caller passed another). */
  model_name: string;
  /** Rates for computeCostUsd. A list price carries all five; a custom price carries what the block declares. */
  pricing: ModelPricing;
  /** The list period that priced it; null for a custom price. */
  period: PeriodRef | null;
  /** The modifiers the list applied; null for a custom price (a block is one flat card). */
  applied_modifiers: AppliedModifiers | null;
  warnings: string[];
}

export interface EffectiveUnpriced {
  unpriced: true;
  model_name: string;
  reason: string;
  warnings: string[];
}

export type EffectivePrice = EffectivePriced | EffectiveUnpriced;

/**
 * True when two model names name the same model: equal; or both resolve to
 * the same list id (so `claude-opus-5[1m]` and `claude-haiku-4-5-20251001`
 * match their bare ids); or, when neither is on the list, equal once a
 * trailing Claude Code `[option]` is dropped (so a custom gateway name still
 * matches its `[1m]` spelling). A listed and an unlisted name never match.
 */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolveModel(a);
  const rb = resolveModel(b);
  if (ra && rb) return ra.id === rb.id;
  if (ra || rb) return false;
  const strip = (n: string) => n.replace(/\[[^[\]]+\]$/, "");
  return strip(a) === strip(b);
}

/** A Date prices on its UTC day; a string goes to lookupPrice as given (YYYY-MM-DD or a zoned timestamp). */
function dateArg(date: Date | string): string {
  return typeof date === "string" ? date : date.toISOString();
}

/**
 * Effective price of `name` (default: the leaf's own model_name) under policy
 * model `model`, on `date`, with the request's `modifiers`.
 */
export function effectivePrice(
  model: PricedModel,
  date: Date | string,
  modifiers: PriceModifiers | null = {},
  name: string = model.model_name,
): EffectivePrice {
  const warnings: string[] = [];
  const ownModel = sameModel(name, model.model_name);

  // 1. A deliberate custom price. The loader refuses pricing_override without
  //    a block, so `pricing` is present whenever the flag is true.
  if (ownModel && model.pricing_override === true && model.pricing) {
    return {
      unpriced: false,
      basis: "custom",
      model_name: name,
      pricing: { ...model.pricing },
      period: null,
      applied_modifiers: null,
      warnings,
    };
  }

  // 3. No list price and no override: unpriced, with what would price it.
  const day = dateArg(date);
  const looked = lookupPrice(name, day, modifiers);
  if (looked.unpriced) {
    const hint = ownModel
      ? `; add its verified price period to plugin/mcp/model-dispatch/src/prices.ts, or give policy model ` +
        `'${model.id}' a pricing block with pricing_override: true to bill a custom price`
      : "";
    return { unpriced: true, model_name: name, reason: `${looked.reason}${hint}`, warnings };
  }

  // 2. The list prices it. A declared block is compared with the list's
  //    STANDARD card (no modifiers): a block is one flat card, so comparing it
  //    with a fast-mode or US-only rate would warn on every correct block.
  if (ownModel && model.pricing) {
    const standard = lookupPrice(name, day, {});
    if (!standard.unpriced) {
      const warning = blockMismatch(model, standard.pricing, standard.period);
      if (warning) warnings.push(warning);
    }
  }

  return {
    unpriced: false,
    basis: "list",
    model_name: name,
    pricing: looked.pricing,
    period: looked.period,
    applied_modifiers: looked.applied_modifiers,
    warnings,
  };
}

/** A declared rate differs when it is more than the tolerance away (any nonzero rate differs from a zero list rate). */
function differs(declared: number, listed: number): boolean {
  if (listed === 0) return declared !== 0;
  // The 1e-12 keeps a value exactly at the boundary from flipping on float noise.
  return Math.abs(declared - listed) > POLICY_PRICE_TOLERANCE * listed + 1e-12;
}

function blockMismatch(model: PricedModel, list: Required<ModelPricing>, period: PeriodRef): string | null {
  const block = model.pricing as ModelPricing;
  const declared = RATE_KEYS.filter((k) => typeof block[k] === "number");
  const off = declared.filter((k) => differs(block[k] as number, list[k]));
  if (off.length === 0) return null;
  const card = (rates: Partial<Record<RateKey, number>>) => `{${declared.map((k) => `${k} ${rates[k]}`).join(", ")}}`;
  return (
    `Policy model '${model.id}' (${model.model_name}): its pricing block ${card(block)} differs on ` +
    `${off.join(", ")} by more than ${POLICY_PRICE_TOLERANCE * 100}% from the price list ${card(list)} ` +
    `(period ${period.from}..${period.to ?? "open"}, ${period.source_url}, verified ${period.verified}). ` +
    `The list price is used; set pricing_override: true on this model to bill the block instead ` +
    `(reported as a custom price).`
  );
}

/**
 * Whether a run may start with this model, price-wise, on `date`.
 *
 * Unpriced is blocking in both auth modes and whether or not the server
 * dispatches the model: dispatched work would be refused mid-run, and work a
 * session runs in-session is priced from the same list by the collector, so
 * either way the run's cost would have a hole in it.
 *
 * Under `estimated`, a model the orchestrator runs in-session also needs a
 * pricing block: orchestrator.md rule 6 prices that estimated work from the
 * block text and aborts when it is missing, so the absence is caught here,
 * before anything is spent, rather than at the first estimate.
 */
export function checkModelPrice(model: ModelConfig, date: Date | string, authMode: AuthMode): PriceCheck {
  const r = effectivePrice(model, date);
  if (r.unpriced) return { ok: false, unpriced: true, reason: r.reason, warnings: r.warnings };
  if (authMode === "estimated" && model.adapter === IN_SESSION_ADAPTER && !model.pricing) {
    const list = RATE_KEYS.slice(0, 3).map((k) => `${k} ${(r.pricing as ModelPricing)[k]}`).join(", ");
    return {
      ok: false,
      unpriced: false,
      basis: r.basis,
      reason:
        `has no pricing block, but it runs inside the Claude Code session under auth_mode=estimated, where the ` +
        `orchestrator prices that work from the block (orchestrator.md rule 6). Add a pricing block equal to ` +
        `the price list ({${list}}), or run with auth_mode=vendor`,
      warnings: r.warnings,
    };
  }
  return { ok: true, basis: r.basis, warnings: r.warnings };
}
