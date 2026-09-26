/**
 * Builds the board's one JSON document from the real records: session event
 * logs, session transcripts (for cost) and the seed table. Nothing is sampled
 * or made up; a board with no sessions yet is an empty board.
 *
 * Text never enters this document: events hold rule ids, sizes, paths and
 * numbers only, and steps are described from their event TYPE.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { pricesFor } from "../lib/cost-rule.mjs";
import { parseEvents } from "../lib/events.mjs";
import { summarise } from "../lib/ledger.mjs";
import { localSummary, readEvidence } from "../lib/evidence.mjs";
import { cellFor, pickWorker } from "../lib/offers.mjs";
import { mmoHome } from "../lib/paths.mjs";
import { sessionCost } from "../lib/session-cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDS = resolve(HERE, "..", "..", "..", "config", "ambient-seeds.json");

const JOB_NAMES = {
  bugfix_code: "Writing the code of a bug fix", tests: "Writing tests", boilerplate: "Writing routine new files",
  logic: "Writing new logic", docs: "Writing docs", repeat_edit: "Repeating one edit across many files", scout: "Reading an existing project to find where to edit",
};
const WORKER_NAMES = { flash: "Gemini Flash", sonnet: "Claude Sonnet" };
const EVIDENCE = {
  hidden_tests: "Strong. Graded by tests the models never saw.",
  kept_result: "Strong. Counted whether the result was kept.",
  valid_result: "Weak. Only checked that a usable result came back, not that it was right.",
  edit_format: "Weak. Only checked that edits came in the right format, on an older model version.",
};
const DECISION = { open: "Allowed", explore: "Tried some of the time", closed: "Not allowed: it does not pay" };
/** The languages the seed table knows, as the page names them. */
const LANGUAGE_NAME = { python: "Python", js_ts: "JavaScript / TypeScript", go: "Go" };

/** The order languages are listed in; "any" is the evidence pooled over every language. */
const LANGUAGE_ORDER = ["python", "js_ts", "go", "docs", "any"];
const languageName = (kind, { pooled = "other languages" } = {}) => kind === "any" ? pooled : kind === "docs" ? "docs (markdown)" : LANGUAGE_NAME[kind] ?? kind;
const listOf = (names) => (names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names.at(-1));

/**
 * One row per kind of work and cheaper model. The languages live inside the
 * row: what was measured on each, which ones the model is picked for, and why
 * it is not used on the others. The evidence pooled over every language is
 * shown only when the job has no per-language rows; when it has, the pooled
 * cell still decides "other languages", and the row says so.
 */
/** The languages this machine has run a (job, worker) cell on since install, from the evidence file. */
function localKindsFor(job, worker, env) {
  const cells = readEvidence(env).cells;
  const out = [];
  for (const key of Object.keys(cells)) {
    const [j, kind, w] = key.split("|");
    if (j === job && w === worker && kind && cells[key].jobs > 0) out.push(kind);
  }
  return out;
}
const languageRank = (k) => { const i = LANGUAGE_ORDER.indexOf(k); return i < 0 ? LANGUAGE_ORDER.length : i; };

