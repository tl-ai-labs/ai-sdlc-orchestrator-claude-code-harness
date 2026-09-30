/**
 * Has the workflow this chat started ended? Read from the workflow's own log (29 Sep 2026).
 *
 * Every /mmo: workflow logs its life through plugin/scripts/mmo-log.mjs into <project>/.sdlc/runs/<run-id>/
 * orchestrator.log, one line per event as plugin/scripts/lib/log.mjs renders it: `run.start`, each `gate.open`
 * and `gate.resolved` (response approved | revise | abort), and `run.end` (outcome completed | aborted | failed).
 * A greenfield run logs `run.end` before its final gate opens, so "ended" is: an abort at any gate, a `run.end`
 * that says aborted or failed, or a `run.end` with every gate it opened answered.
 *
 * The run is found by time: the latest run whose `run.start` is not earlier than the moment the chat started its
 * workflow (the chat's `pipeline` record holds that moment). No such run means the workflow never reached its run
 * (it was stopped at its first questions, or is still asking them): the chat stays the workflow's, so an answer to
 * one of its questions is never taken for a new job. Two chats running workflows in one project at once could see
 * each other's run; the answer is then the latest run's.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatLine } from "../../lib/log.mjs";

/** One log line: an optional prefix, an ISO timestamp, a level, the event, then key=value fields (log.mjs). */
const LINE = /^(?:\S+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+[A-Z]+\s+(\S+)(.*)$/;
const FIELD = /([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
/** A log file older than the chat's start by more than this cannot hold its run (its file time is only a first filter). */
const SLACK_MS = 2_000;

function fields(rest) {
  const out = {};
  for (const m of rest.matchAll(FIELD)) {
    let v = m[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    out[m[1]] = v;
  }
  return out;
}

/** The events of one log file, oldest first: { ms, event, fields }. */
export function readWorkflowLog(file) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const events = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (Number.isFinite(ms)) events.push({ ms, event: m[2], fields: fields(m[3]) });
  }
  return events;
}

/**
 * "ended", "running" (a run of this workflow is logged and not over), or "not-started" (none logged yet). A running
 * run also says `waiting: true` while one of its gates is open: the workflow has asked the person something, so the
 * person's next message is its answer (0.8.4, the replace-or-queue question).
 */
export function workflowState(projectDir, sinceMs) {
  const root = join(projectDir, ".sdlc", "runs");
  if (!Number.isFinite(sinceMs) || !existsSync(root)) return { state: "not-started" };
  let best = null;
  let names = [];
  try { names = readdirSync(root); } catch { return { state: "not-started" }; }
  for (const name of names) {
    const file = join(root, name, "orchestrator.log");
    try { if (statSync(file).mtimeMs < sinceMs - SLACK_MS) continue; } catch { continue; }
    const events = readWorkflowLog(file);
    // A run id can be reused; the run is the part of the log from its latest run.start at or after the chat's start.
    let start = -1;
    // The chat records its workflow's start before the workflow logs run.start (the command runs first), so a
    // run.start earlier than that moment belongs to an earlier run, however close.
    events.forEach((e, i) => { if (e.event === "run.start" && e.ms >= sinceMs) start = i; });
    if (start < 0) continue;
    if (!best || events[start].ms > best.startMs) best = { runId: name, startMs: events[start].ms, events: events.slice(start) };
  }
  if (!best) return { state: "not-started" };
  const open = new Set();
  let ended = false, outcome = null;
  for (const e of best.events) {
    const gate = e.fields.gate;
    if (e.event === "gate.open" && gate) open.add(gate);
    if (e.event === "gate.resolved" && gate) {
      open.delete(gate);
      if (String(e.fields.response ?? "").startsWith("abort")) { ended = true; outcome = "aborted"; }
    }
    if (e.event === "run.end") {
      outcome = e.fields.outcome ?? "completed";
      if (outcome === "aborted" || outcome === "failed") ended = true;
    }
  }
  if (!ended && outcome && open.size === 0) ended = true;
  return ended ? { state: "ended", runId: best.runId, outcome } : { state: "running", runId: best.runId, outcome, waiting: open.size > 0 };
}

/**
 * Stops a run the way the workflow's own abort does (0.8.4, "Replace it" in a zero-touch chat): the run's log
 * records `run.end outcome=aborted`, in the format mmo-log.mjs writes, so workflowState and the collector read it as
 * ended; and a brownfield write lock (`.sdlc/local/write-contract.json`) that belongs to this run is switched off,
 * as the brownfield manual's abort step does (active: false, the file and the run folder kept). A lock of another
 * run is left alone. Returns what was done.
 */
export function abortRun(projectDir, runId, why) {
  const done = { logged: false, unlocked: false };
  if (!runId) return done;
  const log = join(projectDir, ".sdlc", "runs", runId, "orchestrator.log");
  if (existsSync(log)) {
    appendFileSync(log, formatLine("info", "run.end", { run_id: runId, outcome: "aborted", reason: why }) + "\n");
    done.logged = true;
  }
  const contractFile = join(projectDir, ".sdlc", "local", "write-contract.json");
  try {
    const contract = JSON.parse(readFileSync(contractFile, "utf8"));
    if (contract && contract.active === true && contract.run_id === runId) {
      writeFileSync(contractFile, JSON.stringify({ ...contract, active: false }, null, 2) + "\n");
      done.unlocked = true;
    }
  } catch { /* no lock, or not this run's */ }
  return done;
}
