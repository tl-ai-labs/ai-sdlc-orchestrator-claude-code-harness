/**
 * The live board. Two things are pinned: it is safe to run on a developer's
 * machine (token, Host check, three routes, strict CSP, text-only rendering),
 * and its numbers come from the real records and add up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const BOARD = join(ROOT, "plugin", "scripts", "ambient", "board");
const { startBoard } = await import(join(BOARD, "server.mjs"));
const { buildData } = await import(join(BOARD, "data.mjs"));

function get(url, headers = {}) {
  return new Promise((done, fail) => {
    const u = new URL(url);
    const req = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method: headers.method ?? "GET", headers: { Host: headers.Host ?? u.host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

const at = (s) => new Date(Date.UTC(2026, 8, 22, 10, 0, s)).toISOString();
const usage = { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 400 };
const REQ = (1000 * 5 + 100000 * 0.5 + 400 * 25) / 1e6;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-board-"));
  const home = join(dir, "home");
  const session = (id, arm, events, requests) => {
    mkdirSync(join(home, "sessions", id), { recursive: true });
    const transcript = join(dir, id + ".jsonl");
    writeFileSync(transcript, requests.map((s, i) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { id: id + i, model: "claude-opus-5", usage } })).join("\n"));
    const all = [{ ts: at(0), type: "session.start", arm, forced: true, mode: "on", transcript_path: transcript, repo_kind: "brownfield" }, ...events];
    writeFileSync(join(home, "sessions", id, "events.jsonl"), all.map((e) => "\n" + JSON.stringify(e) + "\n").join(""));
  };
  session("sessA", "on", [
    { ts: at(1), type: "prompt", label: "other", inherited: false },
    { ts: at(1), type: "prompt", label: "bugfix", inherited: false },
    { ts: at(7), type: "prompt", label: "system", typed: false, inherited: false, chars: 408 },
    { ts: at(2), type: "valve.act", act_id: "x", valve: "read", path: "/r/<img src=x onerror=alert(1)>.js", tokens_full: 20000, tokens_kept: 2000 },
    { ts: at(8), type: "job.ready", job: "j1", files: 1, worker_cost_usd: 0.004 },
    { ts: at(8), type: "write_files.used", files: 3, created: 3, overwritten: 0, tests_ran: true, tests_passed: true },
    { ts: at(8), type: "offer.eligible", trigger: "new_files_written", job: "boilerplate", worker: "flash", shown: true, break_even_chars: 6213 },
    { ts: at(8), type: "job.queued", job: "j2", tool: "write_tests_from_cases", worker: "flash" },
    { ts: at(8), type: "job.retried", job: "j2", error: "fetch failed" },
    { ts: at(8), type: "job.failed", job: "j3", error_class: "worker-or-answer", error: "waited 600 s for the repository's other job; giving up", wall_ms: 600000 },
    { ts: at(8), type: "job.refused_forbidden", tool: "write_files_from_specs", files: 3, forbidden: ["jest.config.js", ".env"] },
    { ts: at(8), type: "job.retried", job: "j4", error: "tests failed in a scratch copy: Type 'X' is not assignable to 'Y'" },
    { ts: at(8), type: "bash.tests_passed", command: "npm test" },
    { ts: at(9), type: "turn.end" },
  ], [3, 4, 5]);
  session("sessB", "control", [{ ts: at(1), type: "prompt", label: "bugfix", inherited: false }], [3, 4, 5, 6]);
  return { dir, env: { MMO_HOME: home, HOME: home }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the numbers come from the records and add up; a pair shows no saving until BOTH sides finished", () => {
  const w = world();
  try {
    const d = buildData({ env: w.env });
    assert.equal(d.pair.a.id, "sessA");
    assert.equal(d.pair.b.id, "sessB");
    assert.deepEqual([d.pair.a.side, d.pair.b.side], ["on", "plain"]);
    assert.equal(d.pair.a.label, "bugfix", "a greeting before the real request must not name the task");
    assert.equal(d.pair.a.repo_kind, "brownfield");
    assert.equal(d.pair.a.label, "bugfix", "a bug fix in existing code keeps its own name");
    assert.ok(Math.abs(d.pair.a.thinker_usd - 3 * REQ) < 1e-12 && Math.abs(d.pair.b.thinker_usd - 4 * REQ) < 1e-12);
    // A background command's completion notice arrives as a queued message and fires the prompt hook (seen live on
    // 22 Sep, "3 prompts" on a side where the person typed two). It is not a prompt and must not count as one.
    assert.equal(d.pair.a.touches, 2, "only what a person typed counts");
    assert.ok(d.pair.a.steps.some((x) => x.text === "A background command finished and its notice was queued (not a prompt)"), JSON.stringify(d.pair.a.steps.map((x) => x.text)));
    assert.equal(d.pair.a.label, "bugfix", "a system notice never names the task");
    assert.ok(Math.abs(d.pair.a.total_usd - (3 * REQ + 0.004)) < 1e-12, "the worker's cost is part of side A's total");
    assert.equal(d.pair.both_done, false, "side B has not finished");
    assert.equal(d.pair.saving_usd, null, "a half-done side must never look cheap");
    const kept = 18000 * (10e-6 + 0.5e-6 * 3);
    assert.ok(Math.abs(d.headline.ledger_saved_usd - kept) < 1e-12, "the headline is the realised ledger: 18000 tokens kept out of 3 later requests");
    assert.equal(d.headline.sessions_counted, 1, "the control session adds nothing to the saved total");
    assert.ok(Math.abs(d.headline.worker_share - 0.004 / (7 * REQ + 0.004)) < 1e-12);
    const feed = d.pair.a.steps.map((x) => x.text);
    assert.ok(feed.some((t) => /Refused a cheaper-model job before any worker was called.*jest\.config\.js, \.env/.test(t)), "a job refused at the door for a forbidden file is one plain line naming the files: " + JSON.stringify(feed));
    assert.ok(feed.includes("Offered a cheaper-model job (Writing routine new files, Gemini Flash); at this chat's size handing over pays above 6,213 characters of typing"), JSON.stringify(feed));
    assert.ok(feed.includes("Cheaper-model job queued behind the running one: Writing tests"), "a queued job must show in the feed, or the page looks stuck");
    assert.ok(feed.includes("Wrote 3 files in one call, no worker, and ran the tests: passed"), "the batch write shows as the thinker's own typing");
    assert.ok(feed.includes("The worker call dropped (fetch failed); trying once more"));
    // 31 jobs once showed as "no usable answer" when they had simply given up waiting in line; the feed says the real reason.
    assert.ok(feed.includes("Cheaper-model job failed (waited 600 s for the repository's other job; giving up); the main model does it itself"), JSON.stringify(feed));
    // ONE table, ONE row per kind of work and cheaper model. The languages live inside the row: which ones
    // the model is picked for, what was measured on each, and why it is not used on the others.
    assert.equal(d.by_language, undefined, "no second table");
    assert.ok(d.seeds.every((s) => s.source.length > 10), "every seed row shows its source");
    const bug = d.seeds.filter((s) => s.job.includes("bug fix"));
    assert.deepEqual(bug.map((s) => s.worker), ["Gemini Flash", "Claude Sonnet"], "one row per model, nothing repeated");
    const [flash, sonnet] = bug;
    assert.equal(flash.files, "Python, JavaScript / TypeScript, other languages");
    assert.equal(sonnet.files, "Go");
    assert.match(flash.measured, /Python: 264 bugs to both; Opus fixed 10 that Gemini Flash missed, Gemini Flash fixed 3 that Opus missed; 12\.1% cheaper\./);
    assert.match(flash.measured, /Go: 130 bugs to both.*1\.8% dearer\./);
    assert.match(flash.decision, /^Allowed, on the strength of this evidence\. Picked for Python, JavaScript \/ TypeScript and other languages\. Not for Go: it costs more than Opus alone there\.$/);
    assert.match(sonnet.measured, /Go: 142 bugs to both.*8\.2% cheaper\./);
    assert.match(sonnet.decision, /Picked for Go\./);
    assert.match(sonnet.decision, /Not for Python: it does not pay there\./);
    assert.match(sonnet.decision, /Not for JavaScript \/ TypeScript: Gemini Flash saves more per job there\./);
    assert.match(flash.source, /SWE-bench Pro/);
    assert.ok(!/repositories only/.test(flash.source), "one source line for the row, not one per language");
    const files = d.seeds.filter((s) => s.job === "Writing routine new files");
    assert.equal(files.length, 1);
    assert.equal(files[0].files, "Python, JavaScript / TypeScript");
    assert.match(files[0].measured, /Python: 7 of 8 results were usable\. JavaScript \/ TypeScript: 5 of 6 results were usable\./);
    const repeat = d.seeds.filter((s) => s.job.startsWith("Repeating"));
    assert.deepEqual(repeat.map((s) => [s.worker, s.files]), [["Gemini Flash", "any language"], ["Claude Sonnet", "none"]]);
    assert.match(repeat[1].decision, /Not for any language: Gemini Flash saves more per job there\./);
    const tests = d.seeds.find((s) => s.job === "Writing tests");
    assert.match(tests.decision, /^Allowed, because the policy file/, "weak evidence beside 'Allowed' must say what opened the lane");
    assert.match(tests.evidence, /^Weak/, "weak evidence is labelled as weak");
    assert.equal(tests.files, "Python");
    const names = d.numbers.map((n) => n.name + " = " + n.value).join(" | ");
    assert.match(names, /come after a file is read = 23/);
    assert.match(names, /starting guess\) = 1 in 5/);
    assert.match(names, /really went wrong on this machine = no file shortened yet/);
    assert.match(names, /wrong result from a worker is priced at = \$9/);
    assert.ok(d.numbers.every((n) => n.from.length > 15), "every number says where it came from");
  } finally { w.cleanup(); }
});

test("a build request in an empty folder is shown as greenfield, in one word", () => {
  const w = world();
  try {
    const file = join(w.env.MMO_HOME, "sessions", "sessA", "events.jsonl");
    const text = readFileSync(file, "utf8").replace('"repo_kind":"brownfield"', '"repo_kind":"greenfield"').replace('"label":"bugfix"', '"label":"feature"');
    writeFileSync(file, text);
    const a = buildData({ env: w.env }).pair.a;
    assert.equal(a.label, "greenfield");
    // The live feed must agree with the task name: a reader who sees "labelled feature" in the feed and
    // "greenfield" as the task (as on the rehearsal of 22 Sep) cannot tell which one is right.
    assert.ok(a.steps.some((s) => s.text === "You typed a prompt (labelled greenfield)"), JSON.stringify(a.steps.map((s) => s.text)));
    assert.ok(!a.steps.some((s) => /labelled feature/.test(s.text)));
  } finally { w.cleanup(); }
});

test("once both sides finish, the pair shows the difference", () => {
  const w = world();
  try {
    const file = join(w.env.MMO_HOME, "sessions", "sessB", "events.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + "\n" + JSON.stringify({ ts: at(9), type: "turn.end" }) + "\n");
    const d = buildData({ env: w.env });
    assert.equal(d.pair.both_done, true);
    assert.ok(Math.abs(d.pair.saving_usd - (REQ - 0.004)) < 1e-12);
    assert.equal(d.pair.a_actions, 3, "one shortened read, one worker job landed and one batch write: the page must say the plugin acted");
  } finally { w.cleanup(); }
});

test("an empty machine gives an empty board, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-board-empty-"));
  try {
    const d = buildData({ env: { MMO_HOME: dir, HOME: dir } });
    assert.deepEqual([d.sessions.length, d.pair.a, d.headline.ledger_saved_usd], [0, null, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the link survives a restart: the token is kept in a private file and reused, and can be replaced on request", async () => {
  // Seen on 22 Sep: every restart made a new link, so the open tab showed "missing or wrong token" each time.
  const w = world();
  try {
    const first = await startBoard({ env: w.env });
    await first.close();
    const second = await startBoard({ env: w.env });
    await second.close();
    assert.equal(second.token, first.token, "same machine, same folder: same link after a restart");
    const file = join(w.env.MMO_HOME, "board-token");
    assert.equal(statSync(file).mode & 0o777, 0o600, "only the owner can read the link");
    writeFileSync(file, "not-a-token");
    const repaired = await startBoard({ env: w.env });
    await repaired.close();
    assert.match(repaired.token, /^[0-9a-f]{48}$/, "a damaged token file is replaced, never trusted");
    assert.notEqual(repaired.token, "not-a-token");
    const fresh = await startBoard({ env: w.env, newToken: true });
    await fresh.close();
    assert.notEqual(fresh.token, repaired.token, "--new-token makes a new link, and the old one stops working");
    assert.equal(readFileSync(file, "utf8").trim(), fresh.token);
  } finally { w.cleanup(); }
});

test("the server answers only with the token, the right Host, GET, and its three routes", async () => {
  const w = world();
  const board = await startBoard({ env: w.env });
  try {
    const base = new URL(board.url);
    const ok = await get(board.url);
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-security-policy"], /default-src 'none'; script-src 'self'; style-src 'nonce-[^']+'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|https?:\/\/(?!127)/.test(ok.headers["content-security-policy"]));
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal((await get(`${base.origin}/data.json?t=${board.token}`)).status, 200);
    assert.equal((await get(`${base.origin}/app.js?t=${board.token}`)).status, 200);
    assert.equal((await get(`${base.origin}/`)).status, 403, "no token");
    assert.equal((await get(`${base.origin}/?t=${"0".repeat(48)}`)).status, 403, "wrong token");
    assert.equal((await get(board.url, { Host: "evil.example" })).status, 403, "a page on another site reaches 127.0.0.1 with its own Host");
    assert.equal((await get(`${base.origin}/../../etc/passwd?t=${board.token}`)).status, 404);
    assert.equal((await get(`${base.origin}/page.html?t=${board.token}`)).status, 404, "there is no file serving to walk out of");
    assert.equal((await get(board.url, { method: "POST" })).status, 405);
    assert.equal(board.server.address().address, "127.0.0.1");
  } finally { await board.close(); w.cleanup(); }
});

test("the page never builds markup from data, loads nothing from another origin, and hostile text stays text", async () => {
  const app = readFileSync(join(BOARD, "app.js"), "utf8");
  const page = readFileSync(join(BOARD, "page.html"), "utf8");
  assert.match(app, /orchestrator took no action in A, so this gap is normal run-to-run variation/, "a zero-action pair must never read as a saving");
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.ok(!app.includes(banned), `app.js uses ${banned}`);
  }
  assert.ok(!/https?:\/\//.test(page.replace(/http:\/\/127\.0\.0\.1/g, "")), "no external font, script or style");
  assert.ok(!/ on[a-z]+=/.test(page), "no inline event handlers");
  const w = world();
  try {
    const d = JSON.stringify(buildData({ env: w.env }));
    assert.ok(!d.includes("onerror"), "a path is never part of a step's text, so hostile file names cannot reach the page at all");
  } finally { w.cleanup(); }
});

test("a chat's cost includes its Claude Code helper agents: their transcripts sit next to the main one and are priced the same way", async () => {
  // Pair 6 on 22 Sep: the plain chat ran four helper agents (49 requests) that the
  // board priced at $0, so the plain side looked $4 cheaper than it was.
  const { sessionCost } = await import("../../plugin/scripts/ambient/lib/session-cost.mjs");
  const dir = mkdtempSync(join(tmpdir(), "mmo-subagents-"));
  const usage = { input_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, output_tokens: 0 };
  const row = (id) => JSON.stringify({ type: "assistant", uuid: id, timestamp: "2026-09-22T08:00:00.000Z", message: { id, model: "claude-opus-5", usage } }) + "\n";
  writeFileSync(join(dir, "s1.jsonl"), row("m1"));
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s1", "subagents", "agent-a.jsonl"), row("a1") + row("a2"));
  writeFileSync(join(dir, "s1", "subagents", "agent-a.meta.json"), "{}");
  const config = { cost: { prices_usd_per_mtok: { "claude-opus-5": { input: 5, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.5, output: 25 } } } };
  const cost = sessionCost(join(dir, "s1.jsonl"), config);
  assert.equal(cost.requests, 3, "main request + two helper-agent requests");
  assert.equal(cost.usd, 1.5, "three requests at one million cache-read tokens, 50 cents each");
  assert.equal(cost.subagent_requests, 2);
  assert.equal(cost.subagent_usd, 1);
  assert.equal(cost.request_times.length, 3, "helper-agent requests are moments of this chat too");
  rmSync(dir, { recursive: true, force: true });
});

test("a re-opened chat is priced from the moment its record starts, and a chat where nothing was typed is not listed", () => {
  // 22 Sep: an old chat was re-opened after the records had been reset. The plugin made a fresh
  // record for it (session.start with source "resume", no prompt), and the board showed a
  // "running" chat with 0 prompts costing the whole old history. Two general rules fix that.
  const dir = mkdtempSync(join(tmpdir(), "mmo-board-resume-"));
  const home = join(dir, "home");
  const env = { MMO_HOME: home, HOME: home };
  const mk = (id, startExtra, events, requests) => {
    mkdirSync(join(home, "sessions", id), { recursive: true });
    const transcript = join(dir, id + ".jsonl");
    writeFileSync(transcript, requests.map((s, i) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { id: id + i, model: "claude-opus-5", usage } })).join("\n"));
    const all = [{ ts: at(10), type: "session.start", arm: "on", forced: true, mode: "on", transcript_path: transcript, repo_kind: "brownfield", ...startExtra }, ...events];
    writeFileSync(join(home, "sessions", id, "events.jsonl"), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  // Re-opened, nothing typed since: two old requests before the record, one request after (a resumed
  // chat's first turn is the app replaying its state, not a prompt).
  mk("reopened", { source: "resume" }, [{ ts: at(11), type: "turn.end" }], [3, 4, 12]);
  // Re-opened, then a prompt typed: only the requests from the record's start count.
  mk("continued", { source: "resume" }, [{ ts: at(13), type: "prompt", label: "bugfix", inherited: false }, { ts: at(16), type: "turn.end" }], [3, 4, 14, 15]);
  // A fresh chat: everything counts, as before.
  mk("fresh", { source: "startup" }, [{ ts: at(11), type: "prompt", label: "bugfix", inherited: false }, { ts: at(13), type: "turn.end" }], [11, 12]);
  const d = buildData({ env });
  const ids = d.sessions.map((s) => s.id);
  assert.ok(!ids.includes("reopened"), "a chat with no typed prompt is not a chat on the board");
  assert.ok(ids.includes("continued") && ids.includes("fresh"));
  const cont = d.sessions.find((s) => s.id === "continued");
  assert.equal(cont.requests, 2, "the two requests before the record's start are the old history, not this chat");
  assert.ok(Math.abs(cont.thinker_usd - 2 * REQ) < 1e-9);
  assert.equal(d.sessions.find((s) => s.id === "fresh").requests, 2);
  assert.equal(d.headline.sessions_total, 2, "the headline counts chats, not records");
  assert.notEqual(d.pair.a?.id, "reopened", "a record with nothing typed is never a side of the pair");
  rmSync(dir, { recursive: true, force: true });
});

test("a worker call that never answered is counted as unpriced on the board, never shown as costing nothing", () => {
  // Pair 6, 22 Sep: six jobs timed out; the vendor returns no usage for a call that never answered, so
  // their cost is unknown. The board must say so, the way it already says so for unpriced model requests.
  const w = world();
  try {
    const d = buildData({ env: w.env });
    const a = d.sessions.find((s) => s.id === "sessA");
    assert.equal(a.worker_calls_unpriced, 1, "sessA's j3 failed without a cost");
    assert.equal(d.headline.worker_calls_unpriced, 1);
  } finally { w.cleanup(); }
});

test("a rules-only chat (delegation off) is its own side: the like-for-like B, preferred over a plain chat, and the verdict says the gap is delegation alone", () => {
  const w = world();
  try {
    const home = w.env.MMO_HOME;
    const transcript = join(w.dir, "sessC.jsonl");
    writeFileSync(transcript, [3, 4].map((sec, i) => JSON.stringify({ type: "assistant", timestamp: at(sec), message: { id: "sessC" + i, model: "claude-opus-5", usage } })).join("\n"));
    mkdirSync(join(home, "sessions", "sessC"), { recursive: true });
    const ev = [
      { ts: at(2), type: "session.start", arm: "on", forced: true, mode: "on", delegation: "off", transcript_path: transcript, repo_kind: "brownfield" },
      { ts: at(3), type: "prompt", label: "bugfix", inherited: false },
      { ts: at(4), type: "valve.act", act_id: "y", valve: "read", path: "/r/x.js", tokens_full: 20000, tokens_kept: 2000 },
      { ts: at(6), type: "turn.end" },
    ];
    writeFileSync(join(home, "sessions", "sessC", "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const d = buildData({ env: w.env });
    const c = d.sessions.find((s) => s.id === "sessC");
    assert.equal(c.side, "rules-only");
    assert.equal(d.pair.b.id, "sessC", "the like-for-like side is preferred as B");
    assert.equal(d.pair.like_for_like, true);
    assert.equal(d.headline.sessions_rules_only, 1);
    assert.ok(!d.pair.a || d.pair.a.side === "on");
  } finally { w.cleanup(); }
});

test("the page describes side B by what it is: the same orchestrator with hand-overs off (like for like), or plain Claude Code; never 'plain' by default", () => {
  const app = readFileSync(join(BOARD, "app.js"), "utf8");
  const page = readFileSync(join(BOARD, "page.html"), "utf8");
  assert.ok(!/plain Claude Code/.test(page), "no fixed 'plain Claude Code' copy in the page: side B is described from the records");
  assert.match(page, /id="lead"/, "the lead paragraph is filled by the renderer");
  assert.match(page, /id="headB"/, "the B box heading is filled by the renderer");
  assert.match(app, /same orchestrator with hand-overs switched off, so the only difference between the sides is the hand-over itself/, "the like-for-like sentence");
  assert.match(app, /Side B is plain Claude Code: no orchestrator at all/, "the plain sentence, only when B really is plain");
  assert.match(app, /B · rules only, no hand-overs/, "the B heading for a rules-only chat");
  assert.match(app, /d\.pair\.b_kind/, "both are chosen from the records, per refresh");
  const w = world();
  try {
    const transcript = join(w.dir, "sessR.jsonl");
    writeFileSync(transcript, [3, 4].map((sec, i) => JSON.stringify({ type: "assistant", timestamp: at(sec), message: { id: "sessR" + i, model: "claude-opus-5", usage } })).join("\n"));
    const empty = join(w.env.MMO_HOME, "..", "empty-home-" + process.pid);
    mkdirSync(empty, { recursive: true });
    assert.equal(buildData({ env: { ...w.env, MMO_HOME: empty } }).pair.b_kind, null, "no B yet: nothing is claimed");
    assert.equal(buildData({ env: w.env }).pair.b_kind, "plain", "the fixture's control chat is a plain B");
    mkdirSync(join(w.env.MMO_HOME, "sessions", "sessR"), { recursive: true });
    writeFileSync(join(w.env.MMO_HOME, "sessions", "sessR", "events.jsonl"), [
      { ts: at(2), type: "session.start", arm: "on", forced: true, mode: "on", delegation: "off", transcript_path: transcript, repo_kind: "greenfield" },
      { ts: at(3), type: "prompt", label: "greenfield", inherited: false },
      { ts: at(6), type: "turn.end" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(buildData({ env: w.env }).pair.b_kind, "rules-only");
  } finally { w.cleanup(); }
});

test("this machine's own jobs show on the seed table even where nothing was seeded: a JS/TS tests cell joins the tests row, and a scout cell gets a row of its own", async () => {
  const { recordChecks } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "evidence.mjs"));
  const w = world();
  try {
    recordChecks("tests|js_ts|flash|completion", true, w.env);
    recordChecks("tests|js_ts|flash|completion", false, w.env);
    recordChecks("scout|js_ts|flash|completion", true, w.env);
    const d = buildData({ env: w.env });
    const tests = d.seeds.find((s) => s.job === "Writing tests" && s.worker === "Gemini Flash");
    assert.match(tests.measured, /On this machine, JavaScript \/ TypeScript: 2 jobs; 1 passed the checks, 1 did not/, "the language this machine has evidence for is shown even though the seed only measured Python");
    assert.match(tests.files + " " + tests.decision, /JavaScript \/ TypeScript/, "and it is judged");
    const scout = d.seeds.find((s) => s.job.startsWith("Reading an existing project"));
    assert.ok(scout, "a job with no seed row still gets a row once this machine has run it");
    assert.match(scout.measured, /^Nothing was measured before install\. On this machine, JavaScript \/ TypeScript: 1 job; 1 passed the checks, 0 did not/);
    assert.match(scout.evidence, /this machine/);
    assert.match(scout.source, /this machine/);
    assert.match(scout.decision, /^Allowed/);
  } finally { w.cleanup(); }
});

/**
 * Three things the board said that were not true (23 Sep, pair 11, all found by reading it):
 * it called a greenfield build a bug fix, because the brief's heading says "Tech stack
 * (fixed)" and the word rules matched "fixed"; it said a worker call DROPPED when nothing
 * dropped and the tests had simply failed; and it could only ever show a FAILING test run,
 * so a side that ended green read as three failures then "finished", and the only way to
 * know whether the pair had really passed was to run the suite by hand.
 */