function plainRow(job, worker, rows, seeds, config, env = process.env) {
  const who = WORKER_NAMES[worker] ?? worker;
  const own = rows.filter((r) => r.file_kind !== "any");
  const shown = (own.length ? own : rows).sort((a, b) => languageRank(a.file_kind) - languageRank(b.file_kind));
  const pooledOnly = own.length === 0;
  // Every language this row is judged on: the measured ones, the ones this machine has run jobs on since
  // install (a language the seed never measured still gets its counts and its verdict here), plus "other
  // languages" through the pooled cell.
  const local = localKindsFor(job, worker, env).filter((k) => k !== "any");
  const named = [...new Set([...shown.map((r) => r.file_kind).filter((k) => k !== "any"), ...local])].sort((a, b) => languageRank(a) - languageRank(b));
  const kinds = named.length
    ? [...named, ...(rows.some((r) => r.file_kind === "any") ? ["any"] : [])]
    : shown.map((r) => r.file_kind);
  const nameOf = (kind) => languageName(kind, { pooled: pooledOnly ? "any language" : "other languages" });

  const measured = shown.map((r) => {
    if (r.paired) {
      const cost = seeds.rows.find((c) => c.cost_only && c.job === job && c.worker === worker && c.file_kind === r.file_kind);
      return `${nameOf(r.file_kind)}: ${r.paired.n} bugs to both; Opus fixed ${r.paired.only_thinker_right} that ${who} missed, ${who} fixed ${r.paired.only_worker_right} that Opus missed` +
        (cost ? `; ${Math.abs(cost.saving_pct)}% ${cost.saving_pct >= 0 ? "cheaper" : "dearer"}.` : ".");
    }
    return `${nameOf(r.file_kind)}: ${r.rate[0]} of ${r.rate[1]} results were usable.`;
  }).join(" ") || "Nothing was measured before install.";

  const picked = [];
  const notes = [];
  let openedBy = null;
  let anyOpen = false;
  for (const kind of kinds) {
    const verdict = cellFor(config, job, kind, seeds, worker, env);
    const pick = pickWorker(config, job, kind, seeds, { env });
    if (verdict.state !== "closed") anyOpen = true;
    if (verdict.opened_by === "evidence" || (verdict.opened_by === "policy" && !openedBy)) openedBy = verdict.opened_by;
    if (pick.worker === worker) { picked.push(nameOf(kind)); continue; }
    const cost = seeds.rows.find((c) => c.cost_only && c.job === job && c.worker === worker && c.file_kind === kind);
    const why = verdict.state === "closed"
      ? (cost && cost.saving_pct < 0 ? "it costs more than Opus alone there" : "it does not pay there")
      : pick.worker ? `${WORKER_NAMES[pick.worker] ?? pick.worker} saves more per job there` : "no cheaper model pays there";
    notes.push(`Not for ${nameOf(kind)}: ${why}.`);
  }
  const lead = !anyOpen ? "Not allowed: it does not pay."
    : openedBy === "evidence" ? "Allowed, on the strength of this evidence."
    : openedBy === "policy" ? "Allowed, because the policy file already gives this work to a worker. This evidence could only take that away."
    : "Tried some of the time.";
  // What this machine has seen of the cell since install: shown on the row, and already inside the verdict above.
  const here = kinds.map((kind) => ({ kind, s: localSummary(`${job}|${kind}|${worker}|completion`, env) })).filter((x) => x.s && x.s.jobs > 0)
    .map((x) => `On this machine, ${nameOf(x.kind)}: ${x.s.jobs} job${x.s.jobs === 1 ? "" : "s"}; ${x.s.passed} passed the checks, ${x.s.failed} did not; after landing ${x.s.wrong} went wrong and ${x.s.held} held.`);
  const evidence = [...new Set(shown.map((r) => EVIDENCE[r.success_definition] ?? r.success_definition))].join(" ") || "Only this machine's own jobs so far: whether each passed the checks, and whether it held after landing.";
  const source = [...new Set(shown.map((r) => r.source.replace(/, (?:all repositories|[A-Za-z /]+ repositories only)/, "")))].join(" ") || "Jobs run on this machine since install.";
  return {
    job: JOB_NAMES[job] ?? job, files: picked.length ? picked.join(", ") : "none", worker: who,
    measured: [measured, ...here].join(" "), evidence,
    decision: [lead, picked.length ? `Picked for ${listOf(picked)}.` : "", ...notes].filter(Boolean).join(" "),
    source,
  };
}

