/**
 * GeminiFlashAdapter — calls Gemini 3.5 Flash, with explicit context caching
 * for the stable project header to amortize the input cost across many
 * TaskPackets in a single pass.
 *
 * The adapter is auth-agnostic. Google exposes Gemini through two front doors
 * — AI Studio (an API key) and Vertex AI (Application Default Credentials on a
 * GCP project) — and which one is reachable depends entirely on whose machine
 * this runs on. Both live behind `GeminiTransport` in ./geminiTransports.ts,
 * chosen from the credentials present at construction time. Everything below
 * this line — the output-cap doubling loop, prompt assembly, JSON-schema mode,
 * per-attempt telemetry — is identical on both doors and is written once.
 *
 * Falls back gracefully to implicit caching if explicit cache creation fails.
 */

import type {
  AttemptRecord,
  ExecutionResult,
  ModelConfig,
  ModelPricing,
  TaskPacket,
} from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import {
  applyVertexSurcharge,
  billedOutputTokens,
  buildGeminiTransport,
  type BackendChoice,
  type GeminiTransport,
  type GenerateOutcome,
} from "./geminiTransports.js";

// Fallback when the policy YAML doesn't declare max_output_tokens_absolute
// for a Gemini model. 8192 is the current Gemini 3.5 Flash generation ceiling
// on the standard API; overriding via the YAML is the way to lift it if the
// vendor bumps it in the future.
const GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 8192;

// Cap on doublings per execute() — matches the Anthropic adapter so the
// report can compare per-model doubling behavior on equal footing.
const MAX_DOUBLINGS = 3;

