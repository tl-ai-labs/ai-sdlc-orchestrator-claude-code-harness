/**
 * Ambient job tools: the thin typed layer between the MCP protocol and the
 * job runner in plugin/scripts/ambient/jobs.mjs. All job logic lives in that
 * plain-ESM file so it can be tested without a TypeScript build and with no
 * vendor code; this file only declares the tools, builds the completion door on
 * the server's existing adapters, and shapes the replies.
 *
 * Three rules held here:
 *   - every call must carry the `_mmo` stamp a plugin hook adds. A call without
 *     it means the hooks are not running, and nothing is sent anywhere;
 *   - the completion door accepts only completion adapters. The executing agent
 *     adapter is refused by name: workers in chat never execute;
 *   - consent is a tool a person must approve. It is marked with the
 *     `anthropic/requiresUserInteraction` tool meta, which makes Claude Code ask
 *     even in auto-accept modes, so a model cannot grant consent to itself.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdapter } from "../adapters/index.js";
import { ClaudeCliAdapter } from "../adapters/ClaudeCliAdapter.js";
import type { ModelAdapter } from "../adapters/ModelAdapter.js";
import type { ModelConfig, Policy, TaskPacket } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBS_MODULE = resolve(HERE, "..", "..", "..", "..", "scripts", "ambient", "jobs.mjs");
const COMPLETION_ADAPTERS = new Set(["mcp:model-dispatch", "mcp:gemini-flash-server", "builtin-anthropic", "claude-cli"]);

const START_TOOLS = ["repeat_edit_across_files", "write_files_from_specs", "write_tests_from_cases", "fix_from_analysis", "scout_repo"] as const;
export const AMBIENT_TOOL_NAMES: ReadonlySet<string> = new Set([...START_TOOLS, "job_result", "undo_job", "consent_to_send", "lookup", "write_files"]);
const LOOKUP_MODULE = resolve(HERE, "..", "..", "..", "..", "scripts", "ambient", "lookup.mjs");

const STAMP = { _mmo: { type: "object", description: "Added by the plugin's hook. Do not set it." } };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { ...properties, ...STAMP }, required });
const strList = { type: "array", items: { type: "string" } };

export const AMBIENT_TOOLS = [
  {
    name: "fix_from_analysis",
    description:
      "Have a worker model write the CODE of a bug fix from your finished analysis. You keep the diagnosis and you run the tests. " +
      "Needs all nine analysis fields; refuses an analysis that leaves a decision open or already contains the code. ONE request: the call waits for the job (up to nine minutes), code checks the answer, the declared tests run in a scratch copy, the verified files are written into the project, and you get one receipt. If it is still running you get the id; it lands itself when done and you collect the receipt with job_result.",
    inputSchema: obj({
      analysis: { type: "object", description: "bug_files, test_command, root_cause, fix_approach, ruled_out, change_sites[{path,what}], constraints, read_set, new_identifiers" },
      repro_files: { ...strList, description: "Your failing reproduce test(s). Shown to the worker, never changeable by it." },
      held_out_files: { ...strList, description: "A second test the worker never sees." },
    }, ["analysis"]),
  },
  {
    name: "repeat_edit_across_files",
    description: "Apply ONE edit you already made to a list of other existing files with a worker model. Code checks every file. ONE request: the call waits for the job (up to nine minutes), code checks the answer, the declared tests run in a scratch copy, the verified files are written into the project, and you get one receipt. If it is still running you get the id; it lands itself when done and you collect the receipt with job_result.",
    inputSchema: obj({
      files: strList, instruction: { type: "string" }, test_command: { type: "string", description: "Optional: the command that runs the tests. The landing command then runs it too and prints pass or fail, so you need no separate turn." },
      example: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] },
    }, ["files", "instruction", "example"]),
  },
  {
    name: "write_files_from_specs",
    description: "Have a worker model write NEW files. Write the design to a file FIRST (one file, any length, on disk) and name it here; the plugin reads it and gives it to the worker once, so you never repeat it. Per file give only what the design cannot say: the exported names, one line of behaviour, and a file to copy the style from. Specs long enough to cost more than the files they describe are refused at the door, with both numbers. Lock files, test-runner configs (jest, vitest, playwright and the like), CI files, env files and the plugin's own folders stay with you: a job that lists one is refused at once, before any worker is paid. Code checks each file. ONE request: the call waits for the job (up to nine minutes), code checks the answer, the declared tests run in a scratch copy, the verified files are written into the project, and you get one receipt. If it is still running you get the id; it lands itself when done and you collect the receipt with job_result.",
    inputSchema: obj({
      design_file: { type: "string", description: "The design you already wrote, as a path in this project. Read once by the plugin and given to the worker as read-only context, so the architecture is written once instead of inside every spec." },
      specs: { type: "array", items: { type: "object", properties: {
        path: { type: "string" },
        exports: { type: "array", items: { type: "string" }, description: "The names this file exports. At most 20; more than that is a module the design should split." },
        behaviour: { type: "string", description: "One line: what this file does, pointing at the design for the detail. Never the code itself, never an undecided choice." },
        mirror: { type: "string", description: "Optional: an existing file whose style and conventions this one should follow. Read only." },
      }, required: ["path", "behaviour"] } },
      context_files: { ...strList, description: "Existing files that show the conventions to follow. Read only." },
      test_command: { type: "string", description: "Optional: the command that runs the tests. The landing command then runs it too and prints pass or fail, so you need no separate turn." },
    }, ["design_file", "specs"]),
  },
  {
    name: "write_tests_from_cases",
    description: "Have a worker model write the test files of this phase from your lists of cases: ALL of them in ONE call (one file per call never pays; every call re-reads the chat). Name your design file if you have one and the plugin gives it to the worker once. The test-runner config itself (jest.config and the like) stays with you: a job that lists it is refused at once. Code checks each file; with test_command the tests run in a scratch copy before you hear of it.",
    inputSchema: obj({
      design_file: { type: "string", description: "Optional: the design you already wrote, as a path in this project. Read once and given to the worker as read-only context." },
      tests: { type: "array", description: "Every test file to write, each with its own cases.", items: { type: "object", properties: { path: { type: "string" }, cases: strList }, required: ["path", "cases"] } },
      target_files: strList, context_files: strList, test_command: { type: "string", description: "Optional: the command that runs the tests; they run in a scratch copy before hand-back." },
    }, ["tests", "target_files"]),
  },
  { name: "scout_repo", description: "Have a worker model READ the likely files of this project and report where to look or edit: each place with the exact Read range and a verified quoted line, plus a short summary. One job replaces opening many files yourself. Nothing is changed. The call waits for the report (up to nine minutes) and answers once; if it is still running you get the id and collect it with job_result.", inputSchema: obj({ question: { type: "string", description: "What you are trying to find or change, in words (20 to 2,000 characters)." }, terms: { ...strList, description: "Literal search strings that pick the candidate files (up to 8)." }, paths: { ...strList, description: "Optional path patterns to narrow the candidates." }, max_files: { type: "number", description: "At most this many files are read (default 40, cap 40)." } }, ["question"]) },
  { name: "write_files", description: "Write files YOU composed, many in ONE call, and run your test command in the same call: one request instead of one per file. No worker is involved; the same on both sides of a pair. Paths are checked like a landing and writes are atomic.", inputSchema: obj({ files: { type: "array", description: "Every file to write: its project-relative path and its full content.", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }, test_command: { type: "string", description: "Optional: the command that runs the tests, run in the project after the writes." } }, ["files"]) },
  { name: "lookup", description: "Find where things live in this project in ONE call: up to eight search strings in, every matching line out with the exact Read offset and limit that shows it and the function or class it sits in. Replaces a grep plus a read per file with one round trip. Searches this repository only; nothing leaves the machine.", inputSchema: obj({ terms: { ...strList, description: "1 to 8 literal search strings (not regular expressions)." }, paths: { ...strList, description: "Optional path patterns to narrow the search, e.g. src/ or *.ts." }, max_hits: { type: "number", description: "At most this many hits are listed (default 40, cap 60)." } }, ["terms"]) },
  { name: "job_result", description: "Collect your worker jobs in ONE call: pass every id as job_ids. Waits up to 90 s until at least one is ready, then reports each: its checked change and how to land it, failed with the reason, or still running. Do not poll one job at a time; every call re-reads the chat.", inputSchema: obj({ job_ids: { type: "array", items: { type: "string" }, description: "All the job ids to collect, in one call." }, job_id: { type: "string", description: "One id (the old form)." }, show_diff: { type: "boolean", description: "Include the worker's diff (default false: a receipt only; the checks proved scope and exact match, the tests prove correctness)." } }, []) },
  { name: "undo_job", description: "Take back a worker change that was landed with apply.mjs. Files edited since are left alone and reported.", inputSchema: obj({ job_id: { type: "string" } }, ["job_id"]) },
  {
    name: "consent_to_send",
    description: "Ask the person, once per repository and vendor, whether files from this repository may be sent to a worker model at another vendor. Only the person can approve this call.",
    inputSchema: obj({ vendor: { type: "string", enum: ["google"] } }, ["vendor"]),
    _meta: { "anthropic/requiresUserInteraction": true },
  },
];

// The EDIT jobs' answer: edits and creates, either may be absent (a repeated edit that
// applies to no more files is a legitimate empty answer, judged by the checks).
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    edits: { type: "array", items: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] } },
    creates: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
};

// The CREATE jobs' answer (new files from specs, test files from cases): `creates` is
// REQUIRED and there is no `edits` to fall back on. Under the shared schema above both
// keys were optional, so {"edits":[]} was a schema-valid answer, and on 23 Sep (pair 10)
// Gemini 3.8 Flash gave exactly that six times to fourteen-file commissions while Sonnet
// wrote the files. The orchestrator pipeline never sees this because its packet schema
// requires `files`; this is the same contract, in the chat job's own vocabulary.
const CREATE_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    creates: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  },
  required: ["creates"],
};
const CREATE_KINDS = new Set(["write_files_from_specs", "write_tests_from_cases"]);
export function answerSchemaFor(kind: string) {
  return CREATE_KINDS.has(kind) ? CREATE_ANSWER_SCHEMA : ANSWER_SCHEMA;
}

/** The policy model a worker name maps to: same model_name, completion adapter only. */
export function completionModelFor(policy: Policy, workerModelName: string): ModelConfig | null {
  return policy.models.find((m) => m.model_name === workerModelName && COMPLETION_ADAPTERS.has(m.adapter)) ?? null;
}

