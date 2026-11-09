/**
 * time-split — where one run's time went, from the records the run already leaves.
 *
 * Every second of the run's window goes into exactly one of four kinds, in this order of precedence:
 *   model working   a request to a model, from the line it answers to the last line of its reply (the main
 *                   session and every helper, from Claude Code's history files), and every call the plugin
 *                   handed out to a model (telemetry.jsonl: `ts` is the call's end, `latency_ms` its length);
 *   tool running    a tool call, from its `tool_use` line to its `tool_result` line. An Agent/Task call is not
 *                   tool time (the helper is timed from its own file, so a stuck helper shows as nothing
 *                   recorded); an AskUserQuestion call is waiting for a person; the plugin's dispatch calls are
 *                   tool time, so what is left of one after the model calls inside it is the plugin's overhead;
 *   waiting for a person   in the main session, from the run's last activity before a person's message to that
 *                   message (the person's turns are the cost tool's own `humanTurns`), and AskUserQuestion calls;
 *   nothing recorded  the rest, shown and never cut: a laptop asleep or a stuck helper lands here.
 * The window is the run log's `run.start` to the later of its last `run.end` and its last `gate.resolved`; the time
 * before it (the command turn to `run.start`: discovery, intake, Gate 0) is split the same way and reported apart.
 * No cutoff anywhere; a run that cannot be timed says why (`unknown_reason`) and carries no numbers.
 * The rules, R1-R11, with the evidence they rest on: harness-work notes "proper-fix-rules.md" (9 Nov 2026).
 */
import { readFileSync } from "node:fs";

export const TIME_SPLIT_VERSION = 1;

/** The plugin's run-log line: `MMO: <ISO> <LEVEL> <event> key=value ...` (scripts/lib/log.mjs writes it). */
const LOG_LINE = /^MMO:\s+(\S+)\s+\S+\s+(\S+)(.*)$/;

