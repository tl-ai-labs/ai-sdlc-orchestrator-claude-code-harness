/**
 * Fix D: the receipt rule, with no percentage.
 *
 * A receipt (`claude -p` result) is Anthropic's count for ONE invocation, and
 * it includes calls Claude Code bills but never writes to a transcript. The
 * collector used to require every token bucket in the window to EQUAL the
 * receipt, so a good headless run was refused whenever Claude Code billed a
 * call it did not log (Sep 10 2026: two Opus 4.8 calls, 2.3% of the bill), and
 * when it did book a receipt it booked Claude Code's own dollars, whose price
 * table was stale on Aug 24 2026. It also compared model names verbatim, so a
 * receipt's `claude-opus-5[1m]` never matched the log's `claude-opus-5`.
 *
 * The rule now:
 *   1. a receipt for another session: exit 3 (unchanged);
 *   2. names on both sides are read with the price list's resolveModel and
 *      compared per list model; a name that does not resolve is exit 3; a log
 *      bucket above the receipt, or a log model the receipt does not bill, takes
 *      the unchanged ABOVE path (the last invocation alone, else exit 3);
 *   3. log at or below the receipt on every bucket: the receipt is booked, as
 *      its token counts priced from the list: the logged part per message, the
 *      gap (receipt minus log, per bucket) at that model's logged cache-write
 *      TTL mix and modifier mix. `unlogged_billed` records the gap per model,
 *      and `attribution_complete` says whether every helper an Agent/Task
 *      result names has its transcript file. When some bucket is BELOW the
 *      receipt, booking also needs the window to be provably the receipt's
 *      invocation (pinned to the receipt's session, opened at the command turn,
 *      no later human turn, exact); a log EQUAL to the receipt proves that on
 *      its own, exactly as before;
 *   4. below the receipt without that proof: exit 3.
 *
 * Fixtures (token-only copies of real headless runs, see their READMEs):
 *   T5 tools/test/fixtures/headless-unlogged-calls (CLI 2.1.245)
 *   T6 tools/test/fixtures/headless-side-call      (CLI 2.1.270)
 *
 * RE-DERIVED EXPECTATIONS (existing tests whose outcome or figures moved, and why)
 *
 * receivables-ops (tools/test/fixtures/receivables-ops; no human turns kept, so no
 * command turn and every window approximate):
 *   - pass1: every bucket ABOVE the receipt. ABOVE path unchanged: exit 3.
 *   - pass2: still exit 3, by a different path. Its cache buckets are far BELOW
 *     the receipt (cached 2,503,877 < 4,002,221; cache_write 70,808 < 263,021;
 *     transcript -44.7%, a subagent file missing), but its input is ABOVE it
 *     (78 > 56): the window also holds messages this receipt never billed.
 *     ABOVE is decided first, and with no human turns there is no last
 *     invocation to check, so it refuses as ABOVE. The old exact rule reported
 *     the shortfall first ("BELOW the CLI's own receipt"). Without the input
 *     excess it would still refuse: its window opens at the first dispatch and
 *     is not pinned to the receipt's session, so it cannot be proven.
 *   - pass3: every bucket EQUAL. Still booked. The booked figure is now the
 *     receipt's tokens at the list, $16.235409, which equals Claude Code's own
 *     figure to the micro-dollar (its top-level usage matches the model's counts
 *     exactly, so the 1-hour write split is the receipt's own). The label changes
 *     from "receipt (transcript agrees, +0.0%)" to "receipt (Anthropic token
 *     counts priced at the price list); 0.0% billed but not logged". True total
 *     unchanged ($22.311708).
 *   - pass3 plus a synthetic Haiku line on the receipt ($0.01 for 10 in / 100
 *     out): booked $16.235919, not $16.245409. Haiku is priced from the list
 *     ($0.00051) instead of taking Claude Code's dollars.
 *   - pass3 receipt-only (no transcript in the window): $16.235409, unchanged in
 *     dollars, label "receipt-only (Anthropic token counts priced at the price
 *     list)"; the old "its $16.235409 is used verbatim" NOTE is gone.
 *   - pass2 receipt-only: $4.703347, was Claude Code's $4.766478. That receipt's
 *     top-level usage is a per-turn snapshot that matches no model's counts, so
 *     no cache-write split can be attributed to a model: its 263,021 writes are
 *     priced at the 5-minute rate and flagged, and the drift NOTE says Claude
 *     Code's figure is 1.3% higher. The Gemini vendor spend still survives.
 *
 * collectOrchestratorUsage.test.mjs, synthetic runs whose logs EQUAL their
 * receipts: the booked dollars are unchanged ($30, $10), the label is the new
 * one. Two figures move:
 *   - a Haiku receipt line never logged ($0.02 for 200 in / 50 out): booked
 *     $30.00045, not $30.02 (Haiku at the list, $0.00045);
 *   - rate drift (a receipt claiming $33 for tokens that cost $30 at the run's
 *     pricing_override card): booked $30, not $33, with a NOTE naming the 10%
 *     difference; Claude Code's own dollars are never booked.
 *   - SHORT with an exact window but a receipt naming no session: still exit 3,
 *     now because the invocation cannot be proven (the receipt names no session).
 * collectPerModelPricing.test.mjs pass3 regression: label only.
 * The manifest's first-test deepEqual gains the new fields (null / [] when no
 * receipt is booked and no session is pinned).
 *
 * Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pricesMod from "../dist/prices.js";
import * as effectiveMod from "../dist/effectivePrice.js";
import * as pricingMod from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const REPO = join(HERE, "..", "..", "..", "..");
const UNLOGGED = join(REPO, "tools", "test", "fixtures", "headless-unlogged-calls");
const SIDE_CALL = join(REPO, "tools", "test", "fixtures", "headless-side-call");
const ENV = { ...process.env, MMO_SELECT: "" };
const helpers = () => import(pathToFileURL(SCRIPT).href);

const exec = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: ENV });
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const readLines = (p) => readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

// ── T5: the Sep 10 headless run the exact rule refused ─────────────────────

test("T5: the Sep 10 headless run is booked at $14.197777 — receipt tokens at the list, 2.3% billed but not logged, all four helpers attributed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t5-"));
  try {
    cpSync(UNLOGGED, root, { recursive: true });
    const r = exec([join(root, "pass1"), "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The receipt's claude-opus-5[1m] is the log's claude-opus-5 once names are resolved.
    assert.match(r.stdout, /receipt names resolved: claude-opus-5\[1m\] → claude-opus-5/);
    assert.match(r.stdout, /claude-opus-5: in 20=20 · cached 327898=327898 · cache_write 20329=20329 · out 5295≤5295 → agrees/);
    assert.match(r.stdout, /claude-opus-4-8: in 224<228 · cached 12247927<12651407 · cache_write 404585<423523 · out 188601≤188968 → short of the receipt/);
    assert.match(r.stdout, /= \$14\.19777[67] \[receipt \(Anthropic token counts priced at the price list\); 2\.3% billed but not logged\]/);
    // Claude Code's own table agrees with the list on this run: no drift note.
    assert.doesNotMatch(r.stderr, /price table differs/);

    const m = readJson(join(root, "pass1", "manifest.json"));
    const o = m.orchestrator_overhead;
    near(o.cost_usd, 14.197777, 0.000002, "booked");
    assert.equal(o.transcript_cost_usd, 13.868479, "the logged part, priced per message");
    near(o.receipt_cli_usd, 14.19777625, 1e-9, "Claude Code's own figure, kept as a check");
    assert.equal(o.receipt_cost_usd, o.receipt_cli_usd, "receipt_cost_usd keeps its meaning");
    assert.deepEqual(o.per_model.map((e) => [e.role, e.model, e.cost_usd]), [["session", "claude-opus-5", 0.499714], ["helper", "claude-opus-4-8", 13.368765]]);

    const u = o.unlogged_billed;
    assert.equal(u.per_model.length, 1);
    const g = u.per_model[0];
    assert.deepEqual([g.model, g.reported_as, g.receipt_only, g.ttl_split], ["claude-opus-4-8", ["claude-opus-4-8"], false, "logged mix"]);
    assert.deepEqual(g.tokens, { input: 4, input_cached: 403_480, input_cache_write: 18_938, output: 367 });
    // 4 x $5 + 403,480 x $0.50 + 18,938 x $6.25 (all logged writes were 5-minute) + 367 x $25, per 1M.
    near(g.cost_usd, 0.3292975, 0.000001, "unlogged Opus 4.8");
    near(u.cost_usd, 0.3292975, 0.000001, "unlogged total");
    assert.ok(u.pct_of_booked > 2.3 && u.pct_of_booked < 2.35, `pct_of_booked ${u.pct_of_booked}`);
    assert.deepEqual(u.unpriced, []);
    near(o.cost_usd, round6(o.transcript_cost_usd + u.cost_usd), 0.000001, "booked = logged + unlogged");

    assert.equal(o.attribution_complete, true);
    assert.deepEqual(o.missing_helper_ids, []);
    assert.deepEqual(o.unreferenced_helper_files, []);
    assert.equal(o.pricing_complete, true);
    // Token fields are the receipt's; the 1-hour share is the session's logged 20,329 (no 1-hour gap).
    assert.deepEqual([o.input_tokens, o.input_tokens_cached, o.input_tokens_cache_write, o.input_tokens_cache_write_1h, o.output_tokens], [248, 12_979_305, 443_852, 20_329, 194_263]);
    assert.deepEqual([o.window.start_anchor, o.window.exact, o.window.lower_bound, o.window.session_id], ["command turn", true, false, "908511af-6158-466f-92ad-beb1cd9f5c73"]);

    // True total: the Gemini vendor calls plus the booked receipt; the estimated Opus events ran inside the session.
    const gemini = readLines(join(root, "pass1", "telemetry.jsonl")).filter((e) => e.provenance === "vendor").reduce((s, e) => s + e.cost_usd, 0);
    near(m.true_total_cost_usd, gemini + o.cost_usd, 0.000003, "true total");
    const event = readLines(join(root, "pass1", "telemetry.jsonl")).find((e) => e.tier === "orchestrator");
    assert.deepEqual(event.unlogged_billed, u);
    assert.equal(event.attribution_complete, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ── T6: [1m] and a Haiku side call on a 2.1.270 receipt ────────────────────

test("T6: a receipt naming claude-opus-5[1m] and a Haiku side call the log never records is booked; Haiku is priced from the list inside unlogged_billed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t6-"));
  try {
    cpSync(SIDE_CALL, root, { recursive: true });
    const r = exec([root, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", join(root, "transcripts")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-haiku-4-5-20251001 → claude-haiku-4-5/);
    assert.match(r.stdout, /claude-opus-5\[1m\] → claude-opus-5/);
    assert.match(r.stdout, /claude-opus-5: in 34=34 · cached 28810=28810 · cache_write 8837=8837 · out 154≤154 → agrees/);
    assert.match(r.stdout, /claude-opus-4-8: in 2=2 · cached 0=0 · cache_write 12202=12202 · out 4≤4 → agrees/);
    assert.match(r.stderr, /NOTE: the receipt also bills claude-haiku-4-5 \(943 tokens, \$0\.001003\) for calls the transcript does not record/);
    assert.match(r.stdout, /= \$0\.184171 \[receipt \(Anthropic token counts priced at the price list\); 0\.5% billed but not logged\]/);

    const o = readJson(join(root, "manifest.json")).orchestrator_overhead;
    assert.equal(o.cost_usd, 0.184171);
    assert.equal(o.transcript_cost_usd, 0.183168);
    near(o.receipt_cli_usd, 0.1841705, 1e-9, "Claude Code's own figure");
    const u = o.unlogged_billed;
    assert.equal(u.per_model.length, 1, JSON.stringify(u.per_model));
    const haiku = u.per_model[0];
    assert.deepEqual([haiku.model, haiku.reported_as, haiku.receipt_only, haiku.ttl_split], ["claude-haiku-4-5", ["claude-haiku-4-5-20251001"], true, "none"]);
    assert.deepEqual(haiku.tokens, { input: 928, input_cached: 0, input_cache_write: 0, output: 15 });
    assert.deepEqual(haiku.rates, { input: 1, input_cached: 0.1, input_cache_write: 1.25, output: 5 });
    assert.equal(haiku.cost_usd, 0.001003); // 928 x $1 + 15 x $5, per 1M
    assert.match(haiku.assumed.join(" | "), /no logged message/);
    assert.equal(o.attribution_complete, true);
    assert.deepEqual([o.input_tokens, o.input_tokens_cached, o.input_tokens_cache_write, o.input_tokens_cache_write_1h, o.output_tokens], [964, 28_810, 21_039, 8_837, 173]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T7: the rule on a small headless-shaped run ─────────────────────────────

const AT = (hms) => `2026-09-10T${hms}.000Z`;
const usage = (input, cached, write5m, write1h, output) => ({
  input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  output_tokens: output, service_tier: "standard", speed: "standard", inference_geo: "not_available",
});
const asst = (sid, id, model, u, ts, content) => JSON.stringify({ type: "assistant", timestamp: ts, sessionId: sid, message: { id, model, stop_reason: content ? "tool_use" : "end_turn", usage: u, ...(content ? { content } : {}) } });
const human = (sid, ts, text) => JSON.stringify({ type: "user", timestamp: ts, sessionId: sid, message: { role: "user", content: text } });
const COMMAND = "<command-message>mmo:pass</command-message>\n<command-name>/mmo:pass</command-name>\n<command-args>--run-id=r-h brief.md</command-args>";

/**
 * Session sess-h on Opus 5 spawns two Opus 4.8 helpers: a1111 (named by the
 * result line's toolUseResult) and a2222 (named only in the result text, the
 * shape a nested orchestrator writes). Log: Opus 5 in 10 / cached 200,000 / 1h
 * writes 20,000 / out 2,000 ($0.35005); Opus 4.8 in 70 / 700,000 / 5m 70,000 /
 * 7,000 ($0.96285). The receipt bills Opus 5 exactly and Opus 4.8 at
 * 100 / 1,000,000 / 100,000 / 10,000: the log is 30% short on every bucket.
 * Receipt at the list: $0.35005 + $1.3755 = $1.72555, of which $0.41265 unlogged.
 */