/** The same lookup over several policy files, first match wins. */
export function completionModelIn(policies: Policy[], workerModelName: string): ModelConfig | null {
  for (const policy of policies) {
    const m = completionModelFor(policy, workerModelName);
    if (m) return m;
  }
  return null;
}

/**
 * The policy files chat jobs reach their workers through, in order. Two
 * shipped files: Flash through Google (opus-plus-flash-v38) and Sonnet through
 * the local Claude login (opus-plus-sonnet-max, adapter claude-cli, no API
 * key). Only their model lists are used; the typed pipeline's routing is not
 * touched. MMO_AMBIENT_POLICY replaces the list (comma-separated names).
 */
export const DEFAULT_CHAT_POLICIES = ["opus-plus-flash-v38", "opus-plus-sonnet-max"];
export function chatPolicyNames(env: Record<string, string | undefined> = process.env): string[] {
  const named = (env.MMO_AMBIENT_POLICY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return named.length ? named : [...DEFAULT_CHAT_POLICIES];
}

/**
 * The model config a chat job's worker runs with. A chat job is typing from a
 * spec, so a Gemini worker runs with low reasoning unless the policy leaf sets
 * a tier itself: with the vendor's default thinking, whole-test-file jobs took
 * three to five minutes and the reasoning tokens were billed as output.
 */
export function chatModelConfig(model: ModelConfig, thinking: string = "low"): ModelConfig {
  if (model.adapter === "claude-cli") return model;
  // `jobs.worker_thinking` (~/.mmo-ambient/ambient.json): "low" (default), "medium", "high", or "policy"
  // (send nothing: the leaf's own tier, else the vendor's default). A measured pair at another depth is
  // one setting away; the depth each answer ran at is reported by the door and recorded on the job.
  if (thinking === "policy") return model;
  if (thinking === "medium" || thinking === "high") return { ...model, reasoning: { tier: thinking } };
  if (model.reasoning) return model;
  return { ...model, reasoning: { tier: "low" } };
}

/**
 * The adapter a chat job's worker runs on. A Claude-login worker is started
 * with no tools, so it can only answer in text, the same as the Flash call.
 */
export function chatWorkerAdapter(model: ModelConfig, cliOptions: Record<string, unknown> = {}, thinking: string = "low"): ModelAdapter {
  return model.adapter === "claude-cli" ? new ClaudeCliAdapter(model, { ...cliOptions, noTools: true }) : createAdapter(chatModelConfig(model, thinking));
}

/**
 * Which worker models the chat policies can really call: a model of that name
 * with a text-only (completion) adapter. The job runner weighs only these, so
 * a worker nobody can reach is never picked and then fails at the call.
 */
export function reachableIn(policies: Policy[]): (workerModelName: string) => boolean {
  return (workerModelName) => completionModelIn(policies, workerModelName) !== null;
}

/** Builds the callWorker function the job runner expects, on top of one completion adapter. */
export function completionDoor(policies: Policy[], { makeAdapter, thinking = "low" }: { makeAdapter?: (m: ModelConfig) => Pick<ModelAdapter, "execute">; thinking?: string } = {}) {
  return async ({ kind, worker, brief }: { kind: string; worker: string; brief: string }) => {
    const found = completionModelIn(policies, worker);
    if (!found) throw new Error(`the chat policies have no completion model named ${worker}; an executing agent adapter is never used for chat jobs`);
    const model = chatModelConfig(found, thinking);
    const build = makeAdapter ?? ((m: ModelConfig) => chatWorkerAdapter(m, {}, thinking));
    const packet: TaskPacket = {
      id: `ambient_${kind}`, phase: "codegen", task_type: "ambient_job", module: "ambient",
      instruction: brief, inputs: [], outputSchema: answerSchemaFor(kind), acceptance: [],
      budget: { maxInputTokens: 400_000, maxOutputTokens: 32_000 }, pass_id: "ambient",
    };
    const res = await build(model).execute(packet);
    if (!res.success) {
      // Say WHY when the adapter did not: a cut-off answer (output cap) is the
      // common case, and "the worker call failed" hid it on three live jobs.
      const why = res.error ?? (res.terminal_reason && res.terminal_reason !== "vendor_error" ? `the worker's answer was cut off (${res.terminal_reason.replace(/_/g, " ")}) after ${res.tokens?.output ?? "?"} output tokens` : "the worker call failed");
      const err = new Error(why) as Error & { rateLimited?: boolean };
      err.rateLimited = /\b429\b|rate.?limit|resource.?exhausted/i.test(res.error ?? "");
      throw err;
    }
    // A Claude-login answer that is not bare JSON (a fenced block, say) comes
    // back wrapped as { raw }. Hand the worker's own text to the strict reader.
    const r = res.result as unknown;
    const raw = r && typeof r === "object" && Object.keys(r).length === 1 && typeof (r as { raw?: unknown }).raw === "string" ? (r as { raw: string }).raw : null;
    return {
      text: typeof r === "string" ? r : raw ?? JSON.stringify(r),
      usage: { input_tokens: res.tokens.input + res.tokens.input_cached, output_tokens: res.tokens.output },
      // The adapter's own priced figure (the Claude-login door counts cache writes, a card times tokens does not).
      ...(Number.isFinite(res.cost_usd) ? { cost_usd: res.cost_usd } : {}),
      model: model.model_name,
      // The depth this answer ran at: the leaf's tier after the setting, or the vendor's default.
      thinking: model.adapter === "claude-cli" ? "claude" : model.reasoning?.tier ?? "default",
    };
  };
}

/** `jobs.worker_thinking` from the person's ambient settings (the ESM loader; a project file may not set it): the depth chat workers type at. */
async function workerThinking(projectDir: string): Promise<string> {
  try {
    const mod = await import(pathToFileURL(resolve(dirname(JOBS_MODULE), "lib", "config.mjs")).href);
    const t = mod.loadConfig({ projectDir }).config?.jobs?.worker_thinking;
    return typeof t === "string" && t ? t : "low";
  } catch { return "low"; }
}

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (value: unknown, isError = false): Reply => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError } : {}) });

