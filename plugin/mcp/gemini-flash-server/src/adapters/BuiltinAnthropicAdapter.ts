/**
 * BuiltinAnthropicAdapter — calls Claude (Opus / Sonnet / Haiku) directly
 * via @anthropic-ai/sdk with prompt caching enabled on the system block.
 *
 * In production, the Claude Code plugin would route Anthropic work through
 * the host CLI's own model dispatch (no API key needed in our process).
 * This adapter exists so the Pass-2 driver script can run standalone
 * outside the CC session — useful for CI replays and judge.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AttemptRecord, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";

// Fallback when the policy YAML doesn't declare max_output_tokens_absolute
// for a Claude model. 32000 is the current documented Opus 4.7 output ceiling;
// keeping it conservative avoids sending a request the API rejects with 400
// while still leaving headroom for 3 doublings from a 5000-token premium ceiling.
const CLAUDE_ABSOLUTE_OUTPUT_TOKENS_FALLBACK = 32000;

// Cap on how many times the adapter will double the ceiling in one execute().
// After this many doublings we fail the packet with terminal_reason
// "output_cap_at_model_max" — the report surfaces the fact without editorial.
const MAX_DOUBLINGS = 3;

export class BuiltinAnthropicAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private client: Anthropic;
  private cachedSystem = "";

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    const envKey = config.auth?.env ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(`${envKey} not set for BuiltinAnthropicAdapter (model ${config.id})`);
    }
    this.client = new Anthropic({ apiKey });
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    // Split packet.inputs into stable (project-level artifacts that recur
    // across every packet in a pass) and dynamic (per-task inputs). The
    // stable ones lift into the system block with `cache_control: ephemeral`
    // so Anthropic prompt caching amortizes the input cost across dispatches.
    // Cached-read is billed at ~10% of the input rate — this is what makes
    // the doubling loop economical: retries hit the cache on input, so only
    // output tokens are re-paid.
    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);

    const absoluteCeiling =
      this.modelConfig.max_output_tokens_absolute ?? CLAUDE_ABSOLUTE_OUTPUT_TOKENS_FALLBACK;

    const attempts: AttemptRecord[] = [];
    let ceiling = Math.min(packet.budget.maxOutputTokens, absoluteCeiling);

    // Doubling loop. The successful attempt (or the final failed one) supplies
    // the ExecutionResult; the full attempts[] array is returned so the caller
    // can emit one telemetry event per attempt with a shared task_id.
    for (let attemptNumber = 1; attemptNumber <= MAX_DOUBLINGS + 1; attemptNumber++) {
      const attemptStart = Date.now();
      const baseReq: any = {
        model: this.modelConfig.model_name,
        max_tokens: ceiling,
        system: stableBlock
          ? [{ type: "text", text: stableBlock, cache_control: { type: "ephemeral" } } as any]
          : undefined,
        messages: [{ role: "user", content: userPrompt }],
      };

      let resp: any;
      let vendorError: string | undefined;
      try {
        // Some Claude model versions reject the `temperature` parameter with
        // HTTP 400 ("temperature not supported"), others accept it. Rather
        // than encode a model-version regex here (which drifts), we send with
        // temperature and, if the API rejects it, retry without. Cost: at
        // most one extra request per model, and only on first use.
        try {
          resp = await this.client.messages.create({ ...baseReq, temperature: 0.2 });
        } catch (e: any) {
          const msg = String(e?.message ?? e ?? "");
          const status = e?.status ?? e?.response?.status;
          const rejectsTemperature = status === 400 && /temperature/i.test(msg);
          if (!rejectsTemperature) throw e;
          resp = await this.client.messages.create(baseReq);
        }
      } catch (err: any) {
        vendorError = err?.message ?? String(err);
        const failTokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
        const attempt: AttemptRecord = {
          attempt_number: attemptNumber,
          ceiling_used: ceiling,
          hit_output_cap: false,
          tokens: failTokens,
          cost_usd: computeCostUsd(failTokens, this.modelConfig.pricing),
          latency_ms: Date.now() - attemptStart,
          success: false,
          error: vendorError,
        };
        attempts.push(attempt);
        // Vendor errors are not output-cap; no reason to double. Bail with
        // the accumulated attempts so the report can show the failure chain.
        return this.finalizeResult(attempts, /*parsed*/ null, /*cacheHit*/ false, "vendor_error");
      }

      const text = resp.content
        .map((b: any) => ("text" in b ? b.text : ""))
        .join("\n")
        .trim();

      const usage = resp.usage as any;
      const attemptTokens = {
        input: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
        input_cached: usage?.cache_read_input_tokens ?? 0,
        output: usage?.output_tokens ?? estimateTokens(text),
      };
      const stopReason = resp.stop_reason as string | undefined;
      const hitOutputCap = stopReason === "max_tokens";

      const attempt: AttemptRecord = {
        attempt_number: attemptNumber,
        ceiling_used: ceiling,
        stop_reason: stopReason,
        hit_output_cap: hitOutputCap,
        tokens: attemptTokens,
        cost_usd: computeCostUsd(attemptTokens, this.modelConfig.pricing),
        latency_ms: Date.now() - attemptStart,
        success: !hitOutputCap,
      };
      attempts.push(attempt);

      if (!hitOutputCap) {
        // Genuine completion — parse and return.
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        return this.finalizeResult(attempts, parsed, attemptTokens.input_cached > 0, "success");
      }

      // Hit output cap. If we still have doublings available and headroom
      // under the model absolute, double and try again.
      const nextCeiling = Math.min(ceiling * 2, absoluteCeiling);
      const atModelAbsolute = nextCeiling <= ceiling; // clamp collapsed → we're already at absolute
      const doublingsExhausted = attemptNumber > MAX_DOUBLINGS;
      if (doublingsExhausted || atModelAbsolute) {
        // Two distinct signals: doubling budget out (retry the packet with
        // a higher initial next run) vs already at the vendor absolute
        // (raising the initial won't help — the packet is too big for this
        // model). Both truncate; the reason field tells them apart.
        const truncatedParsed = { raw: text, _truncated: true };
        return this.finalizeResult(
          attempts,
          truncatedParsed,
          attemptTokens.input_cached > 0,
          atModelAbsolute
            ? "output_cap_at_model_absolute"
            : "output_cap_doubling_budget_exhausted",
        );
      }
      ceiling = nextCeiling;
    }

    // Unreachable — the loop always returns. Included for TS control-flow.
    return this.finalizeResult(attempts, null, false, "output_cap_doubling_budget_exhausted");
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
    // Aggregate tokens and cost across every attempt so the ExecutionResult's
    // top-level totals reflect what actually got billed for the packet, not
    // just the final attempt. This is what makes the report's per-packet cost
    // honest even when doubling was triggered.
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

