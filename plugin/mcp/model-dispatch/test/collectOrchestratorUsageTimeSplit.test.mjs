/**
 * `time_split`: every second of a run's window as model working, tool running, waiting for a person or nothing
 * recorded, from Claude Code's history files, the run log and the run's telemetry (the rules R1-R11 of the run-time
 * split; the block's format is version 1).
 *
 * Every case is end to end: the real collector CLI on a copy of a run folder, with --project-root and
 * --transcripts-dir pointing at the copy (or the history under CLAUDE_CONFIG_DIR, where the tools find it on their
 * own), and `time_split` read from the manifest it wrote; the manifest writer's cases run write-manifest.mjs too.
 *
 *   - Three real runs (tools/test/fixtures/run-time-split, README there): a Gemini-led bugfix (Argon and Flash handed
 *     out, Opus session and helpers) and two Claude-led brownfield runs (Opus helpers, Flash and an Opus typist handed
 *     out). Expected values were worked out from the raw files and the rules, independently of the implementation.
 *   - The same three runs keep every existing manifest and telemetry field as the collector wrote it before time_split
 *     existed (R11): before-time-split/ in each fixture.
 *   - Small hand-made runs, one rule or one clarification of the rules each, and two variants of the real runs (a log
 *     without its prefix, a helper's history file left out).
 *
 * Seconds are compared to the millisecond, and the four kinds must add up to the window exactly (R7). A request starts
 * at the line its first line answers, passing over the attachment lines Claude Code writes between that line and the
 * reply (R3); the last line written before a typed message is the nearest earlier line of the main session file that
 * carries a timestamp (R5). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTOR = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const WRITE_MANIFEST = join(HERE, "..", "..", "..", "scripts", "write-manifest.mjs");
const FIXTURES = join(HERE, "..", "..", "..", "..", "tools", "test", "fixtures", "run-time-split");
const ENV = { ...process.env, MMO_SELECT: "" };
delete ENV.CLAUDE_CONFIG_DIR;

// ── checking a time_split ──────────────────────────────────────────────────────────────────────────────────────────

/** A seconds value given to the millisecond, as an integer count of milliseconds. */
function msOf(value, what) {
  assert.equal(typeof value, "number", `${what}: a number of seconds, got ${JSON.stringify(value)}`);
  const ms = Math.round(value * 1000);
  assert.ok(Math.abs(value * 1000 - ms) < 1e-6, `${what}: ${value} is not given to the millisecond`);
  return ms;
}

/** An ISO time as milliseconds: any ISO spelling of the instant is the same instant. */
function isoMs(value, what) {
  assert.equal(typeof value, "string", `${what}: an ISO time, got ${JSON.stringify(value)}`);
  const ms = Date.parse(value);
  assert.ok(Number.isFinite(ms), `${what}: ${value} is not an ISO time`);
  return ms;
}

const byTimeDesc = (a, b) => b.ms - a.ms || a.start - b.start;

/**
 * The whole block against the expected one. model_by_source and longest_nothing are compared as sets: the rules give
 * no order. An entry with no request and no second carries nothing and is left out of the comparison.
 */
function assertSplit(ts, want) {
  assert.ok(ts && typeof ts === "object", "the manifest carries a time_split block");
  assert.equal(ts.version, 1);
  assert.equal(ts.unknown_reason, null);
  assert.equal(isoMs(ts.window.start, "window.start"), Date.parse(want.window.start), "window.start (R1: run.start)");
  assert.equal(isoMs(ts.window.end, "window.end"), Date.parse(want.window.end), "window.end (R1: the later of the last run.end and the last gate.resolved)");
  const win = msOf(ts.window.sec, "window.sec");
  assert.equal(win, Math.round(want.window.sec * 1000), "window.sec");
  const kinds = {};
  for (const k of ["model", "tool", "person", "nothing"]) {
    kinds[k] = msOf(ts.kinds_sec[k], `kinds_sec.${k}`);
    assert.equal(kinds[k], Math.round(want.kinds_sec[k] * 1000), `kinds_sec.${k}`);
  }
  assert.equal(kinds.model + kinds.tool + kinds.person + kinds.nothing, win, "R7: the four kinds add up to the window exactly");
  assert.equal(msOf(ts.time_taken_sec, "time_taken_sec"), win - kinds.person, "R8: time taken = window minus the person's seconds");
  assert.equal(msOf(ts.time_taken_sec, "time_taken_sec"), Math.round(want.time_taken_sec * 1000), "time_taken_sec");
  const sources = (list) => list
    .map((e) => ({ source: e.source, model: e.model, ms: msOf(e.sec, `model_by_source ${e.source} ${e.model}`), requests: e.requests }))
    .filter((e) => e.requests > 0 || e.ms > 0)
    .sort((a, b) => a.source.localeCompare(b.source) || String(a.model).localeCompare(String(b.model)));
  assert.ok(Array.isArray(ts.model_by_source), "model_by_source is a list");
  assert.deepEqual(sources(ts.model_by_source), sources(want.model_by_source), "model_by_source (R3: per model and source, overlaps within one counted once)");
  const before = msOf(ts.before_run.sec, "before_run.sec");
  assert.equal(before, Math.round(want.before_run.sec * 1000), "before_run.sec (R2: command turn to run.start)");
  const bk = {};
  for (const k of ["model", "tool", "person", "nothing"]) {
    bk[k] = msOf(ts.before_run.kinds_sec[k], `before_run.kinds_sec.${k}`);
    assert.equal(bk[k], Math.round(want.before_run.kinds_sec[k] * 1000), `before_run.kinds_sec.${k}`);
  }
  assert.equal(bk.model + bk.tool + bk.person + bk.nothing, before, "R2/R7: the kinds before the run add up to it exactly");
  const stretches = (list) => list.map((e) => ({ start: isoMs(e.start, "longest_nothing start"), ms: msOf(e.sec, "longest_nothing sec") })).sort(byTimeDesc);
  assert.ok(Array.isArray(ts.longest_nothing), "longest_nothing is a list");
  assert.deepEqual(stretches(ts.longest_nothing), stretches(want.longest_nothing), "longest_nothing: the three longest stretches of nothing recorded");
  assert.equal(msOf(ts.checks.log_approval_wait_sec, "checks.log_approval_wait_sec"), Math.round(want.checks.log_approval_wait_sec * 1000), "R10: the log's approval waits, merged");
  assert.equal(msOf(ts.checks.handed_out_call_sec, "checks.handed_out_call_sec"), Math.round(want.checks.handed_out_call_sec * 1000), "R10: telemetry's summed call time");
}

