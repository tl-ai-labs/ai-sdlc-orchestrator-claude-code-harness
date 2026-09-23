/**
 * The worker-job runner, driven end to end with the STUB door: canned worker
 * answers from a temp folder. No test here can reach a vendor. Each case uses a
 * real throwaway git repository and a private MMO_HOME and HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { startJob, jobResult, undoStagedJob, grantConsent, readJob } = await import(join(A, "jobs.mjs"));
const { stubDoor } = await import(join(A, "lib", "door.mjs"));
const { validateAnalysis } = await import(join(A, "lib", "brief.mjs"));
const { parseWorkerAnswer } = await import(join(A, "lib", "answer-parse.mjs"));
const { applyJob } = await import(join(A, "apply.mjs"));
const { localSummary: localSummaryOf } = await import(join(A, "lib", "evidence.mjs"));
const { acquireJobLock, releaseJobLock } = await import(join(A, "lib", "job-lock.mjs"));

const SOURCE = "export function parse(s) {\n  return new Date(s);\n}\n";
const ANALYSIS = {
  bug_files: ["src/date.js"], test_command: "node --test src/date.test.js",
  root_cause: "parse() hands the raw string to Date, so a trailing space yields an Invalid Date object.",
  fix_approach: "Trim the input inside parse() before constructing the Date; keep the signature unchanged.",
  ruled_out: ["the caller in year()"], change_sites: [{ path: "src/date.js", what: "trim inside parse" }],
  constraints: ["no new dependency"], read_set: ["src/date.js"], new_identifiers: [],
};
const GOOD_ANSWER = { edits: [{ path: "src/date.js", find: "return new Date(s);", replace: "return new Date(String(s).trim());" }] };

function world({ consent = true, answer = GOOD_ANSWER, stub = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-jobs-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  for (const d of [join(repo, "src"), home, stubs]) mkdirSync(d, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "dev@example.com"); git("config", "user.name", "dev");
  writeFileSync(join(repo, "src", "date.js"), SOURCE);
  writeFileSync(join(repo, "src", "date.test.js"), "import './date.js';\n");
  writeFileSync(join(repo, "src", "b.js"), "export const b = new Date(s);\n");
  writeFileSync(join(repo, "src", "c.js"), "export const c = new Date(s);\n");
  // Create jobs commission files from a design written once; every fixture has one.
  writeFileSync(join(repo, "DESIGN.md"), "# Design\n\n## Util\nt(s) trims a string and returns it.\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual" } }));
  const env = { MMO_HOME: home, HOME: home, PATH: process.env.PATH, MMO_AMBIENT_STUB_DIR: stubs };
  for (const kind of ["fix_from_analysis", "repeat_edit_across_files", "write_files_from_specs", "write_tests_from_cases"]) {
    writeFileSync(join(stubs, kind + ".json"), JSON.stringify({ answer, usage: { input_tokens: 4000, output_tokens: 1000 }, model: "gemini-3.8-flash", ...stub }));
  }
  if (consent) grantConsent({ projectDir: repo, vendor: "google", env });
  const stamp = { session_id: "s1", prompt_id: "p1", arm: "on", mode: "on" };
  const start = (over = {}) => startJob({ tool: "fix_from_analysis", args: { analysis: ANALYSIS, repro_files: ["src/date.test.js"] }, stamp, projectDir: repo, callWorker: stubDoor(env), env, ...over });
  const events = () => {
    const f = join(home, "sessions", "s1", "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { dir, repo, home, stubs, env, stamp, start, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("bug fix end to end: start returns at once, the result carries a bounded diff and marker edits, nothing is written yet", async () => {
  const w = world();
  try {
    const started = await w.start();
    assert.equal(started.status, "running", JSON.stringify(started));
    const r = await jobResult(started.job_id, { waitMs: 5000, env: w.env, showDiff: true });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.match(r.produced_by, /NOT for correctness/, "the result must say what the checks do not prove");
    assert.equal(r.landing.mode, "marker_edits");
    assert.deepEqual(r.landing.edits[0].old_string, `mmo-apply:${started.job_id}:0`);
    assert.match(r.diff, /\+ return new Date\(String\(s\)\.trim\(\)\);/);
    assert.ok(Math.abs(r.worker_cost_usd - (4000 * 0.75 + 1000 * 3.75) / 1e6) < 1e-12, "the worker is priced at its own card");
    assert.equal(readFileSync(join(w.repo, "src", "date.js"), "utf8"), SOURCE, "a ready job has changed NOTHING in the tree");

    const job = readJob(started.job_id, w.env);
    assert.equal(job.status, "ready");
    const folder = join(w.home, "jobs", started.job_id);
    assert.ok(!existsSync(join(folder, "brief.txt")), "briefs are not kept by default");
    const egress = readFileSync(join(folder, "egress.json"), "utf8");
    assert.ok(egress.includes("src/date.js") && !egress.includes("new Date"), "the egress record lists what left, never its content");
    const logged = JSON.stringify(w.events());
    assert.ok(!logged.includes("trailing space") && !logged.includes("new Date"), "neither the analysis nor code may reach the event log");
    assert.deepEqual(w.events().filter((e) => e.type.startsWith("job.")).map((e) => e.type), ["job.eligible", "job.started", "job.verified", "job.ready"], "the declared tests ran in a scratch copy before the hand-back");
    assert.equal(applyJob(started.job_id, job.staged_sha256, w.env).ok, true, "the bulk route lands the same staged change");
    assert.equal(undoStagedJob(started.job_id, w.env).ok, true);
  } finally { w.cleanup(); }
});

test("refused before anything leaves: no stamp, control arm, off the thinker, no consent, no door, a closed cell", async () => {
  const w = world({ consent: false });
  try {
    assert.match((await w.start({ stamp: undefined })).reason, /no session stamp/);
    assert.match((await w.start({ stamp: { ...w.stamp, arm: "control" } })).reason, /not active/);
    const noConsent = await w.start();
    assert.equal(noConsent.needs_consent, "google");
    assert.match(noConsent.reason, /consent_to_send/);
    // Seen live on 22 Sep: six jobs sent one after another, each refused for the same missing consent, each a full
    // request re-reading an 86k chat. The refusal has to say that EVERY job is refused until consent is given once.
    assert.match(noConsent.reason, /every job start is refused until then/i);
    assert.match(noConsent.reason, /once, then send the jobs again/i);
    grantConsent({ projectDir: w.repo, vendor: "google", env: w.env });
    assert.match((await w.start({ callWorker: undefined })).reason, /no worker door/);
    mkdirSync(join(w.home, "sessions", "s1"), { recursive: true });
    writeFileSync(join(w.home, "sessions", "s1", "off_thinker"), "");
    assert.match((await w.start()).reason, /not on the policy's thinker/);
    rmSync(join(w.home, "sessions", "s1", "off_thinker"));
    // Closing Flash's cell alone would hand the job to Sonnet (open on JS/TS); both closed, the thinker keeps it.
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", closed_cells: ["bugfix_code|js_ts|flash|completion", "bugfix_code|js_ts|sonnet|completion"], jobs: { block_ms: 0, landing: "manual" } }));
    assert.match((await w.start()).reason, /does not pay/);
    assert.ok(!existsSync(join(w.home, "jobs")) || readdirSync(join(w.home, "jobs")).length === 0, "a refused start creates no job and sends nothing");
    assert.equal(w.events().at(-1).delegate, false, "an eligible job the thinker keeps is still logged, with its probability");
  } finally { w.cleanup(); }
});

test("the worker is picked per language from the seeds: a Go bug fix goes to Claude Sonnet (the chat's own vendor, so no consent), a JS one to Gemini Flash", async () => {
  const w = world({ consent: false });
  try {
    // Worker choice is the point here; no Go toolchain on the test machine, so the scratch-copy verification stays off.
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", verify_before_handback: false } }));
    writeFileSync(join(w.repo, "src", "main.go"), "package main\n\nfunc Parse(s string) string {\n\treturn s\n}\n");
    writeFileSync(join(w.repo, "src", "main_test.go"), "package main\n");
    execFileSync("git", ["add", "-A"], { cwd: w.repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "go"], { cwd: w.repo, stdio: "pipe" });
    const analysis = {
      ...ANALYSIS, bug_files: ["src/main.go"], test_command: "go test ./...", read_set: ["src/main.go"],
      root_cause: "Parse() returns the raw string, so a trailing space is kept and the lookup that follows misses.",
      fix_approach: "Trim the input inside Parse before returning it; keep the signature unchanged.",
      change_sites: [{ path: "src/main.go", what: "trim inside Parse" }],
    };
    writeFileSync(join(w.stubs, "fix_from_analysis.json"), JSON.stringify({ answer: { edits: [{ path: "src/main.go", find: "return s", replace: "return strings.TrimSpace(s)" }] }, usage: { input_tokens: 4000, output_tokens: 1000 }, model: "claude-sonnet-5" }));
    const started = await w.start({ args: { analysis, repro_files: ["src/main_test.go"] } });
    assert.equal(started.status, "running", "no Google consent is needed: Sonnet sits at the chat's own vendor. " + JSON.stringify(started));
    const r = await jobResult(started.job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.ok(Math.abs(r.worker_cost_usd - (4000 * 2 + 1000 * 10) / 1e6) < 1e-12, "priced at Sonnet's own card");
    const job = readJob(started.job_id, w.env);
    assert.equal(job.worker, "claude-sonnet-5");
    assert.equal(job.cell, "bugfix_code|go|sonnet|completion");
    const eligible = w.events().find((e) => e.type === "job.eligible");
    assert.equal(eligible.worker, "sonnet");
    assert.deepEqual(eligible.considered.map((c) => [c.worker, c.state]), [["flash", "closed"], ["sonnet", "open"]], "both workers were weighed and the log says so");
    // The JS bug fix of the default world goes to Flash, which is at another vendor: consent first.
    const js = await w.start();
    assert.equal(js.needs_consent, "google");
  } finally { w.cleanup(); }
});

test("when the door prices its own call, that figure is the worker cost; otherwise the worker's card", async () => {
  // The Claude-login door prices the worker from its own token ledger, cache writes included; a card
  // times raw token counts would miss those. Doors that report no cost fall back to the card.
  const w = world({ stub: { cost_usd: 0.0123 } });
  try {
    const started = await w.start();
    const r = await jobResult(started.job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.worker_cost_usd, 0.0123);
  } finally { w.cleanup(); }
});

test("a second job while one runs is QUEUED behind it, not refused; it runs when the first is done", async () => {
  // Seen live on 22 Sep: the model sent the next job every few seconds while one ran, and each refusal was a full
  // request re-reading a 90k chat: thirteen of them for two jobs.
  const w = world({ stub: { delay_ms: 700 } });
  try {
    const first = await w.start();
    assert.equal(first.status, "running", JSON.stringify(first));
    // The same file again while the first job holds it: queued, never refused.
    const second = await w.start();
    assert.equal(second.status, "queued", JSON.stringify(second));
    assert.match(second.next, /job_result/, "the answer says how to collect it, not to try again");
    assert.equal(readJob(second.job_id, w.env).status, "queued");
    const r2 = await jobResult(second.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r2.status, "ready", JSON.stringify(r2));
    const r1 = await jobResult(first.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r1.status, "ready");
    const types = w.events().filter((e) => e.type.startsWith("job.")).map((e) => e.type);
    assert.deepEqual(types.filter((t) => t === "job.queued"), ["job.queued"]);
    assert.ok(types.indexOf("job.queued") < types.lastIndexOf("job.started"), "the queued job started after it was queued");
  } finally { w.cleanup(); }
});

test("jobs on different files run side by side, up to jobs.max_parallel; the lock is per file, not per repository", async () => {
  // Seen live on 22 Sep: 18 test-file jobs, each on its own new file, waited in one line behind a single running job,
  // twenty to thirty seconds each, while the model kept polling for them.
  const w = world({ stub: { delay_ms: 600 } });
  try {
    const trim = "new Date(String(s).trim())";
    writeFileSync(join(w.stubs, "repeat_edit_across_files.json"), JSON.stringify({ answer: { edits: [{ path: "src/b.js", find: "new Date(s)", replace: trim }, { path: "src/c.js", find: "new Date(s)", replace: trim }] }, usage: { input_tokens: 100, output_tokens: 50 }, delay_ms: 600 }));
    const first = await w.start();
    const other = await w.start({ tool: "repeat_edit_across_files", args: { files: ["src/b.js", "src/c.js"], instruction: "Trim the input before constructing the Date.", example: { path: "src/date.js", find: "new Date(s)", replace: trim } } });
    assert.equal(first.status, "running");
    assert.equal(other.status, "running", "different files: no waiting. " + JSON.stringify(other));
    const overlap = await w.start({ tool: "repeat_edit_across_files", args: { files: ["src/c.js", "src/date.js"], instruction: "Trim the input before constructing the Date.", example: { path: "src/b.js", find: "new Date(s)", replace: trim } } });
    assert.equal(overlap.status, "queued", "shares a file with a running job: waits");
    const [r1, r2] = await Promise.all([jobResult(first.job_id, { waitMs: 8000, env: w.env }), jobResult(other.job_id, { waitMs: 8000, env: w.env })]);
    assert.deepEqual([r1.status, r2.status], ["ready", "ready"]);
    await jobResult(overlap.job_id, { waitMs: 8000, env: w.env });
  } finally { w.cleanup(); }
  const capped = world({ stub: { delay_ms: 500 } });
  try {
    writeFileSync(join(capped.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", max_parallel: 1 } }));
    const trim = "new Date(String(s).trim())";
    writeFileSync(join(capped.stubs, "repeat_edit_across_files.json"), JSON.stringify({ answer: { edits: [{ path: "src/b.js", find: "new Date(s)", replace: trim }, { path: "src/c.js", find: "new Date(s)", replace: trim }] }, usage: { input_tokens: 100, output_tokens: 50 } }));
    const a = await capped.start();
    const b = await capped.start({ tool: "repeat_edit_across_files", args: { files: ["src/b.js", "src/c.js"], instruction: "Trim the input before constructing the Date.", example: { path: "src/date.js", find: "new Date(s)", replace: trim } } });
    assert.equal(b.status, "queued", "with max_parallel 1 even disjoint jobs wait");
    await Promise.all([jobResult(a.job_id, { waitMs: 8000, env: capped.env }), jobResult(b.job_id, { waitMs: 8000, env: capped.env })]);
  } finally { capped.cleanup(); }
});

test("a person can allow a vendor for every repository once, in their own settings file; a repository file cannot", async () => {
  const w = world({ consent: false });
  try {
    assert.equal((await w.start()).needs_consent, "google");
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", vendors_allowed_everywhere: ["google"], jobs: { block_ms: 0, landing: "manual" } }));
    const started = await w.start();
    assert.equal(started.status, "running", "allowed once for all repositories: no consent prompt");
    await jobResult(started.job_id, { waitMs: 5000, env: w.env });
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual" } }));
    mkdirSync(join(w.repo, ".sdlc"), { recursive: true });
    writeFileSync(join(w.repo, ".sdlc", "ambient.json"), JSON.stringify({ vendors_allowed_everywhere: ["google"] }));
    assert.equal((await w.start()).needs_consent, "google", "a repository's own file cannot grant consent on the person's behalf");
  } finally { w.cleanup(); }
});

test("a network-level failure of the worker call is retried once; a model answer is never retried", async () => {
  // Seen live on 22 Sep: "fetch failed" after 9 s, the job failed, the model typed the file itself. A dropped
  // connection bills nothing, so one more try costs nothing; a bad ANSWER is still one attempt only.
  const w = world({ stub: { fail_first: "fetch failed" } });
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_cascade: false } }));
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.ok(w.events().some((e) => e.type === "job.retried" && /fetch failed/.test(e.error)), "the retry is logged with the network error");
  } finally { w.cleanup(); }
  const twice = world({ stub: { fail_first: "fetch failed", error: "fetch failed" } });
  try {
    writeFileSync(join(twice.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", network_retries: 1, job_retries: 0, worker_cascade: false } }));
    const r = await jobResult((await twice.start()).job_id, { waitMs: 8000, env: twice.env });
    assert.equal(r.status, "failed", "a network failure on every attempt: the job fails after the retries");
  } finally { twice.cleanup(); }
  // A vendor-side 500 bills nothing either (seen live: {"error":{"code":500,"message":"Internal error encountered."}}).
  const internal = world({ stub: { fail_first: '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}' } });
  try {
    writeFileSync(join(internal.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_cascade: false } }));
    const r = await jobResult((await internal.start()).job_id, { waitMs: 8000, env: internal.env });
    assert.equal(r.status, "ready", "one retry after a vendor 500");
  } finally { internal.cleanup(); }
  const badAnswer = world({ stub: { fail_first: "the worker's answer was cut off (output cap at model absolute) after 8192 output tokens" } });
  try {
    writeFileSync(join(badAnswer.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_cascade: false } }));
    const r = await jobResult((await badAnswer.start()).job_id, { waitMs: 8000, env: badAnswer.env });
    assert.equal(r.status, "failed", "a cut-off or bad answer is not a network failure and is not retried");
    assert.ok(!badAnswer.events().some((e) => e.type === "job.retried"));
  } finally { badAnswer.cleanup(); }
});

test("a rate limit is retried with growing pauses; only when every retry is refused does the breaker trip, for one minute", async () => {
  // Seen live on 22 Sep: one 429 from Google stopped every job for five minutes while the model typed on.
  const fast = { mode: "on", jobs: { block_ms: 0, landing: "manual", rate_limit_backoff_ms: [30, 30], job_retries: 0, worker_cascade: false } };
  const once = world({ stub: { fail_first: "429" } });
  try {
    writeFileSync(join(once.home, "ambient.json"), JSON.stringify(fast));
    const r = await jobResult((await once.start()).job_id, { waitMs: 8000, env: once.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.ok(!existsSync(join(once.home, "breaker-429.json")), "one rate limit does not trip the breaker");
    assert.ok(once.events().some((e) => e.type === "job.retried" && /rate limited/.test(e.error)));
  } finally { once.cleanup(); }
  const always = world({ stub: { error: "429" } });
  try {
    writeFileSync(join(always.home, "ambient.json"), JSON.stringify(fast));
    const r = await jobResult((await always.start()).job_id, { waitMs: 8000, env: always.env });
    assert.equal(r.status, "failed");
    assert.equal(always.events().filter((e) => e.type === "job.retried").length, 2, "two retries, three attempts in all");
    const breaker = JSON.parse(readFileSync(join(always.home, "breaker-429.json"), "utf8"));
    assert.ok(breaker.until - Date.now() <= 60 * 1000 + 500 && breaker.until - Date.now() > 50 * 1000, "the breaker holds for one minute, not five");
  } finally { always.cleanup(); }
});

test("a rejected answer is sent back to the worker once, with the reason; the second answer is checked like the first", async () => {
  // "Give Google every chance": a Flash retry costs a cent or two, the thinker typing the file costs far more.
  const bad = { edits: [{ path: "src/date.js", find: "NOT IN THE FILE", replace: "x" }] };
  const w = world({ stub: { answers: [bad, GOOD_ANSWER] } });
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_cascade: false } }));
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    const retried = w.events().filter((e) => e.type === "job.retried");
    assert.equal(retried.length, 1);
    assert.match(retried[0].error, /rejected: .*exact-match|rejected: .*find/i, JSON.stringify(retried[0]));
    assert.ok(Math.abs(r.worker_cost_usd - 2 * (4000 * 0.75 + 1000 * 3.75) / 1e6) < 1e-12, "both calls are paid for and both are counted");
  } finally { w.cleanup(); }
  const unreadable = world({ stub: { answers: [] } });
  try {
    writeFileSync(join(unreadable.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", answer_retries: 1, worker_cascade: false } }));
    writeFileSync(join(unreadable.stubs, "fix_from_analysis.json"), JSON.stringify({ text: "Sure! Here is the fix.", usage: { input_tokens: 10, output_tokens: 5 } }));
    const r = await jobResult((await unreadable.start()).job_id, { waitMs: 8000, env: unreadable.env });
    assert.equal(r.status, "failed", "the same unreadable answer twice: the job fails after one retry");
    assert.equal(unreadable.events().filter((e) => e.type === "job.retried").length, 1);
  } finally { unreadable.cleanup(); }
});

test("a hand-over that leaves a decision open, dictates the code, or misses a field is refused", () => {
  assert.doesNotThrow(() => validateAnalysis(ANALYSIS));
  assert.throws(() => validateAnalysis({ ...ANALYSIS, root_cause: "It is either the parser or the caller that drops the offset, not sure which one yet." }), /leaves a decision open/);
  const code = "```js\n" + "line();\n".repeat(14) + "```";
  assert.throws(() => validateAnalysis({ ...ANALYSIS, fix_approach: "Replace the function body with exactly this code, nothing else:\n" + code }), /already contains the code/);
  const { constraints, ...missing } = ANALYSIS;
  assert.throws(() => validateAnalysis(missing), /missing constraints/);
  assert.throws(() => validateAnalysis({ ...ANALYSIS, bug_files: ["../../etc/passwd"] }), /unsafe path/);
  assert.throws(() => validateAnalysis({ ...ANALYSIS, change_sites: [{ path: "src/other.js", what: "change it" }] }), /one of bug_files/);
});

test("worker answers are read strictly and never repaired", () => {
  assert.deepEqual(parseWorkerAnswer("```json\n" + JSON.stringify(GOOD_ANSWER) + "\n```"), { ...GOOD_ANSWER, creates: [] });
  for (const bad of ["Sure! Here is the fix: {}", "", "[1,2]", '{"edits":[],"run":"rm -rf"}', '{"edits":[{"path":"a","find":"b"}]}', '{"edits":[{"path":"a","find":"b","replace":"c","mode":"755"}]}', '{"creates":"x"}']) {
    assert.throws(() => parseWorkerAnswer(bad), /answer:/, bad.slice(0, 30));
  }
});

test("a worker that edits the reproduce test, a file outside the job, or a lockfile fails the job; the tree is untouched", async () => {
  const bads = {
    protected: { edits: [{ path: "src/date.test.js", find: "import './date.js';", replace: "// test removed" }] },
    "declared-files": { edits: [{ path: "src/b.js", find: "new Date(s)", replace: "1" }] },
    "find-once": { edits: [{ path: "src/date.js", find: "no such text", replace: "x" }] },
  };
  for (const [gate, answer] of Object.entries(bads)) {
    const w = world({ answer });
    try {
      const r = await jobResult((await w.start()).job_id, { waitMs: 5000, env: w.env });
      assert.equal(r.status, "failed", gate);
      assert.equal(r.failures[0].gate, gate);
      assert.equal(readFileSync(join(w.repo, "src", "date.test.js"), "utf8"), "import './date.js';\n");
      assert.ok(!existsSync(join(w.home, "jobs", r.job_id, "change.json")), "a failed job stages nothing");
    } finally { w.cleanup(); }
  }
});

test("one attempt only: a rate limit trips the shared breaker, a slow worker times out, and the lock is always released", async () => {
  const w = world({ stub: { error: "429" } });
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", rate_limit_backoff_ms: [30, 30] } }));
    // Rate limits on every attempt (the retries pause only 30 ms here), then the breaker trips.
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "failed");
    assert.match((await w.start()).reason, /rate limited a moment ago/, "the next job does not even try");
    rmSync(join(w.home, "breaker-429.json"));
    assert.equal(acquireJobLock(w.repo, "probe", w.env), true, "the failed job released its lock");
    const queued = await w.start();
    assert.equal(queued.status, "queued", "a second job while one runs is queued, never refused");
    releaseJobLock(w.repo, "probe", w.env);
    await jobResult(queued.job_id, { waitMs: 5000, env: w.env }); // let it finish before the folder goes
  } finally { w.cleanup(); }
  const slow = world({ stub: { delay_ms: 400 } });
  try {
    writeFileSync(join(slow.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_timeout_ms: 100 } }));
    const started = await slow.start();
    assert.equal((await jobResult(started.job_id, { waitMs: 20, env: slow.env })).status, "running", "job_result returns while the worker is still busy");
    const r = await jobResult(started.job_id, { waitMs: 5000, env: slow.env });
    assert.match(r.reason, /did not answer within/);
  } finally { slow.cleanup(); }
});

test("a repeated edit lands as marker edits; new files from specs land through the one apply command", async () => {
  const trim = "new Date(String(s).trim())";
  const w = world({ answer: { edits: [{ path: "src/b.js", find: "new Date(s)", replace: trim }, { path: "src/c.js", find: "new Date(s)", replace: trim }] } });
  try {
    const args = { files: ["src/b.js", "src/c.js"], instruction: "Trim the input before constructing the Date.", example: { path: "src/date.js", find: "new Date(s)", replace: trim } };
    const started = await startJob({ tool: "repeat_edit_across_files", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env, args });
    const r = await jobResult(started.job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.deepEqual(r.landing.edits.map((e) => e.file_path.endsWith("src/b.js") || e.file_path.endsWith("src/c.js")), [true, true]);
    const missing = await startJob({ tool: "repeat_edit_across_files", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env, args: { ...args, files: ["src/b.js", "src/nope.js"] } });
    assert.match(missing.reason, /not in the snapshot/, "a repeated edit can only name files that exist");

    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = (s) => String(s).trim();\n" }] } }));
    const specs = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export t(s): returns String(s).trim(). One function, no dependencies." }], context_files: ["src/date.js"] },
    });
    const made = await jobResult(specs.job_id, { waitMs: 5000, env: w.env });
    assert.equal(made.status, "ready", JSON.stringify(made));
    assert.equal(made.landing.mode, "apply_command", "a change that creates a file cannot land as marker edits");
    assert.match(made.landing.command, new RegExp(`apply\\.mjs" ${specs.job_id} [0-9a-f]{64}$`));
    assert.equal(made.files[0].new_file, true);
  } finally { w.cleanup(); }
});

test("a secret in a file the job would send ends the job before the worker is called", async () => {
  const w = world();
  try {
    writeFileSync(join(w.repo, "src", "date.js"), SOURCE + `const k = "${"gh" + "p_" + "A1b2C3d4E5f6".repeat(3)}";\n`);
    let called = false;
    const r = await w.start({ callWorker: async () => { called = true; return { text: "{}" }; } });
    assert.equal(r.status, "refused");
    assert.match(r.reason, /secret shape/);
    assert.equal(called, false);
    assert.equal(acquireJobLock(w.repo, "probe", w.env), true, "a refusal after the lock was taken must release it");
  } finally { w.cleanup(); }
});

test("every job teaches the machine: a passed check, a failed check and a timeout are counted per cell, and the polls per job are measured", async () => {
  const { localSummary, measuredExtraRequests } = await import(join(A, "lib", "evidence.mjs"));
  const w = world();
  try {
    const cell = "bugfix_code|js_ts|flash|completion";
    assert.equal(measuredExtraRequests(w.env), null);
    const started = await w.start();
    assert.equal(started.status, "running");
    await jobResult(started.job_id, { env: w.env });           // one poll
    let sum = localSummary(cell, w.env);
    assert.equal(sum.passed, 1, "the answer passed the checks");
    assert.equal(sum.failed, 0);
    assert.equal(measuredExtraRequests(w.env), 2, "the start call plus one poll");
    // An answer that fails the checks twice (the resend included) is a failed check.
    writeFileSync(join(w.stubs, "fix_from_analysis.json"), JSON.stringify({ answer: { edits: [{ path: "src/date.test.js", find: "import", replace: "import x" }] }, usage: { input_tokens: 10, output_tokens: 10 }, model: "gemini-3.8-flash" }));
    const bad = await w.start();
    for (let i = 0; i < 3; i++) { const r = await jobResult(bad.job_id, { env: w.env }); if (r.status !== "running") break; }
    sum = localSummary(cell, w.env);
    assert.equal(sum.failed, 3, "every rejected answer, the resends included, is a fail for the worker that gave it");
    assert.equal(sum.jobs, 2, "two jobs, counted once each");
    assert.ok(sum.passed >= 1);
  } finally { w.cleanup(); }
});

test("a stray extra file in an otherwise correct answer is DROPPED, the declared files land, and the drop is reported", async () => {
  // Pair 6, 22 Sep: a 22-file job died because the worker also touched one file it was not allowed to;
  // the correct 22 files were thrown away with it. Nothing outside scope ever lands either way.
  const answer = { edits: [...GOOD_ANSWER.edits, { path: "src/b.js", find: "new Date(s)", replace: "1" }] };
  const w = world({ answer });
  try {
    const r = await jobResult((await w.start()).job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready");
    assert.deepEqual(r.files.map((f) => f.path), ["src/date.js"]);
    assert.deepEqual(r.dropped_files, ["src/b.js"]);
    assert.match(r.next, /1 file the worker touched but may not change was dropped \(src\/b\.js \(outside the job\)\)/);
    const staged = JSON.parse(readFileSync(join(w.home, "jobs", r.job_id, "change.json"), "utf8"));
    assert.deepEqual(staged.files.map((f) => f.path), ["src/date.js"], "only the declared file is staged");
    assert.deepEqual(staged.edits.map((e) => e.path), ["src/date.js"], "the dropped edit is not staged either");
    assert.equal(r.landing.mode, "marker_edits");
    assert.equal(r.landing.edits.length, 1, "no marker edit for the dropped file");
    const shown = await jobResult(r.job_id, { waitMs: 1000, env: w.env, showDiff: true });
    assert.doesNotMatch(shown.diff ?? "", /src\/b\.js/, "the diff the thinker may ask for holds only what will land");
    assert.equal(readFileSync(join(w.repo, "src", "b.js"), "utf8"), "export const b = new Date(s);\n", "the stray file is untouched");
    assert.equal(w.events().find((e) => e.type === "job.ready")?.dropped, 1);
  } finally { w.cleanup(); }
});

test("ONE collect call gathers many jobs: it waits until at least one is ready, reports every job's state, and a delivered job is never delivered twice", async () => {
  const { jobResults } = await import(join(A, "jobs.mjs"));
  const w = world();
  try {
    // Two jobs on different files: the bug fix on date.js and a repeated edit on b.js and c.js.
    const trim = "new Date(String(s).trim())";
    writeFileSync(join(w.stubs, "repeat_edit_across_files.json"), JSON.stringify({ answer: { edits: [{ path: "src/b.js", find: "new Date(s)", replace: trim }, { path: "src/c.js", find: "new Date(s)", replace: trim }] }, usage: { input_tokens: 10, output_tokens: 10 }, model: "gemini-3.8-flash" }));
    const a = await w.start();
    const b = await w.start({ tool: "repeat_edit_across_files", args: { files: ["src/b.js", "src/c.js"], instruction: "Trim the input before constructing the Date.", example: { path: "src/date.js", find: "new Date(s)", replace: trim } } });
    assert.equal(a.status, "running", JSON.stringify(a)); assert.equal(b.status, "running", JSON.stringify(b));
    assert.match(a.next, /job_ids/, "the start reply says to collect everything in one call");
    const got = await jobResults([a.job_id, b.job_id, "jnope"], { waitMs: 5000, env: w.env });
    assert.equal(got.status, "collected");
    const byId = Object.fromEntries(got.jobs.map((j) => [j.job_id, j]));
    assert.equal(byId[a.job_id].status, "ready"); assert.equal(byId[b.job_id].status, "ready");
    assert.equal(byId.jnope.status, "refused");
    assert.equal(got.ready, 2); assert.equal(got.running, 0);
    const again = await jobResults([a.job_id], { waitMs: 1000, env: w.env });
    assert.match(again.jobs[0].note ?? "", /already delivered/);
    const bad = await jobResults([], { env: w.env });
    assert.equal(bad.status, "refused");
  } finally { w.cleanup(); }
});

test("a job that dies of a timeout or a vendor error is tried ONCE MORE as a whole (jobs.job_retries) before the thinker is told to do it; a bad answer is not", async () => {
  // fail_first with no network retries: the first whole attempt dies at once; the second whole attempt answers.
  const w = world({ stub: { fail_first: "fetch failed" } });
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", network_retries: 0, job_retries: 1, worker_cascade: false } }));
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    const whole = w.events().filter((e) => e.type === "job.retried" && e.whole_job === true);
    assert.equal(whole.length, 1, "one whole-job retry, logged as such");
  } finally { w.cleanup(); }
  const dead = world({ stub: { fail_first: "fetch failed", error: "fetch failed" } });
  try {
    writeFileSync(join(dead.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", network_retries: 0, job_retries: 1, worker_cascade: false } }));
    const r = await jobResult((await dead.start()).job_id, { waitMs: 8000, env: dead.env });
    assert.equal(r.status, "failed", "two whole attempts, then the thinker does it");
    assert.equal(dead.events().filter((e) => e.type === "job.retried").length, 1);
  } finally { dead.cleanup(); }
  const bad = world({ stub: { fail_first: "the worker's answer was cut off (output cap at model absolute) after 8192 output tokens" } });
  try {
    writeFileSync(join(bad.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", network_retries: 0, job_retries: 1, worker_cascade: false } }));
    const r = await jobResult((await bad.start()).job_id, { waitMs: 8000, env: bad.env });
    assert.equal(r.status, "failed", "a bad answer is not transient: no second whole attempt");
    assert.ok(!bad.events().some((e) => e.type === "job.retried"));
  } finally { bad.cleanup(); }
});

test("with delegation off in the settings, a job start is refused before anything leaves, and the reason says so", async () => {
  const w = world();
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", delegation: "off", jobs: { block_ms: 0, landing: "manual" } }));
    const r = await w.start();
    assert.equal(r.status, "refused");
    assert.match(r.reason, /delegation: off/);
    assert.ok(!w.events().some((e) => e.type === "job.started"));
  } finally { w.cleanup(); }
});

test("landing runs the job's declared test command in the SAME turn (apply --test): pass or fail is printed and the evidence settles at once", async () => {
  // v2's harness ran the tests itself; in chat the thinker had to spend a turn on it after every landing.
  const good = world();
  try {
    writeFileSync(join(good.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = (s) => String(s).trim();\n" }] } }));
    const started = await startJob({ tool: "write_files_from_specs", stamp: good.stamp, projectDir: good.repo, callWorker: stubDoor(good.env), env: good.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a trim helper t(s) that returns String(s).trim(). Nothing else." }], context_files: ["src/date.js"], test_command: "node -e \"process.exit(0)\"" } });
    const r = await jobResult(started.job_id, { waitMs: 5000, env: good.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.landing.mode, "apply_command");
    assert.match(r.landing.command, / --test$/, "the landing command runs the tests too");
    assert.match(r.landing.how, /runs the job's test command/);
    const { localSummary } = await import(join(A, "lib", "evidence.mjs"));
    const applied = applyJob(r.job_id, r.landing.command.split(" ")[3].replace(/"/g, ""), good.env, { runTests: true });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.deepEqual([applied.tests.ran, applied.tests.passed, applied.tests.exit_code], [true, true, 0]);
    assert.equal(localSummary("boilerplate|js_ts|flash|completion", good.env).held, 1, "the verified pass at hand-back is the held verdict; landing adds no second one");
    assert.ok(!existsSync(join(good.home, "sessions", "s1", "landed-pending", r.job_id)), "nothing left for the hook to settle later");
    assert.equal(good.events().find((e) => e.type === "job.applied")?.judged_at_handback, "good");
  } finally { good.cleanup(); }
  const bad = world();
  try {
    writeFileSync(join(bad.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] } }));
    const started = await startJob({ tool: "write_files_from_specs", stamp: bad.stamp, projectDir: bad.repo, callWorker: stubDoor(bad.env), env: bad.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a trim helper t(s) that returns String(s).trim(). Nothing else." }], context_files: ["src/date.js"], test_command: "node -e \"const fs=require('fs'); if (fs.existsSync('src/util.js')) { console.log('Tests: 1 failed, 1 total'); process.exit(1); } console.log('Tests: 1 passed, 1 total')\"" } });
    const r = await jobResult(started.job_id, { waitMs: 5000, env: bad.env });
    const applied = applyJob(r.job_id, r.landing.command.split(" ")[3].replace(/"/g, ""), bad.env, { runTests: true });
    assert.equal(applied.ok, true, "the files are written even when the tests then fail; undo_job takes them back");
    assert.equal(applied.tests.passed, false);
    assert.match(applied.tests.tail, /1 failed, 1 total/);
    const { localSummary } = await import(join(A, "lib", "evidence.mjs"));
    assert.equal(localSummary("boilerplate|js_ts|flash|completion", bad.env).wrong, 1, "the declared tests failed on the worker's own change in the scratch copy: proven wrong at hand-back");
    assert.ok(!existsSync(join(bad.home, "sessions", "s1", "landed-pending", r.job_id)), "judged at hand-back, so the landing waits for nothing");
    assert.equal(bad.events().filter((e) => e.type === "job.outcome" && e.via === "apply-test").length, 0, "the failing run after landing adds no second verdict");
  } finally { bad.cleanup(); }
  const none = world();
  try {
    writeFileSync(join(none.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] } }));
    const started = await startJob({ tool: "write_files_from_specs", stamp: none.stamp, projectDir: none.repo, callWorker: stubDoor(none.env), env: none.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a trim helper t(s) that returns String(s).trim(). Nothing else." }], context_files: ["src/date.js"] } });
    const r = await jobResult(started.job_id, { waitMs: 5000, env: none.env });
    assert.doesNotMatch(r.landing.command, /--test/, "no test command declared: the plain apply command, and the thinker runs the tests");
  } finally { none.cleanup(); }
});

test("receipt-only read-back: a ready job shows Opus a receipt, not the code; the diff comes only when asked for", async () => {
  // The pipeline's 0.7.4 change 1: Opus never sees the code; it re-read and re-typed it three times before.
  const w = world();
  try {
    const r = await jobResult((await w.start()).job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready");
    assert.equal(r.diff, undefined, "no diff by default");
    assert.deepEqual([r.receipt.files, r.receipt.edits, r.receipt.creates], [1, 1, 0]);
    assert.ok(r.receipt.bytes > 0);
    assert.match(r.next, /diff is not shown/i);
    const again = await jobResult(r.job_id, { waitMs: 1000, env: w.env, showDiff: true });
    assert.match(again.diff ?? "", /trim/, "the diff on request, even after delivery, from the staged change");
  } finally { w.cleanup(); }
});

test("worker cascade: when the first worker's answer fails, the next open worker for that job gets one try before Opus is told to do it", async () => {
  const bad = { edits: [{ path: "src/date.js", find: "NOT IN THE FILE", replace: "x" }] };
  const w = world({ stub: { answers: [bad, GOOD_ANSWER] } });
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", answer_retries: 0, job_retries: 0, worker_cascade: true } }));
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.match(r.produced_by, /claude-sonnet-5/, "the second worker produced it");
    const hop = w.events().find((e) => e.type === "job.retried" && e.worker_cascade === true);
    assert.deepEqual([hop?.from, hop?.to], ["gemini-3.8-flash", "claude-sonnet-5"]);
  } finally { w.cleanup(); }
  const off = world({ stub: { answers: [bad, GOOD_ANSWER] } });
  try {
    writeFileSync(join(off.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", answer_retries: 0, job_retries: 0, worker_cascade: false } }));
    const r = await jobResult((await off.start()).job_id, { waitMs: 8000, env: off.env });
    assert.equal(r.status, "failed", "cascade off: the first failure ends the job");
  } finally { off.cleanup(); }
});

test("verification before hand-back: the declared tests run on the worker's change in a scratch copy; a failing run goes back to the worker, Opus hears only the verified result", async () => {
  // The pipeline's 0.7.4 change 2: the server runs the tests and retries Flash with the error; Opus is called only after the retry limit.
  const w = world();
  try {
    writeFileSync(join(w.repo, "src", "greet.js"), 'export function greet(n) {\n  return "hi " + n;\n}\n');
    writeFileSync(join(w.repo, "src", "greet.test.js"), 'import { greet } from "./greet.js";\nimport assert from "node:assert/strict";\nassert.equal(greet("x"), "hello x");\n');
    execFileSync("git", ["add", "-A"], { cwd: w.repo });
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", worker_cascade: false, answer_retries: 0, verify_retries: 1 } }));
    const wrong = { edits: [{ path: "src/greet.js", find: '"hi " + n', replace: '"hey " + n' }] };
    const right = { edits: [{ path: "src/greet.js", find: '"hi " + n', replace: '"hello " + n' }] };
    writeFileSync(join(w.stubs, "fix_from_analysis.json"), JSON.stringify({ answers: [wrong, right], usage: { input_tokens: 100, output_tokens: 20 }, model: "gemini-3.8-flash" }));
    const analysis = { ...ANALYSIS, bug_files: ["src/greet.js"], test_command: "node src/greet.test.js", root_cause: "greet() says hi where the callers and the test expect the word hello in front of the name.", fix_approach: "Change the greeting word inside greet() to hello; keep the signature and the rest of the file unchanged.", change_sites: [{ path: "src/greet.js", what: "the greeting word" }], read_set: ["src/greet.js"] };
    const started = await w.start({ args: { analysis, repro_files: ["src/greet.test.js"] } });
    assert.equal(started.status, "running", JSON.stringify(started));
    const r = await jobResult(started.job_id, { waitMs: 20000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.deepEqual([r.verify.ran, r.verify.passed], [true, true], "the second answer passed the tests in the scratch copy");
    const retried = w.events().find((e) => e.type === "job.retried" && /tests failed in a scratch copy/.test(e.error));
    assert.ok(retried, "the first answer went back to the worker with the failing tests");
    assert.equal(w.events().filter((e) => e.type === "job.verified").length, 2);
    assert.equal(readFileSync(join(w.repo, "src", "greet.js"), "utf8"), 'export function greet(n) {\n  return "hi " + n;\n}\n', "the real tree is untouched by verification");
    assert.ok(!existsSync(join(w.home, "verify")) || readdirSync(join(w.home, "verify")).length === 0, "the scratch copy is gone");
    assert.match(r.next, /passed in a scratch copy/);
  } finally { w.cleanup(); }
});

test("a worker answer that also rewrites the read-only test is not thrown away: the test change is dropped with its reason, the code lands, and the rejected answers of a failed job are kept for diagnosis", async () => {
  const w = world({ answer: { edits: [...GOOD_ANSWER.edits, { path: "src/date.test.js", find: "import './date.js';", replace: "// removed" }] } });
  try {
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env, showDiff: true });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.deepEqual(r.dropped_files, ["src/date.test.js"]);
    assert.match(r.next, /src\/date\.test\.js \(read-only for this job\)/, "the thinker is told which file and why");
    assert.equal(readFileSync(join(w.repo, "src", "date.test.js"), "utf8"), "import './date.js';\n", "the tree is untouched until landing");
  } finally { w.cleanup(); }
  const bad = world({ answer: { edits: [{ path: "src/date.test.js", find: "import './date.js';", replace: "// removed" }] } });
  try {
    const r = await jobResult((await bad.start()).job_id, { waitMs: 8000, env: bad.env });
    assert.equal(r.status, "failed");
    const kept = readdirSync(join(bad.home, "jobs", r.job_id)).filter((f) => f.startsWith("rejected-"));
    assert.ok(kept.length >= 1, "every rejected answer is kept, bounded, so a dead job can be read afterwards");
    const first = readFileSync(join(bad.home, "jobs", r.job_id, kept[0]), "utf8");
    assert.match(first, /^reason: protected/);
    assert.match(first, /chars: \d+/);
  } finally { bad.cleanup(); }
});

test("evidence is written under the worker that answered: Flash's rejected answers are Flash's fails, Sonnet's rescue is Sonnet's pass, and the landing verdict follows the worker that wrote the files", async () => {
  const w = world();
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 0, landing: "manual", answer_retries: 1, verify_before_handback: false } }));
    const bad = { edits: [{ path: "src/b.js", find: "new Date(s)", replace: "1" }] };
    writeFileSync(join(w.stubs, "fix_from_analysis.json"), JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10 }, by_worker: { "gemini-3.8-flash": { answer: bad, model: "gemini-3.8-flash" }, "claude-sonnet-5": { answer: GOOD_ANSWER, model: "claude-sonnet-5" } } }));
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.match(r.produced_by, /claude-sonnet-5/);
    const flash = localSummaryOf("bugfix_code|js_ts|flash|completion", w.env);
    const sonnet = localSummaryOf("bugfix_code|js_ts|sonnet|completion", w.env);
    assert.deepEqual([flash.jobs, flash.passed, flash.failed], [1, 0, 2], "one Flash job, two rejected answers = two Flash fails");
    assert.deepEqual([sonnet.jobs, sonnet.passed, sonnet.failed], [1, 1, 0], "the rescue is Sonnet's pass, not Flash's");
    assert.equal(readJob(r.job_id, w.env).cell, "bugfix_code|js_ts|sonnet|completion", "the landing verdict goes to the worker that wrote the files");
  } finally { w.cleanup(); }
});

test("a scratch-copy verification is the landing verdict: passed means held, failed after the retries means wrong; landing then adds no second verdict", async () => {
  const w = world();
  try {
    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = (s) => String(s).trim();\n" }] } }));
    const started = await startJob({ tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a trim helper t(s) that returns String(s).trim(). Nothing else." }], test_command: "node -e \"process.exit(0)\"" } });
    const r = await jobResult(started.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.verify.passed, true);
    const cell = "boilerplate|js_ts|flash|completion";
    assert.equal(localSummaryOf(cell, w.env).held, 1, "the verified pass is the held verdict");
    const applied = applyJob(r.job_id, r.landing.command.split(" ")[3].replace(/"/g, ""), w.env, { runTests: true });
    assert.equal(applied.ok, true);
    assert.equal(localSummaryOf(cell, w.env).held, 1, "landing a verified change adds no second verdict");
    assert.ok(!existsSync(join(w.home, "sessions", "s1", "landed-pending", r.job_id)), "nothing waits: the verdict was given at hand-back");
  } finally { w.cleanup(); }
});

test("the cost rule decides at the tool call: a job whose expected typing is below the chat's break-even is refused with the numbers; above it, it runs; the size per file is learned from real answers; a stamp without a break-even is not gated", async () => {
  const w = world();
  try {
    const small = await w.start({ stamp: { ...w.stamp, break_even_chars: 16000, context_tokens: 100000 } });
    assert.equal(small.status, "refused", JSON.stringify(small));
    assert.equal(small.gate, "break-even");
    assert.match(small.reason, /about [\d,]+ characters \(1 file × [\d,]+ per file for a bug fix, measured from this project\).*pays only above 16,000 characters.*Bundle more files into one call, or type them yourself/s);
    const gate = w.events().find((e) => e.type === "job.refused_gate");
    assert.deepEqual([gate.break_even_chars, gate.files], [16000, 1]);
    assert.ok(gate.expected_chars > 0 && gate.expected_chars < 2700, `sized from this project, not the 2,700 prior: ${gate.expected_chars}`);
    assert.match(String(gate.size_from), /^project\(\d+\)$/, "and the record names how many of its files were measured");
    const ok = await w.start({ stamp: { ...w.stamp, break_even_chars: 1000, context_tokens: 8000 } });
    assert.equal(ok.status, "running", JSON.stringify(ok));
    const r = await jobResult(ok.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready");
    const { expectedCharsPerFile } = await import(join(A, "lib", "evidence.mjs"));
    const learned = expectedCharsPerFile("bugfix_code", w.env, 2700);
    assert.ok(learned > 0 && learned < 2700, `one real answer (a 40-character replacement) pulls the learned size down from the seed: ${learned}`);
    assert.equal((await w.start()).status, "running", "no break-even on the stamp (an older hook): no gate, as before");
  } finally { w.cleanup(); }
});

test("the tests tool takes every test file of a phase in ONE call: each file has its own cases, all are declared, one job, one receipt", async () => {
  const { BUILDERS } = await import(join(A, "lib", "brief.mjs"));
  const built = BUILDERS.write_tests_from_cases({ tests: [{ path: "src/a.test.js", cases: ["parse trims spaces", "parse rejects empty"] }, { path: "src/b.test.js", cases: ["b is a date"] }], target_files: ["src/date.js", "src/b.js"], test_command: "node --test" });
  assert.deepEqual(built.declared, ["src/a.test.js", "src/b.test.js"]);
  const text = built.render([{ path: "src/date.js", content: SOURCE }]);
  assert.match(text, /Write tests in src\/a\.test\.js[\s\S]*1\. parse trims spaces[\s\S]*Write tests in src\/b\.test\.js[\s\S]*1\. b is a date/);
  assert.throws(() => BUILDERS.write_tests_from_cases({ test_path: "src/a.test.js", cases: ["x"], target_files: ["src/date.js"] }), /tests/, "the one-file shape is gone: it forced hand-overs below the break-even");
  const w = world();
  try {
    writeFileSync(join(w.stubs, "write_tests_from_cases.json"), JSON.stringify({ answer: { creates: [{ path: "src/a.test.js", content: "import './date.js';\n" }, { path: "src/b.test.js", content: "import './b.js';\n" }] } }));
    const started = await startJob({ tool: "write_tests_from_cases", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { tests: [{ path: "src/a.test.js", cases: ["parse trims spaces"] }, { path: "src/b.test.js", cases: ["b is a date"] }], target_files: ["src/date.js", "src/b.js"] } });
    assert.equal(started.status, "running", JSON.stringify(started));
    const r = await jobResult(started.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.receipt.creates, 2);
  } finally { w.cleanup(); }
});

test("one hand-over, one request: the start call waits for the job, the server lands the verified files itself, and answers once with the receipt; the request count learned is one", async () => {
  const w = world();
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on" })); // the defaults: block and land
    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = (s) => String(s).trim();\n" }] } }));
    const r = await startJob({ tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a trim helper t(s) that returns String(s).trim(). Nothing else." }], test_command: "node -e \"process.exit(0)\"" } });
    assert.equal(r.status, "landed", JSON.stringify(r));
    assert.deepEqual(r.landed.files, ["src/util.js"]);
    assert.equal(readFileSync(join(w.repo, "src", "util.js"), "utf8"), "export const t = (s) => String(s).trim();\n", "written into the project by the server");
    assert.equal(r.verify.passed, true);
    assert.equal(r.landing, undefined, "nothing left for the thinker to land");
    assert.match(r.next, /tests passed in a scratch copy.*written into the project/s);
    assert.ok(w.events().some((e) => e.type === "job.applied" && e.by === "server"));
    const { measuredExtraRequests } = await import(join(A, "lib", "evidence.mjs"));
    assert.equal(measuredExtraRequests(w.env), 1, "one request: the start call itself");
    assert.equal(w.events().filter((e) => e.type === "job.ready").length, 1);
  } finally { w.cleanup(); }
});

test("a job longer than the wait returns 'running' and still lands itself when done; a change whose tests failed is NOT landed and comes back with the manual landing; landing: manual keeps the old path", async () => {
  const slow = world();
  try {
    writeFileSync(join(slow.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 300 } }));
    writeFileSync(join(slow.stubs, "write_files_from_specs.json"), JSON.stringify({ delay_ms: 1200, answer: { creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] } }));
    const r = await startJob({ tool: "write_files_from_specs", stamp: slow.stamp, projectDir: slow.repo, callWorker: stubDoor(slow.env), env: slow.env, args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a constant t equal to one, nothing else." }] } });
    assert.equal(r.status, "running", JSON.stringify(r));
    assert.match(r.next, /lands itself/);
    const got = await jobResult(r.job_id, { waitMs: 8000, env: slow.env });
    assert.equal(got.status, "landed", JSON.stringify(got));
    assert.ok(existsSync(join(slow.repo, "src", "util.js")));
    assert.match(got.next, /run the tests yourself/, "no test command was declared, so the thinker runs the tests");
  } finally { slow.cleanup(); }
  const failing = world();
  try {
    writeFileSync(join(failing.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { verify_retries: 0 } }));
    writeFileSync(join(failing.stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] } }));
    const r = await startJob({ tool: "write_files_from_specs", stamp: failing.stamp, projectDir: failing.repo, callWorker: stubDoor(failing.env), env: failing.env,
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a constant t equal to one, nothing else." }], test_command: "node -e \"const fs=require('fs'); if (fs.existsSync('src/util.js')) { console.log('Tests: 1 failed, 1 total'); process.exit(1); } console.log('Tests: 1 passed, 1 total')\"" } });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.verify.passed, false);
    assert.ok(!existsSync(join(failing.repo, "src", "util.js")), "a change whose tests failed is never written by the server");
    assert.equal(r.landing.mode, "apply_command", "the thinker may still land it by hand, or do it itself");
  } finally { failing.cleanup(); }
  const manual = world();
  try {
    writeFileSync(join(manual.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { landing: "manual" } }));
    const r = await manual.start();
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.landing.mode, "marker_edits");
    assert.equal(readFileSync(join(manual.repo, "src", "date.js"), "utf8"), SOURCE, "manual: nothing written by the server");
  } finally { manual.cleanup(); }
});

test("the depth a worker ran at is on the job's record and its ready event", async () => {
  const w = world({ stub: { thinking: "high" } });
  try {
    const r = await jobResult((await w.start()).job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready");
    assert.equal(w.events().find((e) => e.type === "job.ready")?.thinking, "high");
    assert.equal(readJob(r.job_id, w.env).worker_thinking, "high");
  } finally { w.cleanup(); }
});

test("the waiting call never outlives the chat's prompt cache: on the five-minute tier it returns at the cap and the job lands itself", async () => {
  const w = world();
  try {
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { block_ms: 100000, block_cap_5m_ms: 200 } }));
    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({ delay_ms: 900, answer: { creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] } }));
    const r = await startJob({ tool: "write_files_from_specs", stamp: { ...w.stamp, cache_tier: "5m" }, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env, args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a constant t equal to one, nothing else." }] } });
    assert.equal(r.status, "running", "returned at the cap, before the cache could expire");
    const got = await jobResult(r.job_id, { waitMs: 8000, env: w.env });
    assert.equal(got.status, "landed");
  } finally { w.cleanup(); }
});

test("a commissioned job that answers with some of its files is sent back for the rest, named", async () => {
  const w = world();
  try {
    // First answer: one file of the three commissioned. Second: all three.
    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({
      answers: [
        { creates: [{ path: "src/one.js", content: "export const one = 1;\n" }] },
        { creates: ["one", "two", "three"].map((n) => ({ path: `src/${n}.js`, content: `export const ${n} = 1;\n` })) },
      ],
    }));
    const started = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { design_file: "DESIGN.md", specs: ["one", "two", "three"].map((n) => ({ path: `src/${n}.js`, exports: [n], behaviour: `Export a constant called ${n} equal to one.` })) },
    });
    const r = await jobResult(started.job_id, { waitMs: 20000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.receipt.creates, 3, "the finished answer holds all three commissioned files");
    const retried = w.events().filter((e) => e.type === "job.retried");
    assert.equal(retried.length, 1, JSON.stringify(retried));
    assert.match(retried[0].error, /missing-files/, "the resend says which gate refused it");
    assert.match(retried[0].error, /src\/two\.js/, "and names the files that were not written");
  } finally { w.cleanup(); }
});

test("a job handed back with failing tests releases its files: the thinker may type them by hand", async () => {
  const w = world();
  try {
    const { isReleased } = await import(join(A, "lib", "released.mjs"));
    // A repro test that always fails, so every attempt fails verification in the scratch copy.
    writeFileSync(join(w.repo, "src", "date.test.js"), "console.log('# fail 1');\nprocess.exit(1);\n");
    execFileSync("git", ["add", "-A"], { cwd: w.repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "red"], { cwd: w.repo, stdio: "pipe" });
    const started = await w.start();
    const r = await jobResult(started.job_id, { waitMs: 30000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.verify.passed, false, "the tests failed, so nothing was written");
    assert.ok(!r.landed, "a change whose tests failed never lands");
    assert.equal(isReleased("s1", join(w.repo, "src", "date.js"), w.env), true,
      "no worker could do it, so the hook must let the thinker type it: a bad verdict releases the files, not only a crash");
  } finally { w.cleanup(); }
});

test("a job that dies without a verdict still records what the worker cost", async () => {
  const w = world();
  try {
    // Every answer is unparseable, so `checked` is never built and the chain throws
    // with no gate failures: the exit that used to drop the money it had already spent.
    writeFileSync(join(w.stubs, "fix_from_analysis.json"), JSON.stringify({ text: "I cannot do this.", cost_usd: 0.25 }));
    const started = await w.start();
    const r = await jobResult(started.job_id, { waitMs: 20000, env: w.env });
    assert.equal(r.status, "failed", JSON.stringify(r));
    const failed = w.events().find((e) => e.type === "job.failed");
    assert.ok(failed, "the job reports its failure");
    assert.ok(Number(failed.worker_cost_usd) > 0.7, `three rejected answers at $0.25 were really paid for: ${failed.worker_cost_usd}`);
    assert.ok(Number(readJob(started.job_id, w.env).worker_cost_usd) > 0.7, "and the job record carries it too");
  } finally { w.cleanup(); }
});

/**
 * 23 Sep, pair 10: Opus commissioned jest.config.js, .env and .env.example, which a
 * worker may never write. Nothing refused the job, so five worker calls were paid
 * to discover a contradiction that was readable from the file list: write every
 * commissioned file (the completeness rule) and never write these (hard deny).
 * The door now refuses such a job before anyone is called, naming the files.
 */
