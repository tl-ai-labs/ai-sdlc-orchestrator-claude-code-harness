/**
 * AntigravityWorkerAdapter — dispatches a TaskPacket to a Gemini model running
 * as an AGENT, through the Antigravity SDK, instead of as a single completion.
 *
 * WHAT IS ACTUALLY DIFFERENT. `GeminiFlashAdapter` sends one `generateContent`
 * call: the orchestrating session has already read every file the model will
 * see, the model answers once, and the session writes the result to disk. This
 * adapter launches `worker/gemini_worker.py`, which starts an Antigravity agent
 * session with `policies=[policy.allow_all()]` and a single workspace — the
 * worker lists the directory, reads what it decides it needs, runs commands and
 * edits files itself. Same model, same Vertex project, same policy file. The
 * difference is who holds the hands.
 *
 * WHY IT IS A SEPARATE ADAPTER AND NOT A FLAG. The two produce different
 * evidence and different bills. A completion has one prompt and one answer; an
 * agent session has a tool loop whose prompt is re-sent every turn on top of
 * the SDK's own multi-thousand-token identity preamble, so a packet that costs
 * a fraction of a cent as a completion costs meaningfully more as a delegation.
 * Making it a policy leaf — `adapter: antigravity-worker` — means the choice is
 * visible in the run's manifest, priced by the same code path as every other
 * leaf, and switchable without touching TypeScript.
 *
 * WHAT THIS ADAPTER DOES NOT DO. There is no output-cap doubling loop. That
 * loop exists because a single completion can be truncated by a `max_tokens`
 * ceiling the adapter chose and can therefore raise. An agent session has no
 * such ceiling under our control — it ends when the agent decides it is done or
 * when the deadline fires — so a retry would be a fresh, fully-billed session,
 * not a cheap continuation. One attempt is reported, always.
 *
 * VERTEX ONLY. The Antigravity SDK's doorway is Vertex; there is no AI Studio
 * path. Credentials are Application Default Credentials, resolved by exactly
 * the same helpers the Vertex transport uses, so a machine that can run the
 * model tier can run this one with no extra secret.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AttemptRecord,
  ExecutionResult,
  ModelConfig,
  ModelPricing,
  RunContext,
  TaskPacket,
} from "../types.js";
import { computeCostUsd } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { applyVertexSurcharge, resolveGcpLocation, resolveGcpProject } from "./geminiTransports.js";
import {
  DEFAULT_WORKER_TIMEOUT_SEC,
  WORKER_KILL_GRACE_SEC,
  buildWorkerArgs,
  buildWorkerEnv,
  evidenceStem,
  mapSidecarTokens,
  resolveWorkerPython,
  workerTaskMarkdown,
  workerThinkingLevel,
} from "../delegation/workerProcess.js";
import {
  buildDelegationRecord,
  diffInventories,
  takeInventory,
} from "../delegation/evidence.js";

/**
 * The worker directory, resolved from this module's own location rather than
 * from `process.cwd()`.
 *
 * The MCP server is launched by Claude Code with a working directory that is
 * the user's project, not the plugin — so any cwd-relative path here would
 * resolve somewhere different on every run. Compiled output lives at
 * `dist/adapters/`, which puts the package root two levels up.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(PACKAGE_ROOT, "worker");
const WORKER_SCRIPT = join(WORKER_DIR, "gemini_worker.py");

/**
 * How much of the worker's stderr is kept when it fails.
 *
 * A Python traceback is worth reporting whole, but an agent that fails after
 * printing progress can produce a great deal of it, and the entire string ends
 * up inside a telemetry event that a human reads in a terminal. The tail is
 * kept rather than the head because the exception is at the bottom.
 */
const STDERR_TAIL_CHARS = 4000;