// Recognized as project-level, stable across every packet in a pass.
// These files' contents don't change once written; caching them saves
// input cost on every subsequent dispatch.
const STABLE_INPUT_PATHS = new Set([
  "brief.md",
  "requirements.md",
  "design.md",
  "security_review.md",
]);
function isStableInput(input: { path: string; reason: string }): boolean {
  if (STABLE_INPUT_PATHS.has(input.path)) return true;
  // Also accept explicit orchestrator marking. Rule 6 (orchestrator.md)
  // instructs the orchestrator to mark inputs that don't change per packet.
  return /\bstable\b/i.test(input.reason);
}

function splitStableFromDynamic(
  packet: TaskPacket,
  extraCachedSystem: string,
): { stableBlock: string; userPrompt: string } {
  const stableInputs = packet.inputs.filter(isStableInput);
  const dynamicInputs = packet.inputs.filter((i) => !isStableInput(i));

  // Stable block: any pre-set system prompt from setSystemCache() plus
  // the stable inputs, formatted the same way as the dynamic inputs so
  // the model sees consistent structure.
  const stableParts: string[] = [];
  if (extraCachedSystem) stableParts.push(extraCachedSystem);
  if (stableInputs.length > 0) {
    stableParts.push("## Project reference (stable across the pass)");
    for (const s of stableInputs) {
      stableParts.push(`### ${s.path} — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``);
    }
  }
  const stableBlock = stableParts.join("\n\n");

  // Dynamic user prompt: everything that changes per packet.
  const dynamicInputsBlock = dynamicInputs
    .map((s) => `### ${s.path} — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");
  const userPrompt = [
    `## TaskPacket ${packet.id} (${packet.phase}/${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    dynamicInputsBlock || "_(none)_",
    ``,
    `### Acceptance`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output format`,
    `Respond with strictly valid JSON conforming to this schema:`,
    "```json",
    JSON.stringify(packet.outputSchema, null, 2),
    "```",
    `No prose outside the JSON object.`,
  ].join("\n");

  return { stableBlock, userPrompt };
}
