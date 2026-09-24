/**
 * The MCP tools of the typed-spec executor (greenfield, `/mmo:pass --executor`):
 *
 *  - submit_spec_section — the architect hands the typed spec over one section
 *    at a time (the header, then units in batches); each is checked on arrival.
 *  - finalize_spec — assembles spec.json, checks requirement coverage, renders
 *    design.md.
 *  - execute_stage — types every unit of one stage (codegen, tests, docs), or
 *    every fix of a repair round, and returns one short receipt. Same machine
 *    for every policy; the policy only decides which typist types each job.
 *
 * server.ts lists these tools and forwards their calls here with the run
 * state pre-flight recorded (the auth mode and the policy arguments), the
 * run's slot choices (the Gemini door: completion or agent) and the request's
 * progress channel. The model never chooses the auth mode, the policy or how
 * many jobs run at once for a stage call: those are the run's, set once at
 * pre-flight or fixed in code, so no stage can differ from another — or one
 * arm from the other — by a value a model typed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ModelConfig, Policy, SelectOverrides, TelemetryEvent } from "../types.js";
import { getModel } from "../policy.js";
import { appendEvent } from "../telemetry.js";
import { log } from "../log.js";
import { SPEC_HEADER_SCHEMA, SPEC_UNIT_SCHEMA, UNIT_MAX_LINES, UNITS_PER_SECTION } from "../spec/schema.js";
import { finalizeSpec, loadSpec, submitSpecSection } from "../spec/store.js";
import { renderShared } from "./brief.js";
import { executeStage, type RepairItem, type Stage } from "./run.js";
import { AgyTypist, FlashCompletionTypist, LeanOpusTypist, type Typist } from "./typists.js";
import { LEGACY_GEMINI_ADAPTER_ID } from "../adapters/index.js";

/**
 * Every typist types at LOW effort. One pre-registered rule chose it on the
 * same eight TeamBoard units for both vendors: the lowest effort whose
 * first-try passes equal the highest effort's (task folder, probes/s2).
 */
export const TYPIST_EFFORT = "low";
/**
 * Jobs typed at once, for every stage and both arms: a stated upper bound on
 * one vendor quota's load, not a measurement. A rate-limited call waits and is
 * not an attempt (and a 429 bills $0), so a lower number would change only the
 * wall time, never who types or what is billed.
 */
export const STAGE_CONCURRENCY = 4;
/** Routed attempts before the lean Opus attempt (the same ladder for every policy). */
export const ROUTED_ATTEMPTS = 2;
/**
 * Transport waits per call, and the backoff's base and cap. Both vendors meter
 * rate limits per minute (Vertex AI quotas per minute; Anthropic's requests and
 * tokens per minute), so no single wait longer than one 60 s window helps: that
 * is the cap, and a vendor asking for a longer pause turns the call into an
 * attempt (run.ts). Six waits and a 2 s base are stated bounds (DESIGN §6.3b).
 */
export const TRANSPORT = { maxWaits: 6, baseMs: 2_000, capMs: 60_000 };
/**
 * Every typist call's time limit, the same for all three doors: a stated
 * safety bound that only catches a hung call. 540 s is the agent door's
 * existing per-job limit, and about 9× the longest typist call measured at
 * low effort (61 s, steps 2 and 8: Opus 49 s, Flash 61 s under load, agent
 * 52 s). A call past it is an attempt: a lean Opus or agent process is killed,
 * process group and all; a completion request fails by the SDK's own timeout.
 */
export const TYPIST_TIMEOUT_S = 540;
/** The agent typist's model-call budget: 3, the agy-best configuration step 2 measured (8/8 first try, one call used per unit). */
export const AGY_MAX_MODEL_CALLS = 3;
/** Progress heartbeat while a stage runs: any interval well inside Claude Code's MCP idle limit keeps the call alive (P7). */
export const HEARTBEAT_MS = 30_000;

