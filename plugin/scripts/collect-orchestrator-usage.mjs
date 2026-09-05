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
 * session transcript before this tool was written, and re-verified for the
 * window and receipt rules against four real sessions across two CLI
 * versions in September 2026):
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
 *   5. WINDOW: run_id is NOT present in transcript metadata (checked
 *      empirically), but the run's own COMMAND TURN is: the `"type": "user"`
 *      line whose text invokes `/mmo:pass`, `/mmo:greenfield` or
 *      `/mmo:brownfield` (any plugin prefix; the orchestration runner's
 *      `ai-sdlc-*` command names too), carrying this run's `--run-id` or no
 *      run id at all. Claude Code bills PER INVOCATION, and an invocation
 *      begins at its human turn, so the window OPENS at that turn's own
 *      timestamp — exact, not approximate. The turn chosen is the latest one
 *      at or before the driver's `run.start` line in
 *      `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` (else at or
 *      before the first dispatched event), preferring a turn in the receipt's
 *      own session and a turn naming this run id. The window CLOSES at the
 *      first human turn after the driver's `run.end` line (that turn starts
 *      the next invocation and is excluded), or at the end of the session
 *      file when no human turn follows — both exact, because assistant
 *      messages only ever follow a human turn. Lines with `isMeta: true`,
 *      `toolUseResult`, or a `tool_result` content block are the CLI's own
 *      bookkeeping, not human turns. Subagent files hold no human turns and
 *      are not scanned for them.
 *      FALLBACKS, each APPROXIMATE and said so: no command turn → the window
 *      opens at `run.start` minus 5 minutes (the driver's setup runs for a
 *      couple of seconds before it logs run.start), else at the manifest's
 *      `started_at` minus 5 minutes — `started_at` is the FIRST DISPATCHED
 *      event, not the driver's start, and opening the window there dropped
 *      7 messages and 22% of the driver's spend on a real run (v37-agsdk-1,
 *      2026-09-05). No `run.end`, or no pinned session file to read human
 *      turns from → the window closes at `run.end` plus 5 minutes, else at
 *      `ended_at` plus 5 minutes. An approximate window is labelled
 *      "approximate window" in cost_source and `window.exact = false` in the
 *      manifest, and the receipt rule (8) is what decides whether it was
 *      right — a wrong window fails that rule; it never writes a guess.
 *      `run.start`/`run.end` are read as the LAST run.start at or before the
 *      first dispatch (a reused run id appends to the same log) and the first
 *      lifecycle marker after it, which must be run.end. File-level pruning
 *      uses mtime with a LOWER bound only (mtime < anchor − slack ⇒ the
 *      file's last write predates the run and it cannot contain run
 *      messages). There is deliberately NO mtime upper bound — a session
 *      that keeps going after the run would push mtime past the window and
 *      silently drop the run's own messages. This diverges from report.mjs's
 *      artifacts listing, which bounds mtime on both ends for a different
 *      purpose.
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
 *      exist). Its `modelUsage[model]` is what Anthropic's price table
 *      multiplied. The decision is PER TOKEN BUCKET, PER MODEL, and EXACT —
 *      there is no dollar tolerance: for every model the transcript
 *      recorded, its input, cache_read and cache_write totals must EQUAL the
 *      receipt's, and its output must be AT MOST the receipt's (a message
 *      with no terminal line under-reports output; nothing over-reports).
 *      When a model has NO input or cache tokens on either side, the three
 *      buckets prove nothing and output must equal the receipt exactly —
 *      only synthetic transcripts ever hit that case.
 *      Measured on four real sessions: all three buckets equal exactly
 *      whenever the window is the receipt's invocation, and only then.
 *      AGREE → the receipt's own dollars are booked, labelled
 *      "receipt (transcript agrees, ±x%)" with the transcript figure kept
 *      beside it; the receipt's tokens priced at the policy card are compared
 *      to its dollars and a rate-drift NOTE says when the card is stale.
 *      SHORT (any of the three below the receipt) → exit 3, nothing written:
 *      the receipt cannot over-report, so the tree is missing billed
 *      messages (a subagent file not copied, a window that opened late).
 *      ABOVE (any bucket over the receipt) → the window holds messages the
 *      receipt never billed. Claude Code bills per invocation and a runner's
 *      `--resume` continuations each restart the bill, so when the pinned
 *      session file carries two or more human turns inside the window the
 *      LAST invocation alone is checked with the same exact rule: agreement
 *      writes the whole-window transcript figure as "transcript (receipt
 *      covers only the last invocation, verified; N earlier invocation(s)
 *      unverified)"; anything else is exit 3. A receipt model the transcript
 *      never recorded at all (the CLI's own side calls) is a NOTE — its
 *      dollars are inside the booked total. A receipt naming a session other
 *      than the command turn's is exit 3. With a receipt but no transcript
 *      lines in the window, the receipt's dollars are used verbatim
 *      ("receipt-only"). At run-end a headless live-run.log has no result
 *      line yet (the CLI writes it on exit): the figure is written
 *      transcript-priced and labelled "receipt pending; provisional", and a
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
 *      worker whose session was not scanned (receipt-booked figures, or a
 *      scan pinned to the driver's session). Measured +21% over the receipt
 *      without it.
 *
 *
 * Usage:
 *   node collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>]
 *        [--policy <name>] [--policy-path <file>]
 *        [--transcripts-dir <dir>] [--receipt <file>] [--dry-run]
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
 *   --dry-run           print everything, write nothing.
 *
 * Exit codes: 0 = event written (or --dry-run). 1 = bad arguments, missing
 * manifest, or no billable assistant messages found in the run window (the
 * run WAS driven by a session, so an empty window means the wrong
 * project-root/transcripts-dir — nothing is written). 3 = the transcript and
 * the receipt disagree — the transcript is short of the receipt, or over it
 * with no continuation turn to account for the excess, or the receipt names
 * a session other than the command turn's — nothing is written.
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveDriverModel, IN_SESSION_ADAPTERS } from "./driver-model-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/**
 * Slack for the APPROXIMATE anchors only (header, fact 5): a fallback start
 * opens this much before run.start / started_at, a fallback end closes this
 * much after run.end / ended_at, and the mtime prune reaches this much
 * further back. An exact anchor — the command turn, the next human turn, the
 * end of the session file — never carries slack: it is a real event, not an
 * estimate of one.
 */
