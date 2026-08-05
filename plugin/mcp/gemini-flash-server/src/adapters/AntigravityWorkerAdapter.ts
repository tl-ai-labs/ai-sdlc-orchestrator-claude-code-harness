/**
 * AntigravityWorkerAdapter — Gemini as an AGENT, via `worker/gemini_worker.py`.
 * The worker gets a workspace and tools; it lists, reads, runs commands, and
 * edits files itself.
 *
 * Vertex-only (Application Default Credentials; no API-key branch).
 * No output-cap doubling loop: an agent session has no ceiling under our
 * control, and a retry would be a fresh fully-billed session. One attempt.
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

// Module-location relative, not cwd — the server runs in the user's project.
// dist/adapters/ → package root two levels up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(PACKAGE_ROOT, "worker");
const WORKER_SCRIPT = join(WORKER_DIR, "gemini_worker.py");

// Tail (exception is at the bottom of the traceback) kept when the worker fails.
const STDERR_TAIL_CHARS = 4000;

export class AntigravityWorkerAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  /** GCP project every delegation bills to. */
  readonly project: string;
  /** Vertex region every delegation runs in. */
  readonly location: string;
  /** Absolute path to the interpreter. */
  readonly python: string;
  /** Pricing adjusted for a pinned regional endpoint. Cost reports read from here. */
  readonly billedPricing: ModelPricing;

  /**
   * Strict on purpose. preflight_dispatch constructs every adapter before the
   * run starts, so a missing project / interpreter / worker script surfaces
   * once at the start, not as a crash after premium phases are billed.
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

    // Same precedence as the Vertex transport: policy leaf's `region:`, then
    // GOOGLE_CLOUD_LOCATION, then `global`. Passed to the worker explicitly so
    // the region in the manifest and on the endpoint match by construction.
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

  /** `cacheContext` accepted and ignored — no cache handle for agent sessions. */
  async execute(
    packet: TaskPacket,
    _cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    // Workspace the agent may act in. Refused rather than defaulted to a
    // temp dir whose edits nobody would look at.
    const workdir = runContext?.work_dir ?? runContext?.project_root;
    if (!workdir) {
      return this.failure(
        started,
        `Model '${this.id}' delegates to an agent that edits files, so it needs a working ` +
          `directory. Pass work_dir (or project_root) to execute_with_model.`,
      );
    }

    // Evidence lands beside telemetry, where the report reads. Fallback under
    // the workspace keeps a hand-run invocation from writing into wherever
    // the server was launched from.
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

    // Inventoried as late as possible so nothing this adapter wrote appears
    // in the delta. `outDir` is excluded because it sits inside the workspace
    // and the SDK writes session state there.
    const before = takeInventory(workdir, { exclude: [outDir] });

    const run = await this.spawnWorker(args, workdir, timeoutSec);

    const after = takeInventory(workdir, { exclude: [outDir] });

    // Read whatever the exit status: a failed delegation still spent tokens.
    const sidecar = readJsonIfPresent(usageFile);
    const tokens = mapSidecarTokens(sidecar);
    const cost = computeCostUsd(tokens, this.billedPricing);
    const latency = Date.now() - started;

    // Written for BOTH outcomes — a failed delegation is what a reader most
    // needs a receipt for.
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

    // Worker prints the final message on stdout. `{ raw }` fallback matches
    // the model tier's shape.
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
   * `detached: true` puts the child in its own process group; the worker
   * spawns shell commands as grandchildren, and killing only the Python
   * process would leave them running (holding the workdir, still talking to
   * Vertex). Signalling the negative pid takes the whole group. `shell: false`
   * (default) prevents re-parsing user paths in the argv.
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

      // Deadline = worker's timeout + grace, so the worker's own timeout
      // (which exits cleanly with a diagnosable message) fires first.
      const timer = setTimeout(
        () => {
          timedOut = true;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone — 'close' reports whatever it exited with.
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
   * Never fail the delegation over the receipt. stderr, not stdout — stdout
   * is the MCP transport.
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

  /** Pre-subprocess failure. Zeros throughout — no tokens spent. */
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

/** Absent and unparseable are the same answer — null → mapSidecarTokens → zeros. */
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
