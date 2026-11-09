#!/usr/bin/env node
/**
 * Builds one run-time-split fixture from a real run on this machine (README.md beside this file says which runs).
 *
 *   node tools/test/fixtures/run-time-split/build.mjs --run <run folder> --history <projects/<hash> folder> \
 *        --session <session id> --out <fixture folder>
 *
 * --run is the run's `.sdlc/runs/<run-id>/` folder (manifest.json, telemetry.jsonl, orchestrator.log); --history is
 * Claude Code's history folder for the project (`~/.claude/projects/<hash>`). Writes <out>/run/ and <out>/transcripts/.
 *
 *   node tools/test/fixtures/run-time-split/build.mjs --before <fixture folder> --collector <collect-orchestrator-usage.mjs>
 *        [--policy-path <file>]
 *
 * runs the given collector on a copy of the fixture, the way the tests do, and writes what it wrote into
 * <fixture>/before-time-split/ (manifest.json, telemetry.jsonl): the record an unchanged collector must keep (R11).
 *
 * Kept from the history files: every line that carries a timestamp, with its type, timestamp, uuid, parentUuid,
 * session and helper ids; assistant message ids, models, stop reasons and token usage; content block types, tool ids
 * and tool names; the person-message markers (origin kind, promptSource, turnOrigin, isMeta, toolUseResult present);
 * slash-command names and --run-id flags; the helper id an Agent/Task result names. All other text is blanked.
 * Lines without a timestamp (titles, account and mode records, request bodies) are left out.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);

const RUN_COMMAND = "(?:mmo:(?:pass|greenfield|brownfield|docs|bugfix|feature-extend|feature-new|refactor|test|deps)|(?:[\\w-]+:)?ai-sdlc-[\\w-]+|pass)";
const COMMAND_TAG = /<command-name>\/([\w:.-]+)<\/command-name>/;
const BARE_COMMAND = new RegExp(`^\\s*\\/(${RUN_COMMAND})(?:\\s|$)`);
const RUN_ID = /--run-id(?:=|\s+)([^\s<]+)/;
const AGENT_ID = /agentId: ([A-Za-z0-9]+)/g;

/** A user text reduced to the slash command it names and its --run-id, or "". */
function reduceText(text) {
  if (typeof text !== "string") return "";
  const tag = COMMAND_TAG.exec(text)?.[1];
  const bare = tag ? null : BARE_COMMAND.exec(text)?.[1];
  const runId = RUN_ID.exec(text)?.[1];
  if (tag) return `<command-message>${tag}</command-message>\n<command-name>/${tag}</command-name>` + (runId ? `\n<command-args>--run-id=${runId}</command-args>` : "");
  if (bare) return `/${bare}` + (runId ? ` --run-id=${runId}` : "");
  return "";
}

function pick(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) if (keys.includes(k)) out[k] = obj[k];
  return out;
}

const USAGE_KEYS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "service_tier", "speed", "inference_geo"];

function reduceUsage(u) {
  if (!u || typeof u !== "object") return u;
  const out = pick(u, USAGE_KEYS);
  if (u.cache_creation && typeof u.cache_creation === "object") out.cache_creation = pick(u.cache_creation, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);
  if (u.server_tool_use?.web_search_requests) out.server_tool_use = { web_search_requests: u.server_tool_use.web_search_requests };
  return out;
}

function reduceAssistantBlock(b) {
  if (!b || typeof b !== "object") return b;
  if (b.type === "tool_use") {
    const input = {};
    if (b.name === "Skill" && typeof b.input?.skill === "string") {
      input.skill = b.input.skill;
      const runId = RUN_ID.exec(String(b.input.args ?? ""))?.[1];
      if (runId) input.args = `--run-id=${runId}`;
    }
    return { type: "tool_use", id: b.id, name: b.name, input };
  }
  if (b.type === "text") return { type: "text", text: "" };
  if (b.type === "thinking") return { type: "thinking", thinking: "" };
  return { type: b.type };
}

/** The `agentId: <id>` lines of an Agent/Task result, the only text of a result anything reads. */
function agentIdText(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((x) => (x?.type === "text" ? x.text ?? "" : "")).join("\n") : "";
  return [...text.matchAll(AGENT_ID)].map((m) => `agentId: ${m[1]}`).join("\n");
}