export const EXECUTOR_TOOLS = [
  {
    name: "submit_spec_section",
    description:
      `Hand over ONE section of the typed build spec. Send the header first (section: "header", with header: {stack, commands, decisions, shared}), then the units in batches of at most ${UNITS_PER_SECTION} (section: "units", with units: [...]), each unit after the units it depends on and none longer than ${UNIT_MAX_LINES} lines. Each section is checked on arrival; a refused section stores nothing and the reply lists every problem by path, so fix and re-send that section only.`,
    inputSchema: {
      type: "object",
      properties: {
        spec_dir: { type: "string", description: "The run's output directory; the spec is assembled there." },
        section: { type: "string", enum: ["header", "units"] },
        header: SPEC_HEADER_SCHEMA,
        units: { type: "array", items: SPEC_UNIT_SCHEMA },
      },
      required: ["spec_dir", "section"],
    },
  },
  {
    name: "finalize_spec",
    description:
      "Assemble spec.json from the accepted sections, check that every FR- and AC- requirement in requirements.md is covered by some unit, and render design.md from the spec. If coverage is short, the reply names the missing ids: submit more units, then finalize again.",
    inputSchema: {
      type: "object",
      properties: { spec_dir: { type: "string" }, requirements_path: { type: "string" } },
      required: ["spec_dir"],
    },
  },
  {
    name: "execute_stage",
    description:
      "Type every unit of one stage of the finalized spec (codegen, tests or docs), or every fix of a repair round (stage: \"repair\"): each job goes to the typist the run's policy routes it to, is checked, and is written under code_dir by code. A repair round takes the senior reviewer's review.json files (review_paths: every finding with a file is fixed) and/or failures you name from a test run (failures: the file to change, what is wrong, and optionally files to show beside it). Returns one short receipt (files written, failures, dollars by typist). Long-running: it reports progress as each job finishes. The auth mode and policy are the ones preflight_dispatch recorded for this run.",
    inputSchema: {
      type: "object",
      properties: {
        spec_path: { type: "string" },
        stage: { type: "string", enum: ["codegen", "tests", "docs", "repair"] },
        code_dir: { type: "string", description: "Where the files are written; every path is relative to it." },
        pass_id: { type: "string" },
        telemetry_path: { type: "string" },
        review_paths: { type: "array", items: { type: "string" }, description: "repair only: review.json files written by the senior reviewer." },
        failures: {
          type: "array",
          description: "repair only: one entry per file to change, from a failing test run.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "The file to change, relative to code_dir." },
              problem: { type: "string", description: "What fails: the test name and its error, verbatim." },
              context_paths: { type: "array", items: { type: "string" }, description: "Files to show beside it, e.g. the failing test file (relative to code_dir)." },
            },
            required: ["path", "problem"],
          },
        },
      },
      required: ["spec_path", "stage", "code_dir"],
    },
  },
] as const;

export const EXECUTOR_TOOL_NAMES = new Set(EXECUTOR_TOOLS.map((t) => t.name));

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (value: unknown, isError = false): Reply => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) });

/** What pre-flight recorded for this run: the auth mode and the policy arguments every later call uses. */
export interface RunState {
  authMode: "estimated" | "vendor";
  policyName?: string;
  projectRoot?: string;
  policyPath?: string;
}

/**
 * The fixes a review asks for: every finding that names a file becomes a
 * problem for that file, with its severity, issue and fix. A finding whose
 * file cannot be placed inside the code directory is reported back, never
 * guessed.
 */
export function reviewRepairs(reviewPaths: string[], codeDir: string): { items: RepairItem[]; not_routed: { review: string; file: string; reason: string }[] } {
  const root = resolve(codeDir);
  const items: RepairItem[] = [];
  const notRouted: { review: string; file: string; reason: string }[] = [];
  for (const rp of reviewPaths) {
    let review: any;
    try { review = JSON.parse(readFileSync(rp, "utf8")); } catch (e: any) { notRouted.push({ review: rp, file: "", reason: `unreadable review: ${e?.message ?? e}` }); continue; }
    for (const f of review?.findings ?? []) {
      if (typeof f?.file !== "string" || !f.file) { notRouted.push({ review: rp, file: "", reason: "a finding with no file" }); continue; }
      const rel = isAbsolute(f.file) ? relative(root, f.file) : f.file;
      if (rel.startsWith("..") || isAbsolute(rel) || !rel) { notRouted.push({ review: rp, file: f.file, reason: "outside the code directory" }); continue; }
      items.push({ path: rel, problems: [`${f.severity ?? "finding"}: ${f.issue ?? ""}${f.fix ? ` — fix: ${f.fix}` : ""}`] });
    }
  }
  return { items, not_routed: notRouted };
}

/** The request's progress channel, when the client sent a progress token. */
export interface ProgressChannel {
  token?: string | number;
  send(params: { progressToken: string | number; progress: number; total?: number; message?: string }): Promise<void>;
}

/** The typist for a policy leaf, by the leaf's adapter. */
export function typistForLeaf(leaf: ModelConfig, authMode: "estimated" | "vendor"): Typist {
  switch (leaf.adapter) {
    case "builtin-anthropic":
    case "claude-cli":
      return new LeanOpusTypist(leaf, { authMode, effort: TYPIST_EFFORT, timeoutMs: TYPIST_TIMEOUT_S * 1000 });
    case "mcp:model-dispatch":
    case LEGACY_GEMINI_ADAPTER_ID: // the registry's compat alias, accepted wherever the registry accepts it
      return new FlashCompletionTypist(leaf, TYPIST_EFFORT, TYPIST_TIMEOUT_S * 1000);
    case "antigravity-worker":
      // The leaf's worker_timeout_sec bounds a whole agent job; a typist types one file, so the executor's bound applies.
      return new AgyTypist(leaf, { effort: TYPIST_EFFORT, maxModelCalls: AGY_MAX_MODEL_CALLS, timeoutSec: TYPIST_TIMEOUT_S, apiRetries: TRANSPORT.maxWaits, apiRetryInitialMs: TRANSPORT.baseMs });
    default:
      throw new Error(`execute_stage has no typist for adapter '${leaf.adapter}' (leaf ${leaf.id})`);
  }
}