function headlessRun({ commandTurn = true, runLog = true, helperA2 = true, extraLines = [], receipt = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-receipt-t7-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts");
  const sub = join(tDir, "sess-h", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(root, "policy.yaml"), "version: 1\nname: h-policy\nmodels:\n  - id: driver\n    adapter: builtin-anthropic\n    model_name: claude-opus-4-8\nrules:\n  - default: driver\n");
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify({ pass: "r-h", policy_name: "h-policy", started_at: AT("10:00:20"), ended_at: AT("10:01:20"), totals: { dispatched_cost_usd: 0, models_used: [] } }));
  writeFileSync(join(passDir, "telemetry.jsonl"), "");
  if (runLog) {
    mkdirSync(join(root, ".sdlc", "runs", "r-h"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "runs", "r-h", "orchestrator.log"), `MMO: ${AT("10:00:05")} INFO   run.start run_id=r-h mode=greenfield\nMMO: ${AT("10:01:30")} INFO   run.end run_id=r-h outcome=completed\n`);
  }
  const session = [
    ...(commandTurn ? [human("sess-h", AT("10:00:00"), COMMAND)] : []),
    asst("sess-h", "s1", "claude-opus-5", usage(10, 100_000, 0, 10_000, 1_000), AT("10:00:10"), [{ type: "tool_use", id: "toolu_1", name: "Agent" }, { type: "tool_use", id: "toolu_2", name: "Agent" }]),
    JSON.stringify({ type: "user", timestamp: AT("10:01:00"), sessionId: "sess-h", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] }, toolUseResult: { agentId: "a1111" } }),
    JSON.stringify({ type: "user", timestamp: AT("10:01:05"), sessionId: "sess-h", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "done\nagentId: a2222 (use SendMessage with to: 'a2222', summary: '<5-10 word recap>' to continue this agent)" }] }] } }),
    ...extraLines,
    asst("sess-h", "s2", "claude-opus-5", usage(0, 100_000, 0, 10_000, 1_000), AT("10:01:10")),
  ];
  writeFileSync(join(tDir, "sess-h.jsonl"), session.join("\n") + "\n");
  writeFileSync(join(sub, "agent-a1111.jsonl"), asst("sess-h", "h1", "claude-opus-4-8", usage(40, 400_000, 40_000, 0, 4_000), AT("10:00:30")) + "\n");
  if (helperA2) writeFileSync(join(sub, "agent-a2222.jsonl"), asst("sess-h", "h2", "claude-opus-4-8", usage(30, 300_000, 30_000, 0, 3_000), AT("10:00:40")) + "\n");
  const opus48 = { inputTokens: 100, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 100_000, outputTokens: 10_000, costUSD: 1.3755, ...(receipt.opus48 ?? {}) };
  writeFileSync(join(passDir, "claude-session.json"), JSON.stringify({
    type: "result",
    session_id: receipt.session_id ?? "sess-h",
    total_cost_usd: 1.72555,
    usage: { input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 20_000, output_tokens: 2_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 } },
    modelUsage: {
      "claude-opus-5[1m]": { inputTokens: 10, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 20_000, outputTokens: 2_000, costUSD: 0.35005 },
      [receipt.opus48Name ?? "claude-opus-4-8"]: opus48,
    },
  }));
  const run = () => exec([passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir]);
  return { root, passDir, run, manifest: () => readJson(join(passDir, "manifest.json")), rm: () => rmSync(root, { recursive: true, force: true }) };
}