function reduceUserContent(content, agentUses) {
  if (typeof content === "string") return reduceText(content);
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (!b || typeof b !== "object") return b;
    if (b.type === "tool_result") {
      const out = { type: "tool_result", tool_use_id: b.tool_use_id };
      if (b.is_error !== undefined) out.is_error = b.is_error;
      const ids = agentUses.has(b.tool_use_id) ? agentIdText(b.content) : "";
      out.content = Array.isArray(b.content) ? (ids ? [{ type: "text", text: ids }] : []) : ids;
      return out;
    }
    if (b.type === "text") return { type: "text", text: reduceText(b.text) };
    return { type: b.type };
  });
}

function reduceToolUseResult(tur, isAgentResult) {
  if (tur === undefined) return undefined;
  if (Array.isArray(tur)) return [];
  if (typeof tur === "string") return "";
  if (tur && typeof tur === "object") return isAgentResult && typeof tur.agentId === "string" ? { agentId: tur.agentId } : {};
  return null;
}

const COMMON = ["type", "timestamp", "uuid", "parentUuid", "isSidechain", "sessionId", "agentId"];

/** One history file, reduced line by line. Returns the text and a count of what it kept. */
function reduceHistory(path) {
  const agentUses = new Set();
  const out = [];
  const kept = { lines: 0, dropped_without_timestamp: 0 };
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (typeof o.timestamp !== "string") { kept.dropped_without_timestamp++; continue; }
    const r = pick(o, COMMON);
    if (o.type === "assistant") {
      if (o.isApiErrorMessage !== undefined) r.isApiErrorMessage = o.isApiErrorMessage;
      if (o.requestRef !== undefined) r.requestRef = o.requestRef;
      const m = o.message ?? {};
      const msg = pick(m, ["id", "type", "role", "model", "stop_reason"]);
      if (m.usage) msg.usage = reduceUsage(m.usage);
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) agentUses.add(b.id);
        msg.content = m.content.map(reduceAssistantBlock);
      }
      r.message = msg;
    } else if (o.type === "user") {
      for (const k of ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "promptSource", "turnOrigin"]) if (o[k] !== undefined) r[k] = o[k];
      if (o.origin !== undefined) r.origin = o.origin && typeof o.origin === "object" ? pick(o.origin, ["kind"]) : o.origin;
      const content = o.message?.content;
      const isAgentResult = Array.isArray(content) && content.some((b) => b?.type === "tool_result" && agentUses.has(b.tool_use_id));
      const tur = reduceToolUseResult(o.toolUseResult, isAgentResult);
      if (tur !== undefined) r.toolUseResult = tur;
      r.message = { role: o.message?.role ?? "user", content: reduceUserContent(content, agentUses) };
    } else if (o.type === "system") {
      for (const k of ["subtype", "isMeta"]) if (o[k] !== undefined) r[k] = o[k];
    } else if (o.type === "attachment") {
      r.attachment = { type: o.attachment?.type ?? null };
    } else if (o.type === "queue-operation") {
      r.operation = o.operation;
    } else if (o.type === "api-request") {
      r.id = o.id;
    }
    out.push(JSON.stringify(r));
    kept.lines++;
  }
  return { text: out.join("\n") + "\n", kept };
}

const TELEMETRY_KEYS = [
  "ts", "pass", "phase", "task_type", "task_id", "module", "model", "model_id", "routed_by", "provenance", "tier", "routing", "door",
  "input_tokens", "input_tokens_cached", "input_tokens_cache_write", "input_tokens_cache_write_1h", "output_tokens", "output_tokens_reasoning",
  "cost_usd", "transcript_logged_cost_usd", "latency_ms", "success", "retry_count", "attempt_number", "price_basis",
];

function reduceTelemetry(path) {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => {
    const e = JSON.parse(l);
    const r = pick(e, TELEMETRY_KEYS);
    if (e.routing && typeof e.routing === "object") r.routing = pick(e.routing, ["policy_name", "policy_version", "rule_index"]);
    return JSON.stringify(r);
  }).join("\n") + "\n";
}