const WINDOW_SLACK_MS = 5 * 60_000;

/**
 * One run-lifecycle log line, as plugin/scripts/lib/log.mjs renders it:
 * `MMO: <ISO timestamp> <LEVEL>  run.start run_id=... mode=...`. The prefix
 * is configurable (MMO_LOG_PREFIX, possibly empty), so it is optional here;
 * the timestamp and the event name are what anchor the window. One builder
 * for both markers, so run.start and run.end can never drift apart.
 */
const runMarkerLine = (event) =>
  new RegExp(`^(?:\\S+\\s+)?(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))\\s+[A-Z]+\\s+${event.replace(".", "\\.")}(?:\\s|$)`);
const RUN_START_LINE = runMarkerLine("run.start");
const RUN_END_LINE = runMarkerLine("run.end");

/**
 * The text of a human turn that starts a run. Claude Code records a slash
 * command as `<command-name>/mmo:pass</command-name>` (with the plugin's
 * install name as the prefix, which need not be `mmo`; the orchestration
 * runner's commands are `ai-sdlc-measured`, `ai-sdlc-pass1`, ...); a `-p`
 * prompt on an older CLI is the bare command line. Both shapes are accepted.
 */
const MMO_COMMAND = /<command-name>\/(?:[\w-]+:)?(?:pass|greenfield|brownfield|ai-sdlc-[\w-]+)<\/command-name>|^\s*\/(?:[\w-]+:)?(?:pass|greenfield|brownfield|ai-sdlc-[\w-]+)(?:\s|$)/;
/** `--run-id=<id>` or `--run-id <id>` inside the command turn's text; stops at whitespace or the closing tag. */
const RUN_ID_FLAG = /--run-id(?:=|\s+)([^\s<]+)/;

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

/**
 * The driver's own end for the run that started at `runStartMs`, read from
 * the same log (header, fact 5). Returns { ms, iso } for the FIRST lifecycle
 * marker after run.start — but only if that marker is a `run.end`. When the
 * next marker is another `run.start` (the run was resumed or the id reused
 * and this run never logged its end), there is no run.end that belongs to
 * this run and null is returned; a later run.end would be another run's,
 * and closing this window there would sweep that run's messages in.
 */
export function runEndFromLog(logPath, runStartMs) {
  if (!logPath || !existsSync(logPath)) return null;
  let first = null;
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    for (const [event, re] of [["run.end", RUN_END_LINE], ["run.start", RUN_START_LINE]]) {
      const m = re.exec(line);
      if (!m) continue;
      const ms = Date.parse(m[1]);
      if (!Number.isFinite(ms) || ms <= runStartMs) continue;
      if (first == null || ms < first.ms) first = { ms, iso: m[1], event };
    }
  }
  return first && first.event === "run.end" ? { ms: first.ms, iso: first.iso } : null;
}

/**
 * The human turns of one top-level session file, oldest first (header,
 * fact 5). A human turn is a `"type": "user"` line that is not the CLI's own
 * bookkeeping: `isMeta: true` lines are the CLI's expansion of a slash
 * command (same timestamp as the turn, not a turn), `toolUseResult` lines and
 * lines whose content holds a `tool_result` block are tool output handed
 * back to the model. Each turn reports whether its text is a run command
 * (MMO_COMMAND) and which `--run-id` it names, if any. The session id is the
 * line's own `sessionId` field, else the file's basename — the CLI names the
 * file after the session. Lines without a parseable timestamp cannot anchor
 * anything and are skipped.
 */
