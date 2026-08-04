/**
 * Shared type definitions for the multi-model orchestration layer.
 * The TaskPacket is the cost-control linchpin — every cross-model call uses it.
 */

export type Phase =
  | "requirements_analysis"
  | "architecture_design"
  | "plan_task_packets"
  | "codegen"
  | "tests"
  | "docs"
  | "debug"
  | "senior_code_review"
  | "security_review"
  | "refactor"
  | "final_report";

export interface FileSlice {
  path: string;
  content: string;
  reason: string; // why this slice was included (helps audit context bloat)
}

export interface TaskPacket {
  id: string;                // e.g. tp_codegen_042
  phase: Phase;
  task_type: string;         // controller_handler, dto, test_unit, etc.
  module: string;            // employees, leave, time, reports, auth, audit, cross
  instruction: string;       // crisp imperative, <300 tokens
  inputs: FileSlice[];       // sliced file fragments only — NEVER full Opus history
  outputSchema: Record<string, any>; // JSON schema for structured output
  acceptance: string[];      // testable bullets
  budget: { maxInputTokens: number; maxOutputTokens: number };
  retry_count?: number;
  pass_id: string;           // "pass1" | "pass2"
}

export interface TelemetryEvent {
  ts: string;                // ISO-8601
  pass: string;              // "pass1" | "pass2"
  phase: Phase;
  task_type: string;
  task_id: string;
  module: string;
  model: string;             // canonical model name from pricing table
  routed_by: "orchestrator" | "fallback" | "manual";
  routing: {
    policy_name: string;
    policy_version: number;
    rule_index: number;      // -1 = default
    rule_reason: string;
  };
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
  output_tokens_reasoning?: number; // thinking/reasoning tokens, billed at output rate; surfaced separately for cost-to-complete analysis
  cost_usd: number;
  /**
   * Wall-clock duration of the model call. `null` on the direct tier — those phases run
   * inside Claude Code and never reach this server, so no stopwatch ever ran. `null`
   * means "not measured"; `0` would falsely mean "returned instantly".
   */
  latency_ms: number | null;
  success: boolean;
  retry_count: number;
  // Output-cap doubling telemetry. When a dispatch hits max_tokens, the adapter
  // re-dispatches with 2× the previous ceiling; each attempt gets its own event,
  // grouped by task_id. attempt_number = 1 on the first try, 2 on the first
  // doubling, etc. ceiling_used records the max_tokens value the attempt ran
  // under. retry_reason is set on retries so the report can distinguish
  // output-cap doublings from other retry paths (validation failures, escalations).
  attempt_number?: number;
  ceiling_used?: number;
  retry_reason?: "output_cap" | "validation" | "escalation";
  artifact_path?: string;
  error?: string;
}

// Per-attempt record returned from the adapter loop when max_tokens doubling
// is triggered. The adapter emits one telemetry event per attempt using this
// shape; the report collapses them by task_id.
export interface AttemptRecord {
  attempt_number: number;      // 1-indexed
  ceiling_used: number;        // the max_tokens the attempt ran under
  stop_reason?: string;        // vendor's raw stop_reason / finishReason
  hit_output_cap: boolean;     // true iff the vendor signalled max_tokens
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number;
  };
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error?: string;
}

export interface ModelPricing {
  input: number;          // USD per 1M tokens
  input_cached: number;   // USD per 1M cached tokens
  output: number;         // USD per 1M tokens
}

/**
 * Optional reasoning/thinking controls. Vendors disagree on vocabulary:
 *   - Gemini uses thinkingConfig.thinkingLevel ("minimal" | "low" | "medium" | "high")
 *   - Z.ai / OpenAI-compat use thinking.type ("enabled" | "disabled") + reasoning_effort
 * Adapters consume whatever fields they understand; unknown fields are ignored.
 */
export interface ReasoningConfig {
  tier?: "minimal" | "low" | "medium" | "high";
  effort?: "off" | "low" | "high" | "max";
  enabled?: boolean;
}

export interface ModelConfig {
  id: string;
  adapter: string;        // "builtin-anthropic" | "mcp:<server>" | "gemini-thinking" | "builtin-openai-compat" | ...
  model_name: string;
  display_name?: string;
  pricing: ModelPricing;
  pricing_source?: string;
  auth?: { env: string };
  endpoint?: string;       // required by OpenAI-compat adapter, ignored by others
  reasoning?: ReasoningConfig;
  // Vendor-declared absolute output-tokens limit for this model. Adapters
  // clamp the doubling loop here — beyond this, the API rejects the request
  // with 400. If unset, the adapter defaults to a conservative fallback.
  max_output_tokens_absolute?: number;
}

export type RuleMatcher = {
  phase?: string | string[];
  task_type?: string | string[];
  module?: string | string[];
  retry_count?: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number };
};

export type Rule =
  | { when: RuleMatcher; use: string; reason?: string }
  | { default: string; reason?: string };

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
}

export interface RoutingDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;   // -1 if default
}

export interface ExecutionResult {
  result: any;
  tokens: {
    input: number;
    input_cached: number;
    output: number;
    output_reasoning?: number; // thinking/reasoning tokens, billed at output rate; null/0 for non-thinking models
  };
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
  success: boolean;
  error?: string;
  // Populated when the adapter ran a doubling loop. Length ≥ 1 (the successful
  // final attempt) plus one entry per doubling that was triggered. Enables the
  // orchestrator to emit one telemetry event per attempt with the same task_id.
  attempts?: AttemptRecord[];
  // Why the doubling loop stopped. Split so a reader can distinguish two
  // very different signals: "we ran out of retry budget while the model
  // still had headroom" (raise the doubling cap or the initial ceiling) vs
  // "we ran into the vendor's absolute ceiling" (nothing more the loop can
  // do; the packet is genuinely too big for this model).
  terminal_reason?:
    | "success"
    | "output_cap_doubling_budget_exhausted"
    | "output_cap_at_model_absolute"
    | "vendor_error";
}