/** The run log's lifecycle events, oldest first: { ms, event, gate }. Lines that are not the plugin's are skipped. */
export function runLogEvents(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = LOG_LINE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (!Number.isFinite(ms)) continue;
    const gate = /(?:^|\s)gate=(\S+)/.exec(m[3])?.[1] ?? null;
    out.push({ ms, event: m[2], gate });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * R1: the run's window from its log. { startMs, endMs } or { unknown: reason }. The start is the first `run.start`;
 * the end is the later of the last `run.end` and the last `gate.resolved` (the final approval can come after the first
 * `run.end`, and the plugin writes a second `run.end` after it on some runs and not on others).
 */
export function windowFromLog(events) {
  const starts = events.filter((e) => e.event === "run.start");
  if (!starts.length) return { unknown: "no run.start in the run's orchestrator.log" };
  const startMs = starts[0].ms;
  const closers = events.filter((e) => (e.event === "run.end" || e.event === "gate.resolved") && e.ms >= startMs);
  if (!closers.some((e) => e.event === "run.end")) return { unknown: "no run.end after run.start in the run's orchestrator.log" };
  return { startMs, endMs: Math.max(...closers.map((e) => e.ms)) };
}

/** R10's check: each `gate.open` paired with the next `gate.resolved` of the same gate. */
export function logApprovalWaits(events) {
  const open = new Map();
  const out = [];
  for (const e of events) {
    if (!e.gate) continue;
    if (e.event === "gate.open") open.set(e.gate, e.ms);
    else if (e.event === "gate.resolved" && open.has(e.gate)) { out.push([open.get(e.gate), e.ms]); open.delete(e.gate); }
  }
  return out;
}

// ── interval arithmetic (ms, half-open [start, end)) ────────────────────────────────────────────────────────────────
export function merge(intervals) {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
export function clip(intervals, from, to) {
  return intervals.map(([s, e]) => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s);
}
/** A minus B; both merged and sorted. */
export function subtract(a, b) {
  const out = [];
  let j = 0;
  for (const [s, e] of a) {
    while (j < b.length && b[j][1] <= s) j++;
    let cur = s;
    for (let k = j; k < b.length && b[k][0] < e; k++) {
      if (b[k][0] > cur) out.push([cur, b[k][0]]);
      cur = Math.max(cur, b[k][1]);
      if (cur >= e) break;
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}
const total = (intervals) => intervals.reduce((n, [s, e]) => n + (e - s), 0);
// Seconds to the millisecond, the records' own precision: rounding each kind would let the four stop adding up to
// the window (R7).
const sec = (ms) => Math.round(ms) / 1000;
const iso = (ms) => new Date(ms).toISOString();

function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not a record */ }
  }
  return out;
}
const lineMs = (o) => {
  const t = Date.parse(o?.timestamp);
  return Number.isFinite(t) ? t : null;
};

/**
 * One history file's intervals. R3: a request is one assistant message (its lines share `message.id`), from the line
 * it answers (`parentUuid` of its first line) to its last line; `<synthetic>` lines are the CLI's error placeholders,
 * not requests. R4: tool calls from `tool_use` to `tool_result`. `activity` holds the times of the lines that mark the
 * run working (assistant lines, tool results, system lines), so a person's wait starts after the last of them.
 */
export function historyFileIntervals(lines) {
  const byUuid = new Map();
  for (const o of lines) if (o?.uuid) byUuid.set(o.uuid, o);
  const messages = new Map();
  const toolUse = new Map();
  const tools = [];
  const dispatch = [];
  const asks = [];
  const activity = [];
  for (const o of lines) {
    const t = lineMs(o);
    if (o?.type === "assistant" && o.message) {
      const m = o.message;
      if (m.model === "<synthetic>") continue;
      if (t != null) activity.push(t);
      const id = m.id ?? o.requestId ?? o.uuid;
      let g = messages.get(id);
      if (!g) messages.set(id, (g = { model: m.model ?? "unknown", first: o, end: t }));
      if (t != null) g.end = g.end == null ? t : Math.max(g.end, t);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "tool_use" && b.id && t != null) toolUse.set(b.id, { ms: t, name: String(b.name ?? "") });
      }
    } else if (o?.type === "user" && o.message) {
      const blocks = Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        if (t != null) activity.push(t);
        const u = toolUse.get(b.tool_use_id);
        if (!u || t == null || t < u.ms) continue;
        if (u.name === "Agent" || u.name === "Task") continue;
        if (u.name === "AskUserQuestion") asks.push([u.ms, t]);
        else if (u.name.includes("model-dispatch")) dispatch.push([u.ms, t]);
        else tools.push([u.ms, t]);
      }
    } else if (o?.type === "system" && t != null) {
      activity.push(t);
    }
  }
  const models = new Map();
  for (const g of messages.values()) {
    const parent = g.first.parentUuid ? byUuid.get(g.first.parentUuid) : null;
    const start = (parent ? lineMs(parent) : null) ?? lineMs(g.first);
    if (start == null || g.end == null || g.end < start) continue;
    if (!models.has(g.model)) models.set(g.model, []);
    models.get(g.model).push([start, g.end]);
  }
  activity.sort((a, b) => a - b);
  return { models, tools, dispatch, asks, activity };
}