test("T7: an exact window with a log 30% short of the receipt is booked — there is no percentage", () => {
  const fix = headlessRun();
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-opus-4-8: in 70<100 · cached 700000<1000000 · cache_write 70000<100000 · out 7000≤10000 → short of the receipt/);
    assert.match(r.stdout, /= \$1\.72555 \[receipt \(Anthropic token counts priced at the price list\); 23\.9% billed but not logged\]/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 1.72555);
    assert.equal(o.transcript_cost_usd, 1.3129);
    assert.equal(o.unlogged_billed.cost_usd, 0.41265);
    assert.deepEqual(o.unlogged_billed.per_model.map((g) => [g.model, g.tokens]), [["claude-opus-4-8", { input: 30, input_cached: 300_000, input_cache_write: 30_000, output: 3_000 }]]);
    assert.equal(o.unlogged_billed.pct_of_booked, 23.91);
    assert.equal(o.attribution_complete, true);
  } finally { fix.rm(); }
});

test("T7: a helper transcript that is missing is still booked (the receipt is the bill) with attribution_complete false and the helper named", () => {
  const fix = headlessRun({ helperA2: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /helper a2222 .*has no transcript file/);
    const o = fix.manifest().orchestrator_overhead;
    assert.equal(o.cost_usd, 1.72555, "the total is the receipt's either way");
    assert.equal(o.unlogged_billed.cost_usd, 0.8253, "the unread helper's tokens are inside the gap");
    assert.equal(o.attribution_complete, false);
    assert.deepEqual(o.missing_helper_ids, ["a2222"]);
    assert.deepEqual(o.unreferenced_helper_files, []);
  } finally { fix.rm(); }
});