const LOG_LINE = /^(\S+:\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(\s+)([A-Z]+)(\s+)(\S+)(.*)$/;
const LIFECYCLE = new Set(["run.start", "run.end", "gate.open", "gate.resolved"]);
const LIFECYCLE_FIELDS = ["run_id", "mode", "intent", "gate", "title", "response", "outcome", "reason"];
const FIELD = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;

/** Every log line keeps its time, level and event; a lifecycle line also keeps the fields the rules and the collector read. */
function reduceLog(path) {
  const out = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = LOG_LINE.exec(line);
    if (!m) continue;
    const [, prefix = "", ts, s1, level, s2, event, rest] = m;
    let fields = "";
    if (LIFECYCLE.has(event)) {
      fields = [...rest.matchAll(FIELD)].filter((f) => LIFECYCLE_FIELDS.includes(f[1])).map((f) => ` ${f[1]}=${f[2]}`).join("");
    }
    out.push(`${prefix}${ts}${s1}${level}${s2}${event}${fields}`);
  }
  return out.join("\n") + "\n";
}

function walkHelpers(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^agent-[A-Za-z0-9]+\.(jsonl|meta\.json)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function build() {
  const { run, history, session, out } = args;
  if (!run || !history || !session || !out) throw new Error("usage: build.mjs --run <run folder> --history <projects/<hash>> --session <session id> --out <fixture folder>");
  const runOut = join(out, "run");
  const tOut = join(out, "transcripts");
  rmSync(runOut, { recursive: true, force: true });
  rmSync(tOut, { recursive: true, force: true });
  mkdirSync(runOut, { recursive: true });
  writeFileSync(join(runOut, "manifest.json"), readFileSync(join(run, "manifest.json")));
  writeFileSync(join(runOut, "telemetry.jsonl"), reduceTelemetry(join(run, "telemetry.jsonl")));
  writeFileSync(join(runOut, "orchestrator.log"), reduceLog(join(run, "orchestrator.log")));
  const report = [];
  const main = join(history, `${session}.jsonl`);
  const files = [main, ...walkHelpers(join(history, session, "subagents"))];
  for (const f of files) {
    const rel = relative(history, f);
    const dest = join(tOut, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    if (f.endsWith(".meta.json")) {
      const meta = JSON.parse(readFileSync(f, "utf-8"));
      writeFileSync(dest, JSON.stringify(pick(meta, ["agentType", "toolUseId", "parentAgentId", "spawnDepth"])) + "\n");
      continue;
    }
    const { text, kept } = reduceHistory(f);
    writeFileSync(dest, text);
    report.push(`${rel}: ${statSync(f).size} -> ${Buffer.byteLength(text)} bytes, ${kept.lines} lines kept, ${kept.dropped_without_timestamp} without a timestamp left out`);
  }
  console.log(report.join("\n"));
}

/** What a collector writes for the fixture, run the way the tests run it: the "before" record of R11. */
function before() {
  const fixture = args.before;
  const collector = args.collector;
  if (!fixture || !collector) throw new Error("usage: build.mjs --before <fixture folder> --collector <collect-orchestrator-usage.mjs> [--policy-path <file>]");
  const manifest = JSON.parse(readFileSync(join(fixture, "run", "manifest.json"), "utf-8"));
  const runId = manifest.run_id ?? manifest.pass;
  const root = mkdtempSync(join(tmpdir(), "run-time-split-before-"));
  try {
    const passDir = join(root, ".sdlc", "runs", runId);
    cpSync(join(fixture, "run"), passDir, { recursive: true });
    cpSync(join(fixture, "transcripts"), join(root, "transcripts"), { recursive: true });
    const extra = args["policy-path"] ? ["--policy-path", args["policy-path"]] : [];
    const r = spawnSync(process.execPath, [collector, passDir, "--project-root", root, "--transcripts-dir", join(root, "transcripts"), ...extra], {
      encoding: "utf-8", env: { ...process.env, MMO_SELECT: "" },
    });
    if (r.status !== 0) throw new Error(`collector exit ${r.status}: ${r.stderr}`);
    const dest = join(fixture, "before-time-split");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "manifest.json"), readFileSync(join(passDir, "manifest.json")));
    writeFileSync(join(dest, "telemetry.jsonl"), readFileSync(join(passDir, "telemetry.jsonl")));
    console.log(`${basename(fixture)}: before-time-split written from ${collector}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (args.before) before();
else build();