/** R5: each person's message, waited for from the run's last activity before it. */
function personWaits(activity, personTurnMs) {
  const out = [];
  for (const ms of personTurnMs) {
    let lo = 0;
    let hi = activity.length - 1;
    let last = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (activity[mid] < ms) { last = activity[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (last != null) out.push([last, ms]);
  }
  return out;
}

/** R7: one kind per second over [from, to), in the order model, tool, person; the rest is nothing recorded. */
function splitSpan(from, to, layers) {
  const span = [[from, to]];
  const model = merge(clip(layers.model, from, to));
  const tool = subtract(merge(clip(layers.tool, from, to)), model);
  const busy = merge([...model, ...tool]);
  const person = subtract(merge(clip(layers.person, from, to)), busy);
  const nothing = subtract(span, merge([...busy, ...person]));
  return { model, tool, person, nothing };
}

/** R9: a run that cannot be timed: the reason, and no numbers (never zeros). */
export const unknownTimeSplit = (reason) => ({
  version: TIME_SPLIT_VERSION,
  unknown_reason: reason,
  window: { start: null, end: null, sec: null },
  kinds_sec: { model: null, tool: null, person: null, nothing: null },
  time_taken_sec: null,
  model_by_source: [],
  before_run: null,
  longest_nothing: [],
  checks: { log_approval_wait_sec: null, handed_out_call_sec: null },
});

/**
 * The run's `time_split` block (manifest.json). Inputs:
 *   logText          the run's orchestrator.log
 *   telemetryEvents  telemetry.jsonl's events (the collector's own `tier: "orchestrator"` event is not a call)
 *   files            [{ path, role: "main" | "helper" }]: the run's history files, as the cost tool pinned them
 *   personTurnMs     the main session's person turns (the cost tool's humanTurns), ms
 *   commandTurnMs    the run's command turn (where the time before the run begins), or null
 */
export function timeSplit({ logText, telemetryEvents = [], files = [], personTurnMs = [], commandTurnMs = null }) {
  const events = runLogEvents(logText);
  const w = windowFromLog(events);
  if (w.unknown) return unknownTimeSplit(w.unknown);
  if (!files.some((f) => f.role === "main")) return unknownTimeSplit("no Claude Code history file for the run's session");

  const bySource = new Map();
  const add = (source, model, intervals) => {
    const key = `${source}\u0000${model}`;
    if (!bySource.has(key)) bySource.set(key, { source, model, intervals: [] });
    bySource.get(key).intervals.push(...intervals);
  };
  const tool = [];
  const person = [];
  for (const f of files) {
    let lines;
    try { lines = readJsonl(f.path); } catch (e) { return unknownTimeSplit(`history file unreadable: ${f.path}: ${e?.message ?? e}`); }
    const iv = historyFileIntervals(lines);
    for (const [model, intervals] of iv.models) add(f.role === "main" ? "main" : "helper", model, intervals);
    tool.push(...iv.tools, ...iv.dispatch);
    person.push(...iv.asks);
    if (f.role === "main") person.push(...personWaits(iv.activity, personTurnMs));
  }
  const calls = [];
  for (const e of telemetryEvents) {
    if (e?.tier === "orchestrator") continue;
    const end = Date.parse(e?.ts);
    const len = Number(e?.latency_ms);
    if (!Number.isFinite(end) || !Number.isFinite(len) || len <= 0) continue;
    calls.push([end - len, end]);
    add("handed_out", String(e.model ?? "unknown"), [[end - len, end]]);
  }
  const allModel = [...bySource.values()].flatMap((s) => s.intervals);
  const layers = { model: allModel, tool, person };

  const { startMs, endMs } = w;
  const inRun = splitSpan(startMs, endMs, layers);
  const kinds = (s) => ({ model: sec(total(s.model)), tool: sec(total(s.tool)), person: sec(total(s.person)), nothing: sec(total(s.nothing)) });
  const before = Number.isFinite(commandTurnMs) && commandTurnMs < startMs ? splitSpan(commandTurnMs, startMs, layers) : null;

  return {
    version: TIME_SPLIT_VERSION,
    unknown_reason: null,
    window: { start: iso(startMs), end: iso(endMs), sec: sec(endMs - startMs) },
    kinds_sec: kinds(inRun),
    time_taken_sec: sec(endMs - startMs - total(inRun.person)),
    model_by_source: [...bySource.values()]
      .map((s) => {
        const inside = clip(s.intervals, startMs, endMs);
        return { source: s.source, model: s.model, sec: sec(total(merge(inside))), requests: inside.length };
      })
      .filter((s) => s.requests > 0)
      .sort((a, b) => b.sec - a.sec || a.source.localeCompare(b.source) || a.model.localeCompare(b.model)),
    before_run: before ? { sec: sec(startMs - commandTurnMs), kinds_sec: kinds(before) } : null,
    longest_nothing: [...inRun.nothing].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0]).slice(0, 3)
      .map(([s, e]) => ({ start: iso(s), sec: sec(e - s) })),
    checks: {
      log_approval_wait_sec: sec(total(merge(clip(logApprovalWaits(events), startMs, endMs)))),
      handed_out_call_sec: sec(total(clip(calls, startMs, endMs))),
    },
  };
}