/** R9: no number is filled in; the reason is said (and matches `reason` when given). `version` is the format's, not a time. */
function assertUnknown(ts, reason = null) {
  assert.ok(ts && typeof ts === "object", "the manifest carries a time_split block");
  assert.equal(typeof ts.unknown_reason, "string", "unknown_reason says why");
  assert.ok(ts.unknown_reason.trim().length > 0, "unknown_reason says why");
  if (reason) assert.match(ts.unknown_reason, reason, "unknown_reason names what is missing");
  assert.equal(ts.window?.sec, null, "window.sec is null, never 0");
  for (const k of ["model", "tool", "person", "nothing"]) assert.equal(ts.kinds_sec?.[k], null, `kinds_sec.${k} is null, never 0`);
  assert.equal(ts.time_taken_sec, null, "time_taken_sec is null, never 0");
  const numbers = [];
  const walk = (v, path) => {
    if (typeof v === "number") numbers.push(`${path}=${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!(path === "" && k === "version")) walk(x, path ? `${path}.${k}` : k);
  };
  walk(ts, "");
  assert.deepEqual(numbers, [], "every number is null when unknown_reason is set");
}

// ── the three real runs ─────────────────────────────────────────────────────────────────────────────────────────────

const REAL = {
  "gemini-led-bugfix": {
    policy: null,
    want: {
      window: { start: "2026-11-06T08:38:53.132Z", end: "2026-11-06T10:37:37.979Z", sec: 7124.847 },
      kinds_sec: { model: 3347.414, tool: 313.028, person: 3461.49, nothing: 2.915 },
      time_taken_sec: 3663.357,
      model_by_source: [
        { source: "main", model: "claude-opus-5-5", sec: 226.608, requests: 32 },
        { source: "helper", model: "claude-opus-5-5", sec: 628.417, requests: 53 },
        { source: "handed_out", model: "gemini-3.8-flash", sec: 36.202, requests: 5 },
        { source: "handed_out", model: "gemini-4-argon", sec: 2491.706, requests: 8 },
      ],
      before_run: { sec: 3398.116, kinds_sec: { model: 415.672, tool: 23.414, person: 2957.562, nothing: 1.468 } },
      longest_nothing: [
        { start: "2026-11-06T08:57:44.494Z", sec: 0.366 },
        { start: "2026-11-06T09:44:50.593Z", sec: 0.366 },
        { start: "2026-11-06T10:15:32.155Z", sec: 0.332 },
      ],
      checks: { log_approval_wait_sec: 3807.546, handed_out_call_sec: 2541.436 },
    },
  },
  "claude-led-feature-new": {
    policy: "opus55-plus-flash38-agsdk.yaml",
    want: {
      window: { start: "2026-11-09T07:56:09.338Z", end: "2026-11-09T09:02:10.170Z", sec: 3960.832 },
      kinds_sec: { model: 2179.117, tool: 1582.768, person: 196.228, nothing: 2.719 },
      time_taken_sec: 3764.604,
      model_by_source: [
        { source: "main", model: "claude-opus-5-5", sec: 87.67, requests: 17 },
        { source: "helper", model: "claude-opus-5-5", sec: 1694.546, requests: 165 },
        { source: "handed_out", model: "claude-opus-5-5", sec: 147.369, requests: 4 },
        { source: "handed_out", model: "gemini-3.8-flash", sec: 273.729, requests: 34 },
      ],
      before_run: { sec: 527.162, kinds_sec: { model: 344.485, tool: 84.873, person: 97.015, nothing: 0.789 } },
      longest_nothing: [
        { start: "2026-11-09T08:23:37.794Z", sec: 0.769 },
        { start: "2026-11-09T08:18:57.050Z", sec: 0.273 },
        { start: "2026-11-09T08:46:53.899Z", sec: 0.239 },
      ],
      checks: { log_approval_wait_sec: 389.368, handed_out_call_sec: 571.141 },
    },
  },
  "claude-led-feature-extend": {
    policy: "opus55-plus-flash38-agsdk.yaml",
    want: {
      window: { start: "2026-11-09T07:54:30.128Z", end: "2026-11-09T08:54:36.757Z", sec: 3606.629 },
      kinds_sec: { model: 1814.228, tool: 1594.226, person: 195.029, nothing: 3.146 },
      time_taken_sec: 3411.6,
      model_by_source: [
        { source: "main", model: "claude-opus-5-5", sec: 60.38, requests: 13 },
        { source: "helper", model: "claude-opus-5-5", sec: 1550.107, requests: 170 },
        { source: "handed_out", model: "claude-opus-5-5", sec: 52.64, requests: 3 },
        { source: "handed_out", model: "gemini-3.8-flash", sec: 164.633, requests: 39 },
      ],
      before_run: { sec: 468.969, kinds_sec: { model: 313.724, tool: 13.584, person: 140.91, nothing: 0.751 } },
      longest_nothing: [
        { start: "2026-11-09T08:52:35.676Z", sec: 1.539 },
        { start: "2026-11-09T08:12:07.774Z", sec: 0.356 },
        { start: "2026-11-09T08:37:26.678Z", sec: 0.275 },
      ],
      checks: { log_approval_wait_sec: 346.337, handed_out_call_sec: 308.469 },
    },
  },
};

/**
 * A copy of a real fixture laid out as on the machine it came from, and the collector run on it. `logText` rewrites
 * the run log's text; `withoutHelper` leaves that helper's history file out of the copy.
 */
function collectReal(name, { logText = null, withoutHelper = null } = {}) {
  const fx = join(FIXTURES, name);
  const manifest = JSON.parse(readFileSync(join(fx, "run", "manifest.json"), "utf-8"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "time-split-real-")));
  const passDir = join(root, ".sdlc", "runs", manifest.run_id);
  cpSync(join(fx, "run"), passDir, { recursive: true });
  cpSync(join(fx, "transcripts"), join(root, "transcripts"), { recursive: true });
  if (logText) writeFileSync(join(passDir, "orchestrator.log"), logText(readFileSync(join(passDir, "orchestrator.log"), "utf-8")));
  if (withoutHelper) {
    const session = readdirSync(join(root, "transcripts")).find((f) => f.endsWith(".jsonl")).slice(0, -".jsonl".length);
    rmSync(join(root, "transcripts", session, "subagents", `agent-${withoutHelper}.jsonl`));
  }
  const policy = REAL[name].policy ? ["--policy-path", join(FIXTURES, REAL[name].policy)] : [];
  const r = spawnSync(process.execPath, [COLLECTOR, passDir, "--project-root", root, "--transcripts-dir", join(root, "transcripts"), ...policy], { encoding: "utf-8", env: ENV });
  return {
    r,
    fx,
    passDir,
    manifestText: () => readFileSync(join(passDir, "manifest.json"), "utf-8"),
    telemetryText: () => readFileSync(join(passDir, "telemetry.jsonl"), "utf-8"),
    rm: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const name of Object.keys(REAL)) {
  test(`real run ${name}: time_split matches the values worked out from its history files, log and telemetry (R1-R10)`, () => {
    const c = collectReal(name);
    try {
      assert.equal(c.r.status, 0, c.r.stderr);
      assertSplit(JSON.parse(c.manifestText()).time_split, REAL[name].want);
    } finally { c.rm(); }
  });

  test(`real run ${name}: every existing manifest and telemetry field is what the collector wrote before time_split (R11)`, () => {
    const c = collectReal(name);
    try {
      assert.equal(c.r.status, 0, c.r.stderr);
      const after = JSON.parse(c.manifestText());
      assert.ok(Object.hasOwn(after, "time_split"), "the collector adds time_split");
      const before = JSON.parse(readFileSync(join(c.fx, "before-time-split", "manifest.json"), "utf-8"));
      assert.deepEqual(Object.keys(after).filter((k) => k !== "time_split").sort(), Object.keys(before).sort(), "time_split is the only new manifest field");
      for (const k of Object.keys(before)) assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), `manifest field ${k} byte for byte`);
      const lines = (text) => text.split("\n").filter(Boolean);
      const now = lines(c.telemetryText());
      const was = lines(readFileSync(join(c.fx, "before-time-split", "telemetry.jsonl"), "utf-8"));
      assert.equal(now.length, was.length, "the same telemetry lines");
      for (let i = 0; i < was.length; i++) {
        const w = JSON.parse(was[i]);
        if (w.tier !== "orchestrator") { assert.equal(now[i], was[i], `telemetry line ${i + 1} byte for byte`); continue; }
        // The collector's own event carries the time it was written; every other field is compared.
        const n = JSON.parse(now[i]);
        assert.equal(typeof n.ts, "string");
        delete n.ts;
        delete w.ts;
        assert.equal(JSON.stringify(n), JSON.stringify(w), "the collector's orchestrator event, every field but its write time");
      }
    } finally { c.rm(); }
  });
}

// ── hand-made runs ─────────────────────────────────────────────────────────────────────────────────────────────────

const SESSION = "5e5510a0-0000-4000-8000-000000000001";
const RUN_ID = "r-time-split";
const DAY = "2026-10-05";
const T = (hms) => `${DAY}T${hms}.000Z`;
const POLICY = `
version: 1
name: check-time-split
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5-5
  - id: flash
    adapter: antigravity-worker
    model_name: gemini-3.8-flash
  - id: argon
    adapter: antigravity-worker
    model_name: gemini-4-argon
rules:
  - default: opus
`;
const USAGE = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 20 };

/**
 * One history file, written the way Claude Code writes one (only the fields the rules and the collector read).
 * `markers: false` writes the person's lines with no origin, turnOrigin or promptSource, as an older Claude Code did.
 */
function historyFile({ agentId = null, markers = true } = {}) {
  const lines = [];
  let n = 0;
  let last = null;
  const base = () => ({ sessionId: SESSION, isSidechain: agentId != null, ...(agentId ? { agentId } : {}) });
  const uuid = () => `${agentId ?? "main"}-${String(++n).padStart(4, "0")}`;
  const push = (o) => { lines.push(o); last = o.uuid ?? last; return o.uuid; };
  return {
    lines,
    get last() { return last; },
    /** A person's typed message. */
    typed(ts, text = "approved", parent = last) {
      const marks = markers ? { origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human" } : {};
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: parent, ...base(), ...marks, message: { role: "user", content: text } });
    },
    /** The run's command turn. */
    command(ts) {
      const marks = markers ? { origin: { kind: "human" }, turnOrigin: "human" } : {};
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: last, ...base(), ...marks, message: { role: "user", content: "<command-message>mmo:bugfix</command-message>\n<command-name>/mmo:bugfix</command-name>" } });
    },
    /** A helper's prompt, or a message from the session or another helper: not a person's. */
    note(ts, kind, parent = last) {
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: parent, ...base(), isMeta: true, ...(kind ? { origin: { kind } } : {}), message: { role: "user", content: "" } });
    },
    /** One assistant message: `parts` are [ts, block] lines sharing one message id, the first answering `parent`. */
    reply(id, parts, { parent = last, model = "claude-opus-5-5", stop = "end_turn" } = {}) {
      let p = parent;
      for (const [ts, block] of parts) {
        p = push({ type: "assistant", timestamp: T(ts), uuid: uuid(), parentUuid: p, ...base(), message: { id, type: "message", role: "assistant", model, stop_reason: stop, usage: model === "<synthetic>" ? { input_tokens: 0, output_tokens: 0 } : USAGE, content: [block] } });
      }
      return p;
    },
    /** A tool's result. */
    result(ts, toolUseId, { parent = last, agent = null } = {}) {
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: parent, ...base(), toolUseResult: agent ? { agentId: agent } : {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: agent ? `agentId: ${agent}` : "" }] } });
    },
    /** A line Claude Code writes between the answered line and the reply (R3 passes over it). */
    attachment(ts, parent = last) {
      return push({ type: "attachment", timestamp: T(ts), uuid: uuid(), parentUuid: parent, ...base(), attachment: { type: "deferred_tools_record" } });
    },
    text: () => lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  };
}
const text = { type: "text", text: "" };
const thinking = { type: "thinking", thinking: "" };
const toolUse = (id, name) => ({ type: "tool_use", id, name, input: {} });

/** A handed-out call in telemetry: it ended at `endTs` after `latencyMs`. `extra` sets task_id, attempt_number, … */
const call = (endTs, latencyMs, model, phase = "codegen", extra = {}) => ({
  ts: T(endTs), pass: RUN_ID, phase, task_type: "", task_id: `tp_${phase}_${endTs}`, module: "spec", model, routed_by: "orchestrator", provenance: "vendor",
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001, latency_ms: latencyMs, success: true, retry_count: 0, ...extra,
});

/** Claude Code's history folder name for a project: its absolute path with every character not a letter or digit as `-`. */
const projectHash = (root) => root.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Lays out a hand-made run under a fresh project root. `log` is [hms, event, fields] (null: no orchestrator.log), each
 * line written with `prefix`; `helpers` maps a helper id to its history file; `receipt` is written as
 * claude-session.json; `history: false` writes no history files. `runFolder: "passes"` puts the run's files in
 * <root>/passes/<id> instead of <root>/.sdlc/runs/<id>, and `logIn: "project"` then writes the log to
 * <root>/.sdlc/runs/<id>/ alone. `historyIn: "config"` writes the history files where Claude Code keeps them under
 * CLAUDE_CONFIG_DIR, so the tools find them on their own, with no --transcripts-dir. `manifest: false` leaves the
 * manifest to the manifest writer.
 */
function writeRun({ main, helpers = {}, calls = [], log, receipt = null, history = true, prefix = "MMO: ", runFolder = "runs", logIn = "folder", historyIn = "dir", manifest = true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "time-split-made-")));
  const passDir = runFolder === "passes" ? join(root, "passes", RUN_ID) : join(root, ".sdlc", "runs", RUN_ID);
  const config = join(root, "claude-config");
  const tDir = historyIn === "config" ? join(config, "projects", projectHash(root)) : join(root, "transcripts");
  mkdirSync(passDir, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), POLICY);
  if (history) {
    mkdirSync(join(tDir, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(tDir, `${SESSION}.jsonl`), main.text());
    for (const [id, h] of Object.entries(helpers)) writeFileSync(join(tDir, SESSION, "subagents", `agent-${id}.jsonl`), h.text());
  }
  if (log) {
    const logDir = logIn === "project" ? join(root, ".sdlc", "runs", RUN_ID) : passDir;
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "orchestrator.log"), log.map(([hms, event, fields = ""]) => `${prefix}${T(hms)} INFO   ${event} run_id=${RUN_ID}${fields ? ` ${fields}` : ""}`).join("\n") + "\n");
  }
  writeFileSync(join(passDir, "telemetry.jsonl"), calls.map((c) => JSON.stringify(c)).join("\n") + (calls.length ? "\n" : ""));
  if (manifest) {
    const stamps = calls.map((c) => c.ts).sort();
    const lifecycle = (log ?? []).map(([hms]) => T(hms)).sort();
    const at = stamps.length ? stamps : [lifecycle[lifecycle.length - 1] ?? T("10:00:30")];
    writeFileSync(join(passDir, "manifest.json"), JSON.stringify({
      run_id: RUN_ID, policy_name: "check-time-split", started_at: at[0], ended_at: at[at.length - 1],
      total_cost_usd: Math.round(calls.length * 0.001 * 1e6) / 1e6,
      totals: { dispatched_cost_usd: Math.round(calls.length * 0.001 * 1e6) / 1e6, events: calls.length, models_used: [...new Set(calls.map((c) => c.model))] },
    }, null, 2));
  }
  if (receipt) writeFileSync(join(passDir, "claude-session.json"), JSON.stringify(receipt));
  const env = historyIn === "config" ? { ...ENV, CLAUDE_CONFIG_DIR: config } : ENV;
  const t = historyIn === "config" ? [] : ["--transcripts-dir", tDir];
  return {
    root, passDir,
    collect: () => spawnSync(process.execPath, [COLLECTOR, passDir, "--project-root", root, ...t, "--policy-path", join(root, "policy.yaml")], { encoding: "utf-8", env }),
    writeManifest: (...extra) => spawnSync(process.execPath, [WRITE_MANIFEST, passDir, "--pass", RUN_ID, "--policy", "check-time-split", "--project-root", root, ...extra], { encoding: "utf-8", env }),
    manifest: () => (existsSync(join(passDir, "manifest.json")) ? JSON.parse(readFileSync(join(passDir, "manifest.json"), "utf-8")) : null),
    rm: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A hand-made run, the collector run on it once, and what it wrote. */
function collectMade(opts) {
  const run = writeRun(opts);
  try {
    const r = run.collect();
    const manifest = run.manifest();
    return { r, manifest, ts: manifest?.time_split };
  } finally { run.rm(); }
}

test("R3/R4: overlapping handed-out calls of one model are counted once; inside the plugin's dispatch call they are model time and the rest of the call is tool time", () => {
  // Session: the command turn, a request that calls the dispatch tool (10:00:05 to 10:00:45), a closing request.
  // Telemetry: Flash 10:00:10-10:00:20 and 10:00:15-10:00:25 overlap (15 s once, 20 s summed); Argon 10:00:18-10:00:22.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:03", text], ["10:00:05", toolUse("toolu_D", "mcp__plugin_mmo_model-dispatch__execute_batch")]], { stop: "tool_use" });
  main.result("10:00:45", "toolu_D");
  main.reply("msg_m2", [["10:00:50", text]]);
  const { r, ts } = collectMade({
    main,
    calls: [call("10:00:20", 10_000, "gemini-3.8-flash"), call("10:00:25", 10_000, "gemini-3.8-flash"), call("10:00:22", 4_000, "gemini-4-argon")],
    log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:01:00", "run.end", "outcome=completed"]],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:00"), sec: 54 },
    // model: handed out 10:00:10-10:00:25 (15) + the closing request 10:00:45-10:00:50 (5); tool: the dispatch call
    // 10:00:06-10:00:45 (39) less the 15 s of handed-out model time inside it; nothing 10:00:50-10:01:00.
    kinds_sec: { model: 20, tool: 24, person: 0, nothing: 10 },
    time_taken_sec: 54,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 5, requests: 1 },
      { source: "handed_out", model: "gemini-3.8-flash", sec: 15, requests: 2 },
      { source: "handed_out", model: "gemini-4-argon", sec: 4, requests: 1 },
    ],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 1, person: 0, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:50"), sec: 10 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 24 },
  });
});

test("R4/R6: a helper's Agent call is not tool time, so a helper that stops writing shows as nothing recorded", () => {
  // The session waits on a foreground Agent call from 10:00:05 to 10:20:00. The helper's file shows a request, a Bash
  // call and a request, then nothing after 10:00:40: those 19 m 20 s are nothing recorded, not tool time.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:03", thinking], ["10:00:05", toolUse("toolu_A", "Agent")]], { stop: "tool_use" });
  main.result("10:20:00", "toolu_A", { agent: "h1" });
  main.reply("msg_m2", [["10:20:05", text]]);
  const h = historyFile({ agentId: "h1" });
  h.note("10:00:11", null, null);
  h.reply("msg_h1", [["10:00:15", thinking], ["10:00:20", toolUse("toolu_B", "Bash")]], { stop: "tool_use" });
  h.result("10:00:30", "toolu_B");
  h.reply("msg_h2", [["10:00:40", text]]);
  const { r, ts } = collectMade({ main, helpers: { h1: h }, log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:20:10", "run.end", "outcome=completed"]] });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:20:10"), sec: 1204 },
    kinds_sec: { model: 24, tool: 10, person: 0, nothing: 1170 },
    time_taken_sec: 1204,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 5, requests: 1 },
      { source: "helper", model: "claude-opus-5-5", sec: 19, requests: 2 },
    ],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 0, nothing: 1 } },
    longest_nothing: [{ start: T("10:00:40"), sec: 1160 }, { start: T("10:00:06"), sec: 5 }, { start: T("10:20:05"), sec: 5 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R5/R7: an AskUserQuestion call is waiting for a person, except the seconds a model was working", () => {
  // AskUserQuestion 10:00:10 to 10:01:10 (60 s); a handed-out Flash call runs 10:00:35-10:00:45 meanwhile.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:03", text], ["10:00:05", toolUse("toolu_B", "Bash")]], { stop: "tool_use" });
  main.result("10:00:08", "toolu_B");
  main.reply("msg_m2", [["10:00:10", toolUse("toolu_Q", "AskUserQuestion")]], { stop: "tool_use" });
  main.result("10:01:10", "toolu_Q");
  main.reply("msg_m3", [["10:01:15", text]]);
  const { r, ts } = collectMade({
    main,
    calls: [call("10:00:45", 10_000, "gemini-3.8-flash")],
    log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:01:25", "run.end", "outcome=completed"]],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:25"), sec: 79 },
    kinds_sec: { model: 17, tool: 2, person: 50, nothing: 10 },
    time_taken_sec: 29,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 7, requests: 2 },
      { source: "handed_out", model: "gemini-3.8-flash", sec: 10, requests: 1 },
    ],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 1, person: 0, nothing: 0 } },
    longest_nothing: [{ start: T("10:01:15"), sec: 10 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 10 },
  });
});

test("R5: a message typed while the run was working is not a wait; one typed while the run waited is, from the last line before it", () => {
  // The session starts a background helper and goes idle at 10:00:06. The helper works 10:00:08-10:01:30, records
  // nothing 10:01:30-10:02:00, then works 10:02:00-10:05:00. The person types at 10:03:00, while the helper works: no
  // wait, so 10:01:30-10:02:00 stays nothing recorded. The person types again at 10:06:00, after the work ended: a wait
  // from the session's last line (10:03:05), of which 10:05:00-10:06:00 is not covered by a model.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:02", text], ["10:00:04", toolUse("toolu_A", "Agent")]], { stop: "tool_use" });
  main.result("10:00:05", "toolu_A", { agent: "h1" });
  main.reply("msg_m2", [["10:00:06", text]]);
  main.typed("10:03:00", "how is it going?");
  main.reply("msg_m3", [["10:03:05", text]]);
  main.typed("10:06:00", "approved");
  main.reply("msg_m4", [["10:06:05", text]]);
  const h = historyFile({ agentId: "h1" });
  h.note("10:00:08", null, null);
  h.reply("msg_h1", [["10:00:30", thinking], ["10:01:30", text]]);
  h.note("10:02:00", "coordinator");
  h.reply("msg_h2", [["10:03:30", thinking], ["10:05:00", text]]);
  const { r, ts } = collectMade({ main, helpers: { h1: h }, log: [["10:00:07", "run.start", "mode=brownfield intent=bugfix"], ["10:06:10", "run.end", "outcome=completed"]] });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:07"), end: T("10:06:10"), sec: 363 },
    kinds_sec: { model: 267, tool: 0, person: 60, nothing: 36 },
    time_taken_sec: 303,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 10, requests: 2 },
      { source: "helper", model: "claude-opus-5-5", sec: 262, requests: 2 },
    ],
    before_run: { sec: 7, kinds_sec: { model: 5, tool: 0, person: 0, nothing: 2 } },
    longest_nothing: [{ start: T("10:01:30"), sec: 30 }, { start: T("10:06:05"), sec: 5 }, { start: T("10:00:07"), sec: 1 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R3: lines whose model is <synthetic> are not requests", () => {
  // A <synthetic> line at 10:00:45 answers the Bash result of 10:00:15: counted as a request it would be 30 s of model.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:03", text], ["10:00:05", toolUse("toolu_B", "Bash")]], { stop: "tool_use" });
  main.result("10:00:15", "toolu_B");
  main.reply("msg_synthetic", [["10:00:45", text]], { model: "<synthetic>", stop: "stop_sequence" });
  main.typed("10:01:00", "retry");
  main.reply("msg_m2", [["10:01:05", text]]);
  const { r, ts } = collectMade({ main, log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:01:10", "run.end", "outcome=completed"]] });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:10"), sec: 64 },
    // person: from the last line before the typed message (the <synthetic> line, 10:00:45) to it.
    kinds_sec: { model: 5, tool: 9, person: 15, nothing: 35 },
    time_taken_sec: 49,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 5, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 1, person: 0, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:15"), sec: 30 }, { start: T("10:01:05"), sec: 5 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R3: a request starts at the line it answers, passing over an attachment line Claude Code writes when the reply begins", () => {
  // The Bash result is at 10:00:20; Claude Code writes an attachment line at 10:00:29, and the reply's first line
  // (10:00:29) names the attachment as its parent. The request runs 10:00:20-10:00:30, not 10:00:29-10:00:30.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:03", text], ["10:00:05", toolUse("toolu_B", "Bash")]], { stop: "tool_use" });
  main.result("10:00:20", "toolu_B");
  main.attachment("10:00:29");
  main.reply("msg_m2", [["10:00:29", thinking], ["10:00:30", text]]);
  const { r, ts } = collectMade({ main, log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:40", "run.end", "outcome=completed"]] });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:00:40"), sec: 34 },
    kinds_sec: { model: 10, tool: 14, person: 0, nothing: 10 },
    time_taken_sec: 34,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 10, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 1, person: 0, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:30"), sec: 10 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R1/R2: the window opens at run.start, not at the log's first line or the command turn; before the run is reported on its own", () => {
  // The log starts at 10:00:02 (policy.load) and the command turn is at 10:00:00; run.start is at 10:01:00. The typed
  // message at 10:01:10 waits from 10:00:58: 2 s of it fall before the run, 10 s inside it.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:10", thinking], ["10:00:20", toolUse("toolu_B", "Bash")]], { stop: "tool_use" });
  main.result("10:00:50", "toolu_B");
  main.reply("msg_m2", [["10:00:58", text]]);
  main.typed("10:01:10", "approved");
  main.reply("msg_m3", [["10:01:40", text]]);
  const { r, ts } = collectMade({
    main,
    log: [["10:00:02", "policy.load"], ["10:00:30", "preflight.result"], ["10:01:00", "run.start", "mode=brownfield intent=bugfix"], ["10:02:00", "run.end", "outcome=completed"]],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:01:00"), end: T("10:02:00"), sec: 60 },
    kinds_sec: { model: 30, tool: 0, person: 10, nothing: 20 },
    time_taken_sec: 50,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 30, requests: 1 }],
    before_run: { sec: 60, kinds_sec: { model: 28, tool: 30, person: 2, nothing: 0 } },
    longest_nothing: [{ start: T("10:01:40"), sec: 20 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R1: a second run.end after the final approval closes the window, not the first", () => {
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:55", "accept");
  main.reply("msg_m2", [["10:01:01", text]]);
  const { r, ts } = collectMade({
    main,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:20", "gate.open", "gate=gate-4 title=final-acceptance"],
      ["10:00:30", "run.end", "outcome=completed"], ["10:01:00", "gate.resolved", "gate=gate-4 response=approved"], ["10:01:02", "run.end", "outcome=completed"],
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:02"), sec: 56 },
    kinds_sec: { model: 6, tool: 0, person: 49, nothing: 1 },
    time_taken_sec: 7,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 6, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
    longest_nothing: [{ start: T("10:01:01"), sec: 1 }],
    checks: { log_approval_wait_sec: 40, handed_out_call_sec: 0 },
  });
});

test("R1: a gate resolved after the last run.end closes the window there", () => {
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:55", "accept");
  main.reply("msg_m2", [["10:00:58", text]]);
  const { r, ts } = collectMade({
    main,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:30", "run.end", "outcome=completed"],
      ["10:00:31", "gate.open", "gate=gate-4 title=final-acceptance"], ["10:01:00", "gate.resolved", "gate=gate-4 response=approved"],
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:00"), sec: 54 },
    kinds_sec: { model: 3, tool: 0, person: 49, nothing: 2 },
    time_taken_sec: 5,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 3, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:58"), sec: 2 }],
    checks: { log_approval_wait_sec: 29, handed_out_call_sec: 0 },
  });
});

test("R10: the log's approval waits are merged and recorded beside the result, never used to compute it", () => {
  // Gates 1 and 2 overlap (10:00:10-10:00:40 and 10:00:30-10:00:50): 40 s merged. No person typed anything, so no
  // second is a person's; the stretch the gates cover stays nothing recorded.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.note("10:00:55", "peer");
  main.reply("msg_m2", [["10:01:00", text]]);
  const { r, ts } = collectMade({
    main,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"],
      ["10:00:10", "gate.open", "gate=gate-1 title=requirements-approval"], ["10:00:30", "gate.open", "gate=gate-2 title=architecture-approval"],
      ["10:00:40", "gate.resolved", "gate=gate-1 response=approved"], ["10:00:50", "gate.resolved", "gate=gate-2 response=approved"],
      ["10:01:00", "run.end", "outcome=completed"],
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:01:00"), sec: 54 },
    kinds_sec: { model: 5, tool: 0, person: 0, nothing: 49 },
    time_taken_sec: 54,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 5, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 0, nothing: 1 } },
    longest_nothing: [{ start: T("10:00:06"), sec: 49 }],
    checks: { log_approval_wait_sec: 40, handed_out_call_sec: 0 },
  });
});

test("R9: no history files for the run: every time field is null with unknown_reason, never zero", () => {
  // The collector books the run from Claude Code's receipt alone (it still writes the manifest); nothing records the
  // run's time, so nothing may be filled in.
  const { r, manifest, ts } = collectMade({
    main: null,
    history: false,
    calls: [call("10:00:30", 10_000, "gemini-3.8-flash")],
    log: [["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:01:00", "run.end", "outcome=completed"]],
    receipt: {
      type: "result", session_id: SESSION, num_turns: 1, total_cost_usd: 0.05,
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
      modelUsage: { "claude-opus-5-5": { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05 } },
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(manifest.orchestrator_overhead.cost_source, /^receipt-only/, "the collector wrote its figures from the receipt, as before");
  assertUnknown(ts);
});

test("R9: no run.start in the run log, or no run log: every time field is null with unknown_reason, never zero", () => {
  const made = (log) => {
    const main = historyFile();
    main.command("10:00:00");
    main.reply("msg_m1", [["10:00:05", text]]);
    main.typed("10:00:40", "approved");
    main.reply("msg_m2", [["10:00:45", text]]);
    return collectMade({ main, calls: [call("10:00:30", 10_000, "gemini-3.8-flash")], log });
  };
  for (const [label, log] of [
    ["a log without run.start", [["10:00:20", "gate.open", "gate=gate-1 title=requirements-approval"], ["10:00:40", "gate.resolved", "gate=gate-1 response=approved"], ["10:01:00", "run.end", "outcome=completed"]]],
    ["no orchestrator.log", null],
  ]) {
    const { r, ts } = made(log);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assertUnknown(ts);
  }
});

// ── clarifications from the independent review (rules file, 9 Nov) ─────────────────────────────────────────────────

/**
 * One run id used twice: attempt 1 (run.start 10:00:06, gate-1 10:00:10-10:00:20, run.end 10:00:30, failed) and,
 * after a second command turn at 10:00:50, attempt 2 (run.start 10:01:00, gate-1 10:01:05-10:01:35, run.end 10:02:00).
 */
function twoAttempts(calls) {
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:15", "approved");
  main.reply("msg_m2", [["10:00:18", text]]);
  main.command("10:00:50");
  main.reply("msg_m3", [["10:00:55", text]]);
  main.typed("10:01:30", "approved");
  main.reply("msg_m4", [["10:01:33", text]]);
  return collectMade({
    main,
    calls,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:10", "gate.open", "gate=gate-1 title=requirements-approval"],
      ["10:00:20", "gate.resolved", "gate=gate-1 response=approved"], ["10:00:30", "run.end", "outcome=failed"],
      ["10:01:00", "run.start", "mode=brownfield intent=bugfix"], ["10:01:05", "gate.open", "gate=gate-1 title=requirements-approval"],
      ["10:01:35", "gate.resolved", "gate=gate-1 response=approved"], ["10:02:00", "run.end", "outcome=completed"],
    ],
  });
}

test("R1 (review 1): two run.start lines under one run id: the run's first handed-out call is in the second attempt, so the window is the second attempt alone", () => {
  const { r, ts } = twoAttempts([call("10:01:20", 10_000, "gemini-3.8-flash")]);
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:01:00"), end: T("10:02:00"), sec: 60 },
    // person: the wait for the 10:01:30 answer from the last line before it (10:00:55), less the call's 10 s.
    kinds_sec: { model: 13, tool: 0, person: 20, nothing: 27 },
    time_taken_sec: 40,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 3, requests: 1 },
      { source: "handed_out", model: "gemini-3.8-flash", sec: 10, requests: 1 },
    ],
    before_run: { sec: 10, kinds_sec: { model: 5, tool: 0, person: 5, nothing: 0 } },
    longest_nothing: [{ start: T("10:01:33"), sec: 27 }],
    checks: { log_approval_wait_sec: 30, handed_out_call_sec: 10 },
  });
});

test("R1 (review 1): two run.start lines under one run id: the run's first handed-out call is in the first attempt, so the window is the first attempt alone and stops before the second starts", () => {
  const { r, ts } = twoAttempts([call("10:00:25", 4_000, "gemini-3.8-flash"), call("10:01:20", 10_000, "gemini-3.8-flash")]);
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:00:30"), sec: 24 },
    // person: the 10:00:15 answer waits from 10:00:05 (9 s in the window); the command typed at 10:00:50 waits from the
    // last line before it, 10:00:18, so 10:00:18-10:00:30 less the call's 4 s is the person's too (8 s).
    kinds_sec: { model: 7, tool: 0, person: 17, nothing: 0 },
    time_taken_sec: 7,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 3, requests: 1 },
      { source: "handed_out", model: "gemini-3.8-flash", sec: 4, requests: 1 },
    ],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
    longest_nothing: [],
    checks: { log_approval_wait_sec: 10, handed_out_call_sec: 4 },
  });
});

/** The run of the "second run.end" test above, with its log written under `prefix`. */
function secondRunEnd(prefix) {
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:55", "accept");
  main.reply("msg_m2", [["10:01:01", text]]);
  return collectMade({
    main,
    prefix,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:20", "gate.open", "gate=gate-4 title=final-acceptance"],
      ["10:00:30", "run.end", "outcome=completed"], ["10:01:00", "gate.resolved", "gate=gate-4 response=approved"], ["10:01:02", "run.end", "outcome=completed"],
    ],
  });
}

test("R1/R9 (review 2): the run log is read with no prefix or another one, as the collector reads it; such a log is never 'no run.start'", () => {
  for (const prefix of ["", "[sdlc] ", "PLUGIN: "]) {
    const { r, ts } = secondRunEnd(prefix);
    assert.equal(r.status, 0, `prefix ${JSON.stringify(prefix)}: ${r.stderr}`);
    assertSplit(ts, {
      window: { start: T("10:00:06"), end: T("10:01:02"), sec: 56 },
      kinds_sec: { model: 6, tool: 0, person: 49, nothing: 1 },
      time_taken_sec: 7,
      model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 6, requests: 1 }],
      before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
      longest_nothing: [{ start: T("10:01:01"), sec: 1 }],
      checks: { log_approval_wait_sec: 40, handed_out_call_sec: 0 },
    });
  }
});

test("R1/R9 (review 2): real run gemini-led-bugfix with its run log written without the MMO: prefix gives the same time_split", () => {
  const c = collectReal("gemini-led-bugfix", { logText: (t) => t.replace(/^MMO: /gm, "") });
  try {
    assert.equal(c.r.status, 0, c.r.stderr);
    assertSplit(JSON.parse(c.manifestText()).time_split, REAL["gemini-led-bugfix"].want);
  } finally { c.rm(); }
});

test("R3 (review 3): a retried call's numbered attempts sharing one ts are laid back to back; a same-task same-ts group without attempt numbers, and a call of another task, keep their own intervals", () => {
  // Before the run: three pre-flight probes of one task at one ts (no attempt numbers, run at once): 4 s, not 9 s.
  // In the run: tp_codegen_U01's attempts 1-3 (5, 7, 8 s, written in the order 3, 1, 2) all end at 10:01:10, so they ran
  // 10:00:50-10:01:10; tp_codegen_U02 also ends at 10:01:10 (6 s) and is not chained with them.
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:02", text]]);
  const probe = (ms) => call("10:00:20", ms, "gemini-4-argon", "preflight", { task_id: "typist_probe_argon", task_type: "typist_probe" });
  const { r, ts } = collectMade({
    main,
    calls: [
      probe(3_000), probe(4_000), probe(2_000),
      call("10:01:10", 8_000, "gemini-3.8-flash", "codegen", { task_id: "tp_codegen_U01", attempt_number: 3, retry_count: 2 }),
      call("10:01:10", 5_000, "gemini-3.8-flash", "codegen", { task_id: "tp_codegen_U01", attempt_number: 1, retry_count: 0, success: false }),
      call("10:01:10", 7_000, "gemini-3.8-flash", "codegen", { task_id: "tp_codegen_U01", attempt_number: 2, retry_count: 1, success: false }),
      call("10:01:10", 6_000, "gemini-3.8-flash", "codegen", { task_id: "tp_codegen_U02", attempt_number: 1 }),
    ],
    log: [["10:00:30", "run.start", "mode=brownfield intent=bugfix"], ["10:01:30", "run.end", "outcome=completed"]],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:30"), end: T("10:01:30"), sec: 60 },
    kinds_sec: { model: 20, tool: 0, person: 0, nothing: 40 },
    time_taken_sec: 60,
    model_by_source: [{ source: "handed_out", model: "gemini-3.8-flash", sec: 20, requests: 4 }],
    before_run: { sec: 30, kinds_sec: { model: 6, tool: 0, person: 0, nothing: 24 } },
    longest_nothing: [{ start: T("10:00:30"), sec: 20 }, { start: T("10:01:10"), sec: 20 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 26 },
  });
});

/** A run whose session starts a background helper `h1` before run.start; `h1` (when written) starts `h2`. */
function withHelpers({ writeH1 = true, writeH2 = true } = {}) {
  const main = historyFile();
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:02", text], ["10:00:04", toolUse("toolu_A", "Agent")]], { stop: "tool_use" });
  main.result("10:00:05", "toolu_A", { agent: "h1" });
  main.reply("msg_m2", [["10:00:06", text]]);
  main.typed("10:00:30", "approved");
  main.reply("msg_m3", [["10:00:33", text]]);
  const h1 = historyFile({ agentId: "h1" });
  h1.note("10:00:08", null, null);
  h1.reply("msg_h1a", [["10:00:12", thinking], ["10:00:15", toolUse("toolu_N", "Agent")]], { stop: "tool_use" });
  h1.result("10:00:16", "toolu_N", { agent: "h2" });
  h1.reply("msg_h1b", [["10:00:25", text]]);
  const h2 = historyFile({ agentId: "h2" });
  h2.note("10:00:17", null, null);
  h2.reply("msg_h2", [["10:00:24", text]]);
  const helpers = {};
  if (writeH1) helpers.h1 = h1;
  if (writeH2) helpers.h2 = h2;
  return { main, helpers, log: [["10:00:07", "run.start", "mode=brownfield intent=bugfix"], ["10:00:40", "run.end", "outcome=completed"]] };
}

test("R9 (review 4): a helper the run's Agent call names, whose history file is missing, makes the whole split unknown with that reason", () => {
  const { r, ts } = collectMade(withHelpers({ writeH1: false, writeH2: false }));
  assert.equal(r.status, 0, r.stderr);
  assertUnknown(ts, /helper|agent|\bh1\b/i);
});

test("R9 (review 4): a helper named by another helper's Agent call, whose history file is missing, makes the split unknown too", () => {
  const { r, ts } = collectMade(withHelpers({ writeH2: false }));
  assert.equal(r.status, 0, r.stderr);
  assertUnknown(ts, /helper|agent|\bh2\b/i);
});

test("R9 (review 4): with every helper's history file there, the same run is timed in full", () => {
  const { r, ts } = collectMade(withHelpers());
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:07"), end: T("10:00:40"), sec: 33 },
    // model: h1 10:00:08-10:00:15 and 10:00:16-10:00:25, h2 10:00:17-10:00:24, the session 10:00:30-10:00:33. The wait
    // for the 10:00:30 message runs from the session's last line (10:00:06): its seconds outside the helpers' requests
    // are the person's (10:00:07-08, 10:00:15-16, 10:00:25-30).
    kinds_sec: { model: 19, tool: 0, person: 7, nothing: 7 },
    time_taken_sec: 26,
    model_by_source: [
      { source: "main", model: "claude-opus-5-5", sec: 3, requests: 1 },
      { source: "helper", model: "claude-opus-5-5", sec: 16, requests: 3 },
    ],
    before_run: { sec: 7, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 1 } },
    longest_nothing: [{ start: T("10:00:33"), sec: 7 }],
    checks: { log_approval_wait_sec: 0, handed_out_call_sec: 0 },
  });
});

test("R9 (review 4): a helper named before the run's command turn is not the run's; its missing file leaves the split known", () => {
  // An earlier request in the same session (09:59) started helper `old1`, whose file is gone; the run starts at its own
  // command turn (10:00:00) and names no helper.
  const main = historyFile();
  main.typed("09:59:00", "tidy the notes first");
  main.reply("msg_mA", [["09:59:02", toolUse("toolu_X", "Agent")]], { stop: "tool_use" });
  main.result("09:59:03", "toolu_X", { agent: "old1" });
  main.reply("msg_mB", [["09:59:05", text]]);
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:30", "approved");
  main.reply("msg_m2", [["10:00:33", text]]);
  const { r, ts } = collectMade({
    main,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:10", "gate.open", "gate=gate-1 title=requirements-approval"],
      ["10:00:32", "gate.resolved", "gate=gate-1 response=approved"], ["10:00:40", "run.end", "outcome=completed"],
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:00:40"), sec: 34 },
    kinds_sec: { model: 3, tool: 0, person: 24, nothing: 7 },
    time_taken_sec: 10,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 3, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:33"), sec: 7 }],
    checks: { log_approval_wait_sec: 22, handed_out_call_sec: 0 },
  });
});

test("R9 (review 4): real run claude-led-feature-new without its orchestrator helper's history file: the split is unknown", () => {
  const c = collectReal("claude-led-feature-new", { withoutHelper: "a532ceec45509cc9a" });
  try {
    assert.equal(c.r.status, 0, c.r.stderr);
    assertUnknown(JSON.parse(c.manifestText()).time_split, /helper|agent|a532ceec45509cc9a/i);
  } finally { c.rm(); }
});

/** A run for the manifest writer: the writer writes the manifest, the collector patches it, the writer runs again at Gate 4. */
function writerRun(layout) {
  const { main, helpers } = withHelpers();
  return writeRun({
    main,
    helpers: layout.helpers ?? helpers,
    calls: [call("10:00:20", 4_000, "gemini-3.8-flash")],
    log: [["10:00:07", "run.start", "mode=brownfield intent=bugfix"], ["10:00:40", "run.end", "outcome=completed"]],
    historyIn: "config",
    manifest: false,
    ...layout,
  });
}

/** Writer, collector, writer again; returns the block the collector wrote and the block after the rewrite. */
function collectThenRewrite(run) {
  let w = run.writeManifest();
  assert.equal(w.status, 0, w.stderr);
  const r = run.collect();
  assert.equal(r.status, 0, r.stderr);
  const collected = run.manifest().time_split;
  w = run.writeManifest("--status", "accepted");
  assert.equal(w.status, 0, w.stderr);
  const rewritten = run.manifest();
  assert.equal(rewritten.status, "accepted");
  return { collected, rewritten: rewritten.time_split };
}

for (const [label, layout] of [
  ["only in the project's .sdlc/runs/<id>/ (the run folder is elsewhere)", { runFolder: "passes", logIn: "project" }],
  ["only in the run folder itself", { runFolder: "passes", logIn: "folder" }],
]) {
  test(`manifest writer (review 5): with the run log ${label}, a rewrite keeps the collector's time_split`, () => {
    const run = writerRun(layout);
    try {
      const { collected, rewritten } = collectThenRewrite(run);
      assert.ok(collected && collected.unknown_reason === null, `the collector times the run: ${JSON.stringify(collected?.unknown_reason)}`);
      assert.equal(Date.parse(collected.window.start), Date.parse(T("10:00:07")), "the window opens at run.start");
      assert.deepEqual(rewritten, collected, "the rewritten manifest's time_split is the collector's");
    } finally { run.rm(); }
  });
}

