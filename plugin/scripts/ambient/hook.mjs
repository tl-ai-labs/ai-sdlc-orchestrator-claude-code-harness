#!/usr/bin/env node
/**
 * Ambient-mode hook dispatcher: one entry point for every hook event the
 * plugin registers for ordinary chat (no /mmo: command typed).
 *
 *   node hook.mjs <event>        hook input JSON on stdin, decision JSON on stdout
 *
 * Contract held by every handler:
 *   - Decisions are JSON on stdout with exit 0. The shell shim in front of this
 *     file turns ANY exit into 0, so a crash here can never block a tool call,
 *     a prompt or a model switch. No handler relies on exit 2.
 *   - Cost rules fail open: on any doubt the tool result passes through as
 *     Claude Code produced it.
 *   - mode "off" returns before touching the disk. mode "observe", the control
 *     arm, a pipeline session and a subagent call all record what WOULD have
 *     happened and change nothing.
 *   - No prompt text, file content or command output is ever stored. Paths,
 *     sizes, rule ids and numbers only.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { drawArm, readArm } from "./lib/arm.mjs";
import { loadConfig } from "./lib/config.mjs";
import { decide, handoverNet, posteriorMean, pricesFor } from "./lib/cost-rule.mjs";
import { appendEvent, setEventAgent } from "./lib/events.mjs";
import { measuredExtraRequests, recordLanding } from "./lib/evidence.mjs";
import { isReleased } from "./lib/released.mjs";
import { isPipelineCommand, labelPrompt, wantsFullOutput } from "./lib/labels.mjs";
import { buildOutline } from "./lib/outline.mjs";
import { hasConsent } from "./lib/consent.mjs";
import { clearPartial, isPartial, markPartial } from "./lib/partial-view.mjs";
import { appendPrivate, ensureDir, ensureSessionDir, mmoHome, safeId, sessionDir } from "./lib/paths.mjs";
import { recordValve, repoKey, valveCounts } from "./lib/repo-stats.mjs";
import { classifyRunner, parseFileDump, rangeLineCount } from "./lib/shell-parse.mjs";
import { lastTurnFacts } from "./lib/transcript.mjs";
import { repoKind } from "./lib/repo-kind.mjs";
import { folderKind, routeMessage, ROUTABLE_JOBS } from "./lib/route.mjs";
import { askReason, cannotStartInstruction, dropOffer, dropRoute, isPlainYes, NOT_NOW_REASON, prerequisites, readOffer, readRoute, saveWorkflowPolicy, startFirstReason, startInstruction, workflowPolicy, workflowsParagraph, writeOffer, writeRoute } from "./lib/route-flow.mjs";
// edit-fill.mjs and offers.mjs pull in the apply script and the value rule.
// They are loaded only by the rare call that needs them: loading them on every
// tool call pushed the ordinary-call overhead from about 50 ms past the 80 ms
// budget, and an ordinary Read, Bash or Edit never uses either.
const MARKER_EDIT = /^mmo-apply:[A-Za-z0-9_-]{1,80}:\d{1,3}$/;
import { ambientToolName, isStartTool, stampInput } from "./lib/stamp.mjs";
import { bashWrittenPaths, bugfixTrigger, editShape, fileKindOf, fullToolName, isTestPath, mentionsTestRunner, offerLine, outputShowsFailingTests, readsFanOutTrigger, searchNeedle, toolRef } from "./lib/triggers.mjs";

const SELF_STOP_MS = 1500;
const BREAKER_FAILURES = 3;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const DEBUG = process.env.MMO_AMBIENT_DEBUG === "1";

// A hook that hangs is worse than a hook that does nothing. The timer is
// unref'd, so it only matters when something (an open stdin) keeps us alive.
setTimeout(() => process.exit(0), SELF_STOP_MS).unref();

function readStdinJson() {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on("end", () => {
      if (size > MAX_STDIN_BYTES) return done(null);
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { done(null); }
    });
    process.stdin.on("error", () => done(null));
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/**
 * The thinking-effort level Claude Code reports with each hook call. Effort
 * does not change any price per token; it changes how many output tokens a
 * request produces. It is recorded so an on/off comparison can be made between
 * sessions at the same effort, never across different ones.
 */
function effortOf(input) {
  const level = input?.effort?.level ?? input?.effort;
  return typeof level === "string" ? level.slice(0, 20) : undefined;
}

function num(value, fallback, min = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

// ---------- session markers (one tiny file each; presence is the fact) ----------

/**
 * Per-chat state (counters, offers, the once-only push, outlined files) lives
 * in the chat's folder. A helper agent Opus started is a chat of its own: its
 * state lives in a sub-folder per agent, so its counters and its offers are
 * separate from the parent's, while its events, costs and jobs are recorded
 * under the parent chat (one chat, one total on the board).
 */
function scopeDir(ctx) {
  return ctx.agent ? join(sessionDir(ctx.sid), "agents", safeId(ctx.agent)) : sessionDir(ctx.sid);
}
function ensureScopeDir(ctx) {
  ensureSessionDir(ctx.sid);
  return ensureDir(scopeDir(ctx));
}
function marker(ctx, name) {
  return join(scopeDir(ctx), name);
}
/** The text a marker holds, or "" when absent (refusal counts per file live in markers). */
function readMarker(ctx, name) {
  try { return readFileSync(marker(ctx, name), "utf8"); } catch { return ""; }
}
function hasMarker(ctx, name) {
  return existsSync(marker(ctx, name));
}
function setMarker(ctx, name, text = "") {
  ensureScopeDir(ctx);
  writeFileSync(marker(ctx, name), text, { mode: 0o600 });
}
function dropMarker(ctx, name) {
  try { rmSync(marker(ctx, name), { force: true }); } catch { /* already gone */ }
}
/** Flags that belong to the whole chat, helpers included: a typed pipeline command, the model switch, the person's "whole file" turn, the running label. */
function sessionMarker(ctx, name) {
  return join(sessionDir(ctx.sid), name);
}
function hasSessionMarker(ctx, name) {
  return existsSync(sessionMarker(ctx, name));
}
function setSessionMarker(ctx, name, text = "") {
  ensureSessionDir(ctx.sid);
  writeFileSync(sessionMarker(ctx, name), text, { mode: 0o600 });
}
function dropSessionMarker(ctx, name) {
  try { rmSync(sessionMarker(ctx, name), { force: true }); } catch { /* already gone */ }
}

function breakerOpen(sid) {
  try {
    const file = join(sessionDir(sid), "failures.log");
    return existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= BREAKER_FAILURES;
  } catch {
    return false;
  }
}
function recordFailure(sid, event, err) {
  try {
    ensureSessionDir(sid);
    appendPrivate(join(sessionDir(sid), "failures.log"), `${new Date().toISOString()} ${event} ${String(err?.message ?? err).slice(0, 200)}\n`);
  } catch { /* nothing more to do */ }
}

/** True only when this call may change what the model sees. */
function acting(ctx) {
  return ctx.config.mode === "on" && ctx.arm === "on" && !ctx.pipeline && !ctx.fullOutputTurn;
}

/** Cheaper-model jobs can be switched off while every reading rule stays on: the like-for-like plain side of a pair. */
function delegationOn(ctx) {
  return ctx.config.delegation !== "off";
}

/**
 * Routing (docs/ambient-mode.md, "Routing") may act: zero-touch on, this chat
 * on the acting arm, workflows switched on, no workflow running yet, and not
 * inside a helper agent.
 */
function routingOn(ctx) {
  return ctx.config.mode === "on" && ctx.arm === "on" && ctx.config.routing === "on" && !ctx.pipeline && !ctx.agent;
}

/**
 * The chat has changed files (a Write, an Edit, the batch write, or a Bash
 * command that writes). A job-shaped message after that is a follow-up to the
 * work in hand, never a new workflow (offline audit, 25 Sep).
 */
function workStarted(ctx) {
  return hasSessionMarker(ctx, "work_started");
}
function markWorkStarted(ctx) {
  if (hasSessionMarker(ctx, "work_started")) return;
  setSessionMarker(ctx, "work_started");
  appendEvent(ctx.sid, "session.work_started", {});
}

/**
 * Starts a routed workflow: the policy it will run with must pass the
 * workflow's own run-start check; a folder with no saved policy gets the
 * routing default (as /mmo:setup's scripted path writes it); then the chat
 * becomes a workflow run and zero-touch stands down, as for a typed command.
 * Returns null when started, else why it cannot start.
 */
function startWorkflow(ctx, route) {
  try {
    const found = workflowPolicy({ projectDir: ctx.projectDir, fallback: ctx.config.routing_defaults.policy });
    if (found.error) return found.error;
    const pre = prerequisites({ projectDir: ctx.projectDir, policy: found.policy });
    if (!pre.ok) return pre.why;
    const saved = saveWorkflowPolicy({ projectDir: ctx.projectDir, policy: found.policy });
    writeRoute(ctx.sid, { ...route, status: "started" });
    setSessionMarker(ctx, "pipeline");
    appendEvent(ctx.sid, "session.pipeline", { via: "route" });
    appendEvent(ctx.sid, "route.started", { job: route.job, via: route.via, policy: saved.policy, policy_written: saved.written });
    return null;
  } catch (err) {
    return `its setup could not be checked (${String(err?.message ?? err).slice(0, 120)}).`;
  }
}

/** Guard A: while a routed workflow waits for its start, nothing that changes files or starts a helper may run. */
function blockUntilStarted(ctx) {
  if (ctx.pipeline || ctx.agent) return false;
  const route = readRoute(ctx.sid);
  if (route?.status !== "pending") return false;
  appendEvent(ctx.sid, "route.tool_blocked", { tool: String(ctx.input.tool_name ?? "") });
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: startFirstReason(route.job) } });
  return true;
}

