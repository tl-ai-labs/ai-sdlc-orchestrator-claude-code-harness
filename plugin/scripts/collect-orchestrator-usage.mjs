#!/usr/bin/env node
/**
 * collect-orchestrator-usage — reconstruct the run's OWN cost from session
 * transcripts and record it beside (never inside) the dispatched-work totals.
 *
 * The problem this closes: the orchestrator runs as a Claude Code session;
 * its own loop — reasoning, Read/Glob/Bash tool calls, re-sending the growing
 * conversation every turn — never passes through the MCP dispatch server, so
 * it is invisible to telemetry in BOTH auth modes. On real measured runs the
 * plugin reported $1.87 while the session transcripts summed to ≈$236: a
 * ~100× undercount, large enough to INVERT architecture comparisons drawn
 * from dispatched-only numbers. This tool sums the transcripts post-run and
 * appends one `tier: "orchestrator"` event to the run's telemetry, then
 * patches the manifest with an `orchestrator_overhead` block and a
 * `true_total_cost_usd` — leaving `total_cost_usd` dispatched-only, so the
 * two spends are never blended silently.
 *
 * Method, and the facts it rests on (verified against a real 52,985-line
 * session transcript before this tool was written):
 *
 *   1. WHERE: transcripts live in ~/.claude/projects/<hash>/*.jsonl where
 *      <hash> is the absolute project path with `/` and whitespace replaced
 *      by `-`; each session may also have <hash>/<sessionId>/subagents/*.jsonl.
 *      Driver subagents run in-session, so their transcripts count too — all
 *      in-session work is driver-tier work by construction (the plugin ships
 *      only the five driver agents).
 *   2. WHAT: every `"type": "assistant"` line carries `message.usage` with
 *      `input_tokens`, `cache_read_input_tokens`,
 *      `cache_creation_input_tokens`, `output_tokens` — and `message.model`.
 *   3. DEDUPE — the critical one: one API message is written as SEVERAL
 *      JSONL lines (one per content block), each repeating the same
 *      `message.id`. On the reference transcript 5,218 of 7,203 message ids
 *      appeared more than once — naive per-line summing roughly DOUBLES the
 *      cost, so each id is counted once. The usage on those lines is identical
 *      for input, cache_read and cache_write, but NOT for `output_tokens`:
 *      that is a partial snapshot, complete only on the message's terminal
 *      line — the one carrying `stop_reason`. Keeping the first line's value
 *      books a couple of tokens where the true figure is hundreds (measured
 *      2.85x low on a real run), so the terminal line's value is booked
 *      instead. A message with no terminal line (truncated, or still
 *      streaming) falls back to the largest value seen, which is a lower
 *      bound rather than a guess.
 *   4. EXCLUDE: `message.model === "<synthetic>"` lines are error
 *      placeholders fabricated by the CLI, not billed API traffic.
 *   5. WINDOW ANCHOR: run_id is NOT present in transcript metadata (checked
 *      empirically). The window OPENS at the driver's own `run.start` line
 *      in `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` (the
 *      orchestrator prompt writes it through mmo-log.mjs before any packet
 *      is dispatched; the LAST such line at or before the manifest's
 *      `started_at` is used, so a reused run id never reaches back into an
 *      earlier run's messages) and CLOSES at the manifest's `ended_at`,
 *      ± 5 minutes slack, applied per-message via each line's `timestamp`.
 *      The manifest's `started_at` is the FIRST DISPATCHED event, not the
 *      driver's start: opening the window there dropped every driver message
 *      before the first dispatch — measured on a real run (v37-agsdk-1,
 *      2026-09-05) as 7 messages and 22% of the driver's spend, $1.61 priced
 *      against a $2.12 receipt, which the receipt check then refused. A run
 *      log without a usable `run.start` line (a run older than that logging,
 *      a copied pass directory) falls back to `started_at` and says so on the
 *      window line. File-level pruning uses mtime with a LOWER
 *      bound only (mtime < window start − slack ⇒ the file's last write
 *      predates the run and it cannot contain run messages). There is
 *      deliberately NO mtime upper bound — a session that keeps going after
 *      the run would push mtime past the window and silently drop the run's
 *      own messages. This diverges from report.mjs's artifacts listing,
 *      which bounds mtime on both ends for a different purpose.
 *   6. PRICE: at one model's rate — the policy's DERIVED DRIVER MODEL (same
 *      derivation the run-start driver-model check uses), else the model the
 *      session demonstrably ran if the policy prices it anywhere, else the
 *      receipt's own dollars (item 8), else the policy's in-session seat.
 *      Cache writes dominate real driver-loop cost and bill above the fresh
 *      rate by TTL tier: `usage.cache_creation.ephemeral_5m_input_tokens` at
 *      input × 1.25 (or the policy's explicit `pricing.input_cache_write`),
 *      `ephemeral_1h_input_tokens` at input × 2 (or `input_cache_write_1h`).
 *      Long sessions use the 1-hour tier exclusively; pricing every write at
 *      1.25× measured 6% low against the CLI's own receipt. A transcript
 *      without the split books its writes as 5-minute, as before. Observed
 *      per-model message counts are printed and a WARNING is raised when any
 *      observed model differs from the model the run is priced at.
 *   7. IDEMPOTENT: re-running replaces the prior orchestrator event for
 *      this pass (telemetry.jsonl is rewritten atomically without any
 *      `tier: "orchestrator"` lines, then the fresh event is appended) and
 *      re-patches the manifest. Run it as many times as you like.
 *   8. RECEIPT — the referee, when the run kept one: Claude Code's own
 *      end-of-session result (`claude -p --output-format json`, a runner's
 *      `claude-session.json`, or the last "result" line of a stream-json
 *      `live-run.log`; `--receipt <file>` overrides discovery and must
 *      exist). Its `modelUsage[model].costUSD` is what Anthropic's price
 *      table multiplied. The receipt is the FLOOR, not the target: the CLI
 *      accounts per invocation, so a session file can hold messages it never
 *      billed (measured: exactly the first 8 messages of a real run, a
 *      preamble) and those are inside the run's own window. A transcript
 *      priced AT OR ABOVE the receipt is written, with the receipt recorded
 *      beside it. A transcript more than --receipt-tolerance (5%) BELOW it
 *      is refused with exit 3 and nothing written: the receipt cannot
 *      over-report, so the tree is missing billed messages. With a receipt
 *      but no transcript lines in the window, the receipt's dollars are used
 *      verbatim ("receipt-only"). When the receipt names a session id and a
 *      file carries it, the scan is pinned to that session with no upper
 *      time bound — the invocation the receipt bills keeps running after
 *      `ended_at`. Both numbers are always printed. At run-end a headless
 *      live-run.log has no result line yet (the CLI writes it on exit): the
 *      figure is written transcript-priced and marked unverified, and a
 *      re-run after the session exits verifies it. Re-running is idempotent.
 *   9. IN-SESSION DISPATCH: packets the session executed itself (provenance
 *      `estimated` or `apportioned_from_measured_total`), and a `claude-cli`
 *      worker whose own `claude -p` session was swept into a transcript-priced
 *      scan, are already inside the overhead. Their dispatched dollars are
 *      subtracted once: true_total = dispatched − in-session + overhead. The
 *      subtraction is bounded by dispatched minus the out-of-session events
 *      (real vendor calls, never rewritten by any repair), restricted to
 *      models the manifest's `totals.models_used` names, classified by the
 *      event's `model_id` when present, and never applied to a claude-cli
 *      worker whose session was not scanned (receipt-priced figures, or a
 *      scan pinned to the driver's session). Measured +21% over the receipt
 *      without it.
 *
 *
 * Usage:
 *   node collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>]
 *        [--policy <name>] [--policy-path <file>]
 *        [--transcripts-dir <dir>] [--receipt <file>] [--receipt-tolerance <0..1>] [--dry-run]
 *
 *   <pass-dir>          the run's output dir (holds manifest.json +
 *                       telemetry.jsonl), e.g. examples/<study>/passes/<run>
 *   --project-root      the repo the run was launched from. Defaults to the
 *                       current directory. This determines the transcript
 *                       location hash, so it must be the directory `claude`
 *                       ran in.
 *   --policy            policy name to price with. Defaults to the manifest's
 *                       `policy` (or `policy_name`) — the policy the run
 *                       actually used.
 *   --policy-path       explicit policy file; beats --policy and the
 *                       repo-local override, mirroring the server's loader.
 *   --transcripts-dir   read transcripts from this directory instead of
 *                       ~/.claude/projects/<hash> (tests; or a transcript
 *                       tree copied from another machine).
 *   --receipt           Claude Code's own end-of-session result for the driver
 *                       session: a `claude -p --output-format json` object, a
 *                       runner's `claude-session.json`, or a stream-json
 *                       capture (`--output-format stream-json > live-run.log`,
 *                       the headless recipe) whose last "result" line is read.
 *                       Defaults to <pass-dir>/claude-session.json, then
 *                       <pass-dir>/live-run.log, whichever exists.
 *   --receipt-tolerance fraction the transcript-priced overhead may differ
 *                       from the receipt before this tool refuses (0.05).
 *   --dry-run           print everything, write nothing.
 *
 * Exit codes: 0 = event written (or --dry-run). 1 = bad arguments, missing
 * manifest, or no billable assistant messages found in the run window (the
 * run WAS driven by a session, so an empty window means the wrong
 * project-root/transcripts-dir — nothing is written). 3 = the transcript
 * sum and the receipt disagree beyond tolerance — nothing is written.
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveDriverModel, IN_SESSION_ADAPTERS } from "./driver-model-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/** Same slack the report's artifacts window uses; applied per-message. */
const WINDOW_SLACK_MS = 5 * 60_000;

