/**
 * geminiTransports — the two doors into Gemini, behind one interface.
 *
 * The GeminiFlashAdapter owns everything model-agnostic: the output-cap
 * doubling loop, prompt assembly, JSON-schema mode, per-attempt telemetry.
 * What differs between Google's two auth surfaces is only how a request is
 * signed and which endpoint receives it. That difference lives here, so the
 * loop exists once and every future fix lands on both doors at the same time.
 *
 *   api-key    — Google AI Studio. Auth is a single API key string in an env
 *                var. The path individuals use.
 *   vertex-adc — Vertex AI. No key: the SDK signs requests with Application
 *                Default Credentials — whatever `gcloud auth
 *                application-default login` wrote, a service account file
 *                named by GOOGLE_APPLICATION_CREDENTIALS, or a workload
 *                identity. Calls bill a GCP project. The path enterprises use.
 *
 * BOTH doors run on one SDK, `@google/genai`, which is Google's current and
 * only supported JavaScript client. They used to run on two different ones:
 *
 *   @google/generative-ai   (AI Studio)  — superseded by @google/genai
 *   @google-cloud/vertexai  (Vertex)     — its own deprecation notice gives a
 *                                          removal date of 2026-06-24
 *
 * Both were removed here on 2026-08-04 after the second failed outright: it
 * builds its host as `${location}-aiplatform.googleapis.com`, which for the
 * global endpoint yields `global-aiplatform.googleapis.com` — a host that does
 * not exist — and returns an HTML error page that the SDK then tries to parse
 * as JSON. The global endpoint is the one whose rates our policies pin (see
 * applyVertexSurcharge below), so that was not a corner case; it was every run.
 * Collapsing both doors onto the supported SDK also leaves one request path to
 * maintain instead of two that had already drifted apart.
 *
 * The Vertex door is ported from the `enterprise` backend of our earlier
 * internal orchestration experiments, with two deliberate changes:
 *   1. The service-account-file requirement is gone. The original threw
 *      unless GOOGLE_APPLICATION_CREDENTIALS was set, but the SDK resolves
 *      ADC on its own — user credentials from `gcloud auth application-default
 *      login` work without any key file. Demanding one was a stale guard.
 *   2. Explicit context caching is implemented (the original hardcoded
 *      `input_cached: 0`). Cache parity matters: the stable project header is
 *      re-sent with every TaskPacket, and reading it from cache at ~10% of
 *      the fresh-input rate is a large share of the multi-model saving.
 *
 * Backend selection is a pure function (`selectGeminiBackend`) so the
 * precedence rules are unit-testable without touching process state.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

// ─── backend selection (pure; unit-tested) ────────────────────────────

export type GeminiBackend = "api-key" | "vertex-adc";

export interface BackendSelectionInput {
  /** process.env (or a fixture in tests). */
  env: Record<string, string | undefined>;
  /** The env var the policy names for the API key (auth.env, default GEMINI_API_KEY). */
  keyEnvName: string;
  /** Whether a default gcloud ADC file exists on this machine. */
  adcFileExists: boolean;
}

export interface BackendChoice {
  backend: GeminiBackend;
  /** Human-readable trail for logs and error messages. */
  reason: string;
}

/**
 * Decide which door to use, in documented precedence order:
 *
 *   1. GEMINI_BACKEND=vertex | api-key — explicit override, always wins.
 *      Unknown values throw rather than silently picking a door.
 *   2. The policy's API-key env var is set — api-key. A key present is an
 *      explicit local decision; ADC merely existing is ambient machine state,
 *      so the key outranks it.
 *   3. Any Vertex signal — GOOGLE_APPLICATION_CREDENTIALS, a gcloud ADC
 *      file, or an explicit project env var — vertex-adc.
 *   4. Nothing — throw, naming both doors, so the failure happens at
 *      construction (before any premium-phase spend), not mid-run.
 */