export function humanTurns(file) {
  const turns = [];
  let lines;
  try { lines = readFileSync(file, "utf-8").split("\n"); } catch { return turns; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== "user" || obj.isMeta === true || obj.toolUseResult !== undefined) continue;
    const content = obj.message?.content;
    let text;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      if (content.some((b) => b?.type === "tool_result")) continue;
      text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    } else continue;
    const ms = Date.parse(obj.timestamp);
    if (!Number.isFinite(ms)) continue;
    turns.push({
      ms,
      iso: String(obj.timestamp),
      file,
      session_id: obj.sessionId ?? basename(file, ".jsonl"),
      command: MMO_COMMAND.test(text),
      run_id: RUN_ID_FLAG.exec(text)?.[1] ?? null,
    });
  }
  return turns.sort((a, b) => a.ms - b.ms);
}

/**
 * The exact receipt rule (header, fact 8), per model. `perModel` is the
 * transcript's per-model token buckets; `receiptModels` the receipt's
 * `modelUsage`. For every model the transcript recorded: input, cache_read
 * and cache_write must EQUAL the receipt's, output must be AT MOST the
 * receipt's. Why this is exact: every billed message carries at least one
 * non-zero count among input / cache_read / cache_write (a message with all
 * three at zero was never sent), and those three are identical on every
 * duplicate line of a message, so equal totals across all three mean the
 * same set of messages — a missing message lowers a bucket, an extra message
 * raises one, and the two cannot cancel across all three at once on any
 * transcript this tool has seen. Output alone may fall short: a message with
 * no terminal line books a partial snapshot. A receipt model with NO
 * transcript messages at all is the CLI's own side call (recorded on the
 * receipt, never in the transcript) and is reported, not failed; a
 * transcript model with no receipt entry is over the receipt.
 */
export function compareBuckets(perModel, receiptModels) {
  const above = [];
  const short = [];
  const unrecorded = [];
  const lines = [];
  const names = [...new Set([...Object.keys(perModel), ...Object.keys(receiptModels)])].sort();
  for (const name of names) {
    const T = perModel[name];
    const R = receiptModels[name];
    if (!T) { unrecorded.push(name); continue; }
    if (name === "(unlabeled)") {
      above.push(`${T.input + T.input_cached + T.input_cache_write + T.output} tokens on transcript messages with no model name — they cannot be matched to any receipt model`);
      continue;
    }
    if (!R) {
      above.push(`${name}: ${T.input + T.input_cached + T.input_cache_write + T.output} tokens in the transcript, none on the receipt`);
      continue;
    }
    // Output may sit BELOW the receipt (an interrupted message has no terminal
    // line, so its output_tokens never reach the transcript) — but only while
    // the three deterministic buckets (input, cache_read, cache_write) can
    // still prove the window holds every billed message. When those three are
    // zero on BOTH sides they prove nothing (every real billed message writes
    // a non-zero input or cache bucket, so this only happens on synthetic
    // transcripts), and output is the sole remaining evidence: it must then
    // match the receipt exactly, and a shortfall is a missing message.
    const inputless = T.input + T.input_cached + T.input_cache_write === 0 && R.input + R.input_cached + R.input_cache_write === 0;
    const cells = [];
    for (const [key, label] of [["input", "in"], ["input_cached", "cached"], ["input_cache_write", "cache_write"], ["output", "out"]]) {
      const t = T[key], r = R[key];
      if (key === "output") {
        cells.push(`${label} ${t}${t <= r ? "≤" : ">"}${r}`);
        if (t > r) above.push(`${name} output: transcript ${t} > receipt ${r}`);
        else if (t < r && inputless) short.push(`${name} output: transcript ${t} < receipt ${r} (no input or cache tokens on either side, so output alone must match)`);
      } else {
        cells.push(`${label} ${t}${t === r ? "=" : t < r ? "<" : ">"}${r}`);
        if (t > r) above.push(`${name} ${key}: transcript ${t} > receipt ${r}`);
        else if (t < r) short.push(`${name} ${key}: transcript ${t} < receipt ${r}`);
      }
    }
    const verdict = above.some((a) => a.startsWith(`${name} `)) ? "over the receipt" : short.some((s) => s.startsWith(`${name} `)) ? "short of the receipt" : "agrees";
    lines.push(`${name}: ${cells.join(" · ")} → ${verdict}`);
  }
  return { ok: above.length === 0 && short.length === 0, above, short, unrecorded, lines };
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
    // The former --receipt-tolerance is gone on purpose: the receipt rule is
    // exact per token bucket (header, fact 8), so there is no fraction to
    // widen. Name it explicitly so an old invocation fails loudly, not
    // silently as "unknown argument".
    else if (a === "--receipt-tolerance" || a.startsWith("--receipt-tolerance=")) throw new Error("--receipt-tolerance no longer exists: the receipt check is exact per token bucket and has no tolerance to widen");
    else if (a.startsWith("--")) throw new Error(`unknown argument '${a}'`);
    else if (args.passDir === undefined) args.passDir = a;
    else throw new Error(`unexpected extra positional '${a}' (pass dir already given: ${args.passDir})`);
  }
  if (!args.passDir) throw new Error("usage: collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>] [--policy <name>] [--policy-path <file>] [--transcripts-dir <dir>] [--receipt <file>] [--dry-run]");
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
 * windowed per-message: a message counts when
 * windowStartMs <= timestamp < windowEndMs, no slack — the anchors already
 * carry whatever slack they deserve (header, fact 5). Returns token buckets
 * + scan stats + the observed model → unique-message-count map + the same
 * buckets per model (what the receipt rule compares).
 */
