/**
 * workerProcess.ts — the pure half of the Antigravity agent worker.
 *
 * WHAT THIS IS. `AntigravityWorkerAdapter` delegates a TaskPacket by launching
 * `worker/gemini_worker.py` as a subprocess: one process per delegated call,
 * given a working directory it may act inside, and read back through a usage
 * sidecar it writes on the way out. Everything about that launch that can be
 * decided WITHOUT touching the filesystem, the clock or the network lives here
 * — which interpreter to use, what the argument vector is, what environment the
 * child sees, what the task brief says, and how the sidecar's token counts map
 * onto the orchestrator's `ExecutionResult`.
 *
 * WHY IT IS SPLIT OUT. The interesting failures in a delegation are all in
 * these decisions, not in `spawn()`: a project that silently comes from the
 * wrong place, a region the receipt claims but the call never used, an API key
 * leaking into a child that is supposed to prove it went through Vertex, a
 * cached-token count double-billed because the vendor's `prompt_token_count`
 * already includes it. A test that has to launch Python, hold Google
 * credentials and spend money to check any of that will not be run. Every
 * function below is a plain input-to-output mapping, so the whole contract is
 * pinned offline for $0 in `test/workerProcess.test.mjs`.
 *
 * WHAT IS DELIBERATELY NOT HERE: the spawn itself, the timeout kill, and the
 * reading of files. Those are in the adapter, which is the only part that
 * needs a real machine.
 */

import { join } from "node:path";
import type { ReasoningConfig, TaskPacket } from "../types.js";

/**
 * Seconds the worker gives its own `asyncio.wait_for` before abandoning the
 * agent session. Matches the Python side's `--timeout` default so the two
 * halves do not disagree about how long "too long" is. A policy leaf overrides
 * it with `worker_timeout_sec:`.
 *
 * Nine minutes is a long ceiling on purpose. This is not one model call: the
 * worker explores a directory, runs commands and edits files, and the SDK only
 * returns at the END of the whole agentic session. A ceiling tuned to a
 * single-turn completion would kill healthy work.
 */
export const DEFAULT_WORKER_TIMEOUT_SEC = 540;

/**
 * Extra seconds the adapter waits beyond the worker's own deadline before
 * killing the process group.
 *
 * The two deadlines are deliberately unequal. When the worker hits ITS timeout
 * it raises inside `run()`, prints a reason on stderr and exits non-zero —
 * a diagnosable failure. When the ADAPTER's deadline fires we SIGKILL a process
 * group and learn nothing. So the worker must always get there first, and this
 * grace window is what guarantees it does even on a loaded machine.
 */
export const WORKER_KILL_GRACE_SEC = 30;

/**
 * Environment variable naming an explicit interpreter for the worker.
 *
 * Escape hatch, not the normal path: `npm run setup` builds a virtual
 * environment next to the worker and that is what the adapter finds by itself.
 * This exists for the case where a user has already got a >= 3.10 interpreter
 * with `google-antigravity` installed and does not want a second copy of it.
 */
export const WORKER_PYTHON_ENV = "GEMINI_WORKER_PYTHON";

/** Where `npm run setup` puts the worker's virtual environment. */
export function workerVenvPython(workerDir: string): string {
  return join(workerDir, ".venv", "bin", "python");
}

/**
 * Decide which Python runs the worker, or refuse and say how to fix it.
 *
 * WHY THERE IS NO `python3` FALLBACK. On macOS `/usr/bin/python3` is 3.9 and
 * `google-antigravity` requires >= 3.10, so falling back to whatever `python3`
 * resolves to would turn a missing-setup problem into an import error thrown
 * from inside a subprocess several paid phases into a run. Refusing here — at
 * adapter construction, which `preflight_dispatch` exercises before the run
 * spends anything — costs the user one clear sentence instead.
 *
 * `exists` is injected so the resolution order can be tested without a
 * filesystem.
 */
export function resolveWorkerPython(opts: {
  env: Record<string, string | undefined>;
  workerDir: string;
  exists: (path: string) => boolean;
}): string {
  const override = opts.env[WORKER_PYTHON_ENV];
  if (override && override.trim() !== "") {
    if (!opts.exists(override)) {
      throw new Error(
        `${WORKER_PYTHON_ENV} points at '${override}', which does not exist. ` +
          `Unset it to use the worker's own virtual environment, or point it at a ` +
          `Python >= 3.10 that has google-antigravity installed.`,
      );
    }
    return override;
  }
  const venv = workerVenvPython(opts.workerDir);
  if (opts.exists(venv)) return venv;
  throw new Error(
    `The Antigravity agent worker has no Python environment. Expected an interpreter at ` +
      `'${venv}'. Run \`npm run setup\` in the plugin root to create it, or set ` +
      `${WORKER_PYTHON_ENV} to a Python >= 3.10 that already has google-antigravity ` +
      `installed. Nothing is dispatched to this adapter until one of those is true.`,
  );
}

