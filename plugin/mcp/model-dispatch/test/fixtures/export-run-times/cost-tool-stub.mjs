#!/usr/bin/env node
/**
 * Stands in for `collect-orchestrator-usage.mjs <run-dir> --project-root <root> --time-only` in
 * exportRunTimes.test.mjs, and holds to that mode's contract: exit 0 with one line of JSON last on stdout
 * ({ run_id, project_root, time_split }), or a non-zero exit with the reason on stderr. Any other arguments exit 64.
 *
 * What it does for a run is set by `stub.json` in the run folder (none: the run is timed). It reads the run's
 * manifest.json for the run id, as the cost tool does, and writes nothing in the run folder. Each call is appended to
 * $STUB_LOG as one JSON line; a call that starts while another is still going is marked `overlapped`.
 *
 * The timed split is EX-BF-04's (Argon + Flash, 6 Nov): window 118.7 min = model 55.6 + tool 5.2 + person 57.7 +
 * nothing 0.2, to the millisecond so the four kinds add up to the window exactly.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TIMED = {
  version: 1,
  unknown_reason: null,
  window: { start: "2026-11-06T08:57:12.345Z", end: "2026-11-06T10:55:54.776Z", sec: 7122.431 },
  kinds_sec: { model: 3336.112, tool: 312.004, person: 3462.3, nothing: 12.015 },
  time_taken_sec: 3660.131,
  model_by_source: [
    { source: "handed_out", model: "gemini-4-argon", sec: 2490.2, requests: 37 },
    { source: "helper", model: "claude-opus-5", sec: 624.118, requests: 58 },
    { source: "main", model: "claude-opus-5", sec: 222.03, requests: 72 },
    { source: "handed_out", model: "gemini-3.8-flash", sec: 36.4, requests: 5 },
  ],
  before_run: { sec: 412.507, kinds_sec: { model: 120.1, tool: 30.207, person: 250, nothing: 12.2 } },
  longest_nothing: [
    { start: "2026-11-06T09:41:03.120Z", sec: 6.004 },
    { start: "2026-11-06T10:02:47.900Z", sec: 3.511 },
    { start: "2026-11-06T09:13:30.002Z", sec: 2.5 },
  ],
  checks: { log_approval_wait_sec: 3810.004, handed_out_call_sec: 2541.338 },
};

export const unknownSplit = (reason) => ({
  version: 1,
  unknown_reason: reason,
  window: { start: null, end: null, sec: null },
  kinds_sec: { model: null, tool: null, person: null, nothing: null },
  time_taken_sec: null,
  model_by_source: [],
  before_run: { sec: null, kinds_sec: { model: null, tool: null, person: null, nothing: null } },
  longest_nothing: [],
  checks: { log_approval_wait_sec: null, handed_out_call_sec: null },
});

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function main(argv) {
  if (argv.length !== 4 || argv[1] !== "--project-root" || argv[3] !== "--time-only") {
    process.stderr.write(`stub: unexpected arguments ${JSON.stringify(argv)}\n`);
    return 64;
  }
  const [runDir, , projectRoot] = argv;
  const log = process.env.STUB_LOG;
  const busy = log ? `${log}.busy` : null;
  let overlapped = false;
  if (busy) {
    try { mkdirSync(busy); } catch { overlapped = true; }
  }
  if (log) appendFileSync(log, JSON.stringify({ argv, overlapped }) + "\n");
  try {
    const plan = existsSync(join(runDir, "stub.json")) ? JSON.parse(readFileSync(join(runDir, "stub.json"), "utf8")) : {};
    if (plan.hold_ms) sleep(plan.hold_ms);
    const runId = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")).run_id;
    for (const line of plan.stdout_before ?? []) process.stdout.write(`${line}\n`);
    const answer = (timeSplit) => ({ run_id: runId, project_root: projectRoot, time_split: timeSplit, ...(plan.extra ?? {}) });
    switch (plan.kind ?? "timed") {
      case "timed":
        process.stdout.write(`${JSON.stringify(answer(TIMED))}\n`);
        return 0;
      case "unknown":
        process.stdout.write(`${JSON.stringify(answer(unknownSplit(plan.reason)))}\n`);
        return 0;
      case "fail":
        process.stderr.write(plan.stderr ?? "");
        return plan.code ?? 1;
      case "crash":
        throw new Error(plan.message);
      case "line-after-json":
        process.stdout.write(`${JSON.stringify(answer(TIMED))}\n${plan.line}\n`);
        return 0;
      case "no-time-split": {
        const { time_split: _, ...rest } = answer(TIMED);
        process.stdout.write(`${JSON.stringify(rest)}\n`);
        return 0;
      }
      case "silent":
        return 0;
      default:
        process.stderr.write(`stub: unknown kind ${plan.kind}\n`);
        return 65;
    }
  } finally {
    if (busy && !overlapped) rmdirSync(busy);
  }
}

// Imported by the test for TIMED and unknownSplit; run only when invoked as a program.
const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