test("a job that commissions a file workers may never write is refused at the door, naming it, before any worker is paid", async () => {
  const w = world();
  try {
    let called = 0;
    const r = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, env: w.env,
      callWorker: async () => { called++; return { text: "{}" }; },
      args: { design_file: "DESIGN.md", specs: [
        { path: "src/util.js", exports: ["t"], behaviour: "Export t(s): returns String(s).trim(). One function, no dependencies." },
        { path: "jest.config.js", exports: [], behaviour: "CommonJS jest config with ts-jest preset and a testEnvironment of node." },
        { path: ".env", exports: [], behaviour: "Local development environment: DATABASE_URL and JWT_SECRET." },
      ] },
    });
    assert.equal(r.status, "refused", JSON.stringify(r));
    assert.equal(r.gate, "forbidden-file");
    assert.deepEqual(r.forbidden, ["jest.config.js", ".env"]);
    assert.match(r.reason, /jest\.config\.js/);
    assert.match(r.reason, /\.env\b/);
    assert.match(r.reason, /drop|remove|leave .* out/i, "the reason tells the thinker what to do: leave those files out and call again");
    assert.equal(called, 0, "no worker is paid to discover a contradiction that is readable from the file list");
    const ev = w.events().find((e) => e.type === "job.refused_forbidden");
    assert.ok(ev, "the refusal is on the record");
    assert.deepEqual(ev.forbidden, ["jest.config.js", ".env"]);
    assert.equal(w.events().some((e) => e.type === "job.started"), false);
    assert.equal(existsSync(join(w.home, "evidence.json")), false, "a job-definition error teaches nothing about any worker");
  } finally { w.cleanup(); }
});