function plainRows(table, config, env) {
  const evidence = table.rows.filter((r) => !r.cost_only);
  const out = [];
  for (const job of Object.keys(JOB_NAMES)) {
    for (const worker of ["flash", "sonnet"]) {
      const rows = evidence.filter((r) => r.job === job && r.worker === worker);
      // A row for every (job, worker) the seed measured, and for every one this machine has run since install.
      if (rows.length || localKindsFor(job, worker, env).length) out.push(plainRow(job, worker, rows, table, config, env));
    }
  }
  return out;
}

/** The handful of numbers every shrink decision uses, each with where it came from. */
function ruleNumbers(config, prices, env) {
  let measured = null;
  try { measured = JSON.parse(readFileSync(join(mmoHome(env), "measured.json"), "utf8")); } catch { /* census not run here */ }
  let acts = 0;
  let undone = 0;
  try {
    for (const repo of readdirSync(join(mmoHome(env), "repos"))) {
      for (const e of parseEvents(readFileSync(join(mmoHome(env), "repos", repo, "valves.jsonl"), "utf8"))) {
        if (e.valve !== "read") continue;
        if (e.kind === "act") acts++;
        else if (e.kind === "full") undone++;
      }
    }
  } catch { /* nothing shortened yet */ }
  const prior = config.cost?.prior_full_reread ?? [1, 5];
  const usd = (perToken) => "$" + (perToken * 1e6).toFixed(2) + " per million tokens";
  return [
    { name: "Replies that usually come after a file is read", value: String(measured?.n_hat ?? config.cost?.n_hat ?? 23), from: measured ? "Counted from this machine's own past chats." : "Counted from 969 past chats on the author's Mac. Run the census on this machine to replace it." },
    { name: "How often shortening a file goes wrong (starting guess)", value: `${prior[0]} in ${prior[1]}`, from: "A guess for a new install, because there is no history yet." },
    { name: "How often it really went wrong on this machine", value: acts ? `${undone} of ${acts} shortened files needed the full file after all` : "no file shortened yet", from: "Counted by the plugin after every shortening. This replaces the guess as it grows." },
    { name: "Price of putting new text into the chat", value: usd(prices.w), from: `The thinker's price card, ${prices.tier === "1h" ? "one-hour" : "five-minute"} cache.` },
    { name: "Price every later reply pays to re-read that text", value: usd(prices.r), from: "The thinker's price card." },
    { name: "Smallest file read the plugin will even consider", value: `${config.valves?.read?.min_chars ?? 8000} characters`, from: "Below this nothing can be saved. Above it the cost rule decides each time." },
    { name: "What one wrong result from a worker is priced at", value: "$" + (config.cost_of_bad_result_usd ?? 9), from: "About what it cost, in measured runs, to get one bug truly fixed. An organisation can change this one number." },
  ];
}

const REASON = {
  "mode-observe": "this is the plain side", "control-arm": "this is the plain side", "delegation-off": "cheaper-model jobs are off in this chat's settings (rules only)", "pipeline-session": "a /mmo: command was typed",
  "subagent": "inside a helper agent", "asked-for-full-output": "you asked for the whole output", "no-fair-outline": "the file has no usable outline",
  "no-price-card": "no price card for this model", "does-not-pay": "the cost rule said it would not pay", "cell-closed": "the evidence says this job does not pay with a cheaper model",
  "off-thinker": "the chat is not on the main model", "valve-observe": "this rule is set to count only",
};
const why = (r) => REASON[r] ?? String(r ?? "");
/**
 * The label a prompt is shown under. A build request in a folder that held no
 * code is a greenfield build; the folder is the fact, the prompt only says what
 * kind of work was asked. Used for the task name AND every feed line, so the
 * page never says "feature" in one place and "greenfield" in another.
 */
