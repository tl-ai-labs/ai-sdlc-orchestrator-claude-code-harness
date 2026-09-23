/**
 * The worker-job runner. One start call walks a fixed sequence, and every step
 * can end the job with a plain reason:
 *
 *   stamp -> session still on the thinker -> worker and cell for the job's
 *   language (value rule per worker + per-session draw)
 *   -> 429 breaker -> consent -> one-job-per-repo lock -> snapshot -> brief
 *   -> egress manifest -> ONE worker call -> strict parse -> text-only checks
 *   -> staged change -> result (bounded diff + how to land it)
 *
 * Nothing here executes repository code, and nothing here lands a change: the
 * thinker lands it (marker Edits or apply.mjs) and runs the tests itself.
 *
 * The worker call is handed in as `callWorker`, so this file holds no vendor
 * code and the tests drive it with the stub door. A start returns at once with
 * a job id; `jobResult` waits for the background call, up to the configured
 * limit. There is ONE attempt: on any failure the evidence goes back to the
 * thinker, which does the work itself as it would have without the plugin.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyJob, stageJob, undoJob, jobDir } from "./apply.mjs";
import { parseWorkerAnswer } from "./lib/answer-parse.mjs";
import { BUILDERS, JOB_OF_TOOL } from "./lib/brief.mjs";
import { loadConfig } from "./lib/config.mjs";
import { hasConsent, needsConsent, recordConsent, vendorOf } from "./lib/consent.mjs";
import { appendEvent } from "./lib/events.mjs";
import { safeRelPath } from "./lib/deny-paths.mjs";
import { checkChange, workerMayWrite } from "./lib/gates.mjs";
import { handoverNet, pricesFor } from "./lib/cost-rule.mjs";
import { projectCharsPerFile } from "./lib/repo-stats.mjs";

/** The dropped files of a checked answer, each with why, in the words the thinker reads. */
function describeDrops(drops) {
  return drops.map((d) => d.path + (d.why === "protected" ? " (read-only for this job)" : d.why === "never_delegate" ? " (listed under never_delegate_paths)" : " (outside the job)")).join(", ");
}
import { acquireJobLock, releaseJobLock } from "./lib/job-lock.mjs";
import { expectedCharsPerFile, recordChecks, recordHandoverRequests, recordLanding, recordTypedChars } from "./lib/evidence.mjs";
import { releaseFile } from "./lib/released.mjs";
import { loadSeeds, pickWorker } from "./lib/offers.mjs";
import { ensureDir, mmoHome, safeId, sessionDir } from "./lib/paths.mjs";
import { repoKey } from "./lib/repo-stats.mjs";
import { egressManifest, existsInSnapshot, readDenyGlobs, readFromSnapshot, sha256, takeSnapshot } from "./lib/snapshot.mjs";
import { fileKindOf } from "./lib/triggers.mjs";
import { verifyInScratchCopy } from "./lib/verify.mjs";
import { candidateFiles, checkScoutAnswer, renderScoutBrief, renderScoutResult } from "./lib/scout.mjs";
import { drawForSession } from "./lib/value-rule.mjs";

const running = new Map(); // jobId -> Promise<result>, for the life of the server process
const polls = new Map(); // jobId -> how many times job_result asked before the result was delivered (a measured cost)

const JOB_WORDS = { bugfix_code: "a bug fix", boilerplate: "new files", tests: "test files", repeat_edit: "a repeated edit", docs: "docs" };

/**
 * How long a start call may wait: `jobs.block_ms`, but never past the chat's prompt-cache lifetime,
 * which the stamp carries as `cache_tier`. On the five-minute tier a longer wait would let the cache
 * expire, and the next request would rewrite the whole chat at the cache-write price, dearer than the
 * hand-over saved; so the call returns "running" at `jobs.block_cap_5m_ms` and the job lands itself.
 */
function waitFor(config, stamp) {
  const blockMs = Math.max(0, Number(config.jobs?.block_ms ?? 540000) || 0);
  if (stamp?.cache_tier === "5m") return Math.min(blockMs, Math.max(0, Number(config.jobs?.block_cap_5m_ms ?? 270000) || 0));
  return blockMs;
}

function refuse(reason, extra = {}) {
  return { status: "refused", reason, ...extra };
}