test("a create job's design file, written by the thinker and never committed, reaches the worker inlined once", async () => {
  const w = world();
  try {
    writeFileSync(join(w.repo, "DESIGN.md"), "# Design\n\n## Util\nt(s) trims and returns a string.\n"); // untracked on purpose
    let brief = null;
    const started = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, env: w.env,
      callWorker: async ({ brief: b }) => { brief = b; return { text: JSON.stringify({ creates: [{ path: "src/util.js", content: "export const t = (s) => String(s).trim();\n" }] }), usage: { input_tokens: 10, output_tokens: 10 } }; },
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "t(s) per DESIGN §Util: returns String(s).trim(); one function, no dependencies." }] },
    });
    const r = await jobResult(started.job_id, { waitMs: 5000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.ok(brief && brief.includes("t(s) trims and returns a string."), "the design text is in the brief");
    assert.equal((brief.match(/# Design/g) || []).length, 1, "once");
    assert.match(brief, /EXPORTS: t/);
    const noDesign = await startJob({ tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, env: w.env, callWorker: async () => ({ text: "{}" }),
      args: { design_file: "docs/NOPE.md", specs: [{ path: "src/u2.js", behaviour: "A constant, per DESIGN." }] } });
    assert.equal(noDesign.status, "refused");
    assert.match(noDesign.reason, /NOPE\.md/, "a design file that is not on disk is named, not silently dropped");
  } finally { w.cleanup(); }
});

/**
 * Pair 11, 23 Sep: the gate's break-even was built on an ASSUMED 400 chars of spec per job,
 * while Opus actually sent 9,720–42,456 per hand-over. Four of seven hand-overs had specs at
 * 81–99% of the files they described and all four passed the gate, because the judge could
 * not see the bill it was judging. The gate now uses the specs the thinker really wrote.
 */
test("the gate weighs the specs the thinker really wrote, not an assumed 400 characters", async () => {
  const w = world();
  try {
    // Nine files of routine scaffold, with specs nearly as long as the files: the shape that lost.
    const bloated = Array.from({ length: 9 }, (_, i) => ({ path: `src/g${i}.ts`, exports: [`g${i}`], behaviour: "Per DESIGN. " + "detail ".repeat(430) }));
    const lean = bloated.map((s) => ({ ...s, behaviour: "Export a constant per DESIGN §" + s.path }));
    writeFileSync(join(w.repo, "DESIGN.md"), "# Design\n" + "a paragraph.\n".repeat(50));
    const stamp = { ...w.stamp, _mmo: undefined, break_even_chars: 796, context_tokens: 40000 };
    const start = (specs) => startJob({ tool: "write_files_from_specs", stamp, projectDir: w.repo, env: w.env,
      callWorker: async () => ({ text: JSON.stringify({ creates: bloated.map((s) => ({ path: s.path, content: "export const x = 1;\n" })) }), usage: { input_tokens: 10, output_tokens: 10 } }),
      args: { design_file: "DESIGN.md", specs } });

    const big = await start(bloated);
    assert.equal(big.status, "refused", JSON.stringify(big));
    assert.equal(big.gate, "break-even");
    assert.ok(big.spec_chars > 25000, `the refusal names what the thinker wrote: ${big.spec_chars}`);
    assert.match(big.reason, /spec/i, "and says the specs are the reason, so the thinker can shorten them");

    const small = await start(lean);
    assert.equal(small.status, "running", JSON.stringify(small));
    const gate = w.events().find((e) => e.type === "job.refused_gate");
    assert.ok(gate && gate.spec_chars > 25000 && gate.judged_on === "specs", "the refusal is on the record, judged on the real specs");
  } finally { w.cleanup(); }
});

/**
 * Pair 11, 23 Sep: one job ran six attempts — Flash once, then five on Sonnet after the
 * cascade — all failing on the SAME crash inside a Jest global-setup file the THINKER had
 * written by hand. Jest died before a single test executed, the runner reported a failed
 * run, and the code blamed the worker every time. $1.71 and 22 minutes re-judging correct
 * files with a judge that could not start. A run that dies before any test executes is a
 * broken harness, not a failed change: it goes back to the thinker, never to a worker.
 */
test("a test command that dies before any test runs is the thinker's to fix: no worker retry, no cascade, no blame", async () => {
  const w = world();
  try {
    // Jest-shaped crash: a stack trace, no test counts anywhere in the output.
    writeFileSync(join(w.repo, "src", "date.test.js"), "throw new Error('at async runGlobalHook (/x/node_modules/@jest/core/build/index.js:3186:9)');\n");
    execFileSync("git", ["add", "-A"], { cwd: w.repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "broken setup"], { cwd: w.repo, stdio: "pipe" });
    let calls = 0;
    const started = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, env: w.env,
      callWorker: async () => { calls++; return { text: JSON.stringify({ creates: [{ path: "src/util.js", content: "export const t = 1;\n" }] }), usage: { input_tokens: 10, output_tokens: 10 } }; },
      args: { design_file: "DESIGN.md", specs: [{ path: "src/util.js", exports: ["t"], behaviour: "Export a constant t equal to one, per DESIGN." }], test_command: "node src/date.test.js" },
    });
    const r = await jobResult(started.job_id, { waitMs: 30000, env: w.env });
    assert.equal(calls, 1, "the worker is asked once and never again: its change was never judged");
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.verify.ran, false, "the tests did not run, so there is no verdict on the change");
    assert.equal(r.verify.harness, true, "and the reason is named as the harness, not the code");
    assert.match(r.verify.reason, /already fails on this project without the worker/i);
    assert.match(r.next, /test command/i, "the thinker is told what to fix");
    assert.ok(!r.landed, "nothing lands on an unproven change");
    const ev = w.events().filter((e) => e.type === "job.retried");
    assert.equal(ev.length, 0, "no retry is charged to the worker");
    assert.equal(w.events().some((e) => e.type === "job.verified" && e.harness === true), true, "the record says the harness broke");
    const cells = existsSync(join(w.home, "evidence.json")) ? JSON.parse(readFileSync(join(w.home, "evidence.json"), "utf8")).cells : {};
    for (const [k, v] of Object.entries(cells)) assert.equal(v.g?.[1] ?? 0, 0, `no worker is marked wrong for a judge that could not start: ${k}`);
  } finally { w.cleanup(); }
});

