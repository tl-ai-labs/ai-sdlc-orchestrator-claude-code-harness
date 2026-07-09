/**
 * GeminiFlashAdapter — calls Gemini 3.5 Flash via @google/generative-ai,
 * with explicit context caching for the stable project header to amortize
 * the input cost across many TaskPackets in a single pass.
 *
 * Falls back gracefully to implicit caching if explicit cache creation fails.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";

// Fallback when the policy YAML doesn't declare max_output_tokens_absolute
// for a Gemini model. 8192 is the current Gemini 3.5 Flash generation ceiling
// on the standard API; overriding via the YAML is the way to lift it if the
// vendor bumps it in the future.
const GEMINI_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 8192;

// Cap on doublings per execute() — matches the Anthropic adapter so the
// report can compare per-model doubling behavior on equal footing.
const MAX_DOUBLINGS = 3;

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private genAI: GoogleGenerativeAI;
  private cacheManager?: GoogleAICacheManager;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    const envKey = config.auth?.env ?? "GEMINI_API_KEY";
    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(
        `${envKey} not set. The GeminiFlashAdapter requires this env var to call Google's API.`
      );
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    try {
      this.cacheManager = new GoogleAICacheManager(apiKey);
    } catch {
      // Older SDKs may not export this; we'll fall back to implicit caching.
      this.cacheManager = undefined;
    }
  }

  /**
   * Prime the explicit context cache with the stable project header.
   * Call once at the start of a pass. cacheKey is e.g. "pass2:workforce-ops".
   */
  async primeCache(cacheKey: string, header: string): Promise<void> {
    this.cacheHeader = header;
    if (!this.cacheManager) return;
    try {
      const created = await this.cacheManager.create({
        model: `models/${this.modelConfig.model_name}`,
        displayName: cacheKey,
        contents: [{ role: "user", parts: [{ text: header }] }],
        ttlSeconds: 3600,
      });
      if (created?.name) {
        this.cacheNamesByKey.set(cacheKey, created.name);
      }
    } catch (err) {
      // Explicit caching not available (quota / model mismatch / API change).
      // Fall back to inlining the stable header on every call.
      this.cacheManager = undefined;
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

    const model = this.genAI.getGenerativeModel(
      cacheHit
        ? { model: this.modelConfig.model_name, cachedContent: { name: cacheName! } as any }
        : { model: this.modelConfig.model_name },
    );

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

      let resp: any;
      try {
        resp = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig,
        });
      } catch (err: any) {
        const failTokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        attempts.push({
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, this.modelConfig.pricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: err?.message ?? String(err),
        });
        return this.finalizeResult(attempts, null, cacheHit, "vendor_error");
      }

      const text = resp.response.text();
      const usage = (resp.response as any).usageMetadata ?? {};
      const attemptTokens = {
        input: usage.promptTokenCount ?? estimateTokens(userPrompt),
        input_cached:
          usage.cachedContentTokenCount ??
          (cacheHit ? estimateTokens(this.cacheHeader) : 0),
        output: usage.candidatesTokenCount ?? estimateTokens(text),
      };

      // Gemini reports the finish reason on the first candidate. "MAX_TOKENS"
      // is the truncation signal; anything else (STOP, SAFETY, RECITATION,
      // OTHER) is a genuine termination and should not double.
      const finishReason =
        (resp.response as any)?.candidates?.[0]?.finishReason as string | undefined;
      const hitOutputCap = finishReason === "MAX_TOKENS";

      attempts.push({
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: finishReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.modelConfig.pricing),
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