/**
 * Translate the policy's `reasoning:` block into the worker's `--thinking`
 * flag.
 *
 * The worker takes an uppercase `types.ThinkingLevel` member name and treats
 * `NONE` as "no thinking config at all". `tier` is the field Gemini models
 * already use elsewhere in this repo, so a policy leaf that moves between the
 * model adapter and the agent adapter keeps the same vocabulary.
 */
export function workerThinkingLevel(reasoning?: ReasoningConfig): string {
  const tier = reasoning?.tier;
  if (!tier) return "NONE";
  return tier.toUpperCase();
}

export interface WorkerArgsInput {
  /** Absolute path to gemini_worker.py. */
  script: string;
  /** File holding the task brief the worker reads as its first message. */
  taskFile: string;
  /** Model id from the policy leaf — the worker pins none of its own. */
  model: string;
  /** Vertex region, always passed explicitly. See buildWorkerArgs. */
  region: string;
  /** The single directory the worker may read, edit and run commands in. */
  workdir: string;
  /** Where the sidecar and the SDK's own save directory go. */
  outDir: string;
  /** The sidecar this invocation writes. */
  usageFile: string;
  thinking: string;
  timeoutSec: number;
}

/**
 * Build the worker's argument vector.
 *
 * `--region` is passed on EVERY invocation even though the worker will fall
 * back to `GOOGLE_CLOUD_LOCATION` when it is absent. The fallback exists for
 * humans running the script by hand; for the adapter it would be a hazard,
 * because then the region in the run's manifest (the policy's) and the region
 * that served the call (the ambient environment's) could differ with no
 * artifact disagreeing. Passing it explicitly makes those two the same value by
 * construction.
 *
 * Returned as an array and handed to `spawn` without a shell, so a path
 * containing spaces or a quote needs no escaping and cannot be re-parsed as
 * more arguments.
 */
export function buildWorkerArgs(i: WorkerArgsInput): string[] {
  return [
    i.script,
    "--task-file", i.taskFile,
    "--model", i.model,
    "--region", i.region,
    "--workdir", i.workdir,
    "--out-dir", i.outDir,
    "--usage-file", i.usageFile,
    "--thinking", i.thinking,
    "--timeout", String(i.timeoutSec),
  ];
}

/**
 * API-key variables removed from the child environment.
 *
 * The whole claim this adapter exists to make is "the Antigravity SDK reached
 * a Gemini model through Vertex on project P in region R". An API key visible
 * to the child is a second, unrecorded door: Google's libraries prefer it in
 * several code paths, and if one of them took it the sidecar would still say
 * "vertex_project: P" because the worker writes what it was TOLD, not what the
 * transport chose. Deleting the keys makes that divergence impossible rather
 * than merely unlikely.
 */
export const WORKER_STRIPPED_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * Build the environment the worker subprocess sees.
 *
 * Starts from the parent's — the child needs PATH, HOME (Application Default
 * Credentials live under it), and on macOS the DYLD_LIBRARY_PATH that some
 * Homebrew Pythons need to load pyexpat — then pins the two variables that
 * decide who gets billed and where, and strips the API-key door.
 *
 * The parent environment reaching here has already been through
 * `sanitizePluginEnv`, so an unexpanded `${GOOGLE_CLOUD_PROJECT}` placeholder
 * cannot be forwarded as if it were a project id.
 */
export function buildWorkerEnv(
  parent: Record<string, string | undefined>,
  pins: { project: string; location: string },
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    child[key] = value;
  }
  for (const key of WORKER_STRIPPED_ENV) delete child[key];
  child.GOOGLE_CLOUD_PROJECT = pins.project;
  child.GOOGLE_CLOUD_LOCATION = pins.location;
  // Unbuffered stdio: the worker's failure diagnostics are printed to stderr
  // right before a non-zero exit, and a killed process never flushes a buffer.
  // Without this, the one line explaining a timeout is the line most likely to
  // be lost.
  child.PYTHONUNBUFFERED = "1";
  return child;
}

/**
 * Filesystem-safe stem for this packet's evidence files.
 *
 * Packet ids are authored by the orchestrator (`tp_codegen_042`) and are already
 * unique within a run, which is why the evidence is keyed on the id rather than
 * on a phase plus a counter the adapter would have to keep. The substitution is
 * defensive: an id is a string from a model-authored plan, and a `/` in one
 * would silently write the sidecar into a different directory.
 *
 * Leading and trailing dots go too. Not a traversal defence — the separators
 * are already gone by then — but a stem beginning with a dot produces a HIDDEN
 * evidence file, and evidence a reader has to know to look for is not doing its
 * job.
 */
export function evidenceStem(packet: TaskPacket): string {
  const raw = packet.id || `${packet.phase}-untitled`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "packet";
}