export function sumTranscriptUsage(files, windowStartMs, windowEndMs) {
  const seen = new Set();
  /** Per message id: the output figure booked, whether it came from the
   *  terminal (stop_reason) line, and the model it was booked under. See the
   *  streaming note below. */
  const outputById = new Map();
  const observedModels = {};
  const perModel = {};
  const bucketFor = (model) => (perModel[model] ??= { input: 0, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 0 });
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
        if (Number.isFinite(t) && (t < windowStartMs || t >= windowEndMs)) {
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
            bucketFor(prev.model).output += out - prev.out;
            outputById.set(msg.id, { out, terminal, model: prev.model });
          }
          continue;
        }
        seen.add(msg.id);
      }
      stats.counted++;
      const model = msg.model ?? "(unlabeled)";
      if (msg.id) outputById.set(msg.id, { out, terminal, model });
      observedModels[model] = (observedModels[model] ?? 0) + 1;
      const pm = bucketFor(model);
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
      pm.input += usage.input_tokens ?? 0;
      pm.input_cached += usage.cache_read_input_tokens ?? 0;
      pm.input_cache_write += cw;
      pm.input_cache_write_1h += cw1h;
      pm.output += out;
    }
  }
  return { tokens, stats, observedModels, perModel };
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

/** Sum a receipt's per-model buckets into one set of totals. */
const sumReceiptModels = (models) =>
  Object.values(models).reduce(
    (a, m) => ({ input: a.input + m.input, input_cached: a.input_cached + m.input_cached, input_cache_write: a.input_cache_write + m.input_cache_write, output: a.output + m.output }),
    { input: 0, input_cached: 0, input_cache_write: 0, output: 0 }
  );