test("T7 refusal: a log bucket ABOVE the receipt is exit 3, nothing written", () => {
  const fix = headlessRun({ receipt: { opus48: { cacheReadInputTokens: 600_000 } } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the window holds messages the receipt never billed \(claude-opus-4-8 input_cached: transcript 700000 > receipt 600000\)/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined);
  } finally { fix.rm(); }
});

test("T7 refusal: a receipt for a different session is exit 3", () => {
  const fix = headlessRun({ receipt: { session_id: "sess-other" } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /is for session sess-other, but the run's command turn/);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with an approximate window (no command turn) is exit 3, and says why the invocation cannot be proven", () => {
  const fix = headlessRun({ commandTurn: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /BELOW the CLI's own receipt/);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*the window opens at run\.start - 5m, not at the run's command turn/);
    assert.equal(fix.manifest().orchestrator_overhead, undefined);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with a lower-bound window (no command turn, no run log) is exit 3", () => {
  const fix = headlessRun({ commandTurn: false, runLog: false });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*the window opens at the first dispatch \(a lower bound\)/);
  } finally { fix.rm(); }
});

test("T7 refusal: short of the receipt with a second human turn inside the window is exit 3 (the receipt may bill only the last invocation)", () => {
  const fix = headlessRun({ extraLines: [human("sess-h", AT("10:01:07"), "keep going")] });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be proven to be the receipt's invocation: .*2 human turns fall inside the window/);
  } finally { fix.rm(); }
});