function writeJob(dir, record) {
  writeFileSync(join(dir, "job.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function readJob(jobId, env = process.env) {
  try { return JSON.parse(readFileSync(join(jobDir(jobId, env), "job.json"), "utf8")); } catch { return null; }
}

function breakerActive(env) {
  try { return JSON.parse(readFileSync(join(mmoHome(env), "breaker-429.json"), "utf8")).until > Date.now(); } catch { return false; }
}

function tripBreaker(minutes, env) {
  ensureDir(mmoHome(env));
  writeFileSync(join(mmoHome(env), "breaker-429.json"), JSON.stringify({ until: Date.now() + minutes * 60000 }), { mode: 0o600 });
}

function userReadDenyGlobs(projectDir, env) {
  const files = [join(env.HOME ?? homedir(), ".claude", "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  const parsed = [];
  for (const f of files) { try { parsed.push(JSON.parse(readFileSync(f, "utf8"))); } catch { /* absent or unreadable: no rules from it */ } }
  return readDenyGlobs(parsed);
}

/** A unified-looking summary the thinker can read before landing: counts per file plus a bounded excerpt. */
function boundedDiff(change, maxChars) {
  const parts = [];
  for (const e of change.edits) parts.push(`--- ${e.path}\n- ${e.find.split("\n").join("\n- ")}\n+ ${e.replace.split("\n").join("\n+ ")}`);
  for (const c of change.creates) parts.push(`+++ new file ${c.path} (${c.content.split("\n").length} lines)\n${c.content.split("\n").slice(0, 25).join("\n")}`);
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + `\n[... ${text.length - maxChars} more characters not shown]` : text;
}

function landing(jobId, stagedSha, change, repoRoot, maxMarkerEdits, testCommand = null) {
  if (change.creates.length === 0 && change.edits.length <= maxMarkerEdits) {
    return {
      mode: "marker_edits",
      how: "For each entry, in order, call Edit with exactly this file_path and old_string (new_string may be anything). A hook swaps in the checked text; you approve each edit as usual.",
      edits: change.edits.map((e, n) => ({ n, file_path: join(repoRoot, e.path), old_string: `mmo-apply:${jobId}:${n}` })),
    };
  }
  // With a declared test command the SAME command runs the tests after writing and prints
  // pass or fail, so landing and testing cost the thinker one turn, not two (v2's harness ran
  // the tests itself; in chat every extra turn re-reads the chat).
  return {
    mode: "apply_command",
    how: testCommand
      ? "Run this one command with your Bash tool. It re-checks every file, writes nothing if anything changed since the worker was shown it, then runs the job's test command and prints pass or fail. `--undo` takes it back."
      : "Run this one command with your Bash tool. It re-checks every file and writes nothing if anything changed since the worker was shown it. `--undo` takes it back. Then run the tests yourself.",
    command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/ambient/apply.mjs" ${jobId} ${stagedSha}${testCommand ? " --test" : ""}`,
  };
}

/**
 * tool: one of the four start tools. args: the tool input without `_mmo`.
 * stamp: the `_mmo` object the hook added. Returns at once.
 * reachable(model): true when the chat policy has a text-only model of that
 * name. The server passes it; with the stub door (tests) every worker counts.
 */
export async function startJob({ tool, args, stamp, projectDir, callWorker, reachable, env = process.env }) {
  const builder = BUILDERS[tool];
  if (!builder) return refuse(`unknown job tool ${tool}`);
  if (!stamp || typeof stamp.session_id !== "string") return refuse("this call carries no session stamp, so the plugin's hooks are not running; nothing was sent");
  if (stamp.arm !== "on" || stamp.mode !== "on") return refuse(`worker jobs are not active in this session (arm ${stamp.arm}, mode ${stamp.mode})`);
  const sid = stamp.session_id;
  if (existsSync(join(sessionDir(sid, env), "off_thinker"))) return refuse("the chat is not on the policy's thinker model; no new worker job starts until it is back");
  if (typeof callWorker !== "function") return refuse("no worker door is configured on this machine");

  const { config } = loadConfig({ projectDir, env });
  if (config.mode !== "on") return refuse(`ambient mode is ${config.mode}`);
  if (config.delegation === "off") return refuse("cheaper-model jobs are off in this chat's settings (delegation: off); do it yourself");
  const job = JOB_OF_TOOL[tool];

  let built;
  try { built = builder(args ?? {}); } catch (e) { return refuse(e.message); }
  if (built.declared.length > (config.jobs?.max_files ?? 60)) return refuse(`more than ${config.jobs?.max_files ?? 60} files in one job`);

  // A job that commissions a file a worker may never write (a lock file, a test-runner
  // config, an env file, a never-delegate path) is refused HERE, naming the files, before
  // any worker is paid: the worker could only ever fail it, one way or the other (23 Sep,
  // pair 10: five calls bought exactly that discovery). Nothing is learned about any worker
  // from a job that was wrong to start.
  const forbidden = built.declared.filter((rel) => !workerMayWrite(rel, config.never_delegate_paths ?? []));
  if (forbidden.length) {
    appendEvent(sid, "job.refused_forbidden", { agent: typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined, tool, files: built.declared.length, forbidden }, env);
    return refuse(`a worker job may never write ${forbidden.join(", ")} (lock files, test-runner and CI configuration, env files and never-delegate paths stay with you). Leave ${forbidden.length === 1 ? "that file" : "those files"} out and call again with the rest; type ${forbidden.length === 1 ? "it" : "them"} yourself.`,
      { gate: "forbidden-file", forbidden });
  }

  // The language of the files in the job picks the worker: each worker is
  // weighed on its own evidence for this language (see pickWorker), and only
  // workers the chat policy can really call are weighed at all.
  const fileKind = fileKindOf(built.declared);
  const pick = pickWorker(config, job, fileKind, loadSeeds(), { reachable, env });

  // THE GATE (build spec v1.2 row 5; corrected 23 Sep after pair 11). The cost rule decides here, at
  // the tool call, and nothing else forces a hand-over. Expected typing is the declared files times
  // the characters one file of this kind really holds (learned from every staged answer, seeded by
  // measurement). What it is weighed against used to come off the stamp, where the hook built it on
  // an ASSUMED 400 characters of spec per job. Pair 11 sent 9,720-42,456 per hand-over, so four jobs
  // whose specs ran to 81-99% of the files they described all passed a judge that could not see the
  // bill it was judging. When the builder reports what the thinker actually wrote (`specChars`), the
  // break-even is rebuilt from it here, so a job is refused exactly when its specs cost more than the
  // typing they save. It sits after the worker is picked because the rates are that worker's.
  const stampBreakEven = Number(stamp.break_even_chars);
  const specChars = Number.isFinite(built.specChars) ? built.specChars : null;
  let breakEven = stampBreakEven;
  let judgedOn = "stamp";
  // The stamp carrying a break-even is how the hook says this chat can be judged at all; an
  // older hook sends none and nothing is gated, as before. Only then is it worth rebuilding.
  if (Number.isFinite(stampBreakEven) && stampBreakEven > 0 && specChars !== null && specChars > 0) {
    const prices = pricesFor(config, config.thinker, env);
    const card = pick.model ? config.jobs?.worker_prices_usd_per_mtok?.[pick.model] : null;
    const rates = card ? { in: card.input / 1e6, out: card.output / 1e6 } : null;
    const C = Number(stamp.context_tokens) > 0 ? Number(stamp.context_tokens) : Number(config.cost?.unknown_context_tokens) || 100000;
    const rebuilt = handoverNet({ chars: 0, C, prices, worker: rates, extraRequests: 0, specChars, cpt: Number(config.cost?.chars_per_token) || 4 });
    if (Number.isFinite(rebuilt.breakEvenChars) && rebuilt.breakEvenChars > 0) { breakEven = rebuilt.breakEvenChars; judgedOn = "specs"; }
  }
  if (Number.isFinite(breakEven) && breakEven > 0) {
    // How big will these files be? His goal 2: answer it for THIS project, not from a size
    // borrowed off every task the plugin has ever run, because that number is spent on tasks
    // nobody has seen. The project's own files of the same kind are the direct measurement;
    // only a project with nothing to say falls back to the learned prior, as before.
    const measured = projectCharsPerFile({ projectDir, paths: built.declared, env });
    const perFile = expectedCharsPerFile(job, env, config.cost?.expected_chars_per_file?.[job], measured);
    const sizeFrom = measured === null ? "learned" : `project(${measured.samples})`;
    const fromProject = measured !== null;
    const expected = Math.round(perFile * built.declared.length);
    if (expected < breakEven) {
      const n = (x) => Math.round(x).toLocaleString("en-US");
      const agentOf = typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined;
      appendEvent(sid, "job.refused_gate", { agent: agentOf, tool, files: built.declared.length, expected_chars: expected, per_file_chars: Math.round(perFile), size_from: sizeFrom, break_even_chars: Math.round(breakEven), spec_chars: specChars ?? undefined, judged_on: judgedOn, context_tokens: stamp.context_tokens ?? undefined }, env);
      // Too small to pay: the thinker types these itself, and the hook must let it.
      for (const rel of built.declared) { try { releaseFile(sid, resolve(projectDir, rel), env); } catch { /* the refusal stands either way */ } }
      const why = judgedOn === "specs"
        ? `below the break-even: you wrote ${n(specChars)} characters of specs for ${built.declared.length} file${built.declared.length === 1 ? "" : "s"} of ${JOB_WORDS[job] ?? job} worth about ${n(expected)} characters (${n(perFile)} per file, ${fromProject ? "measured from this project\u2019s own files" : "from what this kind of job has measured elsewhere"}); specs that long only pay once the worker types more than ${n(breakEven)} characters, because you pay for them twice — once to write, then on every later request. Put the detail in the design file, which is read once, bundle more files into one call, or type ${built.declared.length === 1 ? "it" : "them"} yourself.`
        : `below the break-even: this job would type about ${n(expected)} characters (${built.declared.length} file${built.declared.length === 1 ? "" : "s"} × ${n(perFile)} per file for ${JOB_WORDS[job] ?? job}, ${fromProject ? "measured from this project" : "learned elsewhere"}); at this chat's size a hand-over pays only above ${n(breakEven)} characters, because every extra request re-reads the chat. Bundle more files into one call, or type them yourself.`;
      return refuse(why, { gate: "break-even", expected_chars: expected, per_file_chars: Math.round(perFile), size_from: sizeFrom, break_even_chars: Math.round(breakEven), spec_chars: specChars ?? undefined, judged_on: judgedOn });
    }
  }
  const cell = pick.cell;
  let delegate = pick.worker !== null && cell.state === "open";
  let probability = pick.worker === null ? 0 : cell.delegateProbability ?? (delegate ? 1 : 0);
  if (pick.worker !== null && cell.state === "explore") {
    const drawn = drawForSession(sid, cell.cellKey, cell.delegateProbability, env);
    delegate = drawn.delegate;
    probability = drawn.probability;
  }
  // Logged for EVERY eligible job, delegated or not: without the not-delegated
  // ones there is nothing to compare the worker against.
  const agent = typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined;
  appendEvent(sid, "job.eligible", {
    agent, tool, worker: pick.worker ?? undefined, file_kind: fileKind, cell: cell.cellKey, cell_state: cell.state, p_pays: cell.P, probability, delegate,
    files: built.declared.length, considered: pick.considered, unreachable: pick.unreachable.length ? pick.unreachable : undefined,
  }, env);
  if (!delegate) {
    const why = pick.worker !== null ? "this session keeps this kind of job with the thinker (drawn once per session); do it yourself"
      : pick.unreachable.length ? `no worker that pays for this job can be called: the chat policy has no text-only model for ${pick.unreachable.map((w) => config.workers[w]).join(", ")}, and the others do not pay here; do it yourself`
      : "the evidence says this kind of job does not pay with a worker here; do it yourself";
    return refuse(why, { cell: cell.cellKey });
  }

  if (breakerActive(env)) return refuse("the worker was rate limited a moment ago; do this one yourself");

  const worker = pick.model;
  let snapshot;
  try { snapshot = takeSnapshot(projectDir); } catch (e) { return refuse("no git snapshot could be taken: " + e.message); }
  const vendor = vendorOf(worker);
  // Consent is the person's: per repository through the consent tool, or once
  // for every repository through their own settings file (a repository's file
  // cannot grant it: that key is not one a project file may set).
  const allowedEverywhere = Array.isArray(config.vendors_allowed_everywhere) && config.vendors_allowed_everywhere.includes(vendor);
  if (needsConsent(worker, config.thinker) && !allowedEverywhere && !hasConsent(snapshot.repoRoot, vendor, env)) {
    return refuse(`sending files from this repository to ${vendor} needs the person's one-time consent, and every job start is refused until then. Call the tool consent_to_send once, then send the jobs again; nothing was sent.`, { needs_consent: vendor });
  }

  const jobId = "j" + randomUUID().replace(/-/g, "").slice(0, 16);
  // A job holds the files it declared (see job-lock.mjs). Jobs on other files
  // run side by side, up to jobs.max_parallel; one that shares a file with a
  // running job is not refused: it is QUEUED and starts when the file frees.
  // Refusing it made the model send it again every few seconds, a full
  // request each time.
  // Evidence goes to the cell of the worker that ANSWERS, never to the one chosen at the start:
  // a cascade rescue is the rescuer's pass, and every rejected answer is that worker's fail.
  const workerKeyOf = (model) => Object.entries(config.workers ?? {}).find(([k, v]) => k !== "default" && v === model)?.[0] ?? model;
  const cellKeyFor = (model) => `${job}|${fileKind}|${workerKeyOf(model)}|completion`;
  // One hand-over, one request (build spec v1.2, row 7): the start call WAITS for the job (jobs.block_ms,
  // nine minutes; Claude Code's own limit on a plugin tool call is thirty idle minutes) and the server
  // LANDS the checked, verified files into the project itself (jobs.landing "auto"), so the thinker
  // pays one request, not four (start, collect, land, test). A job still running at the limit lands
  // itself when done and is collected with job_result. "manual" keeps the old landing by the thinker.
  const landingMode = config.jobs?.landing === "manual" ? "manual" : "auto";
  const blockMs = waitFor(config, stamp);
  const lockOpts = { paths: built.declared, maxParallel: config.jobs?.max_parallel ?? 4 };
  const queued = !acquireJobLock(snapshot.repoRoot, jobId, env, lockOpts);

  let files;
  let brief;
  try {
    const denyGlobs = userReadDenyGlobs(projectDir, env);
    const existing = built.declared.filter((p) => existsInSnapshot(snapshot, p));
    files = readFromSnapshot(snapshot, [...new Set([...built.show, ...existing])], { denyGlobs });
    brief = built.render(files.filter((f) => built.show.includes(f.path) || existing.includes(f.path)));
  } catch (e) {
    if (!queued) releaseJobLock(snapshot.repoRoot, jobId, env);
    return refuse(e.message);
  }

  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "jobs"));
  const dir = ensureDir(jobDir(jobId, env));
  const record = {
    job_id: jobId, tool, job, cell: cell.cellKey, worker, door: "completion", repo: repoKey(snapshot.repoRoot), session: safeId(sid), agent,
    declared: built.declared, protected: built.protectedPaths, test_command: built.testCommand ?? null, landing: landingMode, status: queued ? "queued" : "running", started_at: new Date().toISOString(), brief_sha256: sha256(brief), brief_chars: brief.length,
  };
  writeJob(dir, record);
  writeFileSync(join(dir, "egress.json"), JSON.stringify(egressManifest(snapshot, files, { worker, door: "completion", job: jobId }), null, 2), { mode: 0o600 });
  if (config.jobs?.keep_briefs === true) writeFileSync(join(dir, "brief.txt"), brief, { mode: 0o600 });
  if (queued) appendEvent(sid, "job.queued", { agent, job: jobId, tool, worker }, env);
  else appendEvent(sid, "job.started", { agent, job: jobId, tool, worker, files_sent: files.length, brief_chars: brief.length }, env);

  // Thirty minutes (23 Sep): the pipeline's completion door, in earlier external runs, had NO per-call cap and its longest live call
  // took 22 minutes at the vendor's default depth; a cap must never be what kills a job, and a deeper thinking
  // pair needs the same room. The WAIT of the start call is separate (jobs.block_ms); a job past it lands itself.
  const timeoutMs = config.jobs?.worker_timeout_ms ?? 1800000;
  const queueWaitMs = config.jobs?.queue_wait_ms ?? 1200000;
  // Worker cascade: every worker weighed for this job whose cell is not closed,
  // best first. When one worker's chain fails (no usable answer, checks failed
  // after the resends, a transient death after its second chance), the next
  // gets one chain before the thinker is told to do it. Same brief, priced and
  // summed. A worker whose vendor lacks consent is skipped, never asked.
  const cascadeOn = config.jobs?.worker_cascade !== false;
  const allowedFor = (v) => Array.isArray(config.vendors_allowed_everywhere) && config.vendors_allowed_everywhere.includes(v);
  const lineup = [worker];
  if (cascadeOn) {
    for (const c of pick.considered ?? []) {
      const model = config.workers?.[c.worker];
      if (!model || model === worker || c.state === "closed" || (pick.unreachable ?? []).includes(c.worker)) continue;
      const v = vendorOf(model);
      if (needsConsent(model, config.thinker) && !allowedFor(v) && !hasConsent(snapshot.repoRoot, v, env)) continue;
      lineup.push(model);
    }
  }
  const work = (async () => {
    let t0 = Date.now();
    let cost = null;
    try {
      if (queued) {
        // Wait for the repository's lock, then start as a fresh job would.
        const until = Date.now() + queueWaitMs;
        while (!acquireJobLock(snapshot.repoRoot, jobId, env, lockOpts)) {
          if (Date.now() > until) throw new Error(`waited ${Math.round(queueWaitMs / 1000)} s for the repository's other job; giving up`);
          await new Promise((r) => setTimeout(r, 250).unref());
        }
        t0 = Date.now();
        writeJob(dir, { ...record, status: "running", started_at: new Date().toISOString() });
        appendEvent(sid, "job.started", { job: jobId, tool, worker, files_sent: files.length, brief_chars: brief.length, was_queued: true }, env);
      }
      // One answer, and one more chance at it. A dropped connection or a
      // vendor error is not an attempt: it bills nothing and says nothing about
      // the answer, so it is retried (jobs.network_retries). A rate limit gets
      // one pause per entry of jobs.rate_limit_backoff_ms (doubling by default);
      // only when every retry is refused does the shared breaker trip. An answer
      // that cannot be read or fails a check is sent back with the exact reason
      // (jobs.answer_retries): a worker retry costs cents, the thinker typing
      // the file costs far more.
      const networkRetries = Math.max(0, Number(config.jobs?.network_retries ?? 4) || 0);
      const answerRetries = Math.max(0, Number(config.jobs?.answer_retries ?? 2) || 0);
      // A job whose call chain died of something transient (no answer in time, a
      // dropped connection or vendor error after the retries, a rate limit after
      // every pause) gets ONE more whole attempt (jobs.job_retries) before the
      // next worker or the thinker: a worker retry costs cents, the thinker
      // typing the file costs far more, and pair 6 (22 Sep) lost six jobs this way.
      const jobRetries = Math.max(0, Number(config.jobs?.job_retries ?? 1) || 0);
      const TRANSIENT = /did not answer within|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|"code":\s*50[023]\b|Internal error encountered|UNAVAILABLE|rate limited/i;
      const backoff = Array.isArray(config.jobs?.rate_limit_backoff_ms) ? config.jobs.rate_limit_backoff_ms.map(Number).filter(Number.isFinite) : [5000, 10000, 20000, 40000];

      const priceOf = (activeWorker, reply) => {
        const price = config.jobs?.worker_prices_usd_per_mtok?.[activeWorker];
        return Number.isFinite(reply.cost_usd) ? reply.cost_usd : price && reply.usage ? ((reply.usage.input_tokens ?? 0) * price.input + (reply.usage.output_tokens ?? 0) * price.output) / 1e6 : null;
      };
      const callOnce = async (activeWorker, text) => {
        let rateTries = 0;
        for (let tries = 0; ; tries++) {
          try {
            return await Promise.race([
              callWorker({ kind: tool, worker: activeWorker, brief: text }),
              new Promise((_, no) => setTimeout(() => no(new Error(`the worker did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs).unref()),
            ]);
          } catch (e) {
            const message = String(e?.message ?? e);
            const network = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|"code":\s*50[023]\b|Internal error encountered|UNAVAILABLE/i.test(message);
            if (e?.rateLimited === true) {
              if (rateTries >= backoff.length) throw e;
              appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120) }, env);
              await new Promise((r) => setTimeout(r, backoff[rateTries++]).unref());
              continue;
            }
            if (!network || tries >= networkRetries) throw e;
            appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120) }, env);
            await new Promise((r) => setTimeout(r, 2000).unref());
          }
        }
      };
      const callWithSecondChance = async (activeWorker, t) => {
        for (let jobTry = 0; ; jobTry++) {
          try {
            return await callOnce(activeWorker, t);
          } catch (e) {
            const message = String(e?.message ?? e);
            if (jobTry >= jobRetries || !(e?.rateLimited === true || TRANSIENT.test(message))) throw e;
            appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120), whole_job: true }, env);
            await new Promise((r) => setTimeout(r, 2000).unref());
          }
        }
      };
      // One worker's whole chain: calls, resends, checks. Returns the checked
      // answer or throws; a gate failure after the resends throws with `.checks`.
      // Verification before hand-back: with a declared test command, the checked
      // change is written into a scratch copy of the snapshot and the tests run
      // there; a failing run goes back to the worker with the tail of the output
      // (jobs.verify_retries), and the thinker hears only the outcome.
      const verifyOn = config.jobs?.verify_before_handback !== false && Boolean(built.testCommand);
      const verifyRetries = Math.max(0, Number(config.jobs?.verify_retries ?? 2) || 0);
      const verifyTimeoutMs = Number(config.jobs?.verify_timeout_ms ?? 600000) || 600000;
      const runChain = async (activeWorker) => {
        let text = brief;
        let answerTries = 0;
        let verifyTries = 0;
        // The pipeline's 0.7.4 fix 4, and pair 11's 21-file job: the scratch copy is rebuilt from the
        // snapshot on every attempt, so a worker whose ONE file failed the compiler had to
        // retype all twenty-one. The files that were already accepted carry forward here and
        // the resend asks only for the ones the tests implicate, so a retry costs one file's
        // worth of worker output instead of the whole phase's. A file the worker sends again
        // replaces its earlier version; one it leaves out keeps it, which is why the
        // completeness rule must count what is already in hand (`already` below).
        let carried = [];
        let recorded = false; // the job is counted once for this worker, at its first checks record
        const note = (passed) => { recordChecks(cellKeyFor(activeWorker), passed, env, { newJob: !recorded }); recorded = true; };
        for (;;) {
          const reply = await callWithSecondChance(activeWorker, text);
          const c = priceOf(activeWorker, reply);
          if (c !== null) cost = (cost ?? 0) + c;
          let rejected = null;
          let change = null;
          let checked = null;
          try {
            change = parseWorkerAnswer(reply.text);
            checked = checkChange(change, { declared: built.declared, snapshotFiles: files, protectedPaths: built.protectedPaths, neverDelegate: config.never_delegate_paths ?? [], salvage: true, commissioned: Boolean(built.commissioned), already: carried.map((f) => f.path) });
            if (checked.ok) {
              note(true);
              if (!verifyOn) return { reply, change, checked, verify: { ran: false, reason: built.testCommand ? "verification is off in the settings" : "no test command was declared for this job" } };
              // Newest answer wins per path; anything the worker did not resend keeps the version it already got right.
              const merged = [...new Map([...carried, ...checked.files].map((f) => [f.path, f])).values()];
              checked = { ...checked, files: merged };
              const v = verifyInScratchCopy({ jobId, repoRoot: snapshot.repoRoot, tree: snapshot.commit, files: merged, testCommand: built.testCommand, baselineShouldPass: built.baselineShouldPass === true, env, timeoutMs: verifyTimeoutMs });
              appendEvent(sid, "job.verified", { job: jobId, worker: activeWorker, ran: v.ran, passed: v.passed, harness: v.harness || undefined, exit_code: v.exit_code, ms: v.ms, reason: v.reason }, env);
              if (!v.ran || v.passed || verifyTries >= verifyRetries) return { reply, change, checked, verify: v };
              verifyTries++;
              carried = merged;
              appendEvent(sid, "job.retried", { job: jobId, error: ("tests failed in a scratch copy: " + String(v.tail ?? "").split("\n").filter(Boolean).slice(-3).join(" | ")).slice(0, 160), carried: carried.length }, env);
              text = brief + "\n\nYour previous answer was applied to a copy of the project and its tests FAILED (exit " + v.exit_code + "). The last lines of the test output:\n" + String(v.tail ?? "").slice(-3000) +
                "\nEvery file you already wrote is KEPT: " + carried.map((f) => f.path).join(", ") + ". Answer with ONLY the files you need to change to make these tests pass, in the same format. A file you leave out keeps the version you already sent.";
              continue;
            }
            rejected = checked.failures.slice(0, 5).map((f) => `${f.gate}: ${f.path ?? ""} ${f.detail ?? ""}`.trim()).join("; ");
          } catch (e) {
            rejected = String(e?.message ?? e).slice(0, 300);
          }
          // Every rejected answer is kept, bounded, next to the job: without it a dead job cannot be read
          // afterwards (23 Sep: three answers died in ten seconds and nobody could say what they held).
          try { writeFileSync(join(dir, `rejected-${activeWorker}-${answerTries + 1}.txt`), `reason: ${rejected}\nchars: ${reply.text?.length ?? 0}\n\n${String(reply.text ?? "").slice(0, 16000)}`, { mode: 0o600 }); } catch { /* a diagnosis file is never worth a failed job */ }
          note(false);
          if (answerTries >= answerRetries) {
            const err = new Error(rejected);
            if (checked && !checked.ok) err.checks = checked;
            err.rejectedAnswer = true;
            throw err;
          }
          answerTries++;
          appendEvent(sid, "job.retried", { job: jobId, error: ("answer rejected: " + rejected).slice(0, 160), answer_chars: reply.text?.length ?? 0 }, env);
          text = brief + "\n\nYour previous answer was rejected by the checks: " + rejected + "\nAnswer again, in the same format, touching only the declared files.";
        }
      };

      let done = null;
      let activeWorker = lineup[0];
      for (let hop = 0; hop < lineup.length; hop++) {
        activeWorker = lineup[hop];
        try {
          done = await runChain(activeWorker);
          break;
        } catch (e) {
          // A chain that died without an answer to judge (timeout, vendor error) is this worker's fail too.
          if (!e?.rejectedAnswer) recordChecks(cellKeyFor(activeWorker), false, env, { newJob: true });
          if (hop + 1 < lineup.length) {
            appendEvent(sid, "job.retried", { job: jobId, worker_cascade: true, from: activeWorker, to: lineup[hop + 1], error: String(e?.message ?? e).slice(0, 120) }, env);
            continue;
          }
          throw e;
        }
      }
      const { reply, change, checked, verify } = done;
      // A scratch-copy verification IS the landing verdict: proven right or wrong at hand-back,
      // under the answering worker's cell; the landing then adds no second verdict.
      const verdictAtHandback = verify?.ran ? (verify.passed ? "good" : "bad") : null;
      if (verdictAtHandback) recordLanding(cellKeyFor(activeWorker), verdictAtHandback, env);
      // Only what passed the checks is staged and landed: a dropped stray file must
      // not reappear as a marker edit or in the diff the thinker reviews.
      const keptPaths = new Set(checked.files.map((f) => f.path));
      // The receipt describes what LANDS, which after a repair-only retry is the merged set:
      // the files this answer sent plus the ones an earlier attempt already got right. Taking
      // creates from the last answer alone would under-report a job that repaired one file.
      const kept = { edits: change.edits.filter((e) => keptPaths.has(safeRelPath(e?.path))), creates: checked.files.filter((f) => f.base_sha256 === null).map((f) => ({ path: f.path, content: f.new_content })) };
      const staged = stageJob(jobId, { repoRoot: snapshot.repoRoot, files: checked.files, edits: kept.edits }, env);
      // What one file of this kind really holds, learned for the gate: a created file's length, or the
      // length of what was written into an edited one.
      recordTypedChars(job, checked.files.map((f) => f.base_sha256 === null ? Buffer.byteLength(f.new_content ?? "") : kept.edits.filter((e) => safeRelPath(e?.path) === f.path).reduce((n, e) => n + Buffer.byteLength(e.replace ?? ""), 0)), env);
      writeFileSync(join(dir, "answer.sha256"), sha256(reply.text), { mode: 0o600 });
      writeJob(dir, { ...record, status: "ready", worker: activeWorker, cell: cellKeyFor(activeWorker), verdict_at_handback: verdictAtHandback, wall_ms: Date.now() - t0, worker_cost_usd: cost, worker_model: reply.model, worker_thinking: reply.thinking ?? undefined, staged_sha256: staged.sha256 });
      const dropped = Array.isArray(checked.dropped) ? checked.dropped : [];
      appendEvent(sid, "job.ready", { job: jobId, worker: activeWorker, thinking: reply.thinking ?? undefined, files: checked.files.length, edits: kept.edits.length, creates: kept.creates.length, dropped: dropped.length || undefined, wall_ms: Date.now() - t0, worker_cost_usd: cost ?? undefined }, env);
      const bytes = checked.files.reduce((n, f) => n + Buffer.byteLength(f.new_content ?? ""), 0);
      // The server lands the change itself: only a change that passed the checks and, when tests were
      // declared, passed them in the scratch copy. A change whose tests failed is never written; the
      // thinker gets the manual landing and decides. A project that changed under the job (stale base)
      // is not written either.
      let landed = null;
      // A harness that died before any test ran judged nothing, so the change is unproven
      // and must not be written in on the strength of a run that never happened.
      if (landingMode === "auto" && !verify?.harness && (!verify?.ran || verify.passed)) {
        let applied;
        try { applied = applyJob(jobId, staged.sha256, env, { runTests: false, by: "server" }); } catch (e) { applied = { ok: false, reason: "error", detail: String(e?.message ?? e).slice(0, 200) }; }
        landed = applied.ok ? { ok: true, files: applied.files } : { ok: false, reason: applied.reason, detail: applied.detail };
        if (applied.ok) writeJob(dir, { ...readJob(jobId, env), status: "landed", landed_at: new Date().toISOString() });
      }
      const isLanded = Boolean(landed?.ok);
      // Nothing was written (the tests failed at hand-back, or the project moved
      // under the job), so these files may still be the thinker's to type: the
      // hook must stop refusing them. Until 23 Sep this happened only when a job
      // CRASHED, never when it handed back politely with a bad verdict.
      if (!isLanded) for (const rel of built.declared) { try { releaseFile(sid, join(snapshot.repoRoot, rel), env); } catch { /* the refusal stands either way */ } }
      const dropNote = dropped.length ? `${dropped.length} file${dropped.length === 1 ? "" : "s"} the worker touched but may not change ${dropped.length === 1 ? "was" : "were"} dropped (${describeDrops(checked.drops ?? [])}); nothing outside the job ever lands. ` : "";
      const diffNote = "The diff is not shown, to keep the chat small: the checks proved scope and exact match, and the tests prove correctness. Call job_result with show_diff: true only if you must read it. ";
      const next = isLanded
        ? dropNote + diffNote + (verify?.ran
          ? "The tests passed in a scratch copy of the project and the files are now written into the project. Carry on. undo_job takes it back."
          : "The files are now written into the project (the checks passed; no test command was declared, so run the tests yourself). undo_job takes it back.")
        : dropNote + diffNote + (verify?.harness
          ? `Your test command failed BEFORE any test ran (verify.tail has the output), so the worker's change was never judged and nothing was written. Fix the test command or its setup yourself, then land this with the command below or run the job again. No worker was charged for this.`
          : verify?.ran && !verify.passed
          ? `The tests FAILED on this change in a scratch copy after ${verifyRetries + 1} tries (verify.tail has the last lines), so nothing was written. Land it with the command below and fix the rest yourself, or do the whole thing yourself. `
          : landed && !landed.ok ? `The project changed under the job (${landed.reason}${landed.detail ? ": " + landed.detail : ""}), so nothing was written. Land it with the command below or do it yourself. `
          : verify?.ran && verify.passed ? "The tests already passed in a scratch copy of the project; land it, and the landing runs them once more in place. " : "") +
          (isLanded ? "" : "Land it, then run the tests yourself. If they fail, undo_job takes it back and you carry on as you would have.");
      return {
        status: isLanded ? "landed" : "ready", job_id: jobId, produced_by: `worker model ${activeWorker}${reply.model && reply.model !== activeWorker ? ` (${reply.model})` : ""}; checked by code for scope and exact match only, NOT for correctness`,
        files: checked.files.map((f) => ({ path: f.path, new_file: f.base_sha256 === null, syntax_checked: f.syntax_checked })),
        // Receipt-only read-back (the pipeline's 0.7.4 change 1): the thinker gets the shape of the change, not its
        // text; the diff is kept aside and shown only when asked for (job_result show_diff).
        receipt: { files: checked.files.length, edits: kept.edits.length, creates: kept.creates.length, bytes },
        diff: boundedDiff(kept, config.jobs?.max_diff_chars ?? 6000),
        dropped_files: dropped,
        verify: verify ?? { ran: false },
        ...(landed ? { landed } : {}),
        ...(isLanded ? {} : { landing: landing(jobId, staged.sha256, kept, snapshot.repoRoot, config.offers?.max_marker_edits ?? 5, built.testCommand ?? null) }),
        next,
        worker_cost_usd: cost,
      };
    } catch (e) {
      if (e?.rateLimited) tripBreaker(config.jobs?.breaker_minutes ?? 5, env);
      // Every worker's fails were recorded on its own cell as they happened; nothing is charged to the cell chosen at the start.
      // No worker could do it: the thinker does, so the hook lets it type these files.
      for (const rel of built.declared) { try { releaseFile(sid, join(snapshot.repoRoot, rel), env); } catch { /* the failure stands either way */ } }
      if (e?.checks) {
        const checked = e.checks;
        writeJob(dir, { ...record, status: "failed", wall_ms: Date.now() - t0, worker_cost_usd: cost, failed_gates: checked.failures.map((f) => f.gate) });
        appendEvent(sid, "job.failed", { job: jobId, gates: checked.failures.map((f) => f.gate).join(","), wall_ms: Date.now() - t0, worker_cost_usd: cost ?? undefined }, env);
        return { status: "failed", job_id: jobId, reason: "the worker's change did not pass the checks", failures: checked.failures.slice(0, 10), worker_cost_usd: cost };
      }
      // The worker was paid for every answer it did send, including the rejected ones
      // and the attempts before a timeout. Dropping that here understated the
      // orchestrator's own bill, which is the one direction a measurement must never err in.
      writeJob(dir, { ...record, status: "failed", wall_ms: Date.now() - t0, worker_cost_usd: cost, error: String(e.message).slice(0, 300) });
      appendEvent(sid, "job.failed", { job: jobId, error_class: e?.rateLimited ? "rate-limited" : "worker-or-answer", error: String(e?.message ?? e).slice(0, 120), wall_ms: Date.now() - t0, worker_cost_usd: cost ?? undefined }, env);
      return { status: "failed", job_id: jobId, reason: String(e.message).slice(0, 300), worker_cost_usd: cost, next: "One attempt only. Do this one yourself." };
    } finally {
      releaseJobLock(snapshot.repoRoot, jobId, env);
    }
  })();
  running.set(jobId, work);
  if (blockMs > 0) {
    const result = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), blockMs).unref())]);
    if (result !== null) {
      // One request: the start call itself. The typing rule learns that.
      recordHandoverRequests(1, env);
      running.delete(jobId);
      polls.delete(jobId);
      return withReceipt(result, false, env);
    }
  }
  const self = landingMode === "auto" ? " It lands itself when its checks and tests pass; nothing is yours to land." : "";
  if (queued) return { status: "queued", job_id: jobId, worker, files_sent: files.length, next: `Queued behind this repository's running job; it starts by itself.${self} Collect the receipt later with job_result, passing ALL your job ids at once as job_ids. Do not send it again.` };
  return { status: "running", job_id: jobId, worker, files_sent: files.length, next: `Still running after ${Math.round(blockMs / 1000)} s.${self} Carry on with other work; when you need the receipt, call job_result ONCE with all your job ids as job_ids; every poll re-reads the chat, so do not poll one job at a time.` };
}

const RUNNING = Symbol("running");
/** The result of a finished promise, or RUNNING, without waiting: a settled promise's handler runs before the sentinel's. */
const peek = (work) => Promise.race([work, Promise.resolve(RUNNING)]);

/**
 * Many jobs, ONE call. Waits until at least one of the running jobs has
 * finished (or `waitMs`), then reports every id: ready / failed results as
 * jobResult would give them, "running" for the rest, "refused" for an unknown
 * id. Seen live on 22 Sep: the thinker asked "is it done?" once per job, 18
 * times in one chat, and every ask re-read the chat; the typing rule counted
 * two extra requests per hand-over. One call replaces the polling.
 */
export async function jobResults(jobIds, { waitMs, env = process.env, showDiff = false } = {}) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).map((x) => safeId(String(x ?? ""))).filter(Boolean))];
  if (!ids.length) return refuse("job_ids is empty; pass every job id you were given");
  const limit = waitMs ?? 90000;
  const works = ids.map((id) => running.get(id)).filter(Boolean);
  for (const id of ids) if (running.has(id)) polls.set(id, (polls.get(id) ?? 0) + 1);
  // Wait for the FIRST finished job (if any is still running), never longer than the limit.
  const pending = [];
  for (const w of works) if ((await peek(w)) === RUNNING) pending.push(w);
  if (pending.length) await Promise.race([Promise.any(pending.map((w) => w.catch((e) => e))), new Promise((r) => setTimeout(r, limit).unref())]);
  const jobs = [];
  for (const id of ids) {
    const work = running.get(id);
    if (!work) { jobs.push({ job_id: id, ...(await jobResult(id, { waitMs: 0, env, showDiff })) }); continue; }
    const got = await peek(work);
    if (got === RUNNING) { jobs.push({ status: "running", job_id: id }); continue; }
    recordHandoverRequests(1 + (polls.get(id) ?? 1), env);
    polls.delete(id);
    running.delete(id);
    jobs.push(withReceipt(got, showDiff, env));
  }
  const count = (s) => jobs.filter((j) => j.status === s).length;
  const still = count("running");
  return {
    status: "collected", jobs, landed: count("landed"), ready: count("ready"), failed: count("failed"), running: still,
    next: still ? `${still} still running: call job_result again with those ids, once, when you have nothing else to do.` : "Every job is settled. Landed ones are already in the project; a ready one you land with its instructions; a failed one you do yourself.",
  };
}

/** The diff of a staged change, rebuilt from the job folder, for a thinker that asks to see it after delivery. */
function diffFromStaged(jobId, env) {
  try {
    const change = JSON.parse(readFileSync(join(jobDir(jobId, env), "change.json"), "utf8"));
    const creates = change.files.filter((f) => f.base_sha256 === null).map((f) => ({ path: f.path, content: f.new_content }));
    return boundedDiff({ edits: change.edits ?? [], creates }, 6000);
  } catch { return null; }
}

/** Receipt-only read-back: the diff leaves the result unless the thinker asked for it. */
function withReceipt(result, showDiff, env) {
  if (!result || typeof result !== "object") return result;
  if (showDiff) return result.diff === undefined && (result.status === "ready" || result.status === "landed") ? { ...result, diff: diffFromStaged(result.job_id, env) } : result;
  const { diff, ...rest } = result;
  return rest;
}

export async function jobResult(jobId, { waitMs, env = process.env, showDiff = false } = {}) {
  const id = safeId(jobId);
  const work = running.get(id);
  if (!work) {
    const rec = readJob(id, env);
    if (!rec) return refuse(`no job ${id}`);
    const out = rec.status === "running" ? { status: "lost", job_id: id, reason: "the server restarted while this job ran; do this one yourself" } : { status: rec.status, job_id: id, note: "result already delivered once; the staged change is unchanged" };
    return withReceipt(out, showDiff, env);
  }
  const limit = waitMs ?? 90000;
  polls.set(id, (polls.get(id) ?? 0) + 1);
  const result = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), limit).unref())]);
  if (result === null) return { status: "running", job_id: id, next: "Still running. Call job_result again." };
  // The start call plus every poll is what this hand-over really cost in requests; the typing rule learns from it.
  recordHandoverRequests(1 + (polls.get(id) ?? 1), env);
  polls.delete(id);
  running.delete(id);
  return withReceipt(result, showDiff, env);
}