/**
 * One run-lifecycle log line, as plugin/scripts/lib/log.mjs renders it:
 * `MMO: <ISO timestamp> <LEVEL>  run.start run_id=... mode=...`. The prefix
 * is configurable (MMO_LOG_PREFIX, possibly empty), so it is optional here;
 * the timestamp and the event name are what anchor the window.
 */
const RUN_START_LINE = /^(?:\S+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+[A-Z]+\s+run\.start(?:\s|$)/;

/**
 * The driver's own start, read from a run-lifecycle log (header, fact 5).
 * Returns { ms, iso } for the LAST `run.start` line stamped at or before
 * `notAfterMs` (the manifest's first dispatched event), or null when the
 * file is missing or holds no such line. "Last at or before" is deliberate:
 * mmo-log.mjs appends, so a reused run id carries the earlier run's
 * `run.start` in the same file, and the earlier one must not stretch this
 * run's window back over the earlier run's messages. A `run.start` AFTER
 * the first dispatch cannot belong to this run (clock skew, a stale copy)
 * and is ignored the same way.
 */
export function runStartFromLog(logPath, notAfterMs) {
  if (!logPath || !existsSync(logPath)) return null;
  let best = null;
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const m = RUN_START_LINE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (!Number.isFinite(ms) || ms > notAfterMs) continue;
    if (best == null || ms > best.ms) best = { ms, iso: m[1] };
  }
  return best;
}

// Runs write `policy`/`run_id`; `buildManifest`'s shape says `policy_name`/`pass`.
// Read both spellings — a manifest key the reader does not recognise otherwise
// resolves to undefined and reprices the whole run under a fallback preset.
export const manifestPolicyName = (manifest) => manifest.policy ?? manifest.policy_name;
export const manifestPassId = (manifest) => manifest.run_id ?? manifest.pass;

