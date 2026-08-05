/**
 * Pure routing function — given a task context and a policy, returns the
 * model decision. Pure so it's trivially testable and can power the
 * dashboard's "what-if simulator" by replaying telemetry against a
 * different policy without re-running any LLMs.
 *
 * ---------------------------------------------------------------------------
 * SELECT SLOTS
 * ---------------------------------------------------------------------------
 * A rule may name a LOGICAL slot declared in `policy.select` instead of a
 * concrete model id. `pickModel` resolves it here, at the last possible moment,
 * against the run's chosen options — so one policy file can hold every way of
 * reaching a tier and the RUN picks which one executes.
 *
 * Why it is resolved here rather than by editing the policy between runs:
 * a policy file is the record of how a run was priced and routed, and every
 * cost number already exported from it is read back against that file. Editing
 * it to switch adapter silently re-bases all of them. Resolving at routing time
 * leaves the file untouched and records the choice in the decision instead.
 *
 * The resolved `modelId` is ALWAYS concrete. Nothing downstream of this
 * function ever sees a slot name, so adapters, pricing and telemetry need no
 * knowledge of slots at all.
 */

import type {
  Policy,
  Rule,
  RoutingDecision,
  RuleMatcher,
  SelectOverrides,
} from "./types.js";

export interface TaskContext {
  phase: string;
  task_type: string;
  module: string;
  retry_count: number;
}

/**
 * Parse a run's slot choices from the `slot=option[,slot=option...]` spelling.
 *
 * That spelling exists because this server is configured through a single
 * environment variable (see SELECT_ENV in server.ts): the plugin route passes
 * env vars through `plugin.json` and the clone route through `.mcp.json`, and
 * neither can carry structured data. One variable holding pairs keeps the
 * install surface at one line while still allowing more than one slot later.
 *
 * An empty or whitespace-only spec means "no choices", not an error — an
 * unset variable and a variable set to "" have to behave identically, since a
 * user who answers the wizard's default gets one or the other depending on
 * which route installed the server.
 */
export function parseSelectOverrides(spec: string | undefined): SelectOverrides {
  const out: SelectOverrides = {};
  if (!spec || !spec.trim()) return out;
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      throw new Error(
        `Invalid select spec '${piece}'. Expected 'slot=option', ` +
          `comma-separated for more than one (e.g. 'gemini-flash=flash-agsdk-worker').`
      );
    }
    out[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Check a run's slot choices against the policy BEFORE the run starts.
 *
 * Called once when the policy loads. Without it, a bad choice would first
 * surface as a throw from `pickModel` partway through a phase — after earlier
 * phases have already been paid for. Both messages name the legal values,
 * because the commonest cause by far is a typo.
 */
export function validateSelectOverrides(policy: Policy, overrides: SelectOverrides): void {
  for (const [slot, chosen] of Object.entries(overrides)) {
    const declared = policy.select?.[slot];
    if (!declared) {
      const known = Object.keys(policy.select ?? {});
      throw new Error(
        `select '${slot}': policy '${policy.name}' has no such slot. ` +
          (known.length ? `Known slots: ${known.join(", ")}` : "This policy declares no slots.")
      );
    }
    if (!declared.options.includes(chosen)) {
      throw new Error(
        `select ${slot}=${chosen}: '${chosen}' is not one of that slot's options ` +
          `(${declared.options.join(", ")}). The options are the vetted set — ` +
          `add it to the policy first.`
      );
    }
  }
}

/**
 * Turn whatever a rule named into a concrete model id.
 *
 * A concrete model id passes straight through and carries no selection trace,
 * which is what keeps every policy written before slots existed resolving
 * exactly as it always did.
 */
export function resolveNamed(
  policy: Policy,
  named: string,
  overrides: SelectOverrides = {}
): { modelId: string; selection?: RoutingDecision["selection"] } {
  const slot = policy.select?.[named];
  if (!slot) return { modelId: named };

  const override = overrides[named];
  if (override !== undefined && !slot.options.includes(override)) {
    // Reachable only when the caller skipped validateSelectOverrides. Refuse
    // rather than quietly fall back to the default: a run that ignored the
    // tier it was asked for would produce numbers labelled as the wrong one.
    throw new Error(
      `select ${named}=${override}: not one of that slot's options (${slot.options.join(", ")})`
    );
  }

  const chosen = override ?? slot.default;
  return {
    modelId: chosen,
    selection: { slot: named, chosen, overridden: override !== undefined },
  };
}

/**
 * Model ids this run has ruled out by choosing a different option in their slot.
 *
 * WHY THIS EXISTS. Pre-flight constructs an adapter for every model a policy
 * declares, and a constructor is deliberately strict — it throws on a missing
 * project, a missing interpreter, a missing worker script — so that those
 * failures surface once, before any money is spent, instead of crashing halfway
 * through a paid phase. That is exactly right for a model the run will dispatch
 * to, and exactly wrong for one it will not. The moment a policy holds two ways
 * of reaching the same tier, the losing option is present in `policy.models` but
 * unreachable by any rule, and halting on its prerequisites would make everyone
 * on the default path install the other path's dependencies to run at all.
 *
 * The exclusion is narrow on purpose. Only an option that LOST its slot's
 * selection is dropped, and only if nothing else can reach it — a rule naming it
 * outright, or another slot resolving to it, both keep it in. A policy with no
 * `select:` block therefore yields an empty set and pre-flight behaves exactly
 * as it did before slots existed.
 */
export function unreachableModelIds(
  policy: Policy,
  overrides: SelectOverrides = {}
): Set<string> {
  const unreachable = new Set<string>();
  if (!policy.select) return unreachable;

  for (const [name, slot] of Object.entries(policy.select)) {
    const { modelId: chosen } = resolveNamed(policy, name, overrides);
    for (const option of slot.options) {
      if (option !== chosen) unreachable.add(option);
    }
  }

  // Anything a rule names directly is reachable whatever the slots decided, and
  // an id chosen by one slot is reachable even if another slot rejected it.
  for (const rule of policy.rules) {
    const named = "use" in rule ? rule.use : rule.default;
    if (policy.select?.[named]) {
      unreachable.delete(resolveNamed(policy, named, overrides).modelId);
    } else {
      unreachable.delete(named);
    }
  }

  return unreachable;
}

export function pickModel(
  ctx: TaskContext,
  policy: Policy,
  overrides: SelectOverrides = {}
): RoutingDecision {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) continue; // handle defaults last
    if (matches(rule.when, ctx)) {
      const resolved = resolveNamed(policy, rule.use, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? `matched rule ${i} (${describeMatcher(rule.when)})`,
        ruleIndex: i,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
      };
    }
  }
  // Fall through to default
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) {
      const resolved = resolveNamed(policy, rule.default, overrides);
      return {
        modelId: resolved.modelId,
        reason: rule.reason ?? "fell through to policy default",
        ruleIndex: -1,
        ...(resolved.selection ? { selection: resolved.selection } : {}),
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
  policy: Policy,
  // The what-if is only honest if it replays the same slot choices the real
  // run would make. Defaulting to none means a simulation of a slotted policy
  // prices its defaults, which is the right answer when the caller has not
  // said otherwise.
  overrides: SelectOverrides = {}
): { total_cost_usd: number; per_model: Record<string, number> } {
  const perModel: Record<string, number> = {};
  let total = 0;
  for (const ev of events) {
    const decision = pickModel(ev, policy, overrides);
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