const shownLabel = (label, repoKind) => (label === "feature" && repoKind === "greenfield" ? "greenfield" : label);
const STEP_TEXT = {
  "session.start": () => "Chat started",
  prompt: (e, start) => e.typed === false ? "A background command finished and its notice was queued (not a prompt)" : `You typed a prompt (labelled ${shownLabel(e.label, start.repo_kind)})`,
  "valve.act": (e) => e.valve === "read" ? `Shortened a big file read: ${Math.round(e.tokens_full - e.tokens_kept)} tokens kept out` : e.valve === "file_dump" ? `Turned a big file dump into an outline: ${Math.round(e.tokens_full - e.tokens_kept)} tokens kept out` : `${e.valve}: ${Math.round(e.tokens_full - e.tokens_kept)} tokens kept out`,
  "valve.regret": (e) => e.kind === "full" ? "The whole file was needed after all (counted as a loss)" : "A part of the file was read afterwards (counted against the saving)",
  "valve.would_act": (e) => `Could have shortened a ${e.valve === "read" ? "file read" : "file dump"}; did not, because ${why(e.reason)}`,
  "valve.skip": (e) => `Saw a big ${e.valve === "read" ? "file read" : "file dump"}; left it alone, because ${why(e.reason)}`,
  "bash.failing_tests_seen": () => "A test run failed",
  // Only failures were ever recorded, so a side that ended green read as a run of failures
  // and then "finished": the only way to know whether a pair had passed was to run it by hand.
  "bash.tests_passed": () => "A test run passed",
  "offer.eligible": (e) => (e.shown ? `Offered a cheaper-model job (${JOB_NAMES[e.job] ?? e.job}${e.worker ? ", " + (WORKER_NAMES[e.worker] ?? e.worker) : ""})` : `A cheaper-model job was possible (${JOB_NAMES[e.job] ?? e.job}); the offer was withheld by the coin flip`) +
    (Number.isFinite(e.break_even_chars) ? `; at this chat's size handing over pays above ${Number(e.break_even_chars).toLocaleString("en-US")} characters of typing` : ""),
  "typing.refused": (e) => `Refused ${Number(e.chars).toLocaleString("en-US")} characters typed by hand (${JOB_NAMES[JOB_OF_TOOL[e.tool] ?? e.tool] ?? e.tool}, ${e.files} file${e.files === 1 ? "" : "s"}): above the break-even of ${Number(e.break_even_chars).toLocaleString("en-US")} a worker types it for about a third; pointed at the hand-over`,
  "typing.allowed": (e) => e.why === "released" ? `Let a by-hand write through: the worker could not do these files, so the main model does` : `Let a by-hand write through after two refusals of the same file`,
  "offer.not_yet": (e) => `A cheaper-model job was possible (${JOB_NAMES[e.job] ?? e.job}) but does not pay yet: about ${Number(e.expected_chars ?? 0).toLocaleString("en-US")} characters of typing (${e.basis ?? "so far"}) against a break-even of ${Number(e.break_even_chars ?? 0).toLocaleString("en-US")} at this chat's size${e.break_even_reads ? `; a scout pays after ${e.break_even_reads} reads` : ""}. The plugin speaks the moment it pays`,
  "offer.not_eligible": (e) => `A cheaper-model job was possible (${JOB_NAMES[e.job] ?? e.job}); not offered, because ${why(e.reason)}`,
  "job.eligible": (e) => e.delegate ? "The main model asked for a cheaper-model job" : `The main model asked for a cheaper-model job; refused, because ${e.cell_state === "closed" ? "the evidence says it does not pay" : "this chat keeps that job with the main model"}`,
  "job.queued": (e) => `Cheaper-model job queued behind the running one: ${JOB_NAMES[JOB_OF_TOOL[e.tool] ?? e.tool] ?? e.tool}`,
  // A retry has three quite different causes and the line used to call all of them a dropped
  // call, which read as a network fault when the worker had in fact answered and its code had
  // failed the tests (23 Sep, pair 11, step 18).
  "job.retried": (e) => (e.worker_cascade ? `The cheaper model could not do it (${e.error}); handing the same job to ${WORKER_NAMES[e.to] ?? e.to}`
    : /^tests failed in a scratch copy/i.test(String(e.error ?? "")) ? `The tests failed on the cheaper model's change in a scratch copy; sent back to the worker with the output (${String(e.error).replace(/^tests failed in a scratch copy:\s*/i, "")})${e.carried ? `, keeping the ${e.carried} file${e.carried === 1 ? "" : "s"} it already got right` : ""}`
    : e.whole_job ? `The worker call failed (${e.error}); starting the whole job once more` : `The worker call dropped (${e.error}); trying once more`) + (e.answer_chars !== undefined ? ` (the answer was ${e.answer_chars} characters)` : ""),
  "job.started": (e) => `Cheaper-model job started: ${JOB_NAMES[JOB_OF_TOOL[e.tool] ?? e.tool] ?? e.tool} on ${WORKER_NAMES[(e.worker || "").includes("flash") ? "flash" : "sonnet"] ?? e.worker}`,
  "job.ready": (e) => e.tool === "scout_repo" ? `The cheaper model's scouting report is ready: ${e.places} place${e.places === 1 ? "" : "s"} with exact Read ranges, from ${e.files} file${e.files === 1 ? "" : "s"} it read` : `The cheaper model's change passed the code checks (${e.files} file${e.files === 1 ? "" : "s"})` + (e.dropped ? `; ${e.dropped} file${e.dropped === 1 ? " the worker touched was" : "s the worker touched were"} dropped as read-only or outside the job` : "") + (e.thinking && e.thinking !== "claude" ? ` (worker thinking: ${e.thinking})` : ""),
  "job.failed": (e) => `Cheaper-model job failed (${e.error_class === "rate-limited" ? "rate limited" : e.gates ? "the change failed the checks: " + e.gates : e.error ? e.error : "no usable answer"}); the main model does it itself`,
  "edit_fill.landed": (e) => e.file_complete ? "The cheaper model's change was applied as normal edits" : "One edit of the cheaper model's change was applied",
  "job.applied": (e) => e.by === "server" ? `The checked change was written into the project by the server (${e.files} file${e.files === 1 ? "" : "s"})` : `The main model landed the cheaper model's change (${e.files} file${e.files === 1 ? "" : "s"})`,
  "job.refused_forbidden": (e) => `Refused a cheaper-model job before any worker was called: it commissioned ${e.forbidden.length === 1 ? "a file" : `${e.forbidden.length} files`} a worker may never write (${e.forbidden.join(", ")}); the main model leaves ${e.forbidden.length === 1 ? "it" : "them"} out and calls again`,
  "job.refused_gate": (e) => `Refused a cheaper-model job as too small to pay: about ${Number(e.expected_chars).toLocaleString("en-US")} characters of typing (${e.files} file${e.files === 1 ? "" : "s"}) against a break-even of ${Number(e.break_even_chars).toLocaleString("en-US")} at this chat's size; the main model types it or bundles more files`,
  "tool.ambient_refused": (e) => `A cheaper-model job was refused, because ${why(e.reason)}`,
  "write.partial_view_denied": () => "Blocked an overwrite of a file the main model had only seen as an outline",
  "model.switch_request": (e) => e.leaves_thinker && e.locked ? "Model switch blocked by the project's lock" : null,
  // Since 26 Sep (option 3) the savings rules act on any model and each saving is priced at the model it was made on.
  "session.off_thinker": (e) => `The chat is on ${e.model ?? "another model"}: savings are priced at that model's rates`,
  "model.back_on_thinker": () => "Back on the main model",
  "session.pipeline": () => "A /mmo: command was typed: the plugin stood down",
  "job.verified": (e) => e.ran ? (e.passed ? "The tests passed on the cheaper model's change in a scratch copy, before the main model was told" : "The tests failed on the cheaper model's change in a scratch copy; sent back to the worker") : "No test command was declared, so nothing was verified before the hand-back",
  "write_files.used": (e) => `Wrote ${e.files} file${e.files === 1 ? "" : "s"} in one call, no worker${e.tests_ran ? `, and ran the tests: ${e.tests_passed ? "passed" : "failed"}` : ""}`,
  "lookup.used": (e) => `Looked up ${e.terms} term${e.terms === 1 ? "" : "s"} in one call: ${e.hits} hit${e.hits === 1 ? "" : "s"} in ${e.files} file${e.files === 1 ? "" : "s"}, each with its Read range`,
  "turn.end": () => "Answer finished",
};
const JOB_OF_TOOL = { fix_from_analysis: "bugfix_code", repeat_edit_across_files: "repeat_edit", write_files_from_specs: "boilerplate", write_tests_from_cases: "tests", scout_repo: "scout" };