export function undoStagedJob(jobId, env = process.env) {
  return undoJob(safeId(jobId), env);
}

/** Called by the consent tool's handler AFTER a person agreed. */
export function grantConsent({ projectDir, vendor, env = process.env }) {
  const snapshot = takeSnapshot(projectDir);
  recordConsent(snapshot.repoRoot, vendor, env);
  return { status: "recorded", vendor, repo_root: snapshot.repoRoot };
}

/**
 * One worker call with the same patience the code jobs get: the per-call cap,
 * network and vendor-error retries, rate-limit pauses, one whole second
 * chance for a transient death. Used by jobs that stage nothing.
 */
async function patientCall({ callWorker, kind, worker, brief, config, sid, jobId, env }) {
  const timeoutMs = config.jobs?.worker_timeout_ms ?? 1800000;
  const networkRetries = Math.max(0, Number(config.jobs?.network_retries ?? 4) || 0);
  const jobRetries = Math.max(0, Number(config.jobs?.job_retries ?? 1) || 0);
  const backoff = Array.isArray(config.jobs?.rate_limit_backoff_ms) ? config.jobs.rate_limit_backoff_ms.map(Number).filter(Number.isFinite) : [5000, 10000, 20000, 40000];
  const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|"code":\s*50[023]\b|Internal error encountered|UNAVAILABLE/i;
  const once = async () => {
    let rateTries = 0;
    for (let tries = 0; ; tries++) {
      try {
        return await Promise.race([
          callWorker({ kind, worker, brief }),
          new Promise((_, no) => setTimeout(() => no(new Error(`the worker did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs).unref()),
        ]);
      } catch (e) {
        const message = String(e?.message ?? e);
        if (e?.rateLimited === true) {
          if (rateTries >= backoff.length) throw e;
          appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120) }, env);
          await new Promise((r) => setTimeout(r, backoff[rateTries++]).unref());
          continue;
        }
        if (!NETWORK.test(message) || tries >= networkRetries) throw e;
        appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120) }, env);
        await new Promise((r) => setTimeout(r, 2000).unref());
      }
    }
  };
  for (let jobTry = 0; ; jobTry++) {
    try { return await once(); } catch (e) {
      const message = String(e?.message ?? e);
      if (jobTry >= jobRetries || !(e?.rateLimited === true || NETWORK.test(message) || /did not answer within/.test(message))) throw e;
      appendEvent(sid, "job.retried", { job: jobId, error: message.slice(0, 120), whole_job: true }, env);
      await new Promise((r) => setTimeout(r, 2000).unref());
    }
  }
}

/**
 * The scout job (lib/scout.mjs): a cheaper model reads the likely files of an
 * existing project and reports where to look or edit, each place with an exact
 * Read range verified by code. It changes nothing and stages nothing, so there
 * is no lock and no landing; everything else (stamp, verdict, consent, breaker,
 * snapshot, egress record, patience, cascade, evidence) is the same as a code job.
 */
export async function startScout({ args, stamp, projectDir, callWorker, reachable, env = process.env }) {
  const tool = "scout_repo";
  const job = "scout";
  if (!stamp || typeof stamp.session_id !== "string") return refuse("this call carries no session stamp, so the plugin's hooks are not running; nothing was sent");
  if (stamp.arm !== "on" || stamp.mode !== "on") return refuse(`worker jobs are not active in this session (arm ${stamp.arm}, mode ${stamp.mode})`);
  const sid = stamp.session_id;
  if (existsSync(join(sessionDir(sid, env), "off_thinker"))) return refuse("the chat is not on the policy's thinker model; no new worker job starts until it is back");
  if (typeof callWorker !== "function") return refuse("no worker door is configured on this machine");
  const { config } = loadConfig({ projectDir, env });
  if (config.mode !== "on") return refuse(`ambient mode is ${config.mode}`);
  if (config.delegation === "off") return refuse("cheaper-model jobs are off in this chat's settings (delegation: off); do it yourself");

  const question = typeof args?.question === "string" ? args.question.trim() : "";
  if (question.length < 20 || question.length > 2000) return refuse("question must be 20 to 2,000 characters: say what you are trying to find or change, in words");
  const terms = Array.isArray(args?.terms) ? args.terms : [];
  const paths = Array.isArray(args?.paths) ? args.paths : [];
  let cand;
  try { cand = candidateFiles(projectDir, { terms, paths, maxFiles: args?.max_files }); } catch (e) { return refuse("the files could not be listed: " + String(e?.message ?? e).slice(0, 120)); }
  if (!cand.files.length) return refuse("no candidate file matched the terms or paths; give terms that appear in the code, or a path");

  const fileKind = fileKindOf(cand.files);
  const pick = pickWorker(config, job, fileKind, loadSeeds(), { reachable, env });
  const cell = pick.cell;
  let delegate = pick.worker !== null && cell.state === "open";
  let probability = pick.worker === null ? 0 : cell.delegateProbability ?? (delegate ? 1 : 0);
  if (pick.worker !== null && cell.state === "explore") {
    const drawn = drawForSession(sid, cell.cellKey, cell.delegateProbability, env);
    delegate = drawn.delegate;
    probability = drawn.probability;
  }
  const agent = typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined;
  appendEvent(sid, "job.eligible", { agent, tool, worker: pick.worker ?? undefined, file_kind: fileKind, cell: cell.cellKey, cell_state: cell.state, p_pays: cell.P, probability, delegate, files: cand.files.length, considered: pick.considered }, env);
  if (!delegate) return refuse(pick.worker !== null ? "this session keeps this kind of job with the thinker (drawn once per session); read the files yourself" : "the evidence says scouting does not pay with a worker here; read the files yourself", { cell: cell.cellKey });
  if (breakerActive(env)) return refuse("the worker was rate limited a moment ago; read the files yourself");

  const worker = pick.model;
  let snapshot;
  try { snapshot = takeSnapshot(projectDir); } catch (e) { return refuse("no git snapshot could be taken: " + e.message); }
  const allowedFor = (v) => Array.isArray(config.vendors_allowed_everywhere) && config.vendors_allowed_everywhere.includes(v);
  const vendor = vendorOf(worker);
  if (needsConsent(worker, config.thinker) && !allowedFor(vendor) && !hasConsent(snapshot.repoRoot, vendor, env)) {
    return refuse(`sending files from this repository to ${vendor} needs the person's one-time consent. Call the tool consent_to_send once, then send the job again; nothing was sent.`, { needs_consent: vendor });
  }
  let files;
  try {
    const all = readFromSnapshot(snapshot, cand.files, { denyGlobs: userReadDenyGlobs(projectDir, env) });
    files = [];
    let bytes = 0;
    for (const f of all) {
      const size = Buffer.byteLength(f.content ?? "");
      if (bytes + size > cand.byteBudget) continue;
      bytes += size;
      files.push(f);
    }
  } catch (e) { return refuse(e.message); }
  if (!files.length) return refuse("every candidate file was too large for one brief; give terms or paths that narrow it");
  const brief = renderScoutBrief({ question, files });

  const jobId = "j" + randomUUID().replace(/-/g, "").slice(0, 16);
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "jobs"));
  const dir = ensureDir(jobDir(jobId, env));
  const record = {
    job_id: jobId, tool, job, cell: cell.cellKey, worker, door: "completion", repo: repoKey(snapshot.repoRoot), session: safeId(sid), agent,
    declared: [], files_read: files.map((f) => f.path), protected: [], test_command: null, status: "running", started_at: new Date().toISOString(), brief_sha256: sha256(brief), brief_chars: brief.length,
  };
  writeJob(dir, record);
  writeFileSync(join(dir, "egress.json"), JSON.stringify(egressManifest(snapshot, files, { worker, door: "completion", job: jobId }), null, 2), { mode: 0o600 });
  appendEvent(sid, "job.started", { agent, job: jobId, tool, worker, files_sent: files.length, brief_chars: brief.length }, env);

  const cascadeOn = config.jobs?.worker_cascade !== false;
  const lineup = [worker];
  if (cascadeOn) {
    for (const c of pick.considered ?? []) {
      const model = config.workers?.[c.worker];
      if (!model || model === worker || c.state === "closed" || (pick.unreachable ?? []).includes(c.worker)) continue;
      const v = vendorOf(model);
      if (needsConsent(model, config.thinker) && !allowedFor(v) && !hasConsent(snapshot.repoRoot, v, env)) continue;
      lineup.push(model);
    }
  }
  const answerRetries = Math.max(0, Number(config.jobs?.answer_retries ?? 2) || 0);
  const work = (async () => {
    const t0 = Date.now();
    let cost = null;
    try {
      const price = (w, reply) => { const card = config.jobs?.worker_prices_usd_per_mtok?.[w]; return Number.isFinite(reply.cost_usd) ? reply.cost_usd : card && reply.usage ? ((reply.usage.input_tokens ?? 0) * card.input + (reply.usage.output_tokens ?? 0) * card.output) / 1e6 : null; };
      let done = null;
      let activeWorker = lineup[0];
      for (let hop = 0; hop < lineup.length && !done; hop++) {
        activeWorker = lineup[hop];
        let text = brief;
        try {
          for (let tries = 0; ; tries++) {
            const reply = await patientCall({ callWorker, kind: tool, worker: activeWorker, brief: text, config, sid, jobId, env });
            const c = price(activeWorker, reply);
            if (c !== null) cost = (cost ?? 0) + c;
            const checked = checkScoutAnswer(reply.text, files);
            if (checked.ok) { done = { reply, checked }; break; }
            if (tries >= answerRetries) throw new Error(checked.reason);
            appendEvent(sid, "job.retried", { job: jobId, error: ("answer rejected: " + checked.reason).slice(0, 160) }, env);
            text = brief + "\n\nYour previous answer was rejected: " + checked.reason + "\nAnswer again as ONE JSON object in the format given, naming only files shown above, with quotes copied exactly.";
          }
        } catch (e) {
          if (hop + 1 < lineup.length) { appendEvent(sid, "job.retried", { job: jobId, worker_cascade: true, from: activeWorker, to: lineup[hop + 1], error: String(e?.message ?? e).slice(0, 120) }, env); continue; }
          throw e;
        }
      }
      const { reply, checked } = done;
      recordChecks(cell.cellKey, true, env);
      writeJob(dir, { ...record, status: "ready", worker: activeWorker, wall_ms: Date.now() - t0, worker_cost_usd: cost, worker_model: reply.model });
      appendEvent(sid, "job.ready", { job: jobId, tool, worker: activeWorker, places: checked.places.length, dropped: checked.dropped || undefined, files: files.length, wall_ms: Date.now() - t0, worker_cost_usd: cost ?? undefined }, env);
      return {
        status: "ready", job_id: jobId, tool, produced_by: `worker model ${activeWorker}${reply.model && reply.model !== activeWorker ? ` (${reply.model})` : ""}; every place was checked against the files by code`,
        files_read: files.length, places: checked.places, dropped: checked.dropped, text: renderScoutResult({ places: checked.places, summary: checked.summary, dropped: checked.dropped, filesShown: files.length }),
        next: "These are the places, each with the exact Read range that shows it. Read those ranges, not the files. Nothing was changed.",
        worker_cost_usd: cost,
      };
    } catch (e) {
      if (e?.rateLimited) tripBreaker(config.jobs?.breaker_minutes ?? 5, env);
      recordChecks(cell.cellKey, false, env);
      writeJob(dir, { ...record, status: "failed", wall_ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) });
      appendEvent(sid, "job.failed", { job: jobId, tool, error_class: e?.rateLimited ? "rate-limited" : "worker-or-answer", error: String(e?.message ?? e).slice(0, 120), wall_ms: Date.now() - t0 }, env);
      return { status: "failed", job_id: jobId, reason: String(e?.message ?? e).slice(0, 300), next: "No usable report. Read the files yourself." };
    }
  })();
  running.set(jobId, work);
  const blockMs = waitFor(config, stamp);
  if (blockMs > 0) {
    const result = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), blockMs).unref())]);
    if (result !== null) { recordHandoverRequests(1, env); running.delete(jobId); polls.delete(jobId); return result; }
  }
  return { status: "running", job_id: jobId, worker, files_sent: files.length, next: "Carry on with other work. Collect it with job_result, passing all your job ids as job_ids, when you need the places." };
}
