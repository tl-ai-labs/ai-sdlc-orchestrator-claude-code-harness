/**
 * Pre-flight reachability assessment for the models a policy names.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * Two reasons, both practical. `server.ts` opens a stdio transport as a top-level
 * side effect, so importing it from a test hangs the test runner — the logic had to
 * move somewhere importable. And the decision this file encodes (which failures are
 * fatal) is exactly the kind of thing that needs unit tests, which means it must be
 * callable without a single credential on the machine. Hence the injected
 * `makeAdapter` factory: the real server passes the real adapter constructor, a test
 * passes a stub that fails on demand.
 *
 * WHAT IT DECIDES
 *
 * Not every model in a policy is dispatched through this server. That depends on the
 * run's auth mode, which is a per-run choice the operator makes (see operating rule 6
 * in plugin/agents/orchestrator.md):
 *
 *   - `vendor`    — the orchestrator routes EVERY call through `execute_with_model`,
 *                   including calls to its own tier, so that every telemetry event
 *                   carries vendor-reported tokens. Every adapter must therefore work.
 *
 *   - `estimated` — only mechanical-tier work is dispatched. The orchestrator's own
 *                   phases run inside the Claude Code conversation loop on the user's
 *                   subscription, and their tokens are char-count estimated. The
 *                   in-session adapter is never constructed and never called.
 *
 * Before this distinction existed, pre-flight built an adapter for every model and
 * halted if any of them threw. On 2026-08-04 that halted a perfectly viable
 * `estimated` run on an unset `ANTHROPIC_API_KEY` — a variable that run was never
 * going to read, for an adapter it was never going to construct. The halt was a false
 * positive, and a false positive on a mandatory pre-run gate is worse than no gate:
 * it teaches the operator to override the check.
 *
 * The authority for "the in-session tier does not need this key" is the adapter
 * itself. BuiltinAnthropicAdapter's own header says it exists so a standalone driver
 * script can run outside a Claude Code session, and that in the plugin the host CLI
 * does the dispatch with no API key in this process.
 *
 * A non-required model that fails is still reported — as a warning, not a halt. It is
 * real information (switching that same run to `vendor` mode would fail), and it costs
 * nothing to say so while the operator is already reading pre-flight output.
 */

/**
 * The adapter whose work the orchestrator performs in-session rather than dispatching.
 *
 * Keyed on the adapter name from the policy YAML rather than on a "premium vs
 * mechanical" notion of tier, because tier is a routing concept and this is a
 * transport concept. A policy that put a cheap model on `builtin-anthropic` would
 * still run it in-session under `estimated`; a policy that routed its premium model
 * through an MCP adapter would still need that adapter to work.
 */
export const IN_SESSION_ADAPTER = "builtin-anthropic";

export type AuthMode = "vendor" | "estimated";

/** The shape pre-flight needs from a policy's model entry. */
export interface PreflightModel {
  id: string;
  model_name: string;
  adapter: string;
}

export interface PreflightModelResult extends PreflightModel {
  /** Whether this run will actually dispatch to this model through this server. */
  required: boolean;
  ok: boolean;
  error?: string;
  /** Present only on failures: "blocking" halts the run, "warning" does not. */
  severity?: "blocking" | "warning";
}

export interface PreflightAssessment {
  models: PreflightModelResult[];
  ok: boolean;
  halt_reason: string | null;
  warnings: string[];
}

/**
 * Validate the run's auth mode.
 *
 * Deliberately throws rather than defaulting. Both defaults are wrong in a way that
 * costs real money: defaulting to `vendor` reinstates the false halt this module
 * exists to remove, and defaulting to `estimated` would wave through a genuinely
 * broken vendor run that then dies at the first dispatch. The error text matches the
 * abort string operating rule 6 already specifies, so an operator who hits it finds
 * one message and one explanation, not two.
 */
export function parseAuthMode(value: unknown): AuthMode {
  if (value === "vendor" || value === "estimated") return value;
  throw new Error(
    "this run requires auth_mode=vendor|estimated. Pre-flight cannot tell which models " +
      "will be dispatched through this server without it: under 'vendor' every model is, " +
      "under 'estimated' the orchestrator's own tier runs in-session and its adapter is " +
      "never constructed.",
  );
}

/**
 * Does this run dispatch this model's work through this server?
 *
 * Under `vendor`, yes for everything — that mode's whole purpose is that every token
 * on the report came from a vendor response this server read. Under `estimated`, only
 * for models the orchestrator cannot run itself.
 */
export function requiresServerDispatch(adapter: string, authMode: AuthMode): boolean {
  if (authMode === "vendor") return true;
  return adapter !== IN_SESSION_ADAPTER;
}

/**
 * Construct an adapter for every model and classify what fails.
 *
 * `makeAdapter` is called for required and non-required models alike. Constructing a
 * non-required one is cheap (no API call), it warms the same cache a later dispatch
 * would use, and its failure is worth reporting even though it must not halt.
 */
export function assessModels(
  models: PreflightModel[],
  authMode: AuthMode,
  makeAdapter: (modelId: string) => unknown,
): PreflightAssessment {
  const results: PreflightModelResult[] = models.map((m) => {
    const required = requiresServerDispatch(m.adapter, authMode);
    try {
      makeAdapter(m.id);
      return { id: m.id, model_name: m.model_name, adapter: m.adapter, required, ok: true };
    } catch (err: any) {
      return {
        id: m.id,
        model_name: m.model_name,
        adapter: m.adapter,
        required,
        ok: false,
        error: err?.message ?? String(err),
        severity: required ? "blocking" : "warning",
      };
    }
  });

  const blocking = results.filter((m) => !m.ok && m.required);
  const nonBlocking = results.filter((m) => !m.ok && !m.required);

  // Spelled out here rather than left to the caller, so the halt message an operator
  // sees is identical whichever model is driving the run.
  const halt_reason =
    blocking.length === 0
      ? null
      : `Cannot dispatch to ${blocking.length} of ${results.length} models in this policy: ` +
        blocking.map((f) => `${f.id} (${f.error})`).join("; ") +
        ". Do not start the run — every packet routed to these models would fall back to the " +
        "premium tier, producing a run that costs more than a single-model baseline. Fix " +
        "credentials first, then re-run this check.";

  const warnings = nonBlocking.map(
    (f) =>
      `${f.id} could not be constructed (${f.error}), but this run does not dispatch to it: ` +
      `auth_mode=${authMode} runs '${f.adapter}' work inside the Claude Code session instead of ` +
      `through this server. Not a blocker. It would block a vendor-mode run of the same policy.`,
  );

  return { models: results, ok: blocking.length === 0, halt_reason, warnings };
}
