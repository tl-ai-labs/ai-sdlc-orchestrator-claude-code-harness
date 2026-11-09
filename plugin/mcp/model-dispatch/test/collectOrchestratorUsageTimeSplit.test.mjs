/**
 * `time_split`: every second of a run's window as model working, tool running, waiting for a person or nothing
 * recorded, from Claude Code's history files, the run log and the run's telemetry (the rules R1-R11 of the run-time
 * split; the block's format is version 1).
 *
 * Every case is end to end: the real collector CLI on a copy of a run folder, with --project-root and
 * --transcripts-dir pointing at the copy, and `time_split` read from the manifest it wrote.
 *
 *   - Three real runs (tools/test/fixtures/run-time-split, README there): a Gemini-led bugfix (Argon and Flash handed
 *     out, Opus session and helpers) and two Claude-led brownfield runs (Opus helpers, Flash and an Opus typist handed
 *     out). Expected values were worked out from the raw files and the rules, independently of the implementation.
 *   - The same three runs keep every existing manifest and telemetry field as the collector wrote it before time_split
 *     existed (R11): before-time-split/ in each fixture.
 *   - Small hand-made runs, one rule each.
 *
 * Seconds are compared to the millisecond, and the four kinds must add up to the window exactly (R7). A request starts
 * at the line its first line answers, passing over the attachment lines Claude Code writes between that line and the
 * reply (R3); the last line written before a typed message is the nearest earlier line of the main session file that
 * carries a timestamp (R5). Offline, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTOR = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
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

/** R9: no number is filled in; the reason is said. `version` is the format's, not a time. */
function assertUnknown(ts) {
  assert.ok(ts && typeof ts === "object", "the manifest carries a time_split block");
  assert.equal(typeof ts.unknown_reason, "string", "unknown_reason says why");
  assert.ok(ts.unknown_reason.trim().length > 0, "unknown_reason says why");
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

/** A copy of a real fixture laid out as on the machine it came from, and the collector run on it. */
function collectReal(name) {
  const fx = join(FIXTURES, name);
  const manifest = JSON.parse(readFileSync(join(fx, "run", "manifest.json"), "utf-8"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "time-split-real-")));
  const passDir = join(root, ".sdlc", "runs", manifest.run_id);
  cpSync(join(fx, "run"), passDir, { recursive: true });
  cpSync(join(fx, "transcripts"), join(root, "transcripts"), { recursive: true });
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

/** One history file, written the way Claude Code writes one (only the fields the rules and the collector read). */
function historyFile({ agentId = null } = {}) {
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
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: parent, ...base(), origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human", message: { role: "user", content: text } });
    },
    /** The run's command turn. */
    command(ts) {
      return push({ type: "user", timestamp: T(ts), uuid: uuid(), parentUuid: last, ...base(), origin: { kind: "human" }, turnOrigin: "human", message: { role: "user", content: "<command-message>mmo:bugfix</command-message>\n<command-name>/mmo:bugfix</command-name>" } });
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

/** A handed-out call in telemetry: it ended at `endTs` after `latencyMs`. */
const call = (endTs, latencyMs, model, phase = "codegen") => ({
  ts: T(endTs), pass: RUN_ID, phase, task_type: "", task_id: `tp_${phase}_${endTs}`, module: "spec", model, routed_by: "orchestrator", provenance: "vendor",
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001, latency_ms: latencyMs, success: true, retry_count: 0,
});

/**
 * Writes a hand-made run under a fresh project root and runs the collector on it. `log` is [hms, event, fields]
 * (null: no orchestrator.log); `helpers` maps a helper id to its history file; `receipt` is written as
 * claude-session.json; `history: false` writes no history files at all.
 */
function collectMade({ main, helpers = {}, calls = [], log, receipt = null, history = true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "time-split-made-")));
  const passDir = join(root, ".sdlc", "runs", RUN_ID);
  const tDir = join(root, "transcripts");
  mkdirSync(passDir, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), POLICY);
  if (history) {
    mkdirSync(join(tDir, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(tDir, `${SESSION}.jsonl`), main.text());
    for (const [id, h] of Object.entries(helpers)) writeFileSync(join(tDir, SESSION, "subagents", `agent-${id}.jsonl`), h.text());
  }
  if (log) writeFileSync(join(passDir, "orchestrator.log"), log.map(([hms, event, fields = ""]) => `MMO: ${T(hms)} INFO   ${event} run_id=${RUN_ID}${fields ? ` ${fields}` : ""}`).join("\n") + "\n");
  writeFileSync(join(passDir, "telemetry.jsonl"), calls.map((c) => JSON.stringify(c)).join("\n") + (calls.length ? "\n" : ""));
  const stamps = calls.map((c) => c.ts).sort();
  const lifecycle = (log ?? []).map(([hms]) => T(hms)).sort();
  const at = stamps.length ? stamps : [lifecycle[lifecycle.length - 1] ?? T("10:00:30")];
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify({
    run_id: RUN_ID, policy_name: "check-time-split", started_at: at[0], ended_at: at[at.length - 1],
    total_cost_usd: Math.round(calls.length * 0.001 * 1e6) / 1e6,
    totals: { dispatched_cost_usd: Math.round(calls.length * 0.001 * 1e6) / 1e6, events: calls.length, models_used: [...new Set(calls.map((c) => c.model))] },
  }, null, 2));
  if (receipt) writeFileSync(join(passDir, "claude-session.json"), JSON.stringify(receipt));
  const r = spawnSync(process.execPath, [COLLECTOR, passDir, "--project-root", root, "--transcripts-dir", tDir, "--policy-path", join(root, "policy.yaml")], { encoding: "utf-8", env: ENV });
  const manifest = existsSync(join(passDir, "manifest.json")) ? JSON.parse(readFileSync(join(passDir, "manifest.json"), "utf-8")) : null;
  rmSync(root, { recursive: true, force: true });
  return { r, manifest, ts: manifest?.time_split };
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