/** The lean Opus attempt every unit gets last: the policy's default leaf when it is a Claude model, else its first Claude leaf. */
export function fallbackLeaf(policy: Policy): ModelConfig {
  const isClaude = (m: ModelConfig) => m.adapter === "builtin-anthropic" || m.adapter === "claude-cli";
  const def = policy.rules.find((r: any) => "default" in r) as any;
  const d = def ? policy.models.find((m) => m.id === def.default) : undefined;
  const leaf = d && isClaude(d) ? d : policy.models.find(isClaude);
  if (!leaf) throw new Error(`policy '${policy.name}' has no Claude model for the lean Opus attempt`);
  return leaf;
}

export async function handleExecutorTool(name: string, a: any, ctx: { run?: () => RunState | undefined; policy?: (run: RunState) => Policy; overrides: SelectOverrides; progress?: ProgressChannel }): Promise<Reply> {
  if (name === "submit_spec_section") {
    const r = submitSpecSection(a.spec_dir, a.section === "header" ? { section: "header", header: a.header } : { section: "units", units: a.units });
    log(r.ok ? "info" : "warn", "spec.section", { section: r.section, ok: r.ok, errors: r.errors.length, total_units: r.total_units });
    return reply(r, !r.ok);
  }
  if (name === "finalize_spec") {
    const r = finalizeSpec(a.spec_dir, a.requirements_path);
    log(r.ok ? "info" : "warn", "spec.finalize", { ok: r.ok, units: r.units, missing: r.missing_coverage.length });
    return reply(r, !r.ok);
  }
  // execute_stage — only after pre-flight has recorded the run's auth mode and policy.
  const run = ctx.run?.();
  if (!run) return reply({ error: "execute_stage runs only after preflight_dispatch has recorded this run's auth mode and policy (Phase -1). Call preflight_dispatch first; nothing was typed." }, true);
  const authMode = run.authMode;
  const policy = ctx.policy!(run);
  const spec = loadSpec(a.spec_path);
  let repairs: RepairItem[] | undefined;
  let notRouted: { review: string; file: string; reason: string }[] = [];
  if (a.stage === "repair") {
    const fromReview = reviewRepairs(a.review_paths ?? [], a.code_dir);
    notRouted = fromReview.not_routed;
    repairs = [
      ...fromReview.items,
      ...(a.failures ?? []).map((f: any) => ({ path: String(f.path), problems: [String(f.problem)], context_paths: (f.context_paths ?? []).map(String) })),
    ];
    if (!repairs.length) return reply({ stage: "repair", units: 0, written: 0, failed: [], not_routed: notRouted.slice(0, 10), note: "nothing to fix" });
  }
  const shared = renderShared(spec);
  const sharedFile = join(dirname(resolve(a.spec_path)), "shared-brief.txt");
  writeFileSync(sharedFile, shared);
  const typists = new Map<string, Typist>();
  const typistFor = (modelId: string) => {
    if (!typists.has(modelId)) typists.set(modelId, typistForLeaf(getModel(policy, modelId), authMode));
    return typists.get(modelId)!;
  };
  const fb = fallbackLeaf(policy);
  const fallback = typistFor(fb.id);
  if (a.telemetry_path) mkdirSync(dirname(a.telemetry_path), { recursive: true });
  const emit = (ev: TelemetryEvent) => { if (a.telemetry_path) appendEvent(a.telemetry_path, ev); };

  let done = 0, total = spec.units.filter((u) => u.phase === a.stage).length;
  const token = ctx.progress?.token;
  const say = (message: string) => { if (token !== undefined) void ctx.progress!.send({ progressToken: token, progress: done, total, message }).catch(() => {}); };
  const heartbeat = token !== undefined ? setInterval(() => say(`still typing: ${done} of ${total} units done`), HEARTBEAT_MS) : null;
  log("info", "executor.stage.start", { stage: a.stage, units: total, policy: policy.name, auth_mode: authMode });
  try {
    const receipt = await executeStage(spec, {
      stage: a.stage as Stage, codeDir: a.code_dir, passId: a.pass_id ?? "pass", policy, overrides: ctx.overrides,
      concurrency: STAGE_CONCURRENCY, routedAttempts: ROUTED_ATTEMPTS, transport: TRANSPORT, repairs,
    }, {
      typistFor, fallback, shared, sharedFile, emit,
      progress: (d, t, m) => { done = d; total = t; say(`${m} (${d}/${t})`); },
    });
    log("info", "executor.stage.end", { stage: receipt.stage, written: receipt.written, failed: receipt.failed.length + (receipt.failed_not_listed ?? 0), cost_usd: receipt.cost_usd, seconds: receipt.seconds, not_routed: notRouted.length });
    return reply(notRouted.length ? { ...receipt, not_routed: notRouted.slice(0, 5), not_routed_total: notRouted.length } : receipt);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
