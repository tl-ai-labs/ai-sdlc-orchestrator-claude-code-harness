/**
 * Pure routing function — given a task context and a policy, returns the
 * model decision. Pure so it's trivially testable and can power the
 * dashboard's "what-if simulator" by replaying telemetry against a
 * different policy without re-running any LLMs.
 */

import type { Policy, Rule, RoutingDecision, RuleMatcher } from "./types.js";

export interface TaskContext {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
}

export function pickModel(ctx: TaskContext, policy: Policy): RoutingDecision {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) continue; // handle defaults last
    if (matches(rule.when, ctx)) {
      return {
        modelId: rule.use,
        reason: rule.reason ?? `matched rule ${i} (${describeMatcher(rule.when)})`,
        ruleIndex: i,
      };
    }
  }
  // Fall through to default
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) {
      return {
        modelId: rule.default,
        reason: rule.reason ?? "fell through to policy default",
        ruleIndex: -1,
      };
    }
  }
  throw new Error(
    `Policy '${policy.name}' has no rule matching ${JSON.stringify(ctx)} and no default rule.`
  );
}

function matches(matcher: RuleMatcher, ctx: TaskContext): boolean {
  if (matcher.phase !== undefined && !inSet(matcher.phase, ctx.phase)) return false;
  if (matcher.task_type !== undefined && !inSet(matcher.task_type, ctx.task_type)) return false;
  if (matcher.module !== undefined && !inSet(matcher.module, ctx.module)) return false;
  if (matcher.retry_count !== undefined) {
    const r = ctx.retry_count;
    const m = matcher.retry_count;
    if (m.lt !== undefined && !(r < m.lt)) return false;
    if (m.lte !== undefined && !(r <= m.lte)) return false;
    if (m.gt !== undefined && !(r > m.gt)) return false;
    if (m.gte !== undefined && !(r >= m.gte)) return false;
    if (m.eq !== undefined && !(r === m.eq)) return false;
  }
  return true;
}

function inSet(set: string | string[], value: string): boolean {
  return Array.isArray(set) ? set.includes(value) : set === value;
}

function describeMatcher(m: RuleMatcher): string {
  const parts: string[] = [];
  for (const k of ["phase", "task_type", "module"] as const) {
    if (m[k] !== undefined) parts.push(`${k}=${JSON.stringify(m[k])}`);
  }
  if (m.retry_count) parts.push(`retry_count=${JSON.stringify(m.retry_count)}`);
  return parts.join(", ") || "wildcard";
}

/**
 * Replay helper for the dashboard's what-if simulator.
 * Given a list of telemetry events (real run) and an alternate policy,
 * recompute what the cost would have been.
 */
export interface ReplayEvent {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
}

export function simulatePolicyCost(
  events: ReplayEvent[],
  policy: Policy
): { total_cost_usd: number; per_model: Record<string, number> } {
  const perModel: Record<string, number> = {};
  let total = 0;
  for (const ev of events) {
    const decision = pickModel(ev, policy);
    const model = policy.models.find((m) => m.id === decision.modelId);
    if (!model) continue;
    const inputFresh = ev.input_tokens - ev.input_tokens_cached;
    const cost =
      (inputFresh / 1_000_000) * model.pricing.input +
      (ev.input_tokens_cached / 1_000_000) * model.pricing.input_cached +
      (ev.output_tokens / 1_000_000) * model.pricing.output;
    perModel[model.id] = (perModel[model.id] ?? 0) + cost;
    total += cost;
  }
  return { total_cost_usd: total, per_model: perModel };
}