const fmtPct = (delta) => `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
const isoOf = (ms) => new Date(ms).toISOString();

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
  const lastDispatchMs = Date.parse(manifest.ended_at);
  if (!Number.isFinite(firstDispatchMs) || !Number.isFinite(lastDispatchMs)) {
    throw new Error(`manifest.json has no parseable started_at/ended_at — cannot anchor the run window`);
  }
  const passId = String(manifestPassId(manifest));
  const projectRoot = resolve(args.projectRoot ?? process.cwd());

  // ── The driver's own lifecycle markers ──────────────────────────────────
  // The prompt logs `run.start` / `run.end` with `--run-id --project-root`,
  // so the file is `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` in
  // both modes; brownfield's output directory IS that directory, so the pass
  // directory's own log is the second place to look. run.start bounds the
  // search for the command turn (the turn precedes it) and is the fallback
  // opening anchor; run.end is where the closing human turn is looked for
  // and the fallback closing anchor (header, fact 5). run.end is only ever
  // read from the log that holds this run's run.start: a run.end in some
  // other file cannot be shown to be this run's.
  const runLogCandidates = [
    join(projectRoot, ".sdlc", "runs", passId, "orchestrator.log"),
    join(passDir, "orchestrator.log"),
  ];
  let runStart = null;
  for (const p of runLogCandidates) {
    const found = runStartFromLog(p, firstDispatchMs);
    if (found) { runStart = { ...found, path: p }; break; }
  }
  let runEnd = null;
  if (runStart) {
    const found = runEndFromLog(runStart.path, runStart.ms);
    if (found) runEnd = { ...found, path: runStart.path };
  }

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
  // disagrees with it is wrong, and is not written (header, fact 8).
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

  // ── Candidate transcript files ──────────────────────────────────────────
  // Pruned by mtime against the earliest anchor the window could open at:
  // the command turn precedes run.start by seconds and every run message is
  // written after it, so a file whose last write predates run.start (else
  // the first dispatch) minus the slack cannot hold this run.
  const tDir = args.transcriptsDir ? resolve(args.transcriptsDir) : transcriptsDirFor(projectRoot);
  const candidates = candidateTranscripts(tDir, runStart ? runStart.ms : firstDispatchMs);
  const topLevel = candidates.filter((f) => dirname(f) === tDir);
  const turnsByFile = new Map(topLevel.map((f) => [f, humanTurns(f)]));

  // ── The command turn: where the invocation, and so the window, begins ───
  // Candidates: run commands at or before run.start (else the first
  // dispatch) that name this run id or none. Preference, in order: a turn
  // in the receipt's own session (the receipt says which invocation it
  // bills), a turn naming this run id, then the latest. Two concurrent runs
  // of the same project with no receipt are the one case this cannot tell
  // apart — such runs are unverified anyway, and the docs say so.
  const commandBoundMs = runStart ? runStart.ms : firstDispatchMs;
  let commandTurn = null;
  for (const turns of turnsByFile.values()) {
    for (const t of turns) {
      if (!t.command || t.ms > commandBoundMs) continue;
      if (t.run_id != null && t.run_id !== passId) continue;
      const rank = (receipt?.session_id && t.session_id === receipt.session_id ? 2 : 0) + (t.run_id === passId ? 1 : 0);
      if (!commandTurn || rank > commandTurn.rank || (rank === commandTurn.rank && t.ms > commandTurn.ms)) commandTurn = { ...t, rank };
    }
  }
  if (commandTurn && receipt?.session_id && commandTurn.session_id !== receipt.session_id) {
    // The receipt bills one session; the run's command turn is in another.
    // Either the receipt was copied from a different run or the receipt's
    // session file is not in this tree. Neither can be verified.
    console.error(
      `collect-orchestrator-usage FAILED: the receipt ${receipt.path} is for session ${receipt.session_id}, but the ` +
        `run's command turn (${commandTurn.iso}) is in session ${commandTurn.session_id} (${commandTurn.file}), and ` +
        `session ${receipt.session_id} holds no command turn for run '${passId}'. A receipt for another session cannot ` +
        `referee this run. Nothing was written.`
    );
    return 3;
  }

  // ── Pin the scan to one session ─────────────────────────────────────────
  // With a command turn, the files are that turn's session file plus its
  // subagent files; the receipt's session id does the same job without one.
  // Unpinned (no command turn, no receipt session in the tree — a copied
  // tree, tests) the scan takes every candidate, and the receipt rule below
  // is what catches a stray session.
  let files;
  let pinned;
  let pinnedId;
  let mainFile;
  if (commandTurn) {
    pinnedId = commandTurn.session_id;
    files = candidates.filter((f) => f === commandTurn.file || basename(f).startsWith(pinnedId) || f.includes(`/${pinnedId}/`));
    pinned = true;
    mainFile = commandTurn.file;
  } else {
    files = filesForSession(candidates, receipt?.session_id);
    pinned = Boolean(receipt?.session_id) && files.some((f) => basename(f).startsWith(receipt.session_id) || f.includes(`/${receipt.session_id}/`));
    pinnedId = pinned ? receipt.session_id : null;
    mainFile = pinned ? (topLevel.find((f) => basename(f).startsWith(receipt.session_id)) ?? null) : null;
  }
  const mainTurns = mainFile ? (turnsByFile.get(mainFile) ?? humanTurns(mainFile)) : [];

  // ── Opening anchor ──────────────────────────────────────────────────────
  let windowStartMs;
  let startAnchor;
  let startExact;
  let startLine;
  if (commandTurn) {
    windowStartMs = commandTurn.ms;
    startAnchor = "command turn";
    startExact = true;
    startLine = `opens at the run's command turn ${commandTurn.iso} in ${commandTurn.file} (exact: the invocation the CLI bills begins there)`;
  } else if (runStart) {
    windowStartMs = runStart.ms - WINDOW_SLACK_MS;
    startAnchor = "run.start - 5m";
    startExact = false;
    startLine = `opens at run.start ${runStart.iso} in ${runStart.path} minus 5 minutes (approximate: no run command turn found in ${tDir})`;
  } else {
    windowStartMs = firstDispatchMs - WINDOW_SLACK_MS;
    startAnchor = "manifest started_at - 5m";
    startExact = false;
    startLine = `opens at the manifest's started_at ${manifest.started_at} (= first dispatched event) minus 5 minutes (approximate: no run command turn found in ${tDir} and no run.start line in ${runLogCandidates[0]})`;
  }

  // ── Closing anchor ──────────────────────────────────────────────────────
  // Exact when a pinned session file can be read: the first human turn after
  // run.end starts the next invocation (excluded), and no such turn means the
  // session file ends with this invocation. Without run.end the session file
  // is still exact when no human turn follows the opening at all. Otherwise
  // approximate: run.end (else ended_at) plus the slack.
  let windowEndMs;
  let endAnchor;
  let endExact;
  let endLine;
  if (runEnd && mainFile) {
    const next = mainTurns.find((t) => t.ms > runEnd.ms);
    if (next) {
      windowEndMs = next.ms;
      endAnchor = "next human turn after run.end";
      endExact = true;
      endLine = `closes at the next human turn ${next.iso} after run.end ${runEnd.iso} in ${runEnd.path} (exact: that turn starts the next invocation and is excluded)`;
    } else {
      windowEndMs = Number.POSITIVE_INFINITY;
      endAnchor = "end of session";
      endExact = true;
      endLine = `closes at the end of the session file: run.end ${runEnd.iso} in ${runEnd.path} and no later human turn (exact)`;
    }
  } else if (runEnd) {
    windowEndMs = runEnd.ms + WINDOW_SLACK_MS;
    endAnchor = "run.end + 5m";
    endExact = false;
    endLine = `closes at run.end ${runEnd.iso} in ${runEnd.path} plus 5 minutes (approximate: the scan is not pinned to a session file, so no human turn can bound it)`;
  } else if (mainFile && !mainTurns.some((t) => t.ms > windowStartMs)) {
    windowEndMs = Number.POSITIVE_INFINITY;
    endAnchor = "end of session";
    endExact = true;
    endLine = `closes at the end of the session file: no run.end line in ${runLogCandidates[0]}, and no human turn after the window opens (exact)`;
  } else {
    windowEndMs = lastDispatchMs + WINDOW_SLACK_MS;
    endAnchor = "manifest ended_at + 5m";
    endExact = false;
    endLine =
      `closes at the manifest's ended_at ${manifest.ended_at} (= last dispatched event) plus 5 minutes (approximate: no run.end line in ${runLogCandidates[0]}` +
      (mainFile ? ", and a human turn after the window opens that only run.end could place)" : ", and the scan is not pinned to a session file)");
  }
  const windowExact = startExact && endExact;
  const finiteEnd = Number.isFinite(windowEndMs);

  // A window that closes in the future (the run-end step invokes this from
  // inside the session) cannot be observed past now. Reading it as-is would
  // silently report a partial measurement as a complete one, so clamp to now
  // and say how much of the window was unobservable.
  const collectedAtMs = Date.now();
  const unobservableMs = finiteEnd ? Math.max(0, windowEndMs - collectedAtMs) : 0;
  const effectiveEndMs = finiteEnd ? Math.min(windowEndMs, collectedAtMs) : windowEndMs;

  const { tokens, stats, observedModels, perModel } = sumTranscriptUsage(files, windowStartMs, effectiveEndMs);

  console.log(
    `collect-orchestrator-usage: pass '${passId}' window ${isoOf(windowStartMs)} → ${finiteEnd ? isoOf(windowEndMs) : "end of session"}` +
      (windowExact ? "" : " (approximate)")
  );
  console.log(`  ${startLine}`);
  console.log(`  ${endLine}`);
  if (runStart && firstDispatchMs - runStart.ms > 60 * 60_000) {
    // Not an error — a gate left open before the first dispatch does this —
    // but a stale log under a reused run id looks the same, so say it.
    console.error(
      `NOTE: run.start is ${Math.round((firstDispatchMs - runStart.ms) / 60_000)} minutes before the first dispatched ` +
        `event. If this run reused an earlier run's id, check ${runStart.path} holds this run's own run.start line ` +
        `(the receipt cross-check below is the referee).`
    );
  }
  console.log(`transcripts: ${tDir}${pinned ? ` (scan pinned to session ${pinnedId}${finiteEnd ? "" : "; no upper time bound"})` : ""}`);
  console.log(
    `scanned ${stats.files} file(s), ${stats.lines} line(s): counted ${stats.counted} unique API message(s) ` +
      `(${stats.duplicates} duplicate content-block line(s) skipped, ${stats.synthetic} synthetic, ${stats.outside_window} outside window)`
  );
  console.log(`observed_models ${JSON.stringify(observedModels)}`);
  if (receipt) {
    const perModelCost = Object.fromEntries(Object.entries(receipt.models).map(([k, v]) => [k, v.cost_usd]));
    console.log(`receipt: ${receipt.path} → $${receipt.total_cost_usd} ${JSON.stringify(perModelCost)}`);
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
        `'${derived.modelName}' rate. The receipt rule below compares token buckets per model, so this only ` +
        `affects the transcript-priced figure kept beside the receipt; pass --policy-path for a policy that ` +
        `prices the model the receipt names to make that figure meaningful.`
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
  const priceOf = (t) => ({
    input: t.input,
    input_cached: t.input_cached,
    output: t.output,
    input_cache_write: t.input_cache_write_5m,
    input_cache_write_1h: t.input_cache_write_1h,
  });
  const transcriptCost = driver ? pricingMod.computeCostUsd(priceOf(tokens), driver.pricing) : null;
  const approxTag = windowExact ? "" : "; approximate window";

  // ── The receipt rule ────────────────────────────────────────────────────
  let cost;
  let costSource;
  /** Book the receipt's own dollars and tokens (the 1-hour cache-write share
   *  comes from the transcript, capped at the receipt's total write count). */
  const bookReceipt = () => {
    const rm = sumReceiptModels(receipt.models);
    tokens.input = rm.input;
    tokens.input_cached = rm.input_cached;
    tokens.input_cache_write = rm.input_cache_write;
    tokens.input_cache_write_1h = Math.min(rm.input_cache_write, receipt.cache_write_1h ?? tokens.input_cache_write_1h);
    tokens.input_cache_write_5m = Math.max(0, tokens.input_cache_write - tokens.input_cache_write_1h);
    tokens.output = rm.output;
    cost = pricingMod.round6(receipt.total_cost_usd);
  };
  if (receiptOnly) {
    // No transcript reachable, but the CLI's own accounting is. Its dollars
    // are authoritative; only attribution is lost, and that is said.
    bookReceipt();
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
  } else if (receipt) {
    const rm = sumReceiptModels(receipt.models);
    const delta = transcriptCost == null ? null : (transcriptCost - receipt.total_cost_usd) / receipt.total_cost_usd;
    const pct = delta == null ? null : fmtPct(delta);
    // What the receipt's dollars imply the cache-write rate was, given the
    // policy card's other three rates — the diagnostic that found the 1-hour
    // tier. Informational; the decision is the bucket rule below.
    let implied = "";
    if (driver && rm.input_cache_write > 0) {
      const pr = driver.pricing;
      const nonWrite = (rm.input * pr.input + rm.input_cached * pr.input_cached + rm.output * pr.output) / 1_000_000;
      const rate = ((receipt.total_cost_usd - nonWrite) / rm.input_cache_write) * 1_000_000;
      implied = `; receipt implies a cache-write rate of $${rate.toFixed(2)}/M (5-minute card $${(pr.input * 1.25).toFixed(2)}, 1-hour $${(pr.input * 2).toFixed(2)})`;
    }
    console.log(
      `receipt cross-check: transcript ${transcriptCost == null ? "(no policy rate)" : `$${transcriptCost}`} vs receipt $${receipt.total_cost_usd}` +
        `${pct ? ` → ${pct}` : ""} (informational; the decision is per token bucket)${implied}`
    );
    console.log(
      `  tokens transcript in ${tokens.input} · cached ${tokens.input_cached} · cache_write ${tokens.input_cache_write} · out ${tokens.output}` +
        ` | receipt in ${rm.input} · cached ${rm.input_cached} · cache_write ${rm.input_cache_write} · out ${rm.output}`
    );
    const cmp = compareBuckets(perModel, receipt.models);
    for (const l of cmp.lines) console.log(`  ${l}`);
    if (cmp.unrecorded.length > 0) {
      const detail = cmp.unrecorded.map((m) => `${m} (${receipt.models[m].input + receipt.models[m].input_cached + receipt.models[m].input_cache_write + receipt.models[m].output} tokens, $${receipt.models[m].cost_usd ?? "?"})`).join(", ");
      console.error(
        `NOTE: the receipt also bills ${detail} for calls the transcript does not record — the CLI's own side calls ` +
          `(session titles, summaries). Their dollars are inside the receipt total and are booked with it.`
      );
    }
    if (cmp.short.length > 0) {
      // The receipt cannot over-report: a bucket below it means billed
      // messages are missing from the tree or from the window.
      console.error(
        `collect-orchestrator-usage FAILED: the transcript is BELOW the CLI's own receipt (${cmp.short.join("; ")}` +
          `${pct ? `; priced $${transcriptCost} vs receipt $${receipt.total_cost_usd}, ${pct}` : ""}). The receipt cannot ` +
          `over-report, so the transcript tree is missing billed messages — usually a subagent transcript not copied ` +
          `alongside the session file, a run log with no run.start line (the window then opens near the first dispatch, ` +
          `after the driver's setup work), or a window that closed before the invocation did. Nothing was written. ` +
          `Fix the input; the check is exact and has no tolerance to widen.`
      );
      return 3;
    }
    if (cmp.above.length > 0) {
      // The window holds messages the receipt never billed. The one honest
      // explanation is another invocation on the same session inside the
      // window — a runner's `--resume` continuation, whose receipt covers
      // only the last leg. That leaves a human turn behind, so check the
      // last invocation alone with the same exact rule.
      const turnsInWindow = mainTurns.filter((t) => t.ms >= windowStartMs && t.ms < windowEndMs);
      if (turnsInWindow.length >= 2) {
        const last = turnsInWindow[turnsInWindow.length - 1];
        const lastInv = sumTranscriptUsage(files, last.ms, effectiveEndMs);
        const cmpLast = compareBuckets(lastInv.perModel, receipt.models);
        console.log(`  last invocation (from the human turn at ${last.iso}, ${turnsInWindow.length - 1} earlier turn(s) in the window):`);
        for (const l of cmpLast.lines) console.log(`    ${l}`);
        if (!cmpLast.ok) {
          console.error(
            `collect-orchestrator-usage FAILED: the receipt matches neither the whole window nor its last invocation. ` +
              `Whole window: ${cmp.above.join("; ")}. Last invocation (from ${last.iso}): ` +
              `${[...cmpLast.above, ...cmpLast.short].join("; ") || "no bucket differs"}. Nothing was written; no number is guessed.`
          );
          return 3;
        }
        if (transcriptCost == null) {
          console.error(
            `collect-orchestrator-usage FAILED: the receipt covers only the last of ${turnsInWindow.length} invocations in the ` +
              `window, and the policy prices no Claude model, so the earlier invocations cannot be priced from the transcript. ` +
              `Pass --policy-path for a policy that prices '${derived.modelName}'. Nothing was written.`
          );
          return 3;
        }
        const lastCost = pricingMod.round6(pricingMod.computeCostUsd(priceOf(lastInv.tokens), driver.pricing));
        const lastPct = fmtPct((lastCost - receipt.total_cost_usd) / receipt.total_cost_usd);
        console.log(`    transcript $${lastCost} vs receipt $${receipt.total_cost_usd} → ${lastPct}; the last invocation agrees with the receipt`);
        cost = transcriptCost;
        costSource = `transcript (receipt covers only the last invocation, verified ${lastPct}; ${turnsInWindow.length - 1} earlier invocation(s) unverified${approxTag})`;
        console.error(
          `NOTE: the receipt bills only the last invocation (from the human turn at ${last.iso}); the ${turnsInWindow.length - 1} ` +
            `earlier invocation(s) in the window are transcript-priced and unverified. The whole-window transcript figure ` +
            `($${transcriptCost}) is written. A receipt for each invocation would verify them all.`
        );
      } else {
        console.error(
          `collect-orchestrator-usage FAILED: the window holds messages the receipt never billed (${cmp.above.join("; ")}) ` +
            `and no continuation turn explains them: ` +
            (mainFile
              ? `the session file ${mainFile} carries ${turnsInWindow.length} human turn(s) inside the window. `
              : `the scan is not pinned to a session file, so its human turns cannot be read. `) +
            `Claude Code bills per invocation, so an over-count means the window opened before this invocation (a preamble ` +
            `under the same session id, a stale run.start, a reused run id) or swept in another run's messages. Nothing was ` +
            `written; no number is guessed.`
        );
        return 3;
      }
    } else {
      // AGREE: the transcript is the receipt's invocation, message for
      // message. The receipt's own dollars are booked; the transcript figure
      // (lower only where output placeholders under-report) is kept beside it.
      bookReceipt();
      costSource = transcriptCost == null
        ? "receipt (transcript agrees; no policy rate for a rate check)"
        : `receipt (transcript agrees, ${pct})`;
      // Rate drift: the receipt's own tokens for the priced model, at the
      // policy card, should reproduce the receipt's dollars for that model.
      // A gap means the card no longer matches what the CLI charged.
      const dm = receipt.models[derived.modelName];
      const tm = perModel[derived.modelName];
      if (driver && dm && tm && dm.cost_usd != null && dm.cost_usd > 0) {
        const priced = pricingMod.round6(pricingMod.computeCostUsd({
          input: dm.input,
          input_cached: dm.input_cached,
          output: dm.output,
          input_cache_write: Math.max(0, dm.input_cache_write - tm.input_cache_write_1h),
          input_cache_write_1h: Math.min(dm.input_cache_write, tm.input_cache_write_1h),
        }, driver.pricing));
        const drift = (priced - dm.cost_usd) / dm.cost_usd;
        if (Math.abs(drift) > 0.005) {
          console.error(
            `NOTE: rate drift — the receipt's own '${derived.modelName}' tokens priced at the policy card come to $${priced}, ` +
              `but the receipt bills $${dm.cost_usd} for them (${fmtPct(drift)}). The receipt's dollars are booked; the ` +
              `policy's rates for '${derived.modelName}' (or its cache-write TTL rates) no longer match what the CLI ` +
              `charged — check the policy's pricing block and its pricing_last_verified date.`
          );
        }
      }
    }
  } else {
    cost = transcriptCost;
    costSource = receiptPending
      ? `transcript (receipt pending; provisional${approxTag})`
      : `transcript (no receipt; unverified${approxTag})`;
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
  // A claude-cli worker's own session is inside the overhead only when the
  // scan was not pinned to the driver's session AND the figure written is the
  // transcript's: a booked receipt bills the driver's session alone, so the
  // worker's dollars are not inside it and must stay in the total.
  const inside = inSessionDispatched(readTelemetry(telemetryPath), policy, manifest, dispatched, {
    claudeCliScanned: !pinned && driver != null && costSource.startsWith("transcript"),
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
    // The window the figure was measured over, so a reader can tell an exact
    // invocation-bounded measurement from an approximate one without
    // re-running the tool (header, fact 5).
    window: {
      start: isoOf(windowStartMs),
      end: finiteEnd ? isoOf(windowEndMs) : null,
      start_anchor: startAnchor,
      end_anchor: endAnchor,
      exact: windowExact,
      session_id: pinnedId,
    },
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