function standDownReason(ctx) {
  if (ctx.config.mode !== "on") return "mode-" + ctx.config.mode;
  if (ctx.arm !== "on") return "control-arm";
  if (ctx.pipeline) return "pipeline-session";
  if (ctx.fullOutputTurn) return "asked-for-full-output";
  return null;
}

function insideDir(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function absOf(ctx, p) {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

/** Inputs to the cost rule that do not depend on the particular result. */
function costInputs(ctx, valve) {
  const cost = ctx.config.cost ?? {};
  const facts = lastTurnFacts(ctx.input.transcript_path);
  const prices = pricesFor(ctx.config, facts.model ?? ctx.config.thinker);
  if (!prices) return null;
  const counts = valveCounts(ctx.projectDir, valve);
  const pf = Array.isArray(cost.prior_full_reread) ? cost.prior_full_reread : [1, 5];
  const pr = Array.isArray(cost.prior_ranged_followup) ? cost.prior_ranged_followup : [2, 4];
  return {
    C: facts.contextTokens ?? num(cost.unknown_context_tokens, 100000),
    w: prices.w,
    r: prices.r,
    N: num(readMeasuredNHat() ?? cost.n_hat, 23),
    p: posteriorMean(counts.full, counts.acts, pf[0], pf[1]),
    q: posteriorMean(counts.ranged, counts.acts, pr[0], pr[1]),
    L: num(cost.developer_time_usd_per_s, 0) * num(cost.extra_request_seconds, 8),
    cpt: num(cost.chars_per_token, 4, 1),
    share: num(cost.ranged_followup_share, 0.25),
    margin: num(cost.margin_usd, 0),
    tier: prices.tier,
  };
}

/** The census writes the machine's own median "requests left before a reset" here. */
function readMeasuredNHat() {
  try {
    const m = JSON.parse(readFileSync(join(mmoHome(), "measured.json"), "utf8"));
    return typeof m.n_hat === "number" && m.n_hat > 0 ? m.n_hat : null;
  } catch {
    return null;
  }
}

function ruleFor(ci, fullChars, keptChars) {
  const F = fullChars / ci.cpt;
  const K = keptChars / ci.cpt;
  return { F, K, verdict: decide({ F, K, R: F * ci.share, C: ci.C, w: ci.w, r: ci.r, N: ci.N, p: ci.p, q: ci.q, L: ci.L }, ci.margin) };
}

function outlineHeader(path, totalLines, chars) {
  return (
    `[mmo] ${path} has ${totalLines} lines (${chars} chars). To keep the context small this is a code-built OUTLINE, not the file's text.\n` +
    "Each entry is L<first>-<last> <declaration>. Read the part you need with Read offset/limit. " +
    "A second plain Read of this file returns all of it.\n\n"
  );
}

/** A follow-up on a file this session only showed as an outline. Counted once per kind. */
function noteFollowUp(ctx, abs, kind, tokens) {
  let info = null;
  try { info = JSON.parse(readFileSync(join(scopeDir(ctx), "acts", actKey(abs)), "utf8")); } catch { return; }
  const seen = join(scopeDir(ctx), "acts", actKey(abs) + "." + kind);
  if (existsSync(seen)) return;
  writeFileSync(seen, "", { mode: 0o600 });
  recordValve(ctx.projectDir, info.valve, kind);
  const facts = lastTurnFacts(ctx.input.transcript_path);
  appendEvent(ctx.sid, "valve.regret", {
    act_id: info.act_id, valve: info.valve, kind, path: abs, tokens, context_tokens: facts.contextTokens ?? undefined,
  });
}

function actKey(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function rememberAct(ctx, abs, valve, actId) {
  ensureDir(join(ensureScopeDir(ctx), "acts"));
  writeFileSync(join(scopeDir(ctx), "acts", actKey(abs)), JSON.stringify({ act_id: actId, valve }), { mode: 0o600 });
}

/**
 * A trigger fired. Decide whether its one line is shown, and log the firing
 * either way. Returns the line or null. Never throws into the handler: an
 * offer is a convenience, and a fault here must leave the tool result alone.
 */
/**
 * The one line per kind, at the FIRST moment the cost rule says handing over
 * pays (23 Sep). A trigger only brings evidence; this decides with the same
 * arithmetic the server's gate uses at the call. Before the rule says yes the
 * plugin stays silent (one "not yet" is logged, never shown); after it has
 * spoken for a kind it never speaks again for it. Nothing forces.
 */
/**
 * The two lines that remain (23 Sep): the scout (a reading job the thinker may
 * not know it needs) and the bug fix (an event, a failing test the chat wrote).
 * Typing is no longer asked about: it is enforced (enforceHandover).
 */
async function considerOffer(ctx, trigger, files = []) {
  if (!trigger.fired) return null;
  const spoken = "offer.spoken." + trigger.kind.replace(/[^a-z_]/g, "");
  if (hasMarker(ctx, spoken)) return null;
  const { drawOffer, pickWorker } = await import("./lib/offers.mjs");
  const standDown = standDownReason(ctx) ?? (!delegationOn(ctx) ? "delegation-off" : null) ?? (hasSessionMarker(ctx, "off_thinker") ? "off-thinker" : null);
  const pick = pickWorker(ctx.config, trigger.job, fileKindOf(files));
  const cell = pick.cell;
  const base = { trigger: trigger.kind, job: trigger.job, count: trigger.count, worker: pick.worker ?? undefined, cell: cell.cellKey, cell_state: cell.state, p_pays: cell.P, saving_basis: cell.saving_basis };
  if (standDown || cell.state === "closed") {
    if (!hasMarker(ctx, "offer.noted." + trigger.kind)) { setMarker(ctx, "offer.noted." + trigger.kind); appendEvent(ctx.sid, "offer.not_eligible", { ...base, reason: standDown ?? "cell-closed" }); }
    return null;
  }
  const rule = trigger.kind === "reads_fan_out" ? scoutRule(ctx, pick, trigger.count) : { ...handoverRule(ctx, pick, 0), net: 1 };
  if (!(rule.net > 0)) {
    if (!hasMarker(ctx, "offer.notyet." + trigger.kind)) { setMarker(ctx, "offer.notyet." + trigger.kind); appendEvent(ctx.sid, "offer.not_yet", { ...base, break_even_reads: rule.breakEvenReads ?? undefined, net_usd: rule.net ?? undefined }); }
    return null;
  }
  setMarker(ctx, spoken);
  const drawn = drawOffer(ctx.sid, trigger.kind, num(ctx.config.offers?.share, 1), process.env, undefined, scopeDir(ctx));
  appendEvent(ctx.sid, "offer.eligible", { ...base, shown: drawn.shown, propensity: drawn.propensity, break_even_chars: rule.breakEvenChars ?? undefined, break_even_reads: rule.breakEvenReads ?? undefined, net_usd: rule.net ?? undefined });
  return drawn.shown ? offerLine({ ...trigger, breakEvenChars: rule.breakEvenChars, breakEvenReads: rule.breakEvenReads }) : null;
}

/**
 * ENFORCED hand-over (build spec v1.3, 23 Sep): the thinker does not type what
 * a worker types cheaper. A by-hand write of new code files, new test files,
 * or the same edit in yet another file, whose typing is above this chat's
 * break-even, is refused with the hand-over tool's full name; below it, it
 * runs. Twelve pairs showed asking does not work: told in the note and in a
 * line at the right moment, the thinker typed everything itself. The sum now
 * says a worker types almost any file for about a third of the thinker's
 * price (cost-rule.mjs), so refusing is the cheaper path nearly every time.
 *
 * The way out is never a loop: a file whose job FAILED or was refused by the
 * gate as too small is released (lib/released.mjs); a file refused twice goes
 * through the third time, logged; no worker reachable or the cell closed,
 * nothing is refused; never on the rules-only side; off with
 * `offers.enforce_handover: false`.
 */
const HANDOVER = {
  new_files_written: { job: "boilerplate", tool: "write_files_from_specs", what: "new files", how: "as one-paragraph specs" },
  test_files_written: { job: "tests", tool: "write_tests_from_cases", what: "test files", how: "as lists of cases" },
  same_edit_in_files: { job: "repeat_edit", tool: "repeat_edit_across_files", what: "files", how: "with your edit and their list" },
};
const MAX_REFUSALS_PER_FILE = 2;
async function enforceHandover(ctx, { kind, paths, chars, retryHint }) {
  const k = HANDOVER[kind];
  if (!k || !delegationOn(ctx) || !acting(ctx) || ctx.config.offers?.enforce_handover === false || !(chars > 0)) return null;
  const abs = paths.map((p) => absOf(ctx, p));
  if (abs.some((a) => isReleased(ctx.sid, a))) { appendEvent(ctx.sid, "typing.allowed", { kind, why: "released", files: paths.length, chars }); return null; }
  const { pickWorker } = await import("./lib/offers.mjs");
  const pick = pickWorker(ctx.config, k.job, fileKindOf(paths));
  if (!pick.worker || pick.cell.state === "closed") return null;
  const rule = handoverRule(ctx, pick, chars);
  if (!(rule.net > 0)) return null;
  const counts = abs.map((a) => Number(readMarker(ctx, "refused." + actKey(a))) || 0);
  if (counts.some((n) => n >= MAX_REFUSALS_PER_FILE)) { appendEvent(ctx.sid, "typing.allowed", { kind, why: "refused-twice", files: paths.length, chars }); return null; }
  for (const a of abs) setMarker(ctx, "refused." + actKey(a), String((Number(readMarker(ctx, "refused." + actKey(a))) || 0) + 1));
  appendEvent(ctx.sid, "typing.refused", { kind, tool: k.tool, worker: pick.worker, files: paths.length, chars, break_even_chars: rule.breakEvenChars, net_usd: rule.net });
  const n = (x) => Number(x).toLocaleString("en-US");
  return `[mmo] Not typed by you: ${n(chars)} characters of ${k.what}. Above ${n(rule.breakEvenChars)} characters a worker types this for about a third of the price, so in this chat it goes to the worker. Hand ${paths.length === 1 ? "this file" : "these files"} and all the ${k.what} still to come to ${toolRef(k.tool)} ${k.how}, in one call; the worker types them, code checks each, the tests run in a copy, the files land. Below the break-even you type it yourself; a job the worker cannot do comes back to you. ${consentSentence(ctx)} ${retryHint}`;
}

function scoutRule(ctx, pick, readsSoFar) {
  const facts = lastTurnFacts(ctx.input.transcript_path);
  const prices = pricesFor(ctx.config, facts.model ?? ctx.config.thinker);
  const card = pick.model ? ctx.config.jobs?.worker_prices_usd_per_mtok?.[pick.model] : null;
  if (!prices || !card) return { net: null, breakEvenReads: null };
  const C = facts.contextTokens ?? num(ctx.config.cost?.unknown_context_tokens, 100000);
  const cpt = num(ctx.config.cost?.chars_per_token, 4, 1);
  const readCost = C * prices.r;
  const scoutCost = readCost + ((300 * 1024) / cpt) * (card.input / 1e6);
  return { net: readsSoFar * readCost - scoutCost, breakEvenReads: Math.ceil(scoutCost / readCost), breakEvenChars: null };
}

/** The typing rule's inputs for this chat and worker: thinker prices from the transcript's model, the worker's card, the chat's size. */
function handoverRule(ctx, pick, chars) {
  const facts = lastTurnFacts(ctx.input.transcript_path);
  const prices = pricesFor(ctx.config, facts.model ?? ctx.config.thinker);
  const card = pick.model ? ctx.config.jobs?.worker_prices_usd_per_mtok?.[pick.model] : null;
  const worker = card ? { in: card.input / 1e6, out: card.output / 1e6 } : null;
  // The start call replaces the thinker's own write call, so it is not extra. Only the polls a job
  // past the wait needed are extra: measured requests per hand-over minus the start call, never below
  // zero; with landing manual or the wait off, one collect and one land call are extra.
  const guess = ctx.config.jobs?.landing === "manual" || Number(ctx.config.jobs?.block_ms ?? 540000) === 0 ? 2 : 0;
  const measured = measuredExtraRequests();
  const extraRequests = Math.max(0, measured === null ? guess : measured - 1);
  return handoverNet({ chars, C: facts.contextTokens ?? num(ctx.config.cost?.unknown_context_tokens, 100000), prices, worker, extraRequests, cpt: num(ctx.config.cost?.chars_per_token, 4, 1) });
}

/** The job kind behind each start tool that types (the scout reads; consent starts nothing). */
const JOB_OF_START_TOOL = { fix_from_analysis: "bugfix_code", repeat_edit_across_files: "repeat_edit", write_files_from_specs: "boilerplate", write_tests_from_cases: "tests" };

/** The files a start tool's input declares, read for the gate; null for tools that type nothing. */
function declaredPathsOf(name, input) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  if (name === "fix_from_analysis") return list(input?.analysis?.bug_files);
  if (name === "repeat_edit_across_files") return list(input?.files);
  if (name === "write_files_from_specs") return Array.isArray(input?.specs) ? input.specs.map((s) => s?.path).filter((x) => typeof x === "string") : [];
  if (name === "write_tests_from_cases") return Array.isArray(input?.tests) ? input.tests.map((t) => t?.path).filter((x) => typeof x === "string") : [];
  return null;
}

/**
 * A landed job is settled only by what proves it. A PASSING test run settles
 * every job landed since the last one as held (good). A failing run settles
 * nothing: a half-built project fails for its own reasons (23 Sep: eight
 * test-file jobs were blamed for a project that could not yet run). Wrong is
 * proven by an undo (apply.mjs) or by the thinker rewriting one of the landed
 * files before any passing run (settleRewrittenLanding). apply.mjs leaves one
 * marker per landed job naming the cell and the files.
 */
function pendingLandings(ctx) {
  const dir = join(sessionDir(ctx.sid), "landed-pending");
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    let raw = "";
    try { raw = readFileSync(join(dir, name), "utf8").trim(); } catch { continue; }
    let rec = null;
    try { rec = JSON.parse(raw); } catch { rec = { cell: raw, files: [] }; }
    if (rec && typeof rec.cell === "string" && rec.cell) out.push({ name, file: join(dir, name), cell: rec.cell, files: Array.isArray(rec.files) ? rec.files : [] });
  }
  return out;
}

function settleLandedJobs(ctx) {
  for (const p of pendingLandings(ctx)) {
    try { rmSync(p.file, { force: true }); } catch { /* raced with another hook */ }
    recordLanding(p.cell, "good");
    appendEvent(ctx.sid, "job.outcome", { job: p.name, cell: p.cell, outcome: "good", via: "test-run" });
  }
}

/** The thinker is about to write one of a landed job's files before any passing run: that job was wrong. */
function settleRewrittenLanding(ctx, absPaths) {
  const rels = new Set(absPaths.map((a) => relative(ctx.projectDir, a)));
  for (const p of pendingLandings(ctx)) {
    if (!p.files.some((f) => rels.has(f))) continue;
    try { rmSync(p.file, { force: true }); } catch { /* raced with another hook */ }
    recordLanding(p.cell, "bad");
    appendEvent(ctx.sid, "job.outcome", { job: p.name, cell: p.cell, outcome: "bad", via: "rewrite" });
  }
}

function noteTestFile(ctx, filePath) {
  if (typeof filePath === "string" && isTestPath(filePath) && !hasMarker(ctx, "test_file_touched")) setMarker(ctx, "test_file_touched");
}

// ---------- handlers ----------

const handlers = {
  "session-start"(ctx) {
    const arm = drawArm(ctx.sid, num(ctx.config.control?.share, 0.5));
    if (["clear", "compact"].includes(ctx.input.source)) appendEvent(ctx.sid, "context.reset", { cause: ctx.input.source });
    appendEvent(ctx.sid, "session.start", {
      arm: arm.arm, forced: arm.forced, control_share: arm.control_share,
      mode: ctx.config.mode, delegation: ctx.config.delegation === "off" ? "off" : "on", config_sources: ctx.sources.join(","),
      source: ctx.input.source, model: canonicalModel(ctx.input.model) || undefined,
      transcript_path: ctx.input.transcript_path, repo: repoKey(ctx.projectDir),
      effort: effortOf(ctx.input), repo_kind: repoKind(ctx.projectDir),
    });
    sweepOldSessions(ctx);
    // The start-of-chat note (which worker tools exist and how they are
    // reached) is sent at the chat's first ordinary prompt, by the prompt
    // handler, never here: at session start nobody can know yet whether the
    // chat is a typed /mmo: run, and from 0.8.3 a typed run must see nothing
    // of ambient mode (it runs exactly as on 0.7.6). A compaction drops the
    // note from the context, so a chat that already had it gets it again
    // here; after /clear the next prompt decides again.
    if (ctx.input.source === "clear") dropSessionMarker(ctx, "note_sent");
    if (ctx.input.source === "compact" && hasSessionMarker(ctx, "note_sent") && !ctx.pipeline && ctx.config.mode === "on" && arm.arm === "on") {
      emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionNote(ctx) } });
    }
  },

  "subagent-start"(ctx) {
    // A helper agent Opus started (SubagentStart). Its note travels on its first
    // tool result (noteOnce); here only the fact is recorded. Pipeline agents
    // are told apart by the session's pipeline flag, not by being agents.
    appendEvent(ctx.sid, "agent.start", { agent_type: typeof ctx.input.agent_type === "string" ? ctx.input.agent_type : undefined });
  },

  prompt(ctx) {
    const text = typeof ctx.input.prompt === "string" ? ctx.input.prompt : "";
    // Claude Code delivers some things through the prompt hook that nobody
    // typed: a background command's completion notice, queued as a message
    // (seen live: "3 prompts" on a side where the person typed two). Such a
    // message is a tagged block; it is logged as a system notice, never
    // labelled as work and never inherits or sets the running label.
    // Only the app's own notice tags mark a machine notice; a person pasting HTML is still a person.
    const typed = !NOTICE_TAG.test(text);
    let previous = null;
    try { previous = readFileSync(sessionMarker(ctx, "last_label"), "utf8").trim() || null; } catch { /* first prompt */ }
    const { label, inherited } = typed ? labelPrompt(text, previous) : { label: "system", inherited: false };
    if (typed) setSessionMarker(ctx, "last_label", label);
    if (isPipelineCommand(text) && !ctx.pipeline) {
      setSessionMarker(ctx, "pipeline");
      appendEvent(ctx.sid, "session.pipeline", { via: "prompt" });
    }
    // A session can be on another model without any switch event: started
    // with --model, or the app's default is a different model. The last reply
    // in the transcript says which model is really answering.
    const answering = canonicalModel(lastTurnFacts(ctx.input.transcript_path).model);
    const thinker = canonicalModel(ctx.config.thinker);
    if (answering && thinker) {
      const flagged = hasSessionMarker(ctx, "off_thinker");
      if (answering !== thinker && !flagged) {
        setSessionMarker(ctx, "off_thinker");
        appendEvent(ctx.sid, "session.off_thinker", { model: answering, seen_in: "transcript" });
      } else if (answering === thinker && flagged) {
        dropSessionMarker(ctx, "off_thinker");
        appendEvent(ctx.sid, "model.back_on_thinker", { seen_in: "transcript" });
      }
    }
    if (wantsFullOutput(text)) setSessionMarker(ctx, "full_output_turn");
    else dropSessionMarker(ctx, "full_output_turn");
    appendEvent(ctx.sid, "prompt", {
      prompt_id: ctx.input.prompt_id ?? randomUUID(), label, inherited, typed, chars: text.length,
      effort: effortOf(ctx.input),
    });
    const pipeline = ctx.pipeline || isPipelineCommand(text);
    const lines = [];
    let routed = false;
    if (typed && !pipeline) {
      // A route or an offer belongs to one prompt: a new prompt ends both, so
      // nothing stays blocked and a stale offer can never be accepted later.
      const offer = readOffer(ctx.sid);
      const stale = readRoute(ctx.sid);
      if (stale?.status === "pending") { dropRoute(ctx.sid); appendEvent(ctx.sid, "route.dropped", { job: stale.job }); }
      if (offer) dropOffer(ctx.sid);
      if (routingOn(ctx) && !workStarted(ctx)) {
        let route = null;
        if (offer && isPlainYes(text)) {
          route = { job: offer.job, args: offer.args ?? "", via: "yes" };
        } else {
          if (offer) appendEvent(ctx.sid, "route.offer_declined", { job: offer.job });
          const r = routeMessage(text, folderKind(ctx.projectDir));
          if (r.job) route = { job: r.job, args: r.args, via: "rules" };
          else appendEvent(ctx.sid, "route.none", { reason: r.reason });
        }
        if (route) {
          // Never tell Opus to start a workflow that its own run-start check would stop.
          const found = workflowPolicy({ projectDir: ctx.projectDir, fallback: ctx.config.routing_defaults.policy });
          const pre = found.error ? { ok: false, why: found.error } : prerequisites({ projectDir: ctx.projectDir, policy: found.policy });
          if (pre.ok) {
            writeRoute(ctx.sid, { ...route, status: "pending", prompt_id: ctx.input.prompt_id ?? null });
            appendEvent(ctx.sid, "route.decided", { job: route.job, via: route.via });
            lines.push(startInstruction({ ...route, auth: ctx.config.routing_defaults.auth }));
            routed = true;
          } else {
            appendEvent(ctx.sid, "route.cannot_start", { job: route.job });
            lines.push(cannotStartInstruction(route.job, pre.why));
          }
        }
      }
    }
    // Where the plugin acts, the model is told once which worker tools exist
    // and how they are reached. Without this the first it hears of a tool is
    // one line in the middle of a task, naming a tool it cannot see (seen live
    // on 22 Sep: line read, tool never called). Sent at the first typed prompt
    // that is not a /mmo: command, so a typed pipeline run never carries it,
    // and not with a prompt that starts a workflow (that chat becomes a run).
    if (typed && !pipeline && !routed && ctx.config.mode === "on" && ctx.arm === "on" && !hasSessionMarker(ctx, "note_sent")) {
      setSessionMarker(ctx, "note_sent");
      lines.unshift(sessionNote(ctx));
    }
    if (lines.length) emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n\n") } });
  },

  "pre-skill"(ctx) {
    // Guard B. Every command start, typed or model-started, is a Skill call
    // (probed live on Claude Code 2.1.282). Zero-touch off, the control arm,
    // or a typed / started workflow: nothing to decide, as on 0.7.7.
    const name = String(ctx.input.tool_input?.skill ?? "");
    if (!/^mmo:/.test(name)) return;
    if (ctx.config.mode !== "on" || ctx.arm !== "on" || ctx.pipeline) return;
    const job = name.slice("mmo:".length);
    const deny = (why) => emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    const route = readRoute(ctx.sid);
    if (route?.status === "pending") {
      if (route.job !== job) return void deny(startFirstReason(route.job));
      const why = startWorkflow(ctx, route);
      if (why) deny(cannotStartInstruction(job, why));
      return;
    }
    if (ctx.agent || ctx.config.routing !== "on" || !ROUTABLE_JOBS.has(job) || workStarted(ctx)) {
      appendEvent(ctx.sid, "route.refused", { job });
      return void deny(NOT_NOW_REASON);
    }
    const args = typeof ctx.input.tool_input?.args === "string" ? ctx.input.tool_input.args.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (ctx.config.routing_unsure === "auto") {
      const why = startWorkflow(ctx, { job, args, via: "model" });
      if (why) deny(cannotStartInstruction(job, why));
      return;
    }
    writeOffer(ctx.sid, { job, args });
    appendEvent(ctx.sid, "route.offered", { job });
    deny(askReason(job));
  },

  "prompt-expansion"(ctx) {
    const name = String(ctx.input.command_name ?? "");
    if (/^\/?mmo:/.test(name) && !ctx.pipeline) {
      setSessionMarker(ctx, "pipeline");
      appendEvent(ctx.sid, "session.pipeline", { via: "expansion" });
    }
  },

  "turn-end"(ctx) {
    // The thinker finished answering. The board uses this to say "this task is
    // done" and only then shows what each side of a pair cost.
    appendEvent(ctx.sid, "turn.end", {});
  },

  "context-reset"(ctx) {
    appendEvent(ctx.sid, "context.reset", { cause: ctx.input.trigger ?? "compact" });
  },

  "pre-model-switch"(ctx) {
    const thinker = canonicalModel(ctx.config.thinker);
    const to = canonicalModel(ctx.input.to_model);
    const asked = canonicalModel(ctx.input.requested_model);
    const leaves = Boolean(thinker) && to !== thinker && asked !== thinker;
    appendEvent(ctx.sid, "model.switch_request", { to, leaves_thinker: leaves, locked: ctx.config.lock_model === true });
    if (leaves && ctx.config.lock_model === true && ctx.config.mode === "on" && !ctx.pipeline) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreModelSwitch",
          permissionDecision: "deny",
          permissionDecisionReason:
            `This project runs on ${thinker} (mmo ambient policy, lock_model: true). ` +
            "Set lock_model to false in ~/.mmo-ambient/ambient.json to allow switching.",
        },
      });
    }
  },

  "post-model-switch"(ctx) {
    const thinker = canonicalModel(ctx.config.thinker);
    const to = canonicalModel(ctx.input.to_model);
    if (thinker && to && to !== thinker) {
      setSessionMarker(ctx, "off_thinker");
      appendEvent(ctx.sid, "session.off_thinker", { model: to });
    } else if (to === thinker) {
      dropSessionMarker(ctx, "off_thinker");
      appendEvent(ctx.sid, "model.back_on_thinker", {});
    }
  },

  "pre-agent"(ctx) {
    if (blockUntilStarted(ctx)) return;
    const type = String(ctx.input.tool_input?.subagent_type ?? "");
    if (!type.startsWith("mmo:")) return;
    // The five mmo agents belong to the typed pipeline. In ordinary chat the
    // model picking one up on its own starts a gated run nobody asked for.
    const blocked = !ctx.pipeline && !ctx.agent;
    appendEvent(ctx.sid, "agent.mmo-ambient_request", { agent: type, blocked: blocked && ctx.config.mode === "on" });
    if (blocked && ctx.config.mode === "on") {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `${type} runs only inside a workflow the person started or agreed to. None is running in this chat, so carry on with your own tools.`,
        },
      });
    }
  },

  async "post-read"(ctx) {
    const v = ctx.config.valves?.read;
    if (!v || v.enabled === false) return;
    const ti = ctx.input.tool_input ?? {};
    const file = ctx.input.tool_response?.file;
    if (ctx.input.tool_response?.type !== "text" || typeof file?.content !== "string" || typeof ti.file_path !== "string") return;
    const abs = absOf(ctx, ti.file_path);

    if (insideDir(abs, mmoHome())) return; // the plugin's own files are never outlined
    // The reads-fan-out moment: distinct project files opened by hand, counted per chat (per helper agent).
    if (insideDir(abs, ctx.projectDir)) {
      const counted = countFilesRead(ctx, abs);
      const line = await considerOffer(ctx, readsFanOutTrigger(counted), [relative(ctx.projectDir, abs)]);
      if (line) { emitContext("PostToolUse", [line]); return; }
    }

    const ranged = ti.offset !== undefined && ti.offset !== null || ti.limit !== undefined && ti.limit !== null;
    if (ranged) {
      // The stateless escape: a read that names its own range always passes.
      if (isPartial(ctx.sid, abs)) noteFollowUp(ctx, abs, "ranged", file.content.length / num(ctx.config.cost?.chars_per_token, 4, 1));
      return;
    }
    if (isPartial(ctx.sid, abs)) {
      // Second plain read of an outlined file: the model wants all of it. Let
      // it through, count the regret, and the file now counts as fully seen.
      noteFollowUp(ctx, abs, "full", file.content.length / num(ctx.config.cost?.chars_per_token, 4, 1));
      clearPartial(ctx.sid, abs);
      return;
    }

    const chars = file.content.length;
    if (chars < num(v.min_chars, 8000, 1000)) return;
    if (typeof file.totalLines === "number" && typeof file.numLines === "number" && file.numLines < file.totalLines) return;

    const outline = buildOutline(file.content, abs, {
      budgetChars: num(v.outline_budget_chars, 9000, 500), minCoverage: num(v.min_coverage, 0.7),
    });
    if (!outline) return void appendEvent(ctx.sid, "valve.skip", { valve: "read", path: abs, reason: "no-fair-outline", chars });

    const kept = outlineHeader(abs, outline.totalLines, chars) + outline.body;
    const ci = costInputs(ctx, "read");
    if (!ci) return void appendEvent(ctx.sid, "valve.skip", { valve: "read", path: abs, reason: "no-price-card", chars });
    const { F, K, verdict } = ruleFor(ci, chars, kept.length);
    const fields = {
      valve: "read", path: abs, chars_full: chars, chars_kept: kept.length, tokens_full: F, tokens_kept: K,
      context_tokens: ci.C, n_hat: ci.N, p: ci.p, q: ci.q, cache_tier: ci.tier, net_usd: verdict.net,
    };
    if (!verdict.act) return void appendEvent(ctx.sid, "valve.skip", { ...fields, reason: verdict.reason });
    if (!acting(ctx) || v.act === false) {
      return void appendEvent(ctx.sid, "valve.would_act", { ...fields, reason: standDownReason(ctx) ?? "valve-observe" });
    }

    const actId = randomUUID();
    markPartial(ctx.sid, abs);
    rememberAct(ctx, abs, "read", actId);
    recordValve(ctx.projectDir, "read", "act");
    appendEvent(ctx.sid, "valve.act", { ...fields, act_id: actId });
    emit({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          type: "text",
          file: { ...file, content: kept, numLines: kept.split("\n").length, startLine: 1, totalLines: outline.totalLines },
        },
      },
    });
  },

  async "pre-write"(ctx) {
    if (blockUntilStarted(ctx)) return;
    const p = ctx.input.tool_input?.file_path;
    if (typeof p !== "string") return;
    noteTestFile(ctx, p);
    const abs = absOf(ctx, p);
    settleRewrittenLanding(ctx, [abs]);
    if (!existsSync(abs) && insideDir(abs, ctx.projectDir)) {
      const reason = await enforceHandover(ctx, { kind: isTestPath(p) ? "test_files_written" : "new_files_written", paths: [p], chars: String(ctx.input.tool_input?.content ?? "").length, retryHint: "A second refusal of the same file is the last; the third try goes through." });
      if (reason) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    }
    if (!isPartial(ctx.sid, abs) || !existsSync(abs)) return;
    appendEvent(ctx.sid, "write.partial_view_denied", { path: abs });
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `${abs} was shown to you as an outline only, so a whole-file Write would drop everything you have not seen. ` +
          "Read the file (a second plain Read returns all of it), or change it with Edit.",
      },
    });
  },

  async "pre-bash"(ctx) {
    if (blockUntilStarted(ctx)) return;
    const command = ctx.input.tool_input?.command;
    // A file written through Bash (sed -i, a redirect, a heredoc, a script) is
    // still a file written. One test-file write in four arrives this way, and a
    // greenfield build was seen writing every one of its files with heredocs.
    // A path that does not exist yet MAY become a new file. It is only noted
    // here; it is counted after the command ran, when the file really exists
    // (see newFilesFromBash). Nothing is said to the model from this hook.
    const pending = [];
    const written = bashWrittenPaths(command);
    settleRewrittenLanding(ctx, written.map((p) => absOf(ctx, p)));
    for (const p of written) {
      noteTestFile(ctx, p);
      const abs = absOf(ctx, p);
      if (!existsSync(abs) && insideDir(abs, ctx.projectDir)) pending.push(abs);
    }
    if (pending.length) {
      const rels = pending.map((abs) => relative(ctx.projectDir, abs));
      // The whole command is what the thinker typed; its length is the typing about to happen.
      const reason = await enforceHandover(ctx, { kind: rels.every(isTestPath) ? "test_files_written" : "new_files_written", paths: rels, chars: String(command ?? "").length, retryHint: "A second refusal of the same files is the last; the third try goes through." });
      if (reason) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      const dir = join(ensureScopeDir(ctx), "pending-new");
      ensureDir(dir);
      writeFileSync(join(dir, pendingKey(ctx)), JSON.stringify(pending), { mode: 0o600 });
    }
    const v = ctx.config.valves?.file_dump;
    if (!v || v.enabled === false) return;
    const dump = parseFileDump(command);
    if (!dump) return;
    const abs = absOf(ctx, dump.file);
    let real;
    let st;
    try { real = realpathSync(abs); st = statSync(real); } catch { return; }
    let root = ctx.projectDir;
    try { root = realpathSync(ctx.projectDir); } catch { /* keep as given */ }
    if (!st.isFile() || !insideDir(real, root)) return;
    if (st.size < num(v.min_chars, 6000, 1000) || st.size > num(v.max_file_bytes, 5_000_000, 1)) return;

    // The same dump asked for twice is the model insisting: let it run.
    const repeatKey = "dump." + actKey(command);
    if (hasMarker(ctx, repeatKey)) {
      noteFollowUp(ctx, real, "full", st.size / num(ctx.config.cost?.chars_per_token, 4, 1));
      clearPartial(ctx.sid, real);
      return;
    }

    const text = readFileSync(real, "utf8");
    const totalLines = text.split("\n").length;
    const lines = rangeLineCount(dump.range, totalLines);
    if (lines === null) return void appendEvent(ctx.sid, "valve.seen", { valve: "file_dump", tool: dump.tool, path: real, reason: "size-unknown" });
    const estChars = Math.round(text.length * (lines / Math.max(totalLines, 1)));
    if (estChars < num(v.min_chars, 6000, 1000)) return;

    const outline = buildOutline(text, real, {
      budgetChars: num(ctx.config.valves?.read?.outline_budget_chars, 9000, 500),
      minCoverage: num(ctx.config.valves?.read?.min_coverage, 0.7),
    });
    if (!outline) return void appendEvent(ctx.sid, "valve.skip", { valve: "file_dump", path: real, reason: "no-fair-outline", chars: estChars });

    const message =
      `[mmo] \`${dump.tool}\` would print about ${estChars} chars of ${real} into the context. ` +
      "Use Read with offset/limit on the lines you need; the outline below gives the line ranges. " +
      "Running the same command again prints the file.\n\n" + outline.body;
    const ci = costInputs(ctx, "file_dump");
    if (!ci) return;
    const { F, K, verdict } = ruleFor(ci, estChars, message.length);
    const fields = {
      valve: "file_dump", tool: dump.tool, path: real, chars_full: estChars, chars_kept: message.length,
      tokens_full: F, tokens_kept: K, context_tokens: ci.C, n_hat: ci.N, p: ci.p, q: ci.q, net_usd: verdict.net,
    };
    if (!verdict.act) return void appendEvent(ctx.sid, "valve.skip", { ...fields, reason: verdict.reason });
    if (!acting(ctx) || v.act !== true) {
      return void appendEvent(ctx.sid, "valve.would_act", { ...fields, reason: standDownReason(ctx) ?? "valve-observe" });
    }

    const actId = randomUUID();
    setMarker(ctx, repeatKey);
    markPartial(ctx.sid, real);
    rememberAct(ctx, real, "file_dump", actId);
    recordValve(ctx.projectDir, "file_dump", "act");
    appendEvent(ctx.sid, "valve.act", { ...fields, act_id: actId });
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
  },

  async "post-bash"(ctx) {
    const resp = ctx.input.tool_response;
    const command = ctx.input.tool_input?.command;
    if (bashWrittenPaths(command).length) markWorkStarted(ctx);
    const lines = [noteOnce(ctx), await newFilesFromBash(ctx)];
    // A failing test run that was piped through tail or head arrives HERE, as a
    // success. Notice it from its output; never touch that output. (A rule that
    // trimmed passing test logs lived here too; it could act in 1 of 847 past
    // chats, so it was removed.)
    if (mentionsTestRunner(command)) {
      const failing = outputShowsFailingTests(String(resp?.stdout ?? "") + "\n" + String(resp?.stderr ?? ""));
      if (!failing) { settleLandedJobs(ctx); appendEvent(ctx.sid, "bash.tests_passed", { via: "output" }); }
      if (failing) {
        appendEvent(ctx.sid, "bash.failing_tests_seen", { via: "output" });
        lines.push(await considerOffer(ctx, bugfixTrigger({ testFileTouched: hasMarker(ctx, "test_file_touched"), failedRunner: "test" })));
      }
    }
    emitContext("PostToolUse", lines);
  },

  async "post-bash-failure"(ctx) {
    // Failed commands are never trimmed: the error text is what the model
    // needs most. Only the size is recorded, to size this class of output.
    const err = ctx.input.error;
    const runner = classifyRunner(ctx.input.tool_input?.command);
    appendEvent(ctx.sid, "bash.failure", {
      runner: runner ?? undefined,
      chars: typeof err === "string" ? err.length : undefined,
      is_timeout: ctx.input.is_timeout === true || undefined,
    });
    // A command can create its files and still exit non-zero (a build step
    // after the heredocs failed), so the new files are counted here as well.
    const lines = [noteOnce(ctx), await newFilesFromBash(ctx)];
    const ranTests = runner === "test" || mentionsTestRunner(ctx.input.tool_input?.command);
    lines.push(await considerOffer(ctx, bugfixTrigger({ testFileTouched: hasMarker(ctx, "test_file_touched"), failedRunner: ranTests ? "test" : runner })));
    emitContext("PostToolUseFailure", lines);
  },

  async "pre-mmo-tool"(ctx) {
    const name = ambientToolName(ctx.input.tool_name);
    if (!name) return;
    if (blockUntilStarted(ctx)) return;
    if (name === "write_files") {
      // The batch write is the thinker's OWN typing, on both sides: the partial-view guard and the
      // landed-file rule apply to each path exactly as they do to a Write.
      const paths = Array.isArray(ctx.input.tool_input?.files) ? ctx.input.tool_input.files.map((f) => f?.path).filter((x) => typeof x === "string") : [];
      const abs = paths.map((x) => absOf(ctx, x));
      settleRewrittenLanding(ctx, abs);
      const blind = abs.find((a) => existsSync(a) && isPartial(ctx.sid, a));
      if (blind) {
        appendEvent(ctx.sid, "write.partial_view_denied", { path: blind, via: "write_files" });
        return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${blind} was shown to you as an outline only, so writing the whole file would drop everything you have not seen. Read the file (a second plain Read returns all of it), or change it with Edit.` } });
      }
      for (const x of paths) noteTestFile(ctx, x);
      const files = Array.isArray(ctx.input.tool_input?.files) ? ctx.input.tool_input.files : [];
      const fresh = files.filter((f) => typeof f?.path === "string" && !existsSync(absOf(ctx, f.path)));
      if (fresh.length) {
        const reason = await enforceHandover(ctx, { kind: fresh.every((f) => isTestPath(f.path)) ? "test_files_written" : "new_files_written", paths: fresh.map((f) => f.path), chars: fresh.reduce((n, f) => n + String(f.content ?? "").length, 0), retryHint: "A second refusal of the same files is the last; the third try goes through." });
        if (reason) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      }
    }
    const standDown = standDownReason(ctx) ?? (!delegationOn(ctx) ? "delegation-off" : null) ?? (hasSessionMarker(ctx, "off_thinker") ? "off-thinker" : null);
    if (isStartTool(name) && standDown) {
      appendEvent(ctx.sid, "tool.ambient_refused", { tool: name, reason: standDown });
      return void emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `${name} is not available in this session (${standDown}). Carry on with your own tools.`,
        },
      });
    }
    // The gate's inputs ride on the stamp: the chat's break-even (typing rule, this chat's size and
    // this job's worker) and its context size. The server compares them with the job's expected typing.
    let breakEvenChars = null;
    let contextTokens = null;
    let cacheTier = null;
    try { cacheTier = pricesFor(ctx.config, lastTurnFacts(ctx.input.transcript_path).model ?? ctx.config.thinker)?.tier ?? null; } catch { /* unpriced chat */ }
    const declared = declaredPathsOf(name, ctx.input.tool_input);
    if (declared) {
      try {
        const { pickWorker } = await import("./lib/offers.mjs");
        const pick = pickWorker(ctx.config, JOB_OF_START_TOOL[name], fileKindOf(declared));
        const rule = handoverRule(ctx, pick, 0);
        breakEvenChars = rule.breakEvenChars;
        contextTokens = lastTurnFacts(ctx.input.transcript_path).contextTokens ?? null;
      } catch { /* an unpriced chat is stamped without numbers; the server then does not gate */ }
    }
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: stampInput(ctx.input.tool_input, { sessionId: ctx.sid, promptId: ctx.input.prompt_id, arm: ctx.arm, mode: ctx.config.mode, agent: ctx.agent, breakEvenChars, contextTokens, cacheTier }),
      },
    });
  },

  /** After the batch write: the files it created count as created files, so the new-files and tests moments still happen. */
  async "post-mmo-tool"(ctx) {
    if (ambientToolName(ctx.input.tool_name) !== "write_files") return;
    markWorkStarted(ctx);
    const out = mcpResult(ctx.input.tool_response);
    const created = Array.isArray(out?.created) ? out.created.filter((x) => typeof x === "string") : [];
    if (!created.length) return;
    countNewFiles(ctx, created.map((x) => absOf(ctx, x)));
    emitContext("PostToolUse", [noteOnce(ctx)]);
  },

  async "pre-edit"(ctx) {
    if (blockUntilStarted(ctx)) return;
    const ti = ctx.input.tool_input ?? {};
    noteTestFile(ctx, ti.file_path);
    // An ordinary Edit of a landed file before any passing run is the wrong verdict for that job. A marker
    // edit is the plugin's own landing, never a rewrite.
    if (typeof ti.file_path === "string" && !MARKER_EDIT.test(String(ti.old_string ?? "").trim())) settleRewrittenLanding(ctx, [absOf(ctx, ti.file_path)]);
    // The same kind of edit again, by hand, in a file it has not been made in: a repeated edit the
    // worker applies across files. The typing about to happen is this edit times the files git still
    // finds the old text in (or this edit alone when git cannot say).
    const shape = editShape(ti.old_string, ti.new_string);
    if (shape && typeof ti.file_path === "string") {
      const shapeDir = join(scopeDir(ctx), "edit-shapes", actKey(shape));
      let inFiles = 0;
      try { inFiles = readdirSync(shapeDir).length; } catch { /* first of its shape */ }
      if (inFiles >= 1 && !existsSync(join(shapeDir, actKey(absOf(ctx, ti.file_path))))) {
        let remaining = 1;
        const needle = searchNeedle(ti.old_string);
        if (needle) { try { remaining = Math.max(1, execFileSync("git", ["grep", "-l", "-F", "-e", needle], { cwd: ctx.projectDir, timeout: 2500, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean).length); } catch { /* one at least */ } }
        const reason = await enforceHandover(ctx, { kind: "same_edit_in_files", paths: [ti.file_path], chars: String(ti.new_string ?? "").length * remaining, retryHint: "A second refusal of the same file is the last; the third try goes through." });
        if (reason) return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      }
    }
    if (!MARKER_EDIT.test(String(ti.old_string ?? "").trim())) return;
    const { fillEdit, parseMarker } = await import("./lib/edit-fill.mjs");
    const marker = parseMarker(ti.old_string);
    if (!marker) return;
    const filled = typeof ti.file_path === "string"
      ? fillEdit({ ...marker, filePath: absOf(ctx, ti.file_path), maxEdits: num(ctx.config.offers?.max_marker_edits, 5, 1) })
      : { ok: false, reason: "the Edit names no file" };
    appendEvent(ctx.sid, "edit_fill", { job: marker.jobId, n: marker.n, ok: filled.ok, reason: filled.reason, path: filled.rel });
    if (!filled.ok) {
      return void emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `[mmo] ${filled.reason}. Nothing was changed.`,
        },
      });
    }
    setMarker(ctx, "filling." + marker.jobId + "." + marker.n, ctx.input.tool_use_id ?? "");
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: filled.input } });
  },

  async "post-edit"(ctx) {
    // Runs only after the native Edit SUCCEEDED.
    markWorkStarted(ctx);
    // 1. A marker edit: pair it with the fill it belongs to through the
    //    tool_use_id kept by pre-edit.
    const id = ctx.input.tool_use_id;
    let names = [];
    try { names = readdirSync(scopeDir(ctx)).filter((f) => f.startsWith("filling.")); } catch { /* no session folder yet */ }
    if (names.length) {
      const { recordFilled } = await import("./lib/edit-fill.mjs");
      for (const name of names) {
        let kept = "";
        try { kept = readFileSync(marker(ctx, name), "utf8"); } catch { continue; }
        if (kept !== (id ?? "")) continue;
        const [, jobId, n] = name.split(".");
        dropMarker(ctx, name);
        const done = recordFilled({ jobId, n: Number(n) });
        appendEvent(ctx.sid, "edit_fill.landed", { job: jobId, n: Number(n), path: done.path, file_complete: done.complete, matches_checked_result: done.matches_checked_result });
        return;
      }
    }
    // 2. An ordinary edit: is it the same KIND of edit as one already made in
    //    another file? Only the blanked shape is kept, as a folder of empty
    //    files (one per edited file), never the text.
    const ti = ctx.input.tool_input ?? {};
    const shape = editShape(ti.old_string, ti.new_string);
    if (!shape || typeof ti.file_path !== "string") return;
    const dir = join(ensureScopeDir(ctx), "edit-shapes", actKey(shape));
    ensureDir(join(scopeDir(ctx), "edit-shapes"));
    ensureDir(dir);
    const fileMarker = join(dir, actKey(absOf(ctx, ti.file_path)));
    if (existsSync(fileMarker)) return;
    writeFileSync(fileMarker, String(String(ti.new_string ?? "").length), { mode: 0o600 });
    appendEvent(ctx.sid, "edit.shape_seen", { files_with_shape: readdirSync(dir).length });
  },

  async "post-write"(ctx) {
    markWorkStarted(ctx);
    // Claude Code says whether a Write CREATED the file. Three new files in one
    // chat is the visible sign of "many files to type".
    if (ctx.input.tool_response?.type !== "create" || typeof ctx.input.tool_input?.file_path !== "string") return;
    countNewFiles(ctx, [absOf(ctx, ctx.input.tool_input.file_path)]);
    emitContext("PostToolUse", [noteOnce(ctx)]);
  },
};

/**
 * The consent status for THIS folder, in one sentence. Seen live: a note that
 * only said consent is needed was read by the model as "the person has not
 * agreed", and it typed every file itself although consent was on file.
 */
function consentSentence(ctx) {
  const everywhere = Array.isArray(ctx.config.vendors_allowed_everywhere) && ctx.config.vendors_allowed_everywhere.includes("google");
  if (everywhere) return "Sending files to Google is allowed on this machine for every folder; no consent step is needed.";
  let root = ctx.projectDir;
  try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.projectDir, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim() || root; } catch { /* not a git folder yet */ }
  const agreed = (() => { try { return hasConsent(root, "google"); } catch { return false; } })();
  return agreed
    ? "Sending files to Google from this folder is already agreed; no consent step is needed."
    : "Sending files to Google from this folder has not been agreed yet: call " + fullToolName("consent_to_send") + " once, before the first job; every job start is refused until then.";
}

/** The start-of-chat note: the worker tools by their full names, the consent status, and how the plugin decides. Under 1,200 characters. */
function sessionNote(ctx) {
  // Routing on: the note also says how full workflows start (lib/route-flow.mjs).
  const workflows = ctx.config.routing === "on" ? "\n" + workflowsParagraph() : "";
  return chatNote(ctx) + workflows;
}

function chatNote(ctx) {
  const t = (name, what) => `${fullToolName(name)} ${what}`;
  const lookupLine = `${fullToolName("lookup")} (load it with ToolSearch) finds where things live: search strings in, every matching line with its exact Read range out, in one call.`;
  const writeFilesLine = ` ${fullToolName("write_files")} writes small files you composed yourself, many in one call, and runs your test command in the same call.`;
  // PARITY (his goal 5, 23 Sep): the plain side carries every advantage the delegated
  // side has that is not the hand-over itself. Writing the design to one file before
  // building is ordinary engineering — it helps any model structure its work, worker or
  // none — so telling only the delegated side to do it would hand that side a quality
  // advantage that has nothing to do with delegation, and A minus B would stop being
  // the hand-over alone. Same sentence here, minus the worker half.
  const designLine = "Write the design to ONE file on disk before you build, and keep it there: a file the whole build follows, rather than the same architecture retold in each step.";
  if (!delegationOn(ctx)) {
    return "[mmo] The orchestrator is on in this chat with cheaper-model jobs off: nothing is handed to a worker here, every reading rule still applies. " +
      designLine + " " +
      "A big Read comes back as an outline with line numbers; Read with offset and limit shows the part you need. " + lookupLine + writeFilesLine;
  }
  // The note is not a plea and holds no rule of its own: the hook refuses
  // by-hand typing above the break-even whether or not the note is read. It
  // states that fact once and the order of a phase, so the first hand-over
  // comes before the first refusal (each refusal costs one request of the
  // thinker's). No emphasis, no imperatives: the test on the note rejects them.
  return "[mmo] The orchestrator is on in this chat. You think, plan, read, write specs and run tests; a cheaper model (Gemini Flash, at Google) types.\n" +
    "The rule, enforced by the hook: above this chat's break-even (about 800 characters) new code files, new test files and one edit repeated in more files are typed by a worker; by hand they are refused, and each refusal spends a request. The order of a phase:\n" +
    `1. New files of a phase: one call to ${fullToolName("write_files_from_specs")} for ALL the files of the phase. Write the design to ONE file first and name it: the plugin reads it once for the worker, so per file you give only the exported names, one line of behaviour, and a file to copy the style from. Specs costing more than the files they describe are refused with both numbers. Lock files, test-runner and CI configs and env files stay with you.\n` +
    `2. Test files of a phase: one call to ${fullToolName("write_tests_from_cases")} with a list of cases per file, all in that call.\n` +
    `3. One edit in several files: make it in the first, then ${fullToolName("repeat_edit_across_files")} with the edit and the rest.\n` +
    `4. A bug fix: ${fullToolName("fix_from_analysis")} with your nine-field analysis.\n` +
    `5. An unknown project: ${fullToolName("scout_repo")} before reading by hand.\n` +
    "Below it you type it yourself." + writeFilesLine + "\n" +
    "The tools are hidden until loaded: ToolSearch with select:<tool name> first. " + consentSentence(ctx) + " " +
    "One call does the whole job: the worker writes, code checks scope, your tests run in a copy, the files land, a receipt comes back. " +
    `${fullToolName("job_result")} collects a job that ran past the wait; ${fullToolName("undo_job")} takes a landed change back. ` +
    "A job the worker cannot do comes back to you.\n" +
    "Reading: a big Read comes back as an outline with line numbers; Read with offset and limit shows the part you need. " + lookupLine;
}

/** The JSON a plugin tool answered with, as Claude Code hands it to a hook: a string, a content list, or the object itself. */
function mcpResult(resp) {
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  if (typeof resp === "string") return parse(resp);
  if (Array.isArray(resp)) { const t = resp.find((c) => c && c.type === "text" && typeof c.text === "string"); return t ? parse(t.text) : null; }
  if (resp && typeof resp === "object") {
    if (Array.isArray(resp.content)) { const t = resp.content.find((c) => c && c.type === "text" && typeof c.text === "string"); return t ? parse(t.text) : null; }
    return resp;
  }
  return null;
}

/** One additionalContext for the lines that have something to say; nothing at all otherwise. */
/**
 * A helper agent never sees the chat's SessionStart note, so the first tool
 * result inside it carries the same note once. Without it the helper would
 * not know the worker tools exist (the reason the note exists at all).
 */
function noteOnce(ctx) {
  if (!ctx.agent || !acting(ctx) || hasMarker(ctx, "noted")) return null;
  setMarker(ctx, "noted");
  appendEvent(ctx.sid, "agent.noted", {});
  return sessionNote(ctx);
}

function emitContext(hookEventName, lines) {
  const said = lines.filter(Boolean);
  if (said.length) emit({ hookSpecificOutput: { hookEventName, additionalContext: said.join("\n") } });
}

/**
 * Adds these files to the session's count of CREATED files (one empty file per
 * path hash, never the path) and returns the count before and after, which is
 * what the new-files trigger decides on.
 */
function countNewFiles(ctx, absPaths) {
  // Two counters: test files are their own kind of typing with their own tool
  // and their own moment, so a test file never counts as the new-files moment.
  const base = ensureScopeDir(ctx);
  const dirs = { code: join(base, "new-files"), test: join(base, "new-test-files") };
  ensureDir(dirs.code);
  ensureDir(dirs.test);
  const before = readdirSync(dirs.code).length;
  const testBefore = readdirSync(dirs.test).length;
  for (const abs of absPaths) {
    const mark = join(isTestPath(abs) ? dirs.test : dirs.code, actKey(abs));
    let size = 0;
    try { size = statSync(abs).size; } catch { /* gone again already */ }
    if (!existsSync(mark)) writeFileSync(mark, String(size), { mode: 0o600 });
  }
  return { before, newFilesWritten: readdirSync(dirs.code).length, testBefore, testFilesWritten: readdirSync(dirs.test).length };
}

/** Distinct project files this chat opened by hand: one empty marker per path hash, never the path. */
function countFilesRead(ctx, abs) {
  const dir = join(ensureScopeDir(ctx), "files-read");
  ensureDir(dir);
  const before = readdirSync(dir).length;
  const mark = join(dir, actKey(abs));
  if (!existsSync(mark)) writeFileSync(mark, "", { mode: 0o600 });
  return { before, filesRead: readdirSync(dir).length };
}

const PENDING_NEW_MAX_AGE_MS = 15 * 60 * 1000;
/** The tags Claude Code 2.1.270 wraps its own queued notices in (read from the program, not guessed). */
const NOTICE_TAG = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

/** The note pre-bash leaves for the post-bash of the SAME tool call. */
function pendingKey(ctx) {
  return safeId(String(ctx.input.tool_use_id ?? "last"));
}

/**
 * After a Bash command ran: which of the paths it was about to create now
 * exist? Those are new files, counted once each. The offer, if any, is made
 * here, after the command, for two reasons that were both seen live:
 *   - a before-the-command hook cannot know the command will succeed, and the
 *     decision must not be spent on files that were never made;
 *   - one command can create six files at once, and the decision for the whole
 *     command is one decision, made once, on the count it reached.
 * Notes left by calls that never reached this point (refused, interrupted)
 * are dropped after a while so they can never be counted by a later call.
 */
async function newFilesFromBash(ctx) {
  const dir = join(scopeDir(ctx), "pending-new");
  if (!existsSync(dir)) return null;
  const mine = join(dir, pendingKey(ctx));
  let pending = [];
  try { pending = JSON.parse(readFileSync(mine, "utf8")); } catch { pending = []; }
  try { rmSync(mine, { force: true }); } catch { /* already gone */ }
  for (const name of readdirSync(dir)) {
    try { if (Date.now() - statSync(join(dir, name)).mtimeMs > PENDING_NEW_MAX_AGE_MS) rmSync(join(dir, name), { force: true }); } catch { /* raced with another hook */ }
  }
  const created = pending.filter((abs) => typeof abs === "string" && existsSync(abs));
  if (created.length) countNewFiles(ctx, created);
  return null;
}


/** Once a day, drop session folders older than the retention window. */
function sweepOldSessions(ctx) {
  const home = mmoHome();
  const stamp = join(home, "last-sweep");
  const dayMs = 24 * 3600 * 1000;
  try {
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < dayMs) return;
    writeFileSync(stamp, "", { mode: 0o600 });
    const keepMs = num(ctx.config.retention_days, 30, 1) * dayMs;
    for (const root of [join(home, "sessions"), join(home, "logs")]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (Date.now() - statSync(dir).mtimeMs > keepMs) rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch { /* housekeeping must never fail a session start */ }
}

async function main() {
  const event = process.argv[2];
  const handler = handlers[event];
  if (!handler) return;
  const input = await readStdinJson();
  if (!input || typeof input !== "object" || typeof input.session_id !== "string" || !input.session_id) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const { config, sources } = loadConfig({ projectDir });
  if (config.mode === "off") return;

  const sid = input.session_id;
  if (breakerOpen(sid)) return;
  // A call from inside a helper agent carries agent_id; the session id is the parent chat's.
  const agent = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  const ctx = { input, sid, cwd, projectDir, config, sources, agent, subagent: Boolean(agent) };
  setEventAgent(agent);
  try {
    ctx.arm = (readArm(sid) ?? drawArm(sid, num(config.control?.share, 0.5))).arm;
    ctx.pipeline = hasSessionMarker(ctx, "pipeline");
    ctx.fullOutputTurn = hasSessionMarker(ctx, "full_output_turn");
    await handler(ctx);
  } catch (err) {
    recordFailure(sid, event, err);
    if (DEBUG) console.error(`[mmo ambient] ${event}: ${err?.stack ?? err}`);
  }
}

main().catch(() => {}).finally(() => {
  // Flush stdout before leaving; process.exit() alone can cut a pipe short.
  process.stdout.write("", () => process.exit(0));
});