function parseArgs(argv) {
  const args = {
    passDir: undefined,
    projectRoot: undefined,
    policy: undefined,
    policyPath: undefined,
    transcriptsDir: undefined,
    receipt: undefined,
    receiptTolerance: 0.05,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--project-root" || a.startsWith("--project-root=")) args.projectRoot = eat("--project-root");
    else if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else if (a === "--transcripts-dir" || a.startsWith("--transcripts-dir=")) args.transcriptsDir = eat("--transcripts-dir");
    else if (a === "--receipt" || a.startsWith("--receipt=")) args.receipt = eat("--receipt");
    else if (a === "--receipt-tolerance" || a.startsWith("--receipt-tolerance=")) {
      const v = Number(eat("--receipt-tolerance"));
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("--receipt-tolerance must be a fraction between 0 and 1 (default 0.05)");
      args.receiptTolerance = v;
    }
    else if (a.startsWith("--")) throw new Error(`unknown argument '${a}'`);
    else if (args.passDir === undefined) args.passDir = a;
    else throw new Error(`unexpected extra positional '${a}' (pass dir already given: ${args.passDir})`);
  }
  if (!args.passDir) throw new Error("usage: collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>] [--policy <name>] [--policy-path <file>] [--transcripts-dir <dir>] [--receipt <file>] [--receipt-tolerance <0..1>] [--dry-run]");
  return args;
}

async function loadDist() {
  try {
    const policyMod = await import(pathToFileURL(join(DIST, "policy.js")).href);
    const routingMod = await import(pathToFileURL(join(DIST, "routing.js")).href);
    const pricingMod = await import(pathToFileURL(join(DIST, "pricing.js")).href);
    return { policyMod, routingMod, pricingMod };
  } catch (err) {
    throw new Error(
      `could not load the dispatch server's compiled modules from ${DIST} — the MCP ` +
        `server is not built. Fix: node "${join(HERE, "verify-setup.mjs")}" --fix ` +
        `--project-root "$(pwd)"  (original error: ${err.message})`
    );
  }
}

/** The CLI's transcript directory name for a project: path with / and whitespace → "-". */
export function transcriptsDirFor(projectRoot) {
  const hash = resolve(projectRoot).replace(/[\/\s]/g, "-");
  return join(homedir(), ".claude", "projects", hash);
}

/**
 * Every transcript file that COULD contain run-window messages: top-level
 * session *.jsonl plus each session's subagents/*.jsonl, pruned by the
 * mtime lower bound only (see header, fact 5).
 */
export function candidateTranscripts(dir, windowStartMs) {
  if (!existsSync(dir)) return [];
  const out = [];
  const fresh = (p) => {
    try { return statSync(p).mtimeMs >= windowStartMs - WINDOW_SLACK_MS; } catch { return false; }
  };
  // Subagent transcripts nest to varying depths under `subagents/` — a plain
  // delegation writes one level down, a workflow adds a directory per run below
  // that. Reading a single flat level found the shallow shape only and returned
  // nothing for the rest, which is most of the spend this collector exists to
  // measure. Walk instead, depth-bounded against a pathological tree.
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        if (fresh(p)) out.push(p);
      } else if (e.isDirectory()) {
        walk(p, depth + 1);
      }
    }
  };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (fresh(p)) out.push(p);
    } else if (entry.isDirectory()) {
      // `subagents/` sits either directly under the project directory or under
      // each session directory inside it.
      if (entry.name === "subagents") walk(p, 1);
      else {
        const sub = join(p, "subagents");
        if (existsSync(sub)) walk(sub, 1);
      }
    }
  }
  return out.sort();
}

/**
 * Sum billable usage across transcript files, deduped by message.id and
 * windowed per-message. Returns token buckets + scan stats + the observed
 * model → unique-message-count map.
 */
export function sumTranscriptUsage(files, windowStartMs, windowEndMs) {
  const seen = new Set();
  /** Per message id: the output figure booked, and whether it came from the
   *  terminal (stop_reason) line. See the streaming note below. */
  const outputById = new Map();
  const observedModels = {};
  // `input_cache_write` stays the TOTAL written (what the report and every
  // earlier consumer read); the two TTL buckets are the disjoint split used
  // for pricing. When a line carries no `cache_creation` split (older CLI),
  // its writes are booked as 5-minute — the same 1.25x they were always priced at.
  const tokens = { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_5m: 0, input_cache_write_1h: 0, output: 0 };
  const stats = { files: files.length, lines: 0, assistant: 0, counted: 0, duplicates: 0, synthetic: 0, outside_window: 0 };
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      stats.lines++;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== "assistant") continue;
      stats.assistant++;
      const msg = obj.message;
      const usage = msg?.usage;
      if (!usage) continue;
      if (msg.model === "<synthetic>") { stats.synthetic++; continue; }
      if (obj.timestamp) {
        const t = Date.parse(obj.timestamp);
        if (Number.isFinite(t) && (t < windowStartMs - WINDOW_SLACK_MS || t > windowEndMs + WINDOW_SLACK_MS)) {
          stats.outside_window++;
          continue;
        }
      }
      // Duplicate lines for one id repeat input/cache_read/cache_write, so
      // first-seen is correct for those. `output_tokens` is not: it is a
      // partial snapshot that is only complete on the message's terminal line,
      // the one carrying `stop_reason`. Book that line's value, so the figure
      // comes from the message's own end-of-stream marker rather than from
      // whichever line happened to be largest. Without a terminal line — a
      // truncated or still-streaming message — fall back to the maximum seen,
      // which is the best available lower bound.
      const out = usage.output_tokens ?? 0;
      const terminal = msg.stop_reason != null;
      if (msg.id) {
        const prev = outputById.get(msg.id);
        if (seen.has(msg.id)) {
          stats.duplicates++;
          // A terminal line always wins; otherwise only a larger value does,
          // and never over a value already taken from a terminal line.
          if (!prev?.terminal && (terminal || out > prev.out)) {
            tokens.output += out - prev.out;
            outputById.set(msg.id, { out, terminal });
          }
          continue;
        }
        seen.add(msg.id);
        outputById.set(msg.id, { out, terminal });
      }
      stats.counted++;
      const model = msg.model ?? "(unlabeled)";
      observedModels[model] = (observedModels[model] ?? 0) + 1;
      tokens.input += usage.input_tokens ?? 0;
      tokens.input_cached += usage.cache_read_input_tokens ?? 0;
      const cw = usage.cache_creation_input_tokens ?? 0;
      const split = usage.cache_creation;
      // The split is authoritative for the 1-hour count, the total for the
      // sum: 1h is capped at the total and 5m is the remainder, so a split that
      // disagrees with its total (never seen, never assumed) can neither book
      // a write twice nor price above what the CLI reported.
      const cw1h = Math.min(cw, split?.ephemeral_1h_input_tokens ?? 0);
      tokens.input_cache_write += cw;
      tokens.input_cache_write_1h += cw1h;
      tokens.input_cache_write_5m += cw - cw1h;
      tokens.output += out;
    }
  }
  return { tokens, stats, observedModels };
}

