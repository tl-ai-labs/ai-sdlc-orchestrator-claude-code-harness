// Mirrors the Policy/ModelConfig/Rule/ReasoningConfig shapes in
// plugin/mcp/gemini-flash-server/src/types.ts. Duplicated rather than
// imported because that package builds to its own dist/ and this app has no
// workspace link to it — keep the two in sync by hand if the schema changes.

// The real vendor tier vocabulary, per adapter family:
//  - Gemini (@google/genai Node + google-genai Python, same ThinkingLevel
//    enum): MINIMAL/LOW/MEDIUM/HIGH — a genuine graded range.
//  - Anthropic (@anthropic-ai/sdk's ThinkingConfigParam, checked against the
//    current 0.116.0 release — the repo's pinned 0.32.1 predates thinking
//    entirely): no graded range. Just `enabled` with a numeric `budget_tokens`
//    (a dial, not a level) or `adaptive` (Claude picks its own depth per
//    call, not a fixed point on a scale). Opus genuinely supports thinking —
//    but neither real mode is a discrete tier, so this console offers no
//    picker for it (product decision) rather than one non-rangeable "auto"
//    button. `adaptive` stays in the type so a hand-written policy using it
//    still parses and displays correctly, even with no button to pick it.
// "off" is this console's own label for "no reasoning block at all", not a
// vendor value. There is no "max" — that was an invented label from an
// earlier draft that didn't match any real API.
export type Tier = "off" | "minimal" | "low" | "medium" | "high" | "adaptive";

export interface ModelPricing {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning?: number;
}

export interface ReasoningConfig {
  // "adaptive" is this console's addition, not yet reflected in
  // plugin/mcp/gemini-flash-server/src/types.ts's ReasoningConfig — flag
  // that file for the same update when Anthropic thinking gets wired there.
  tier?: "minimal" | "low" | "medium" | "high" | "adaptive";
  effort?: "off" | "low" | "high" | "max";
  enabled?: boolean;
}

export interface ModelConfig {
  id: string;
  adapter: string;
  model_name: string;
  display_name?: string;
  pricing: ModelPricing;
  pricing_source?: string;
  pricing_last_verified?: string;
  auth?: { env: string };
  endpoint?: string;
  reasoning?: ReasoningConfig;
  max_output_tokens_absolute?: number;
  region?: string;
  worker_timeout_sec?: number;
}

export type RuleMatcher = {
  phase?: string | string[];
  task_type?: string | string[];
  module?: string | string[];
  retry_count?: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number };
};

export type Rule =
  | { when: RuleMatcher; use: string; reason?: string; reasoning?: ReasoningConfig }
  | { default: string; reason?: string };

export interface SelectSlot {
  default: string;
  options: string[];
  reason?: string;
}

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
  select?: Record<string, SelectSlot>;
}

// The nine phases the orchestrator dispatches, in pipeline order. Routing
// and thinking capacity are configurable per phase; the codegen task_type
// breakdown and the debug retry-escalation rule stay structural (see
// docs/specs/custom-policy-and-thinking-config.md, non-goals).
export const PHASES: { id: string; label: string; note: string }[] = [
  { id: "requirements_analysis", label: "Requirements", note: "judgment · low volume" },
  { id: "architecture_design", label: "Design", note: "foundational · decision-bearing" },
  { id: "plan_task_packets", label: "Task planning", note: "needs full context" },
  { id: "codegen", label: "Codegen", note: "schema-driven boilerplate" },
  { id: "tests", label: "Tests", note: "scaffold-heavy" },
  { id: "docs", label: "Docs", note: "volume work" },
  { id: "senior_code_review", label: "Senior review", note: "cross-file judgment" },
  { id: "security_review", label: "Security review", note: "risk-bearing · low volume" },
  { id: "debug", label: "Debug", note: "escalates to opus at retry ≥ 2" },
];

export const GEMINI_TIERS: Tier[] = ["off", "minimal", "low", "medium", "high"];
// Empty, not omitted: Anthropic has no graded range to offer (see the Tier
// comment above) — this is a deliberate "nothing to pick" rather than an
// unmapped adapter falling through the function's final `return []`.
export const ANTHROPIC_TIERS: Tier[] = [];

/**
 * Which tiers a model's real vendor API offers as a *graded range* — not
 * which ones our own adapters currently wire up (see
 * plugin/policy-console/README.md's known gap), and not every thinking mode
 * the vendor has (Anthropic's `adaptive` and numeric `budget_tokens` are
 * real but aren't a range, so Opus offers none here). Gemini's
 * `ThinkingLevel` enum (google-genai, both Node and Python packages) is
 * MINIMAL/LOW/MEDIUM/HIGH regardless of which door (flash-completion vs
 * flash-agsdk-worker) reaches it.
 */
export function thinkingSupport(model: ModelConfig): Tier[] {
  if (model.adapter === "mcp:gemini-flash-server" || model.adapter === "antigravity-worker") {
    return GEMINI_TIERS;
  }
  if (model.adapter === "builtin-anthropic") {
    return ANTHROPIC_TIERS;
  }
  return [];
}

/**
 * The adapters real code exists for (plugin/mcp/gemini-flash-server/src/adapters/).
 * A new model can pick one of these and supply its own model_name/pricing —
 * a new *adapter* (a new vendor integration) is still a code change, not
 * something this console can safely fabricate: there'd be nothing to
 * dispatch the call.
 */
export const KNOWN_ADAPTERS = ["builtin-anthropic", "mcp:gemini-flash-server", "antigravity-worker"] as const;
export type KnownAdapter = (typeof KNOWN_ADAPTERS)[number];

