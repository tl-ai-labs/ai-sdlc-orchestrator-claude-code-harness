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
  /**
   * The policy leaf that ran, e.g. "flash-completion" or "flash-agsdk-worker".
   *
   * Not redundant with `model`: two leaves can name the same vendor model and
   * differ only in how it is reached — one completion call versus an agent
   * session with tools — so `model` alone cannot tell a reader which of them
   * produced a row, and their costs differ by several times. Optional because
   * every event written before this field existed lacks it.
   */
  model_id?: string;
  routed_by: "orchestrator" | "fallback" | "manual";
  routing: {
    policy_name: string;
    policy_version: number;
    rule_index: number;      // -1 = default
    rule_reason: string;
    /**
     * Present only when the matched rule named a select slot. `overridden`
     * distinguishes "the run asked for this leaf" from "the run accepted the
     * policy's default", which is the difference between a deliberate result
     * and an inherited one when the numbers are read back months later.
     */
    select?: { slot: string; chosen: string; overridden: boolean };
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
  /**
   * Vertex region this leaf runs in, e.g. "global" or "asia-south1".
   *
   * Declared on the leaf rather than read from the environment because it is a
   * pricing input, not a deployment detail: Vertex adds 10% to every token
   * class on a regional (non-`global`) endpoint for Gemini 3+, so a run's cost
   * is only reproducible if the region it ran in is written down beside the
   * rates. Unset means "whatever GOOGLE_CLOUD_LOCATION says, else global",
   * which is the behaviour every policy had before this field existed.
   */
  region?: string;
  /**
   * Seconds an agent-worker delegation may run before it is abandoned. Only
   * read by adapters that spawn a worker; ignored by the completion adapters,
   * which have no session to time.
   *
   * Exists because the useful ceiling is a property of the TASK, not of the
   * model: an agent asked to write one module and an agent asked to fix a
   * failing test suite have wildly different honest durations, and the only
   * place that difference is known is the policy.
   */
  worker_timeout_sec?: number;
}

/**
 * Where the run is happening, as opposed to what it is asking for.
 *
 * The TaskPacket says what to do; this says where on disk to do it. Completion
 * adapters need none of it — they send text and get text back. An agent worker
 * needs all of it: a directory it may act in, and somewhere to leave the
 * evidence of what it did.
 *
 * Optional throughout, and optional as an argument, so that adapters which do
 * not care never had to change when it was introduced.
 */
export interface RunContext {
  /** The user's project root — the run's default workspace. */
  project_root?: string;
  /**
   * The directory a delegated agent may read, edit and run commands in.
   * Narrower than `project_root` when the orchestrator wants a worker confined
   * to the generated application rather than the whole repository.
   */
  work_dir?: string;
  /**
   * The run's telemetry JSONL. Used as the anchor for delegation evidence, so
   * that a worker's brief and usage sidecar land in the same pass directory the
   * report already reads rather than somewhere a reader has to be told about.
   */
  telemetry_path?: string;
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

/**
 * One logical slot a rule may name instead of a concrete model leaf.
 *
 * A slot is a QUESTION the policy declines to answer at authoring time — "which
 * of these vetted ways of reaching the mechanical tier should this run use?" —
 * and `options` is the complete list of answers it will accept. The run picks
 * one; if it picks none it gets `default`.
 *
 * Why the options are enumerated rather than left open: a selection can then
 * never invent a model. A typo fails when the policy loads, before any tokens
 * are spent, instead of surfacing as an unknown-model throw partway through a
 * paid phase.
 */
export interface SelectSlot {
  /** The option used when the run selects nothing. Must be one of `options`. */
  default: string;
  /** Every leaf this slot may resolve to. Non-empty; each is a real model id. */
  options: string[];
  /** Human note explaining what the choice trades off. Surfaced in errors. */
  reason?: string;
}

/** A run's answers to the policy's slots, keyed by slot name. */
export type SelectOverrides = Record<string, string>;

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
  /**
   * Logical slots, keyed by the name a rule uses. Optional, and absent from
   * every policy written before slots existed — which is why a rule naming a
   * concrete model id still resolves without consulting this map at all.
   */
  select?: Record<string, SelectSlot>;
}

export interface RoutingDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;   // -1 if default
  /**
   * Present only when the matched rule named a slot. Records which slot was
   * resolved, what it resolved to, and whether the run asked for that leaf or
   * merely accepted the policy's default — three facts that are impossible to
   * recover from `modelId` alone once resolution has happened.
   */
  selection?: { slot: string; chosen: string; overridden: boolean };
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