/**
 * Render the brief the worker reads as its opening message.
 *
 * DIFFERENT FROM THE MODEL PROMPT ON PURPOSE. `GeminiFlashAdapter` builds a
 * prompt for one completion: everything the model could possibly need has to be
 * inlined, because the model cannot go and look. This worker is an agent with a
 * working directory — it can list, read, edit and run commands. So the packet's
 * file slices are presented as EXCERPTS with their real paths named, and the
 * worker is told it may open the originals. That is the entire difference
 * between the two tiers, and it is why the same packet costs more here: the
 * worker will spend turns looking around.
 *
 * The output contract is restated in the imperative at the end because an agent
 * that has just run six tools is far more likely to narrate what it did than a
 * model that only ever produced one message. The adapter parses stdout as JSON
 * and falls back to `{ raw }`, so a narrating worker degrades rather than
 * fails — but the run's downstream phases want the JSON.
 */
export function workerTaskMarkdown(
  packet: TaskPacket,
  opts: { workdir: string; header?: string },
): string {
  const wantsJson = !!packet.outputSchema && !(packet.outputSchema as any).__free_text__;
  const excerpts = packet.inputs
    .map((s) => `#### ${s.path}\n_Included because: ${s.reason}_\n\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    opts.header ? `## Project context\n\n${opts.header}\n` : "",
    `## Task ${packet.id} — ${packet.phase} / ${packet.task_type}`,
    ``,
    `Module: ${packet.module}`,
    ``,
    `### Working directory`,
    ``,
    `You are running as an agent inside \`${opts.workdir}\`. You may list, read,`,
    `edit and create files there, and run commands there. That directory is the`,
    `only place you can act; nothing outside it is reachable.`,
    ``,
    `### Instruction`,
    ``,
    packet.instruction,
    ``,
    `### Provided excerpts`,
    ``,
    excerpts
      ? `These are extracts, not whole files. The paths are real — open them in the\nworking directory when you need more than the excerpt shows.\n\n${excerpts}`
      : `_None supplied. Explore the working directory to find what you need._`,
    ``,
    `### Acceptance criteria`,
    ``,
    ...(packet.acceptance.length ? packet.acceptance.map((a) => `- ${a}`) : ["- _(none stated)_"]),
    ``,
    `### Your final message`,
    ``,
    wantsJson
      ? [
          `Your final message must be a single JSON object and nothing else — no`,
          `prose before it, no summary after it, no \`\`\` fence around it. It must`,
          `conform to this schema:`,
          ``,
          "```json",
          JSON.stringify(packet.outputSchema, null, 2),
          "```",
        ].join("\n")
      : [
          `Return the deliverable itself as your final message — the file content or`,
          `the document that was asked for, not a report about producing it.`,
        ].join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The token counts a worker sidecar carries, mapped onto the orchestrator's
 * DISJOINT convention.
 *
 * TWO TRAPS LIVE HERE, both of which have cost real money elsewhere:
 *
 * 1. THE KEYS ARE PYTHON'S. The sidecar is `usage_metadata.model_dump()` from
 *    the Python SDK, so the fields are snake_case — `prompt_token_count`, not
 *    the `promptTokenCount` the JavaScript Gemini SDK returns. Reading the
 *    camelCase names here yields `undefined`, which floors to zero, which
 *    reports a delegation that cost dollars as having cost nothing.
 *
 * 2. `prompt_token_count` INCLUDES the cached portion. `computeCostUsd`
 *    requires fresh and cached to be disjoint (fresh at the full rate, cached
 *    at the discounted one), so the cached count is subtracted out. Skipping
 *    the subtraction bills every cached token twice and makes an effective
 *    cache look more expensive than no cache at all. `Math.max` guards the
 *    vendor edge case where the reported cached count exceeds the prompt count.
 *
 * Thoughts are billed at the output rate, so they are folded into `output` for
 * costing and ALSO reported separately in `output_reasoning`, which is
 * reporting-only — `computeCostUsd` never reads it, so there is no double count.
 */
export function mapSidecarTokens(sidecar: any): {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning: number;
} {
  const usage = (sidecar && sidecar.usage) || {};
  const prompt = Number(usage.prompt_token_count ?? 0);
  const cached = Number(usage.cached_content_token_count ?? 0);
  const candidates = Number(usage.candidates_token_count ?? 0);
  const thoughts = Number(usage.thoughts_token_count ?? 0);
  return {
    input: Math.max(0, prompt - cached),
    input_cached: cached,
    output: candidates + thoughts,
    output_reasoning: thoughts,
  };
}

/**
 * How many tool calls the worker made.
 *
 * Read from `tool_call_count`, which the worker writes as the true length of
 * the drained list, rather than from `tool_calls.length`, which stops at the
 * worker's own recording cap. The count is the honest number; the list is a
 * bounded sample of it, and `tool_calls_truncated` says when the two differ.
 */
export function sidecarToolCallCount(sidecar: any): number {
  const n = Number(sidecar?.tool_call_count ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