test("the board says what happened: a brief reads as a build, a failed test run is not a dropped call, and a passing run is shown", async () => {
  const { labelPrompt, loadRules } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "labels.mjs"));
  const rules = loadRules();
  const brief = "# Project Brief — Workforce Operations Service\n\n## Tech stack (fixed)\n- NestJS + Prisma.\n";
  assert.equal(labelPrompt(brief, rules).label, "feature", "a prompt that opens with a brief heading is a build, whatever words appear inside it");
  assert.equal(labelPrompt("## Requirements\nBuild the thing.", rules).label, "feature");
  assert.equal(labelPrompt("the due date is broken, it saves 2 March; find the cause and fix it", rules).label, "bugfix", "a real bug report is still a bug fix");
  // The heading only outranks the bug-fix words. A document that plainly describes a
  // refactor is still a refactor: the rule exists to stop "(fixed)" in a tech-stack heading
  // reading as a bug report, not to relabel every document as a build.
  assert.equal(labelPrompt("# Spec\n\nRefactor every HTTPException into one shared helper.", rules).label, "refactor", "a spec that describes a refactor is a refactor");
  assert.equal(labelPrompt("# Brief\n\nThe pinned versions are fixed; add an audit log.", rules).label, "feature", "but a brief is never a bug report because a word like 'fixed' appears in it");

  const w = world();
  try {
    const d = buildData({ env: w.env });
    const feed = d.pair.a.steps.map((x) => x.text);
    assert.ok(feed.some((t) => /tests failed on the cheaper model's change.*sent back/i.test(t)), JSON.stringify(feed));
    assert.ok(!feed.some((t) => /call dropped.*tests failed/i.test(t)), "a failing test run is never reported as a dropped call: " + JSON.stringify(feed));
    assert.ok(feed.some((t) => /test run passed/i.test(t)), "a passing test run is shown, so 'finished' can be read as green: " + JSON.stringify(feed));
  } finally { w.cleanup(); }
});