// TTL on the explicit context cache, in seconds. One hour comfortably covers
// a full pass; the cache is per-run and never reused across runs, so a longer
// TTL would only keep paying storage for content nothing will read again.
const CACHE_TTL_SECONDS = 3600;

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private transport: GeminiTransport;
  /** Which door we came in through — surfaced in errors and setup logs. */
  readonly backendChoice: BackendChoice;
  /**
   * The policy's pinned rates adjusted for where the calls actually run.
   * Identical to `modelConfig.pricing` on every default run; differs only when
   * a user has pinned a Vertex region. Every cost figure this adapter reports
   * is computed from this, never from the raw pin.
   */
  readonly billedPricing: ModelPricing;
  private cachingAvailable = true;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    // auth.env names the API-key variable the policy expects. It is only one
    // of the two doors: buildGeminiTransport falls through to Vertex/ADC when
    // that variable is absent, and throws — naming both doors — when neither
    // is available. Throwing here, at construction, is deliberate: it happens
    // during setup validation, before any premium-tier phase has been billed.
    const { transport, choice } = buildGeminiTransport(config.auth?.env ?? "GEMINI_API_KEY");
    this.transport = transport;
    this.backendChoice = choice;
    // The rates in the policy YAML are the flat global/AI-Studio card. Vertex
    // charges +10% on regional endpoints for Gemini 3+, so on a pinned region
    // the pinned rates are not the billed rates. Resolve the difference once,
    // here, rather than at each call site — a cost path that is right in one
    // place and stale in another is worse than one that is wrong everywhere.
    this.billedPricing = applyVertexSurcharge(config.pricing, {
      backend: choice.backend,
      location: transport.location,
      modelName: config.model_name,
    });
  }

  /**
   * Prime the explicit context cache with the stable project header.
   * Call once at the start of a pass. cacheKey is e.g. "pass2:workforce-ops".
   */
  async primeCache(cacheKey: string, header: string): Promise<void> {
    this.cacheHeader = header;
    if (!this.cachingAvailable) return;
    try {
      const cacheName = await this.transport.createCache(
        this.modelConfig.model_name,
        cacheKey,
        header,
        CACHE_TTL_SECONDS,
      );
      if (cacheName) {
        this.cacheNamesByKey.set(cacheKey, cacheName);
      } else {
        // The transport told us caching is unavailable on this door (e.g. no
        // resolvable GCP project on the Vertex path). Stop re-attempting it.
        this.cachingAvailable = false;
      }
    } catch {
      // Explicit caching not available (quota / model mismatch / API change /
      // minimum-token floor not met). Fall back to inlining the stable header
      // on every call: more expensive, but the run still completes.
      this.cachingAvailable = false;
    }
  }

  async execute(packet: TaskPacket, cacheContext?: string): Promise<ExecutionResult> {
    const cacheName = cacheContext ? this.cacheNamesByKey.get(cacheContext) : undefined;
    const cacheHit = !!cacheName;
    const userPrompt = buildUserPrompt(packet, !cacheHit ? this.cacheHeader : "");

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    // Free-text marker on outputSchema means the caller wants fenced code
    // blocks / plain markdown back, not JSON. Skip JSON mode entirely and
    // don't forward the marker as a schema (Google's API rejects unknown
    // fields like `__free_text__` with 400).
    const wantsJson = packet.outputSchema && !(packet.outputSchema as any).__free_text__;

    const attempts: AttemptRecord[] = [];
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      const generationConfig: any = {
        temperature: 0.2,
        maxOutputTokens: ceiling,
        ...(wantsJson ? { responseMimeType: "application/json" } : {}),
      };
      if (wantsJson) generationConfig.responseSchema = packet.outputSchema;

      let outcome: GenerateOutcome;
      try {
        outcome = await this.transport.generate({
          modelName: this.modelConfig.model_name,
          prompt: userPrompt,
          generationConfig,
          cachedContentName: cacheName,
        });
      } catch (err: any) {
        const failTokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        attempts.push({
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, this.billedPricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: err?.message ?? String(err),
        });
        return this.finalizeResult(attempts, null, cacheHit, "vendor_error");
      }

      const text = outcome.text;
      const usage = outcome.usage;

      // Gemini's promptTokenCount is the WHOLE prompt, cached portion
      // included — cachedContentTokenCount is a subset of it, not a sibling.
      // computeCostUsd() requires the two counts to be disjoint (fresh at the
      // full rate, cached at the discounted one), so subtract before handing
      // them over. Without this the cached tokens are billed twice in the
      // report — once at the full rate and once at the cached rate — which
      // makes an effective cache look more expensive than no cache at all.
      // Math.max guards against a vendor edge case where the reported cached
      // count exceeds the prompt count; a negative would corrupt the totals.
      const cachedTokens =
        usage.cachedContentTokenCount ?? (cacheHit ? estimateTokens(this.cacheHeader) : 0);
      const promptTokens = usage.promptTokenCount ?? estimateTokens(userPrompt);
      // Output is candidates + thoughts: Gemini 3.x bills the reasoning it
      // does before answering at the output rate, and reports it in a separate
      // field. See billedOutputTokens for why reading candidates alone is a
      // large under-report rather than a small one. The estimate fallback
      // stands in only when the vendor sent no usage block at all — a
      // zero-length answer with a real usage block is genuinely zero
      // candidate tokens, and `?? 0` inside the helper keeps it that way.
      const outputTokens =
        usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
          ? estimateTokens(text)
          : billedOutputTokens(usage);
      const attemptTokens = {
        input: Math.max(0, promptTokens - cachedTokens),
        input_cached: cachedTokens,
        output: outputTokens,
      };

      // Gemini reports the finish reason on the first candidate. "MAX_TOKENS"
      // is the truncation signal; anything else (STOP, SAFETY, RECITATION,
      // OTHER) is a genuine termination and should not double.
      const finishReason = outcome.finishReason;
      const hitOutputCap = finishReason === "MAX_TOKENS";

      attempts.push({
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: finishReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.billedPricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
      });

      if (!hitOutputCap) {
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, cacheHit, "success");
      }

      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling;
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        return this.finalizeResult(
          attempts,
          { raw: text, _truncated: true },
          cacheHit,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
        );
      }
      ceiling = nextCeiling;
    }

    return this.finalizeResult(attempts, null, cacheHit, "output_cap_doubling_budget_exhausted");
  }

  private finalizeResult(
    attempts: AttemptRecord[],
    parsed: any,
    cacheHit: boolean,
    terminalReason:
      | "success"
      | "output_cap_doubling_budget_exhausted"
      | "output_cap_at_model_absolute"
      | "vendor_error",
  ): ExecutionResult {
    const totalTokens = attempts.reduce(
      (acc, a) => ({
        input: acc.input + a.tokens.input,
        input_cached: acc.input_cached + a.tokens.input_cached,
        output: acc.output + a.tokens.output,
      }),
      { input: 0, input_cached: 0, output: 0 },
    );
    const totalCost = attempts.reduce((s, a) => s + a.cost_usd, 0);
    const totalLatency = attempts.reduce((s, a) => s + a.latency_ms, 0);
    const finalAttempt = attempts[attempts.length - 1];
    return {
      result: parsed,
      tokens: totalTokens,
      cost_usd: totalCost,
      latency_ms: totalLatency,
      cache_hit: cacheHit,
      success: terminalReason === "success",
      error: finalAttempt?.error,
      attempts,
      terminal_reason: terminalReason,
    };
  }
}

function buildUserPrompt(packet: TaskPacket, headerInline: string): string {
  const inputsBlock = packet.inputs
    .map((s) => `### ${s.path}  — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    headerInline ? `## Project header (inlined; cache miss)\n${headerInline}\n` : "",
    `## Task — ${packet.id} (${packet.phase} / ${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    inputsBlock || "_(none)_",
    ``,
    `### Acceptance criteria`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output`,
    `Respond with strictly valid JSON conforming to the provided response schema.`,
    `Do not include any prose, markdown, or commentary outside the JSON.`,
  ]
    .filter(Boolean)
    .join("\n");
}