function readSession(dir, id, config, prices, priceOf) {
  const file = join(dir, id, "events.jsonl");
  if (!existsSync(file)) return null;
  const events = parseEvents(readFileSync(file, "utf8"));
  const start = events.find((e) => e.type === "session.start");
  if (!start) return null;
  // A re-opened chat (source "resume") is priced from this record's own start; the
  // requests before it are the chat's earlier history, covered by the earlier record.
  const cost = sessionCost(start.transcript_path, config, { since: start.source === "resume" ? start.ts : null });
  const ledger = summarise(events, { w: prices.w, r: prices.r, priceOf, requestTimes: cost.request_times.length ? cost.request_times : null });
  const workerUsd = events.filter((e) => e.type === "job.ready" || e.type === "job.failed").reduce((s, e) => s + (e.worker_cost_usd ?? 0), 0);
  // Only what a person typed is a prompt; a queued system notice is logged with typed:false.
  const prompts = events.filter((e) => e.type === "prompt" && e.typed !== false);
  const lastPrompt = prompts.at(-1);
  const lastEnd = [...events].reverse().find((e) => e.type === "turn.end");
  const steps = [];
  for (const e of events) {
    const text = STEP_TEXT[e.type]?.(e, start);
    if (text) steps.push({ at: e.ts, text: e.agent ? "In a helper agent: " + text : text });
  }
  return {
    // "on" means the plugin could really act in this session. A session in
    // observe mode, or drawn into the control arm, is the plain side of a pair.
    // "rules-only": the plugin acts but hands nothing over (delegation: off), the like-for-like plain side.
    id, side: start.arm === "on" && start.mode === "on" ? (start.delegation === "off" ? "rules-only" : "on") : "plain",
    arm: start.arm, forced: start.forced === true, mode: start.mode, repo_kind: start.repo_kind ?? null, started_at: start.ts, effort: start.effort ?? null,
    // The task is named by the newest prompt that carries a real work label. A
    // chat that opened with "Hi" and then got a bug report is a bug-fix task.
    label: shownLabel([...prompts].reverse().find((p) => !p.inherited && p.label !== "other")?.label ?? "other", start.repo_kind),
    touches: prompts.length,
    done: Boolean(lastPrompt && lastEnd && lastEnd.ts >= lastPrompt.ts),
    finished_at: lastEnd?.ts ?? null,
    thinker_usd: cost.usd, worker_usd: workerUsd, total_usd: cost.usd + workerUsd,
    requests: cost.requests, unpriced_requests: cost.unpriced_requests,
    // Claude Code helper agents (the Agent tool) are part of this chat's spend; their transcripts sit next to the main one.
    helper_agent_requests: cost.subagent_requests ?? 0, helper_agent_usd: cost.subagent_usd ?? 0,
    // A worker call that never answered (timeout, dropped connection) returns no usage, so its cost is unknown: counted, never shown as zero.
    worker_calls_unpriced: events.filter((e) => e.type === "job.failed" && e.worker_cost_usd === undefined).length,
    ledger_saved_usd: ledger.saved_usd, ledger_counted: ledger.counted, ledger_excluded_reason: ledger.excluded_reason, ledger_entries: ledger.entries.length,
    // What the plugin actually DID in this chat. A pair whose A side shows zero
    // actions differs only by run-to-run variation, and the page must say so.
    plugin_actions: events.filter((e) => e.type === "valve.act" || e.type === "job.ready" || e.type === "edit_fill.landed" || e.type === "lookup.used" || e.type === "write_files.used").length,
    offers_shown: events.filter((e) => e.type === "offer.eligible" && e.shown).length,
    steps: steps.slice(-80),
  };
}