export class AntigravityWorkerAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  /** GCP project every delegation bills to. Resolved once, at construction. */
  readonly project: string;
  /** Vertex region every delegation runs in. Resolved once, at construction. */
  readonly location: string;
  /** Absolute path to the interpreter that will run the worker. */
  readonly python: string;
  /**
   * The policy's pinned rates adjusted for where the calls actually run —
   * identical to `modelConfig.pricing` on a `global` endpoint, +10% on a
   * regional one for Gemini 3+. Every cost this adapter reports comes from
   * here, never from the raw pin. Same resolution the model tier does, in the
   * same place, so the two tiers cannot drift apart on pricing.
   */
  readonly billedPricing: ModelPricing;

  /**
   * EVERYTHING THAT CAN FAIL WITHOUT SPENDING MONEY FAILS HERE.
   *
   * `preflight_dispatch` constructs every adapter the run will use before the
   * run dispatches anything, precisely so that a missing project, a missing
   * Python environment or a missing worker script surfaces as one message at
   * the start rather than as a crash after the premium phases are billed. That
   * only works if this constructor is strict, so it is.
   */
  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;

    const project = resolveGcpProject(process.env as Record<string, string | undefined>);
    if (!project) {
      throw new Error(
        `Model '${config.id}' dispatches through the Antigravity SDK, which runs on Vertex ` +
          `and therefore needs a Google Cloud project. None was found: set ` +
          `GOOGLE_CLOUD_PROJECT, or run \`gcloud auth application-default login\` on a ` +
          `project whose credentials record a quota project.`,
      );
    }
    this.project = project;

    // The policy leaf's `region:` is the declaration of record; the ambient
    // environment is the fallback and `global` is the last resort, which is the
    // same order the Vertex transport uses. Whatever wins is passed to the
    // worker explicitly, so the region in the manifest and the region on the
    // endpoint are the same value by construction rather than by luck.
    this.location =
      config.region ?? resolveGcpLocation(process.env as Record<string, string | undefined>);

    if (!existsSync(WORKER_SCRIPT)) {
      throw new Error(
        `Model '${config.id}' needs the agent worker at '${WORKER_SCRIPT}', which is missing. ` +
          `The plugin install is incomplete — reinstall it, or check out the file from the repo.`,
      );
    }
    this.python = resolveWorkerPython({
      env: process.env as Record<string, string | undefined>,
      workerDir: WORKER_DIR,
      exists: existsSync,
    });

    this.billedPricing = applyVertexSurcharge(config.pricing, {
      backend: "vertex-adc",
      location: this.location,
      modelName: config.model_name,
    });
  }

  /**
   * `cacheContext` is accepted and ignored.
   *
   * Explicit context caching is a property of a completion call — you cache a
   * stable prefix and pay a discount when the next call reuses it. An agent
   * session builds its own conversation across turns and the SDK does not
   * expose a cache handle to attach, so there is nothing here to key. Rather
   * than pretend, the adapter reports `cache_hit: false` on every delegation:
   * an honest zero is worth more than an invented discount, because the report
   * subtracts these numbers to claim a saving.
   */
  async execute(
    packet: TaskPacket,
    _cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    // The workspace the agent may act in. `work_dir` is the explicit answer;
    // `project_root` is the sensible default, since that is the directory the
    // orchestrator is already generating into. With neither there is nothing
    // to delegate — an agent with no working directory is just a slower, more
    // expensive completion — so this refuses instead of inventing a temp dir
    // whose edits nobody would ever look at.
    const workdir = runContext?.work_dir ?? runContext?.project_root;
    if (!workdir) {
      return this.failure(
        started,
        `Model '${this.id}' delegates to an agent that edits files, so it needs a working ` +
          `directory. Pass work_dir (or project_root) to execute_with_model.`,
      );
    }

    // Evidence lands beside the run's telemetry, in a `delegation/` directory,
    // because that pass directory is what the report already reads. Falling
    // back under the workspace keeps a hand-run invocation from writing into
    // whatever directory the server happened to be launched from.
    const outDir = runContext?.telemetry_path
      ? join(dirname(runContext.telemetry_path), "delegation")
      : join(workdir, ".sdlc", "delegation");

    const stem = evidenceStem(packet);
    const taskFile = join(outDir, `worker-task-${stem}.md`);
    const usageFile = join(outDir, `worker-usage-${stem}.json`);

    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(taskFile, workerTaskMarkdown(packet, { workdir }), "utf8");
    } catch (err: any) {
      return this.failure(started, `Could not stage the delegation brief: ${err?.message ?? err}`);
    }

    const timeoutSec = this.modelConfig.worker_timeout_sec ?? DEFAULT_WORKER_TIMEOUT_SEC;
    const args = buildWorkerArgs({
      script: WORKER_SCRIPT,
      taskFile,
      model: this.modelConfig.model_name,
      region: this.location,
      workdir,
      outDir,
      usageFile,
      thinking: workerThinkingLevel(this.modelConfig.reasoning),
      timeoutSec,
    });

    // Inventory the workspace as late as possible — after the brief is staged,
    // immediately before the worker starts — so nothing this adapter itself
    // wrote can appear in the delta. `outDir` is excluded because it can sit
    // inside the workspace, and the SDK writes its session transcript there
    // while the agent runs; without the exclusion every delegation would report
    // its own evidence as a file the agent changed.
    const before = takeInventory(workdir, { exclude: [outDir] });

    const run = await this.spawnWorker(args, workdir, timeoutSec);

    // Taken before anything else is read, so the window between "the worker
    // exited" and "we looked" is as short as it can be.
    const after = takeInventory(workdir, { exclude: [outDir] });

    // The sidecar is read whatever the exit status was. A worker that finished
    // its session and then failed to print — or was killed a moment after
    // writing — has still spent every one of those tokens, and a failed
    // delegation reported as free is a hole in the run's cost story.
    const sidecar = readJsonIfPresent(usageFile);
    const tokens = mapSidecarTokens(sidecar);
    const cost = computeCostUsd(tokens, this.billedPricing);
    const latency = Date.now() - started;

    // Written for BOTH outcomes. A delegation that failed halfway still spent
    // money and may still have edited files, and that is exactly the case a
    // reader most needs a receipt for.
    this.writeRecord(join(outDir, `worker-delegation-${stem}.json`), {
      packet: {
        id: packet.id,
        phase: packet.phase,
        task_type: packet.task_type,
        module: packet.module,
      },
      modelId: this.id,
      modelName: this.modelConfig.model_name,
      workdir,
      startedAt,
      durationMs: latency,
      success: run.ok,
      error: run.ok ? undefined : run.error,
      costUsd: cost,
      tokens,
      sidecar,
      diff: diffInventories(before, after),
      briefFile: basename(taskFile),
      usageFile: basename(usageFile),
    });

    if (!run.ok) {
      const attempt: AttemptRecord = {
        attempt_number: 1,
        ceiling_used: packet.budget.maxOutputTokens,
        hit_output_cap: false,
        tokens,
        cost_usd: cost,
        latency_ms: latency,
        success: false,
        error: run.error,
      };
      return {
        result: null,
        tokens,
        cost_usd: cost,
        latency_ms: latency,
        cache_hit: false,
        success: false,
        error: run.error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    // The worker prints the agent's final message on stdout. Parsed as JSON
    // because that is what the packet's schema asked for, with the same
    // `{ raw }` fallback the model tier uses — a worker that narrated instead
    // of answering should degrade into something the orchestrator can still
    // look at, not throw away a session that has already been paid for.
    const text = run.stdout.trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ceiling_used: packet.budget.maxOutputTokens,
      stop_reason: "agent_session_complete",
      hit_output_cap: false,
      tokens,
      cost_usd: cost,
      latency_ms: latency,
      success: true,
    };
    return {
      result: parsed,
      tokens,
      cost_usd: cost,
      latency_ms: latency,
      cache_hit: false,
      success: true,
      attempts: [attempt],
      terminal_reason: "success",
    };
  }

  /**
   * Launch the worker and wait for it.
   *
   * `detached: true` puts the child in its own process group. That is not
   * cosmetic: the worker starts an Antigravity agent session which itself runs
   * shell commands as grandchildren, and killing only the Python process would
   * leave those running — holding the working directory, and in the worst case
   * still talking to Vertex on a run the user believes has stopped. Signalling
   * the negative pid takes the whole group.
   *
   * `shell: false` (the default) is load-bearing too: the argument vector
   * carries user paths and a task-file path, and a shell would re-parse them.
   */
  private spawnWorker(
    args: string[],
    cwd: string,
    timeoutSec: number,
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string; stdout: string }> {
    return new Promise((resolveRun) => {
      const child = spawn(this.python, args, {
        cwd,
        detached: true,
        env: buildWorkerEnv(process.env as Record<string, string | undefined>, {
          project: this.project,
          location: this.location,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

      // The adapter's deadline is the worker's plus a grace window, so the
      // worker's own timeout — which exits cleanly with a diagnosable message —
      // always fires first. Reaching this timer means the worker itself is
      // wedged, and there is nothing to learn by waiting longer.
      const timer = setTimeout(
        () => {
          timedOut = true;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone between the timer firing and the signal — the
            // 'close' handler below reports whatever it exited with.
          }
        },
        (timeoutSec + WORKER_KILL_GRACE_SEC) * 1000,
      );

      child.on("error", (err) => {
        clearTimeout(timer);
        resolveRun({
          ok: false,
          error: `Could not start the agent worker with '${this.python}': ${err.message}`,
          stdout,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolveRun({
            ok: false,
            error:
              `The agent worker was killed after ${timeoutSec + WORKER_KILL_GRACE_SEC}s ` +
              `(its own deadline is ${timeoutSec}s — raise worker_timeout_sec on the policy ` +
              `leaf if the task legitimately needs longer). ${tail(stderr)}`,
            stdout,
          });
          return;
        }
        if (code !== 0) {
          resolveRun({
            ok: false,
            error: `The agent worker exited ${code}. ${tail(stderr)}`,
            stdout,
          });
          return;
        }
        resolveRun({ ok: true, stdout });
      });
    });
  }

  /**
   * Write the delegation receipt, and never fail the delegation over it.
   *
   * The record is evidence ABOUT a run, not part of one. By the time this is
   * called the money is spent and the agent's answer is already in hand, so a
   * full disk or a read-only directory must cost the caller a warning on stderr
   * and nothing else. stderr specifically: this process speaks MCP over stdout,
   * and a stray line there corrupts the protocol frame.
   */
  private writeRecord(path: string, input: Parameters<typeof buildDelegationRecord>[0]): void {
    try {
      writeFileSync(path, JSON.stringify(buildDelegationRecord(input), null, 2), "utf8");
    } catch (err: any) {
      process.stderr.write(
        `[antigravity-worker] could not write the delegation record to '${path}': ` +
          `${err?.message ?? err}. The delegation itself was unaffected.\n`,
      );
    }
  }

  /**
   * A failure that happened before any subprocess ran, and therefore before any
   * token was spent. Reported with the same shape as a vendor failure so the
   * server's telemetry path needs no special case — zeros throughout, which is
   * the truth here rather than a fallback.
   */
  private failure(started: number, error: string): ExecutionResult {
    const tokens = { input: 0, input_cached: 0, output: 0 };
    const latency = Date.now() - started;
    return {
      result: null,
      tokens,
      cost_usd: 0,
      latency_ms: latency,
      cache_hit: false,
      success: false,
      error,
      attempts: [
        {
          attempt_number: 1,
          ceiling_used: 0,
          hit_output_cap: false,
          tokens,
          cost_usd: 0,
          latency_ms: latency,
          success: false,
          error,
        },
      ],
      terminal_reason: "vendor_error",
    };
  }
}

/**
 * Read the sidecar if the worker got as far as writing one.
 *
 * Absent and unparseable are the same answer — `null`, which
 * `mapSidecarTokens` turns into zeros. Both mean "no usage numbers survived",
 * and there is nothing an adapter can do about either except report it as such.
 */
function readJsonIfPresent(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "No output on stderr.";
  return trimmed.length <= STDERR_TAIL_CHARS
    ? trimmed
    : `...${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}