export interface AmbientDeps {
  projectDir: string;
  /** The chat policy files, loaded on demand (see chatPolicyNames). */
  policies: () => Policy[];
  /** Tests inject the stub door; the server passes nothing and gets the completion door. */
  callWorker?: (req: { kind: string; worker: string; brief: string }) => Promise<{ text: string; usage?: unknown; model?: string; cost_usd?: number }>;
}

export async function handleAmbientTool(name: string, rawArgs: unknown, deps: AmbientDeps): Promise<Reply> {
  const { _mmo: stamp, ...args } = (rawArgs ?? {}) as Record<string, unknown>;
  const jobs = await import(pathToFileURL(JOBS_MODULE).href);

  if ((START_TOOLS as readonly string[]).includes(name)) {
    const stub = (await import(pathToFileURL(resolve(dirname(JOBS_MODULE), "lib", "door.mjs")).href)).stubDoor(process.env);
    // With the real door, only the workers this policy can call are weighed. A
    // stub or injected door (tests) answers for any worker, so none is dropped.
    const real = !deps.callWorker && !stub;
    let policies: Policy[] = [];
    if (real) {
      try { policies = deps.policies(); } catch (e: any) { return reply({ status: "refused", reason: `the chat policy files could not be read: ${e?.message ?? e}` }, true); }
    }
    const callWorker = deps.callWorker ?? stub ?? completionDoor(policies, { thinking: await workerThinking(deps.projectDir) });
    const reachable = real ? reachableIn(policies) : undefined;
    const out = name === "scout_repo"
      ? await jobs.startScout({ args, stamp, projectDir: deps.projectDir, callWorker, reachable })
      : await jobs.startJob({ tool: name, args, stamp, projectDir: deps.projectDir, callWorker, reachable });
    return reply(out, out.status === "refused");
  }
  if (name === "write_files") {
    // An optimization, not a delegation: the thinker's own files, written and tested in one call, on both sides.
    const mod = await import(pathToFileURL(resolve(dirname(JOBS_MODULE), "write-files.mjs")).href);
    const out = mod.writeFiles({ files: args.files, testCommand: args.test_command, projectDir: deps.projectDir, stamp: stamp ?? null });
    return reply(out, out.status === "refused");
  }
  if (name === "lookup") {
    // An optimization, not a delegation: allowed on both sides of a pair and inside helpers; the stamp only attributes the record.
    const mod = await import(pathToFileURL(LOOKUP_MODULE).href);
    const out = mod.lookup({ terms: args.terms, paths: args.paths, maxHits: args.max_hits, projectDir: deps.projectDir, stamp: stamp ?? null });
    return reply(out, out.status === "refused");
  }
  if (!stamp || typeof (stamp as { session_id?: unknown }).session_id !== "string") {
    return reply({ status: "refused", reason: "this call carries no session stamp, so the plugin's hooks are not running" }, true);
  }
  if (name === "job_result") {
    const ids = Array.isArray(args.job_ids) ? args.job_ids : [];
    const showDiff = args.show_diff === true;
    return reply(ids.length ? await jobs.jobResults(ids, { showDiff }) : await jobs.jobResult(String(args.job_id ?? ""), { showDiff }));
  }
  if (name === "undo_job") return reply(jobs.undoStagedJob(String(args.job_id ?? "")));
  if (name === "consent_to_send") return reply(jobs.grantConsent({ projectDir: deps.projectDir, vendor: "google" }));
  return reply({ status: "refused", reason: `unknown ambient tool ${name}` }, true);
}