export const ADAPTER_LABEL: Record<KnownAdapter, string> = {
  "builtin-anthropic": "Anthropic (Claude)",
  "mcp:gemini-flash-server": "Gemini — completion call",
  "antigravity-worker": "Gemini — Antigravity agent (SDK worker)",
};

export function defaultAuthEnv(adapter: string): string {
  return adapter === "builtin-anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
}

// Names shipped with the plugin. Anything else in plugin/config/policies is
// a saved custom policy. Mirrors the list policy.ts reports on a missing name.
export const SHIPPED_PRESETS = ["opus-only", "opus-plus-flash"];

function hasWhen(rule: Rule): rule is { when: RuleMatcher; use: string; reason?: string; reasoning?: ReasoningConfig } {
  return "when" in rule;
}

/**
 * A rule's `use` may name a concrete model id or a `select` slot (e.g.
 * `gemini-flash` resolving to `flash-completion` by default). The customize
 * screen offers concrete model ids only — dereference here so a row's value
 * always matches one of the dropdown's own options. A saved custom policy
 * therefore pins a concrete choice rather than staying slot-selectable;
 * that's deliberate (see docs/specs/custom-policy-and-thinking-config.md
 * non-goals — this console doesn't edit `select` block definitions either).
 */
function resolveSlot(policy: Policy, use: string): string {
  const slot = policy.select?.[use];
  return slot ? slot.default : use;
}

/**
 * What a phase resolves to today, ignoring retry-escalation rules — the
 * "steady state" answer a customize screen should show as the starting
 * point. Escalation rules (debug's retry_count >= 2) are structural and
 * carried through unedited by buildCustomPolicy below.
 */
export function resolvePhaseDefault(policy: Policy, phaseId: string): string | undefined {
  for (const rule of policy.rules) {
    if (hasWhen(rule)) {
      if (rule.when.retry_count) continue;
      const phases = Array.isArray(rule.when.phase)
        ? rule.when.phase
        : rule.when.phase
          ? [rule.when.phase]
          : [];
      if (phases.includes(phaseId)) return resolveSlot(policy, rule.use);
    }
  }
  const fallback = policy.rules.find((r): r is { default: string; reason?: string } => "default" in r);
  return fallback ? resolveSlot(policy, fallback.default) : undefined;
}

export function resolvePhaseThinking(policy: Policy, phaseId: string): Tier {
  for (const rule of policy.rules) {
    if (hasWhen(rule)) {
      if (rule.when.retry_count) continue;
      const phases = Array.isArray(rule.when.phase)
        ? rule.when.phase
        : rule.when.phase
          ? [rule.when.phase]
          : [];
      if (phases.includes(phaseId)) return rule.reasoning?.tier ?? "off";
    }
  }
  return "off";
}

/** The codegen rule's task_type array, if the policy scopes it that way. */
export function codegenTaskTypes(policy: Policy): string[] | undefined {
  for (const rule of policy.rules) {
    if (hasWhen(rule) && rule.when.task_type) {
      const phases = Array.isArray(rule.when.phase) ? rule.when.phase : [rule.when.phase];
      if (phases.includes("codegen")) {
        return Array.isArray(rule.when.task_type) ? rule.when.task_type : [rule.when.task_type];
      }
    }
  }
  return undefined;
}

/** The debug retry-escalation rule, if the policy declares one — carried through unedited. */
export function debugEscalationRule(policy: Policy): Rule | undefined {
  return policy.rules.find(
    (r): r is { when: RuleMatcher; use: string; reason?: string; reasoning?: ReasoningConfig } =>
      hasWhen(r) &&
      !!r.when.retry_count &&
      (Array.isArray(r.when.phase) ? r.when.phase.includes("debug") : r.when.phase === "debug")
  );
}

export function fallbackRule(policy: Policy): { default: string; reason?: string } | undefined {
  return policy.rules.find((r): r is { default: string; reason?: string } => "default" in r);
}

/** The structural rule pieces a customize screen carries through unedited. */
export interface StructuralParts {
  codegenTaskTypes?: string[];
  debugEscalation?: Rule;
  fallback?: Rule;
}

export interface PolicySummary {
  id: string;
  origin: "preset" | "custom";
  desc: string;
  models: ModelConfig[];
  select?: Record<string, SelectSlot>;
  routing: Record<string, string>;
  thinking: Record<string, Tier>;
  structural: StructuralParts;
}

export function summarizePolicy(id: string, policy: Policy, headerComment?: string): PolicySummary {
  const routing: Record<string, string> = {};
  const thinking: Record<string, Tier> = {};
  for (const phase of PHASES) {
    routing[phase.id] = resolvePhaseDefault(policy, phase.id) ?? policy.models[0]?.id ?? "";
    thinking[phase.id] = resolvePhaseThinking(policy, phase.id);
  }
  return {
    id,
    origin: SHIPPED_PRESETS.includes(id) ? "preset" : "custom",
    desc: headerComment || describePolicy(policy),
    models: policy.models,
    select: policy.select,
    routing,
    thinking,
    structural: {
      codegenTaskTypes: codegenTaskTypes(policy),
      debugEscalation: debugEscalationRule(policy),
      fallback: fallbackRule(policy),
    },
  };
}

function describePolicy(policy: Policy): string {
  const modelCount = policy.models.length;
  if (modelCount === 1) return `Single model — every phase runs on ${policy.models[0].id}.`;
  return `${modelCount} models across ${policy.rules.length} routing rules.`;
}

/** The first leading `#`-comment line of a policy file, used as its card description. */
export function extractHeaderComment(rawYaml: string): string | undefined {
  const firstLine = rawYaml.split("\n")[0]?.trim();
  if (firstLine?.startsWith("#")) return firstLine.replace(/^#\s*/, "");
  return undefined;
}