export function buildData({ env = process.env, pair = null, now = new Date() } = {}) {
  const { config } = loadConfig({ env });
  const prices = pricesFor(config, config.thinker, env) ?? { w: 0, r: 0, tier: "unknown" };
  // Another model's cache prices, for savings made while the chat was on it (null when it has no card).
  const priceOf = (model) => { const p = pricesFor(config, model, env); return p ? { w: p.w, r: p.r } : null; };
  const dir = join(mmoHome(env), "sessions");
  let ids = [];
  try { ids = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()); } catch { /* nothing recorded yet */ }
  // A record where nobody typed a prompt is not a chat: a re-opened chat that was only
  // looked at, or a window opened and closed. It is neither listed nor a side of a pair.
  const sessions = ids.map((id) => readSession(dir, id, config, prices, priceOf)).filter((s) => s && s.touches > 0).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

  const counted = sessions.filter((s) => s.side === "on" && s.ledger_counted);
  const thinker = sessions.reduce((s, x) => s + x.thinker_usd, 0);
  const worker = sessions.reduce((s, x) => s + x.worker_usd, 0);

  // Without --pair, the newest session of each side is shown.
  const pick = (id, side) => sessions.find((s) => s.id === id) ?? sessions.find((s) => s.side === side) ?? null;
  const a = pick(pair?.[0], "on");
  // The like-for-like side (same rules, no hand-overs) is preferred as B; a plain chat is the fallback.
  const b = pick(pair?.[1], "rules-only") ?? pick(null, "plain");
  const bothDone = Boolean(a && b && a.done && b.done);

  let seeds = [];
  try { seeds = plainRows(JSON.parse(readFileSync(SEEDS, "utf8")), config, env); } catch { /* the table is optional for the page */ }

  return {
    generated_at: now.toISOString(),
    cache_tier: prices.tier,
    headline: {
      ledger_saved_usd: counted.reduce((s, x) => s + x.ledger_saved_usd, 0),
      sessions_counted: counted.length, sessions_total: sessions.length, sessions_rules_only: sessions.filter((s) => s.side === "rules-only").length,
      actions: counted.reduce((s, x) => s + x.ledger_entries, 0),
      worker_share: thinker + worker > 0 ? worker / (thinker + worker) : 0,
      unpriced_requests: sessions.reduce((s, x) => s + x.unpriced_requests, 0),
      worker_calls_unpriced: sessions.reduce((s, x) => s + x.worker_calls_unpriced, 0),
    },
    pair: {
      // What side B is, from its own record: "rules-only" (the same orchestrator with hand-overs off), "plain", or null before any B exists. The page words itself from this, never from a fixed sentence.
      a, b, both_done: bothDone, like_for_like: Boolean(b && b.side === "rules-only"), b_kind: b ? b.side : null,
      saving_usd: bothDone ? b.total_usd - a.total_usd : null,
      a_actions: a ? a.plugin_actions : 0,
      saving_share: bothDone && b.total_usd > 0 ? (b.total_usd - a.total_usd) / b.total_usd : null,
      note: "One pair is an illustration, not a measurement: with no real effect, a single pair shows a 25% 'saving' about one time in four.",
    },
    sessions: sessions.slice(0, 40).map(({ steps, ...rest }) => rest),
    seeds,
    numbers: ruleNumbers(config, prices, env),
  };
}