test("T7 refusal: a receipt model name the price list cannot read is exit 3, printing both name lists", () => {
  const fix = headlessRun({ receipt: { opus48Name: "claude-opus-9-9" } });
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot resolve model name\(s\) the price list does not carry: receipt claude-opus-9-9/);
    assert.match(r.stderr, /transcript names: claude-opus-4-8, claude-opus-5/);
    assert.match(r.stderr, /receipt names: claude-opus-5\[1m\], claude-opus-9-9/);
  } finally { fix.rm(); }
});

// ── Unit pins on the exported helpers ───────────────────────────────────────

test("resolveBucketNames: names resolve to price-list ids and their buckets merge; unresolvable names are listed per side", async () => {
  const { resolveBucketNames } = await helpers();
  const T = (input, input_cached, input_cache_write, input_cache_write_1h, output) => ({ input, input_cached, input_cache_write, input_cache_write_1h, output });
  const R = (input, input_cached, input_cache_write, output, cost_usd) => ({ input, input_cached, input_cache_write, output, cost_usd });
  const r = resolveBucketNames(
    { "claude-opus-5": T(1, 2, 3, 3, 4), "(unlabeled)": T(1, 0, 0, 0, 1), "claude-mystery-1": T(1, 0, 0, 0, 0) },
    { "claude-opus-5[1m]": R(1, 2, 3, 4, 0.1), "claude-haiku-4-5-20251001": R(5, 0, 0, 1, 0.01), "claude-haiku-4-5": R(1, 0, 0, 1, 0.002), "gpt-x": R(1, 0, 0, 0, null) },
    pricesMod.resolveModel,
  );
  assert.deepEqual(r.unresolved, { transcript: ["claude-mystery-1"], receipt: ["gpt-x"] });
  assert.deepEqual(r.receipt["claude-haiku-4-5"], { input: 6, input_cached: 0, input_cache_write: 0, output: 2, cost_usd: 0.012, names: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"] });
  assert.deepEqual(r.receipt["claude-opus-5"].names, ["claude-opus-5[1m]"]);
  assert.deepEqual(r.transcript["claude-opus-5"], { ...T(1, 2, 3, 3, 4), names: ["claude-opus-5"] });
  // A message with no model name can match nothing; it stays under its own key for the ABOVE rule.
  assert.ok(r.transcript["(unlabeled)"]);
});

test("helperAttribution: ids come from Agent/Task results only (toolUseResult.agentId or the result text), at any depth; missing and unreferenced files are named", async () => {
  const { helperAttribution, sessionHelperFiles } = await helpers();
  const dir = mkdtempSync(join(tmpdir(), "mmo-attrib-"));
  try {
    const sub = join(dir, "sess", "subagents");
    mkdirSync(join(sub, "workflows", "wf1"), { recursive: true });
    const tu = (id, name) => ({ type: "tool_use", id, name });
    writeFileSync(join(dir, "sess.jsonl"), [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [tu("t1", "Agent"), tu("b1", "Bash")] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] }, toolUseResult: { agentId: "a1" } }),
      // A Bash result that happens to print "agentId:" names no helper.
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "agentId: zzz" }] }, toolUseResult: { stdout: "agentId: zzz" } }),
    ].join("\n") + "\n");
    writeFileSync(join(sub, "agent-a1.jsonl"), [
      JSON.stringify({ type: "assistant", message: { id: "m2", content: [tu("t2", "Task"), tu("t4", "Agent")] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok\nagentId: a2 (use SendMessage with to: 'a2')" }] }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "agentId: a4" }] } }),
    ].join("\n") + "\n");
    writeFileSync(join(sub, "workflows", "wf1", "agent-a4.jsonl"), "\n");
    writeFileSync(join(sub, "agent-a3.jsonl"), "\n");
    writeFileSync(join(sub, "agent-a1.meta.json"), "{}\n");

    const files = sessionHelperFiles(dir, "sess");
    assert.deepEqual(files.map((f) => f.slice(dir.length + 1)), ["sess/subagents/agent-a1.jsonl", "sess/subagents/agent-a3.jsonl", "sess/subagents/workflows/wf1/agent-a4.jsonl"]);
    const a = helperAttribution(join(dir, "sess.jsonl"), files, { root: dir });
    assert.deepEqual(a, {
      complete: false,
      referenced: ["a1", "a2", "a4"],
      missing_helper_ids: ["a2"],
      unreferenced_helper_files: ["sess/subagents/agent-a3.jsonl"],
    });
    assert.deepEqual(sessionHelperFiles(dir, "no-such-session"), []);
    assert.equal(helperAttribution(join(dir, "sess.jsonl"), files.filter((f) => !f.endsWith("agent-a3.jsonl")).concat([]), { root: dir }).complete, false, "a2 is still missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bookReceiptTokens: the gap is priced at the model's logged TTL and modifier mix; a receipt-only model at API defaults, 5-minute writes flagged unless the receipt's own usage proves the split", async () => {
  const { resolveBucketNames, bookReceiptTokens, priceMessages, makeMessagePricer } = await helpers();
  const pricer = makeMessagePricer({ models: [] }, { pricesMod, effectiveMod, pricingMod });
  const ts = "2026-09-10T10:00:00.000Z";
  const msg = (speed, w5m, w1h) => ({ model: "claude-opus-4-8", role: "helper", timestamp: ts, modifiers: { speed, service_tier: "standard", inference_geo: "not_available" }, conflicts: [], tokens: { input: 1000, input_cached: 0, input_cache_write_5m: w5m, input_cache_write_1h: w1h, output: 1000 } });
  // Logged: one standard message with 5-minute writes ($0.655), one fast message with 1-hour writes ($2.06).
  const priced = priceMessages([msg("standard", 100_000, 0), msg("fast", 0, 100_000)], pricer);
  assert.equal(priced.cost_usd, 2.715);
  const receiptModels = {
    "claude-opus-4-8": { input: 4000, input_cached: 0, input_cache_write: 400_000, output: 4000, cost_usd: 5.43 },
    "claude-haiku-4-5-20251001": { input: 1000, input_cached: 0, input_cache_write: 8000, output: 100, cost_usd: 0.0175 },
  };
  const { receipt } = resolveBucketNames({}, receiptModels, pricesMod.resolveModel);
  const book = (receiptUsage, referenceTimes = [ts, ts]) => bookReceiptTokens({ receipt, priced, pricer, referenceTimes, receiptUsage });

  const b = book(null);
  const opus = b.unlogged_billed.per_model.find((g) => g.model === "claude-opus-4-8");
  // Gap: 2,000 in at (5+10)/2 = $7.50; 200,000 writes at (6.25+20)/2 = $13.125; 2,000 out at (25+50)/2 = $37.50.
  // No logged cache reads, so that bucket has no mix: its rate is the list's at API defaults ($0.50), and no
  // assumption is flagged because the gap holds no cache reads to price with it.
  assert.deepEqual(opus.tokens, { input: 2000, input_cached: 0, input_cache_write: 200_000, output: 2000 });
  assert.deepEqual(opus.rates, { input: 7.5, input_cached: 0.5, input_cache_write: 13.125, output: 37.5 });
  assert.deepEqual(opus.assumed, []);
  assert.equal(opus.ttl_split, "logged mix");
  assert.equal(opus.cost_usd, 2.715);
  const haiku = b.unlogged_billed.per_model.find((g) => g.model === "claude-haiku-4-5");
  assert.equal(haiku.receipt_only, true);
  assert.equal(haiku.ttl_split, "5-minute (assumed)");
  assert.equal(haiku.cost_usd, 0.0115); // 1000 x $1 + 8,000 x $1.25 + 100 x $5
  assert.match(haiku.assumed.join(" | "), /no logged message: API-default speed, service_tier and inference_geo/);
  assert.match(haiku.assumed.join(" | "), /5-minute/);
  assert.equal(b.cost_usd, round6(2.715 + 2.715 + 0.0115));
  assert.equal(b.logged_cost_usd, 2.715);
  // The 1-hour token share: logged 100,000 plus half of the Opus gap's 200,000 writes; Haiku's writes counted 5-minute.
  assert.deepEqual(b.tokens, { input: 5000, input_cached: 0, input_cache_write: 408_000, input_cache_write_5m: 208_000, input_cache_write_1h: 200_000, output: 4100 });
  assert.equal(b.complete, true);

  // The receipt's top-level usage equals Haiku's four counts exactly, so its split is Haiku's own.
  const proven = book({ input: 1000, input_cached: 0, input_cache_write: 8000, output: 100, cache_write_5m: 0, cache_write_1h: 8000 });
  const h2 = proven.unlogged_billed.per_model.find((g) => g.model === "claude-haiku-4-5");
  assert.equal(h2.ttl_split, "receipt usage");
  assert.equal(h2.cost_usd, 0.0175); // 1000 x $1 + 8,000 x $2 + 100 x $5
  assert.doesNotMatch(h2.assumed.join(" | "), /5-minute/);

  // A receipt-only model on a day the list does not price is unpriced, never borrowed.
  const early = book(null, ["2025-12-31T23:00:00.000Z", ts]);
  assert.equal(early.complete, false);
  assert.match(early.unlogged_billed.unpriced.find((x) => x.model === "claude-haiku-4-5").reason, /no price period for claude-haiku-4-5 on 2025-12-31/);
  assert.equal(early.unlogged_billed.per_model.some((g) => g.model === "claude-haiku-4-5"), false);
});

test("provableInvocation: pinned to the receipt's session, opened at the command turn, one human turn, exact", async () => {
  const { provableInvocation } = await helpers();
  const ok = { receiptSessionId: "s", pinnedId: "s", startAnchor: "command turn", humanTurnsInWindow: 1, windowExact: true, lowerBound: false };
  assert.deepEqual(provableInvocation(ok), { provable: true, reasons: [] });
  assert.match(provableInvocation({ ...ok, receiptSessionId: null }).reasons.join("; "), /the receipt names no session/);
  assert.match(provableInvocation({ ...ok, pinnedId: null }).reasons.join("; "), /not pinned to the receipt's session s/);
  assert.match(provableInvocation({ ...ok, startAnchor: "run.start - 5m", windowExact: false }).reasons.join("; "), /opens at run\.start - 5m, not at the run's command turn/);
  assert.match(provableInvocation({ ...ok, humanTurnsInWindow: 3 }).reasons.join("; "), /3 human turns fall inside the window/);
  assert.match(provableInvocation({ ...ok, windowExact: false }).reasons.join("; "), /approximate/);
  assert.match(provableInvocation({ ...ok, startAnchor: "manifest started_at - 5m", windowExact: false, lowerBound: true }).reasons.join("; "), /opens at the first dispatch \(a lower bound\)/);
});