test("manifest writer (review 5): an unknown block whose reason is not the log is kept as it is", () => {
  const { helpers } = withHelpers();
  delete helpers.h2;
  const run = writerRun({ helpers });
  try {
    const { collected, rewritten } = collectThenRewrite(run);
    assertUnknown(collected, /helper|agent|\bh2\b/i);
    assert.deepEqual(rewritten, collected, "the rewritten manifest keeps the unknown block as it was");
  } finally { run.rm(); }
});

test("R5 (clarification): a session file with no person markers (an older Claude Code) falls back to the collector's human turns", () => {
  const main = historyFile({ markers: false });
  main.command("10:00:00");
  main.reply("msg_m1", [["10:00:05", text]]);
  main.typed("10:00:35", "approved");
  main.reply("msg_m2", [["10:00:40", text]]);
  const { r, ts } = collectMade({
    main,
    log: [
      ["10:00:06", "run.start", "mode=brownfield intent=bugfix"], ["10:00:10", "gate.open", "gate=gate-1 title=requirements-approval"],
      ["10:00:38", "gate.resolved", "gate=gate-1 response=approved"], ["10:00:45", "run.end", "outcome=completed"],
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assertSplit(ts, {
    window: { start: T("10:00:06"), end: T("10:00:45"), sec: 39 },
    kinds_sec: { model: 5, tool: 0, person: 29, nothing: 5 },
    time_taken_sec: 10,
    model_by_source: [{ source: "main", model: "claude-opus-5-5", sec: 5, requests: 1 }],
    before_run: { sec: 6, kinds_sec: { model: 5, tool: 0, person: 1, nothing: 0 } },
    longest_nothing: [{ start: T("10:00:40"), sec: 5 }],
    checks: { log_approval_wait_sec: 28, handed_out_call_sec: 0 },
  });
});