export function selectGeminiBackend(input: BackendSelectionInput): BackendChoice {
  const { env, keyEnvName, adcFileExists } = input;

  const override = env.GEMINI_BACKEND?.trim().toLowerCase();
  if (override) {
    if (override === "vertex") return { backend: "vertex-adc", reason: "GEMINI_BACKEND=vertex" };
    if (override === "api-key") return { backend: "api-key", reason: "GEMINI_BACKEND=api-key" };
    throw new Error(
      `GEMINI_BACKEND='${env.GEMINI_BACKEND}' is not a recognized value. Use 'vertex' or 'api-key', ` +
        `or unset it to let credentials decide.`,
    );
  }

  if (env[keyEnvName]) return { backend: "api-key", reason: `${keyEnvName} is set` };

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { backend: "vertex-adc", reason: "GOOGLE_APPLICATION_CREDENTIALS is set" };
  }
  if (adcFileExists) {
    return { backend: "vertex-adc", reason: "gcloud ADC file present" };
  }
  if (env.GOOGLE_CLOUD_PROJECT) {
    return { backend: "vertex-adc", reason: "GOOGLE_CLOUD_PROJECT is set" };
  }

  // Keep this wording aligned with the `gemini-credentials` warning in
  // plugin/scripts/verify-setup.mjs — that script runs pre-build and cannot
  // import this module, so the two are synced by hand.
  throw new Error(
    `No Gemini credentials found. Either authenticate to Vertex AI with ` +
      `\`gcloud auth application-default login\` (no key; the project is read from ` +
      `GOOGLE_CLOUD_PROJECT, or from the ADC file's quota project), or export ` +
      `${keyEnvName}=... for the AI Studio path (https://aistudio.google.com/app/apikey).`,
  );
}