/**
 * Claude Code's own end-of-session receipt: the `result` object a
 * `claude -p --output-format json` run prints (or a runner's copy of it,
 * e.g. `claude-session.json`). Returns null when the file is absent.
 * `modelUsage[model].costUSD` is what the CLI's price table multiplied —
 * the top-level `usage` can be a per-turn snapshot, so dollars and per-model
 * tokens are read from modelUsage and `usage` only supplies the TTL split.
 */
export function readReceipt(path, { required = false } = {}) {
  if (!path) return null;
  if (!existsSync(path)) {
    if (required) throw new Error(`--receipt ${path} does not exist`);
    return null;
  }
  const text = readFileSync(path, "utf-8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not one JSON object — a `--output-format stream-json` capture (the
    // headless recipe's live-run.log). The CLI's final `result` event is the
    // receipt; take the LAST one, so a resumed/continued session reports its
    // final accounting.
    const results = text.split("\n").filter((l) => l.includes('"result"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.type === "result");
    if (results.length === 0) {
      // A stream capture with no result line is a session still running —
      // exactly what the run-end step sees, because the CLI prints the
      // result event only when the process exits. An auto-discovered one is
      // "not final yet"; an explicit --receipt that is not a receipt is an error.
      if (required) throw new Error(`receipt ${path} is neither a JSON object nor a stream-json capture with a "type":"result" line`);
      return { pending: true, path };
    }
    raw = results[results.length - 1];
  }
  const r = raw?.result && typeof raw.result === "object" && raw.result.modelUsage ? raw.result : raw;
  const mu = r.modelUsage ?? {};
  const models = {};
  for (const [name, v] of Object.entries(mu)) {
    models[name] = {
      input: v.inputTokens ?? v.input_tokens ?? 0,
      input_cached: v.cacheReadInputTokens ?? v.cache_read_input_tokens ?? 0,
      input_cache_write: v.cacheCreationInputTokens ?? v.cache_creation_input_tokens ?? 0,
      output: v.outputTokens ?? v.output_tokens ?? 0,
      cost_usd: v.costUSD ?? v.cost_usd ?? null,
    };
  }
  const modelCost = Object.values(models).reduce((a, m) => a + (m.cost_usd ?? 0), 0);
  const total = typeof r.total_cost_usd === "number" ? r.total_cost_usd : (modelCost || null);
  if (total == null) throw new Error(`receipt ${path} carries neither total_cost_usd nor modelUsage[*].costUSD`);
  if (!(total > 0)) throw new Error(`receipt ${path} reports $${total} — a zero or negative receipt cannot referee anything`);
  const cc = r.usage?.cache_creation ?? {};
  return {
    path,
    session_id: r.session_id ?? null,
    total_cost_usd: total,
    models,
    cache_write_1h: cc.ephemeral_1h_input_tokens ?? null,
    cache_write_5m: cc.ephemeral_5m_input_tokens ?? null,
  };
}

/**
 * Dispatched telemetry that ran INSIDE the driver session — and is therefore
 * already inside the transcript-measured overhead. Adding it again on top of
 * the overhead double-counts it (measured +21% on a real run). Two shapes:
 *   - provenance `estimated` / `apportioned_from_measured_total`: the packet
 *     was executed by the session itself (an in-session subagent, or a slice
 *     of the session's own measured total handed back as per-packet events);
 *   - a `claude-cli` worker: it spawns its own `claude -p` session under the
 *     same project, whose transcript the scan above also sums.
 * `vendor` events on any other adapter are real API calls made by the
 * dispatch server outside the session: they are NOT in the transcript and
 * must stay in the total.
 */
export function inSessionDispatched(events, policy, manifest, dispatched, { claudeCliScanned = true } = {}) {
  const models = policy?.models ?? [];
  const adapterById = new Map(models.map((m) => [m.id, m.adapter]));
  const adaptersByName = new Map();
  for (const m of models) adaptersByName.set(m.model_name, [...(adaptersByName.get(m.model_name) ?? []), m.adapter]);
  // A claude-cli worker is inside the overhead only when its own `claude -p`
  // session was actually summed into it — i.e. the scan was not restricted to
  // the driver's session and the figure is transcript-priced. Classify by
  // the event's model_id when it carries one; by model_name only when every
  // policy entry of that name is a claude-cli seat (an API-call event on a
  // model that is ALSO listed as a claude-cli seat must stay in the total).
  const viaClaudeCli = (ev) => {
    if (!claudeCliScanned) return false;
    if (ev.model_id != null && adapterById.has(ev.model_id)) return adapterById.get(ev.model_id) === "claude-cli";
    const adapters = adaptersByName.get(ev.model) ?? [];
    return adapters.length > 0 && adapters.every((a) => a === "claude-cli");
  };
  const isInside = (ev) =>
    ev.provenance === "estimated" ||
    ev.provenance === "apportioned_from_measured_total" ||
    viaClaudeCli(ev);
  const work = events.filter((ev) => ev && ev.tier !== "orchestrator");
  const allCost = work.reduce((a, ev) => a + (ev.cost_usd ?? 0), 0);
  // Only events whose model the manifest's dispatched figure actually
  // contains can be inside it: a repair that later ADDED apportioned driver
  // events to the telemetry did not change what buildManifest summed.
  const modelsUsed = Array.isArray(manifest?.totals?.models_used) ? new Set(manifest.totals.models_used) : null;
  const inside = work.filter((ev) => isInside(ev) && (!modelsUsed || modelsUsed.has(ev.model)));
  const insideSum = inside.reduce((a, ev) => a + (ev.cost_usd ?? 0), 0);
  const outsideSum = work.filter((ev) => !inside.includes(ev)).reduce((a, ev) => a + (ev.cost_usd ?? 0), 0);
  const notes = [];
  // buildManifest summed these same events into `dispatched`. The in-session
  // share can never exceed what is left of the dispatched figure after the
  // out-of-session events — real vendor calls, never rewritten by any repair
  // — are taken out. When the telemetry still sums to the manifest this is
  // exactly the in-session events' own sum; when it was rewritten after the
  // run (a repair apportioning a measured total, say) the bound is what
  // remains, and the difference is said aloud. Never below zero, never more
  // than dispatched.
  const consistent = Math.abs(allCost - dispatched) <= Math.max(0.01, 0.01 * dispatched);
  const bound = Math.max(0, Math.min(dispatched, dispatched - outsideSum));
  const cost = Math.min(insideSum, bound);
  if (!consistent && inside.length > 0 && Math.abs(cost - insideSum) > 0.000001) {
    notes.push(
      `telemetry events sum to $${allCost.toFixed(6)} but the manifest's dispatched figure is $${dispatched} — the ` +
        `telemetry was rewritten after the run. In-session events sum to $${insideSum.toFixed(6)}; only $${cost.toFixed(6)} ` +
        `(dispatched minus the out-of-session events) can be inside the dispatched figure, so that is what is subtracted.`
    );
  }
  return { cost, count: inside.length, allCost, consistent, notes };
}

function readTelemetry(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Restrict a transcript scan to one session when the receipt names it. */
export function filesForSession(files, sessionId) {
  if (!sessionId) return files;
  const mine = files.filter((f) => {
    const base = f.split("/").pop();
    return base.startsWith(sessionId) || f.includes(`/${sessionId}/`);
  });
  // A copied tree (tests, another machine) may not carry the session id in
  // its file names; scanning nothing would be worse than scanning everything.
  return mine.length > 0 ? mine : files;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const passDir = resolve(args.passDir);
  const manifestPath = join(passDir, "manifest.json");
  const telemetryPath = join(passDir, "telemetry.jsonl");
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json in ${passDir} — is this a run's pass directory?`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const firstDispatchMs = Date.parse(manifest.started_at);
  const windowEndMs = Date.parse(manifest.ended_at);
  if (!Number.isFinite(firstDispatchMs) || !Number.isFinite(windowEndMs)) {
    throw new Error(`manifest.json has no parseable started_at/ended_at — cannot anchor the run window`);
  }
  const projectRoot = resolve(args.projectRoot ?? process.cwd());

  // The window OPENS at the driver's own `run.start`, not at the manifest's
  // `started_at` (header, fact 5). `started_at` is the first DISPATCHED event;
  // the driver's setup work before it — preflight, reading the brief, the
  // requirements phase up to its first packet — is billed to the same session
  // and was silently dropped when the window opened at the dispatch: 22% of
  // the driver's spend on a real run, and a receipt check that failed for
  // it. The prompt logs `run.start` with `--run-id --project-root`, so the
  // file is `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` in both
  // modes; brownfield's output directory IS that directory, so the pass
  // directory's own log is the second place to look. No line → `started_at`,
  // and the window line below says which anchor was used.
  const runLogCandidates = [
    join(projectRoot, ".sdlc", "runs", String(manifestPassId(manifest)), "orchestrator.log"),
    join(passDir, "orchestrator.log"),
  ];
  let runStart = null;
  for (const p of runLogCandidates) {
    const found = runStartFromLog(p, firstDispatchMs);
    if (found) { runStart = { ...found, path: p }; break; }
  }
  const windowStartMs = runStart ? runStart.ms : firstDispatchMs;
  const windowStartLabel = runStart
    ? `${runStart.iso} (run.start in ${runStart.path})`
    : `${manifest.started_at} (manifest started_at = first dispatched event; no run.start line in ${runLogCandidates[0]})`;

  const { policyMod, routingMod, pricingMod } = await loadDist();
  // Default to the policy the run recorded — pricing overhead under any
  // other policy would attribute dollars the run never saw.
  const policy = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: args.policy ?? manifestPolicyName(manifest), projectRoot });
  const overrides = routingMod.parseSelectOverrides(process.env.MMO_SELECT);

  // Claude Code's own accounting for the driver session, when a runner kept
  // it (a `claude -p --output-format json` result, or `claude-session.json`
  // beside the manifest). It is the referee: transcript arithmetic that
  // disagrees with it beyond tolerance is wrong, and is not written.
  // Discovery order: --receipt, then the runner convention (claude-session.json),
  // then the headless recipe's stream capture (live-run.log, whose last line is
  // the CLI's result event). The first that exists wins.
  const receiptCandidates = args.receipt
    ? [resolve(args.receipt)]
    : [join(passDir, "claude-session.json"), join(passDir, "live-run.log")];
  const receiptPath = receiptCandidates.find((c) => existsSync(c)) ?? receiptCandidates[0];
  let receipt = readReceipt(receiptPath, { required: Boolean(args.receipt) });
  let receiptPending = false;
  if (receipt?.pending) {
    receiptPending = true;
    receipt = null;
    console.error(
      `NOTE: ${receiptPath} has no "result" line yet — the session that writes it is still running (the CLI ` +
        `prints its receipt when the process exits). The figure below is transcript-priced and UNVERIFIED. ` +
        `Re-run this collector once the session has exited to verify it against the receipt; re-running is safe.`
    );
  }

  // The declared window runs to ended_at + slack, which is in the future when
  // the run-end step invokes this. Reading it as-is silently reports a partial
  // measurement as a complete one, so clamp to now and say how much of the
  // window was unobservable.
  const collectedAtMs = Date.now();
  const unobservableMs = Math.max(0, windowEndMs + WINDOW_SLACK_MS - collectedAtMs);
  const effectiveEndMs = Math.min(windowEndMs, collectedAtMs - WINDOW_SLACK_MS);

  const tDir = args.transcriptsDir ? resolve(args.transcriptsDir) : transcriptsDirFor(projectRoot);
  const candidates = candidateTranscripts(tDir, windowStartMs);
  const files = filesForSession(candidates, receipt?.session_id);
  const sessionScoped = Boolean(receipt?.session_id) && files.some((f) => f.split("/").pop().startsWith(receipt.session_id) || f.includes(`/${receipt.session_id}/`));
  // When the scan is pinned to the receipt's own session, every message in
  // those files belongs to the invocation the receipt bills — including the
  // ones after `ended_at` (the session keeps going: writes the summary, runs
  // this collector). Bounding them would make a complete transcript look
  // short of its receipt. The lower bound stays (opened at run.start, see
  // above): a resumed session id can carry an earlier run.
  const { tokens, stats, observedModels } = sumTranscriptUsage(files, windowStartMs, sessionScoped ? Number.POSITIVE_INFINITY : effectiveEndMs);

  console.log(`collect-orchestrator-usage: pass '${manifestPassId(manifest)}' window ${windowStartLabel} → ${manifest.ended_at} (±5m)`);
  if (runStart && firstDispatchMs - runStart.ms > 60 * 60_000) {
    // Not an error — a gate left open before the first dispatch does this —
    // but a stale log under a reused run id looks the same, so say it.
    console.error(
      `NOTE: run.start is ${Math.round((firstDispatchMs - runStart.ms) / 60_000)} minutes before the first dispatched ` +
        `event. The window opens at run.start; if this run reused an earlier run's id, check ${runStart.path} ` +
        `holds this run's own run.start line (the receipt cross-check below is the referee).`
    );
  }
  console.log(`transcripts: ${tDir}${sessionScoped ? ` (scan pinned to session ${receipt.session_id}; no upper time bound)` : ""}`);
  console.log(
    `scanned ${stats.files} file(s), ${stats.lines} line(s): counted ${stats.counted} unique API message(s) ` +
      `(${stats.duplicates} duplicate content-block line(s) skipped, ${stats.synthetic} synthetic, ${stats.outside_window} outside window)`
  );
  console.log(`observed_models ${JSON.stringify(observedModels)}`);
  if (receipt) {
    const perModel = Object.fromEntries(Object.entries(receipt.models).map(([k, v]) => [k, v.cost_usd]));
    console.log(`receipt: ${receipt.path} → $${receipt.total_cost_usd} ${JSON.stringify(perModel)}`);
  }
  if (unobservableMs > 0) {
    console.error(
      `NOTE: the declared window extends ${Math.round(unobservableMs / 1000)}s past this ` +
        `collection. Messages written after now cannot be counted, so this figure is a ` +
        `lower bound. Re-run after the window closes for the complete measurement.`
    );
  }

  const receiptOnly = stats.counted === 0 && receipt != null;
  if (stats.counted === 0 && !receipt) {
    console.error(
      `collect-orchestrator-usage FAILED: no billable assistant messages found in the run window. ` +
        `The run was driven by a session, so this almost always means the wrong --project-root ` +
        `(transcript location is derived from it) or a transcript tree that lives elsewhere ` +
        `(--transcripts-dir). Nothing was written.`
    );
    return 1;
  }

  // ── Which model's rate prices the overhead ──────────────────────────────
  // 1. the policy's derived driver model (the normal case);
  // 2. the policy's in-session model when the judgment tier is not in-session;
  // 3. the one model the session actually ran, if the policy prices it in
  //    any tier (a Gemini-only policy still drove an Opus session);
  // 4. the receipt alone, when the policy prices no Claude model at all.
  // The session runs on Claude Code whatever the policy routes, so refusing
  // to price it would leave the worst-affected route uncounted — the exact
  // shape of the $1.87-vs-$236 report this tool exists to end.
  const observedNames = Object.keys(observedModels).filter((m) => m !== "(unlabeled)");
  const receiptNames = receipt ? Object.keys(receipt.models) : [];
  const single = observedNames.length === 1 ? observedNames[0] : receiptNames.length === 1 ? receiptNames[0] : null;
  let derived;
  let driver;
  let pricingBasis = "the policy's derived driver model";
  try {
    derived = deriveDriverModel(policy, routingMod, overrides);
    driver = policy.models.find((m) => m.id === derived.modelId);
  } catch (err) {
    // Ordered by evidence: the model the session demonstrably ran, priced by
    // the policy if it prices that model anywhere (a claude-cli entry is a
    // worker seat, so it is the last choice for a driver rate); else the
    // receipt's own dollars; else the policy's in-session driver seat.
    const byName = single ? policy.models.filter((m) => m.model_name === single && m.pricing) : [];
    const priced = byName.find((m) => m.adapter !== "claude-cli") ?? byName[0];
    const inSession = policy.models.find((m) => m.adapter === "builtin-anthropic" && m.pricing);
    if (priced) {
      derived = { modelName: priced.model_name, modelId: priced.id };
      driver = priced;
      pricingBasis = `the session's observed model '${single}' (priced by the policy's '${priced.id}' entry)`;
    } else if (receipt) {
      const dominant = Object.entries(receipt.models).sort((a, b) => (b[1].cost_usd ?? 0) - (a[1].cost_usd ?? 0))[0];
      derived = { modelName: dominant ? dominant[0] : "(receipt)", modelId: null };
      driver = null;
      pricingBasis = `the receipt (policy '${policy.name}' prices no Claude model; receipt bills ${receiptNames.length ? receiptNames.join(" + ") : "an unnamed model"})`;
    } else if (inSession) {
      derived = { modelName: inSession.model_name, modelId: inSession.id };
      driver = inSession;
      pricingBasis = "the policy's in-session model (judgment tier is not in-session)";
    } else {
      console.error(
        `collect-orchestrator-usage FAILED: ${err.message}\n` +
          `The session ran ${JSON.stringify(observedNames)} but this policy prices none of it, and no receipt exists at ` +
          `${receiptPath}. Pass --policy-path <a policy that prices the session model> or --receipt <the run's claude -p ` +
          `result json / live-run.log>. Nothing was written.`
      );
      return 1;
    }
    console.error(`NOTE: ${err.message}\nPricing the orchestrator's own overhead at ${pricingBasis} instead — the session runs on Claude Code regardless of where the policy routes the judgment tier.`);
  }

  if (receipt && driver && receiptNames.length > 0 && !receiptNames.includes(derived.modelName)) {
    console.error(
      `WARNING: the receipt bills ${JSON.stringify(receiptNames)} but the overhead is priced at the policy's ` +
        `'${derived.modelName}' rate. The cross-check below compares dollars, so a rate for the wrong model shows ` +
        `up as a gap; if it does, pass --policy-path for a policy that prices the model the receipt names.`
    );
  }
  const mismatched = observedNames.filter((m) => m !== derived.modelName);
  if (driver && mismatched.length > 0) {
    console.error(
      `WARNING: transcript messages ran on ${JSON.stringify(mismatched)} but the overhead is priced ` +
        `at '${derived.modelName}' — the dollars below assume a single rate. ` +
        `If the mismatch is the driver itself, the run-start driver-model check should have caught it.`
    );
  }

  // ── Price the transcript (5-minute and 1-hour cache writes at their own rates) ──
  const priceTokens = {
    input: tokens.input,
    input_cached: tokens.input_cached,
    output: tokens.output,
    input_cache_write: tokens.input_cache_write_5m,
    input_cache_write_1h: tokens.input_cache_write_1h,
  };
  const transcriptCost = driver ? pricingMod.computeCostUsd(priceTokens, driver.pricing) : null;

  // ── Cross-check against the receipt ─────────────────────────────────────
  let cost;
  let costSource;
  if (receiptOnly) {
    // No transcript reachable, but the CLI's own accounting is. Its dollars
    // are authoritative; only attribution is lost, and that is said.
    const rm = Object.values(receipt.models);
    tokens.input = rm.reduce((a, m) => a + m.input, 0);
    tokens.input_cached = rm.reduce((a, m) => a + m.input_cached, 0);
    tokens.input_cache_write = rm.reduce((a, m) => a + m.input_cache_write, 0);
    tokens.input_cache_write_1h = receipt.cache_write_1h ?? 0;
    tokens.input_cache_write_5m = Math.max(0, tokens.input_cache_write - tokens.input_cache_write_1h);
    tokens.output = rm.reduce((a, m) => a + m.output, 0);
    cost = pricingMod.round6(receipt.total_cost_usd);
    costSource = "receipt-only";
    // Label the figure with what the receipt says ran, not what the policy
    // would have priced: the two differ exactly when the policy was not the
    // driver (an Opus 4.8 session under a Gemini-worker policy, say).
    const dominant = Object.entries(receipt.models).sort((a, b) => (b[1].cost_usd ?? 0) - (a[1].cost_usd ?? 0))[0];
    if (dominant) {
      derived = { modelName: dominant[0], modelId: null };
      pricingBasis = `the receipt (${Object.keys(receipt.models).join(" + ")})`;
    }
    console.error(
      `NOTE: no transcript lines fell in the window (${tDir}), but the receipt ${receipt.path} ` +
        `carries the session's own accounting — its $${cost} is used verbatim. Attribution to ` +
        `phases is not possible without the transcript.`
    );
  } else if (receipt && transcriptCost == null) {
    // The policy prices no Claude model, so the transcript cannot be priced
    // for a cross-check; the receipt's own dollars are the only figure and
    // are used verbatim. The transcript still supplies the token attribution.
    cost = pricingMod.round6(receipt.total_cost_usd);
    costSource = "receipt (no policy rate to cross-check against)";
  } else if (receipt) {
    // The receipt is the FLOOR, not the target. Claude Code accounts per
    // invocation, so a session file can hold messages the receipt never
    // billed (a preamble before the run, another invocation on the same
    // session id — measured: exactly the first 8 messages of a real run,
    // zero residual) and the window includes them by the run's own
    // definition. A transcript ABOVE the receipt is therefore complete and
    // is written — this tool never under-reports. A transcript BELOW it is
    // missing data (a subagent file not in the tree, a wrong window) and is
    // refused: that is the silent failure this check exists to catch.
    const delta = (transcriptCost - receipt.total_cost_usd) / receipt.total_cost_usd;
    const pct = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
    const rm = Object.values(receipt.models).reduce(
      (a, m) => ({ input: a.input + m.input, input_cached: a.input_cached + m.input_cached, input_cache_write: a.input_cache_write + m.input_cache_write, output: a.output + m.output }),
      { input: 0, input_cached: 0, input_cache_write: 0, output: 0 }
    );
    let implied = "";
    if (driver && rm.input_cache_write > 0) {
      const pr = driver.pricing;
      const nonWrite = (rm.input * pr.input + rm.input_cached * pr.input_cached + rm.output * pr.output) / 1_000_000;
      const rate = ((receipt.total_cost_usd - nonWrite) / rm.input_cache_write) * 1_000_000;
      implied = `; receipt implies a cache-write rate of $${rate.toFixed(2)}/M (5-minute card $${(pr.input * 1.25).toFixed(2)}, 1-hour $${(pr.input * 2).toFixed(2)})`;
    }
    console.log(
      `receipt cross-check: transcript $${transcriptCost} vs receipt $${receipt.total_cost_usd} → ${pct} ` +
        `(fails below −${(args.receiptTolerance * 100).toFixed(0)}%)${implied}`
    );
    console.log(
      `  tokens transcript in ${tokens.input} · cached ${tokens.input_cached} · cache_write ${tokens.input_cache_write} · out ${tokens.output}` +
        ` | receipt in ${rm.input} · cached ${rm.input_cached} · cache_write ${rm.input_cache_write} · out ${rm.output}`
    );
    if (delta < -(args.receiptTolerance + 1e-9)) {
      console.error(
        `collect-orchestrator-usage FAILED: the transcript-priced overhead ($${transcriptCost}) is ${pct} BELOW the CLI's own ` +
          `receipt ($${receipt.total_cost_usd}), past the ${(args.receiptTolerance * 100).toFixed(0)}% tolerance. The receipt cannot ` +
          `over-report, so the transcript tree is missing billed messages — usually a subagent transcript not copied ` +
          `alongside the session file, a run log with no run.start line (the window then opens at the first dispatch, ` +
          `after the driver's setup work), or (when the scan is not pinned to the receipt's ` +
          `session) the session continuing past ended_at + 5m. Nothing was written. Fix the input; do not widen ` +
          `--receipt-tolerance to pass.`
      );
      return 3;
    }
    cost = transcriptCost;
    if (delta > args.receiptTolerance) {
      costSource = `transcript (${pct} over the receipt; the receipt is the floor)`;
      console.error(
        `NOTE: the transcript is ${pct} over the receipt: the window holds messages the receipt did not bill — a ` +
          `preamble before the run, or another invocation on the same session id. The transcript figure is written ` +
          `because those messages are inside the run's own window; the receipt is the floor, not the target.`
      );
    } else {
      costSource = `transcript (receipt-verified, ${pct})`;
    }
  } else {
    cost = transcriptCost;
    costSource = "transcript";
    if (!receiptPending) {
      console.error(
        `NOTE: no receipt at ${receiptPath} — dollars are transcript-priced at ${pricingBasis} and UNVERIFIED. ` +
          `Keep the run's \`claude -p --output-format json\` result (or the headless live-run.log; or pass --receipt) ` +
          `and this tool will verify itself against it.`
      );
    }
  }

  // ── Dispatched total, minus what already sits inside the transcript ─────
  // buildManifest writes the dispatched figure as totals.dispatched_cost_usd;
  // total_cost_usd is only present on a manifest this collector has already
  // patched. Reading the latter alone meant a first run defaulted it to 0 and
  // reported overhead as if it were the whole cost — a silent under-report of
  // the entire mechanical tier, which is the failure this script exists to end.
  // Absent both, stop: a cost of zero must never be assumed.
  const dispatched = manifest.totals?.dispatched_cost_usd ?? manifest.total_cost_usd;
  if (typeof dispatched !== "number") {
    console.error(
      `collect-orchestrator-usage FAILED: the manifest carries no dispatched cost ` +
        `(looked for totals.dispatched_cost_usd, then total_cost_usd). Refusing to ` +
        `assume $0 — that would report the overhead as the entire run cost. Nothing was written.`
    );
    return 1;
  }
  const inside = inSessionDispatched(readTelemetry(telemetryPath), policy, manifest, dispatched, {
    claudeCliScanned: !sessionScoped && !receiptOnly && driver != null,
  });
  for (const n of inside.notes) console.error(`NOTE: ${n}`);
  const insideCost = pricingMod.round6(inside.cost);
  const trueTotal = pricingMod.round6(dispatched - insideCost + cost);

  console.log(
    `overhead: in ${tokens.input} + cached ${tokens.input_cached} + cache_write ${tokens.input_cache_write} ` +
      `(5m ${tokens.input_cache_write_5m} / 1h ${tokens.input_cache_write_1h}) + out ${tokens.output} tokens ` +
      `@ '${derived.modelName}' = $${cost} [${costSource}]`
  );
  if (inside.count > 0) {
    console.log(
      `in-session dispatch: ${inside.count} event(s) totaling $${insideCost} ran inside the session ` +
        `and are already inside the overhead above — subtracted so they are counted once.`
    );
  }
  console.log(
    `dispatched total $${dispatched} → true total $${trueTotal}` +
      (inside.count > 0 ? ` (= ${dispatched} − ${insideCost} in-session + ${cost} overhead)` : "")
  );

  if (args.dryRun) {
    console.log("dry-run: nothing written.");
    return 0;
  }

  // Provenance keeps the report's vocabulary: the figure is reconstructed from
  // the session transcript; whether the receipt verified or supplied the
  // dollars is recorded in cost_source / receipt_cost_usd beside it.
  const provenance = "transcript";
  const event = {
    ts: new Date().toISOString(),
    pass: manifestPassId(manifest),
    phase: "orchestrator_overhead",
    task_type: "orchestrator_overhead",
    task_id: `orchestrator-overhead-${manifestPassId(manifest)}`,
    module: "orchestrator",
    model: derived.modelName,
    model_id: derived.modelId,
    routed_by: "orchestrator",
    provenance,
    tier: "orchestrator",
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: -1,
      rule_reason: `orchestrator overhead — ${costSource}; priced at ${pricingBasis}`,
    },
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    input_tokens_cache_write_1h: tokens.input_cache_write_1h,
    output_tokens: tokens.output,
    cost_usd: cost,
    transcript_cost_usd: transcriptCost,
    receipt_cost_usd: receipt?.total_cost_usd ?? null,
    latency_ms: null,
    success: true,
    retry_count: 0,
  };

  // Replace-on-rerun: rewrite telemetry without any prior orchestrator
  // event, append the fresh one, then atomically swap. A crash mid-write
  // can never leave a half-written telemetry.jsonl behind.
  const existing = existsSync(telemetryPath)
    ? readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean)
    : [];
  const kept = existing.filter((l) => {
    try { return JSON.parse(l).tier !== "orchestrator"; } catch { return true; }
  });
  kept.push(JSON.stringify(event));
  const tmpT = `${telemetryPath}.tmp-collect`;
  writeFileSync(tmpT, kept.join("\n") + "\n", "utf-8");
  renameSync(tmpT, telemetryPath);

  manifest.orchestrator_overhead = {
    cost_usd: cost,
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    input_tokens_cache_write_1h: tokens.input_cache_write_1h,
    output_tokens: tokens.output,
    events: 1,
    provenance,
    pricing_basis: pricingBasis,
    cost_source: costSource,
    transcript_cost_usd: transcriptCost,
    receipt_cost_usd: receipt?.total_cost_usd ?? null,
    receipt_path: receipt?.path ?? null,
    dispatched_in_session_cost_usd: insideCost,
    dispatched_in_session_events: inside.count,
  };
  manifest.true_total_cost_usd = trueTotal;
  const tmpM = `${manifestPath}.tmp-collect`;
  writeFileSync(tmpM, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmpM, manifestPath);

  console.log(`written: 1 orchestrator event → ${telemetryPath}; manifest patched with orchestrator_overhead + true_total_cost_usd.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`collect-orchestrator-usage FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