/**
 * The pipeline's 0.7.4 fix 4, and pair 11's 21-file job: the scratch copy is rebuilt from the snapshot on
 * every attempt, so a worker whose ONE file failed the compiler had to retype all twenty-one.
 * The accepted files now carry forward, and the resend asks for the failures only, so a retry
 * costs one file's worth of worker output instead of the whole phase's.
 */
test("a retry repairs only what failed: the accepted files carry forward and the resend asks for those, not the phase", async () => {
  const w = world();
  try {
    const three = ["n1", "n2", "n3"];
    const full = { creates: three.map((n) => ({ path: `src/${n}.js`, content: `export const ${n} = 1;\n` })) };
    // Second answer holds ONLY the file that failed, which must now be accepted.
    const patch = { creates: [{ path: "src/n2.js", content: "export const n2 = 2;\n" }] };
    writeFileSync(join(w.stubs, "write_files_from_specs.json"), JSON.stringify({ answers: [full, patch] }));
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on" })); // the defaults: block and land
    // Green on the untouched project; red while src/b.js still says 1.
    const cmd = "node -e \"const fs=require('fs'); const p='src/n2.js'; if (fs.existsSync(p) && fs.readFileSync(p,'utf8').includes('= 1')) { console.log('Tests: 1 failed, 1 total'); process.exit(1); } console.log('Tests: 1 passed, 1 total')\"";
    const started = await startJob({
      tool: "write_files_from_specs", stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env,
      args: { design_file: "DESIGN.md", test_command: cmd, specs: three.map((n) => ({ path: `src/${n}.js`, exports: [n], behaviour: `Export a constant ${n}, per DESIGN.` })) },
    });
    // With the default wait the start call itself carries the finished job.
    const r = started.status === "running" ? await jobResult(started.job_id, { waitMs: 30000, env: w.env }) : started;
    assert.equal(r.status, "landed", JSON.stringify(r).slice(0, 400));
    assert.equal(r.verify.passed, true, "the retry made the suite green");
    assert.equal(r.receipt.creates, 3, "all three files land: the two that were already right carried forward");
    assert.equal(readFileSync(join(w.repo, "src", "n2.js"), "utf8").trim(), "export const n2 = 2;", "the repaired file is the worker's second answer");
    assert.equal(readFileSync(join(w.repo, "src", "n1.js"), "utf8").trim(), "export const n1 = 1;", "and the untouched ones are its first");
    const retried = w.events().filter((e) => e.type === "job.retried");
    assert.equal(retried.length, 1, JSON.stringify(retried));
    assert.match(retried[0].error, /tests failed/i);
  } finally { w.cleanup(); }
});