/** Default location of the ADC file `gcloud auth application-default login` writes. */
export function defaultAdcPath(home: string = homedir()): string {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * Resolve the GCP project that bills Vertex calls: GOOGLE_CLOUD_PROJECT (the
 * SDK's own convention) → the project recorded inside the credentials file.
 * Returns undefined when nothing resolves — generateContent still works then
 * (the SDK runs its own resolution against gcloud config and the metadata
 * server), but explicit cache creation is skipped, because the cache resource
 * name embeds the project and there is nothing to build it from.
 */
export function resolveGcpProject(
  env: Record<string, string | undefined>,
  adcPath: string = defaultAdcPath(),
): string | undefined {
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  const candidate = env.GOOGLE_APPLICATION_CREDENTIALS ?? adcPath;
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    // User ADC records quota_project_id; service-account files record project_id.
    return parsed.quota_project_id ?? parsed.project_id ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Region for Vertex calls.
 *
 * Defaults to Vertex's flat "global" endpoint, and that default is a PRICING
 * decision, not a latency one. Vertex bills non-global (regional) endpoints
 * +10% on every token class for Gemini 3 and later, effective 2026-07-01. The
 * rates pinned in the policy YAMLs are the flat global/AI-Studio rates, so on
 * the global endpoint the number this plugin reports is the number Google
 * bills. Defaulting to a region instead would have made every reported Gemini
 * cost 10% low — silently, and in the direction that flatters us, which is the
 * direction nobody double-checks.
 *
 * Overriding with GOOGLE_CLOUD_LOCATION is still supported (a region may have
 * quota the global endpoint lacks — that happened to us on 2026-07-16). The
 * surcharge is then applied to the reported cost rather than ignored; see
 * applyVertexSurcharge.
 */
export function resolveGcpLocation(env: Record<string, string | undefined>): string {
  return env.GOOGLE_CLOUD_LOCATION ?? "global";
}

// ─── Vertex regional surcharge ────────────────────────────────────────
//
// Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (Standard
// tier). The page's note reads that for non-global endpoints, pricing takes
// effect for the generally available Gemini 3 and later families on
// 2026-07-01. Verified 2026-08-04 against that page.

export const VERTEX_NONGLOBAL_SURCHARGE = 1.1;
export const VERTEX_NONGLOBAL_EFFECTIVE = "2026-07-01";

/** A Vertex location bills the surcharge unless it is the flat "global" endpoint. */
export function isVertexNonGlobal(location: string): boolean {
  return Boolean(location) && location.trim().toLowerCase() !== "global";
}

/**
 * Whether a model is in a family the regional surcharge applies to.
 *
 * The surcharge is NOT universal — it is Gemini 3 and later only. Gemini 2.5
 * is an earlier family and carries no regional premium, so a blanket x1.10
 * would over-report it. Keyed on the family digit rather than an allow-list,
 * so a newly added 3.x/4.x id is surcharged by default: over-reporting a new
 * model's cost is the safe direction to be wrong in, under-reporting is not.
 */
export function vertexSurchargeApplies(modelName: string): boolean {
  const m = modelName.trim().toLowerCase();
  if (!m.startsWith("gemini-")) return false;
  const major = Number(m.slice("gemini-".length).match(/^(\d+)/)?.[1]);
  return Number.isFinite(major) && major >= 3;
}

/**
 * The rates actually billed, given where the call ran.
 *
 * Returns the policy's pinned rates unchanged on the AI Studio path and on
 * Vertex's global endpoint — which is every default run. Only a user who has
 * pinned a region pays the surcharge, and when they do, the cost this plugin
 * reports moves with it instead of quietly understating their bill.
 */
export function applyVertexSurcharge<T extends { input: number; input_cached: number; output: number }>(
  pricing: T,
  opts: { backend: GeminiBackend; location: string; modelName: string },
): T {
  const surcharged =
    opts.backend === "vertex-adc" &&
    isVertexNonGlobal(opts.location) &&
    vertexSurchargeApplies(opts.modelName);
  if (!surcharged) return pricing;
  const k = VERTEX_NONGLOBAL_SURCHARGE;
  return {
    ...pricing,
    input: pricing.input * k,
    input_cached: pricing.input_cached * k,
    output: pricing.output * k,
  };
}

/**
 * The output-token count Google actually bills, from a raw usageMetadata.
 *
 * Gemini 3.x reasons before answering, and reports those reasoning tokens in
 * `thoughtsTokenCount` — a SIBLING of `candidatesTokenCount`, not a subset of
 * it. (Contrast `cachedContentTokenCount`, which IS a subset of
 * `promptTokenCount`; the two fields look alike and behave oppositely.) Google
 * bills thinking at the output rate, so the billed figure is the sum.
 *
 * Reading `candidatesTokenCount` alone is not a rounding error. A live probe
 * on 2026-08-04 against gemini-3.5-flash returned candidates=1, thoughts=97:
 * counting only candidates reports 1 output token where 98 are billed, and
 * output is the $9/M class. On a policy whose whole claim is "mechanical work
 * on Flash is cheaper", under-reporting Flash's output cost by ~99% does not
 * flatter the result by a little — it manufactures it.
 *
 * `totalTokenCount` is deliberately not used to derive this: it also counts
 * prompt tokens, and on some responses tool-use prompt tokens, so subtracting
 * our way back to output would break the moment a new field appeared.
 */
export function billedOutputTokens(usage: Record<string, number | undefined>): number {
  return (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
}

// ─── the transport interface ──────────────────────────────────────────

export interface GenerateArgs {
  modelName: string;
  prompt: string;
  generationConfig: Record<string, unknown>;
  /** Server-side cache resource name from createCache; omit on cache miss. */
  cachedContentName?: string;
}

export interface GenerateOutcome {
  text: string;
  /** Vendor usageMetadata verbatim: promptTokenCount / candidatesTokenCount / cachedContentTokenCount. */
  usage: Record<string, number | undefined>;
  finishReason?: string;
}

export interface GeminiTransport {
  readonly backend: GeminiBackend;
  /**
   * Vertex endpoint the calls actually go to ("global" or a region name).
   * Empty on the AI Studio path, which has no notion of one. Exposed because
   * cost depends on it — see applyVertexSurcharge.
   */
  readonly location: string;
  /**
   * Create an explicit context cache holding the stable header. Returns the
   * server-side cache name, or undefined when caching is unavailable — the
   * adapter then inlines the header, which costs more but always works.
   */
  createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined>;
  generate(args: GenerateArgs): Promise<GenerateOutcome>;
}

// ─── the shared implementation behind both doors ──────────────────────

/**
 * Everything a request does, once. The two doors differ only in how the
 * client is constructed and how the caches API wants a model addressed;
 * request assembly, response reading and usage extraction are identical, so
 * they live here and a fix to either lands on both doors at the same time.
 */
abstract class GenAiTransport implements GeminiTransport {
  abstract readonly backend: GeminiBackend;
  abstract readonly location: string;
  protected readonly ai: GoogleGenAI;

  protected constructor(ai: GoogleGenAI) {
    this.ai = ai;
  }

  /**
   * How this door names a model to the caches API, or undefined when a cache
   * cannot be addressed at all. Vertex needs a fully-qualified resource path
   * because the cache lives in a specific project and location; AI Studio
   * takes the bare `models/<name>` form.
   */
  protected abstract cacheModelId(modelName: string): string | undefined;

  async createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined> {
    const model = this.cacheModelId(modelName);
    if (!model) return undefined;
    const created = await this.ai.caches.create({
      model,
      config: {
        displayName,
        contents: [{ role: "user", parts: [{ text: headerText }] }],
        ttl: `${ttlSeconds}s`,
      },
    });
    return created?.name;
  }

  async generate(args: GenerateArgs): Promise<GenerateOutcome> {
    const resp = await this.ai.models.generateContent({
      model: args.modelName,
      contents: [{ role: "user", parts: [{ text: args.prompt }] }],
      config: {
        ...(args.generationConfig as Record<string, unknown>),
        // The cache is referenced by resource name alone. The predecessor SDK
        // required the whole CachedContent object back, which forced an
        // in-process Map and meant a cache name from anywhere else silently
        // missed; naming it directly removes both problems.
        ...(args.cachedContentName ? { cachedContent: args.cachedContentName } : {}),
      },
    });
    return {
      // `text` concatenates the text parts of the first candidate for us, and
      // is "" rather than undefined when the model returned no text at all —
      // which happens when the output cap is spent entirely on thinking.
      text: resp.text ?? "",
      usage: (resp.usageMetadata ?? {}) as Record<string, number | undefined>,
      finishReason: resp.candidates?.[0]?.finishReason
        ? String(resp.candidates[0].finishReason)
        : undefined,
    };
  }
}

// ─── door 1: AI Studio API key ────────────────────────────────────────

export class ApiKeyTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "api-key";
  // AI Studio has no regional endpoints, so there is no location to report
  // and the regional surcharge can never apply to this path.
  readonly location = "";

  constructor(apiKey: string) {
    super(new GoogleGenAI({ apiKey }));
  }

  protected cacheModelId(modelName: string): string {
    return `models/${modelName}`;
  }
}

// ─── door 2: Vertex AI with Application Default Credentials ───────────

export class VertexAdcTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "vertex-adc";
  readonly location: string;
  private readonly project?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const project = resolveGcpProject(env);
    const location = resolveGcpLocation(env);
    // Passing project only when we resolved one lets the SDK run its own
    // resolution (gcloud config, metadata server) as a further fallback.
    super(
      new GoogleGenAI({
        vertexai: true,
        ...(project ? { project } : {}),
        location,
      }),
    );
    this.project = project;
    this.location = location;
  }

  protected cacheModelId(modelName: string): string | undefined {
    // The cache resource name embeds project + location; without a resolved
    // project we cannot address it, so fall back to inlining the header.
    if (!this.project) return undefined;
    return `projects/${this.project}/locations/${this.location}/publishers/google/models/${modelName}`;
  }
}

// ─── construction helper used by GeminiFlashAdapter ───────────────────

export function buildGeminiTransport(
  keyEnvName: string,
  env: Record<string, string | undefined> = process.env,
): { transport: GeminiTransport; choice: BackendChoice } {
  const choice = selectGeminiBackend({
    env,
    keyEnvName,
    adcFileExists: existsSync(defaultAdcPath()),
  });
  const transport =
    choice.backend === "api-key"
      ? new ApiKeyTransport(env[keyEnvName]!)
      : new VertexAdcTransport(env);
  return { transport, choice };
}