test("the gate sizes the job from THIS project's own files, and says so; a project with nothing to say keeps the learned prior", async () => {
  const w = world();
  try {
    // Nine tiny source files: this project writes small files, whatever other projects do.
    for (let i = 0; i < 9; i++) writeFileSync(join(w.repo, "src", `s${i}.js`), "x".repeat(300));
    execFileSync("git", ["add", "-A"], { cwd: w.repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "small files"], { cwd: w.repo, stdio: "pipe" });
    const stamp = { ...w.stamp, break_even_chars: 796, context_tokens: 40000 };
    const started = await startJob({
      tool: "write_files_from_specs", stamp, projectDir: w.repo, env: w.env, callWorker: async () => ({ text: "{}" }),
      args: { design_file: "DESIGN.md", specs: [{ path: "src/n0.js", exports: ["n0"], behaviour: "Per DESIGN. " + "detail ".repeat(200) }] },
    });
    assert.equal(started.status, "refused", JSON.stringify(started));
    assert.equal(started.gate, "break-even");
    assert.ok(started.per_file_chars < 1500, `pulled down towards this project's own 300-char files, far from the 2,800 prior: ${started.per_file_chars}`);
    const gate = w.events().find((e) => e.type === "job.refused_gate");
    assert.match(String(gate.size_from), /^project\(\d+\)$/, "the record says where the size came from and on how many files, so nobody has to guess");
  } finally { w.cleanup(); }
});
