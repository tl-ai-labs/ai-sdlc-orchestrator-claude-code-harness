/**
 * T8: a `claude-cli` worker is priced from its own token ledger with the dated
 * price list, never from Claude Code's dollar figure.
 *
 * Before this, ClaudeCliAdapter copied the result's `total_cost_usd` into
 * cost_usd verbatim. That figure comes from Claude Code's own price table,
 * which has been stale before (2026-08-24: Opus billed at exactly 0.6x the
 * list). Now the result's `modelUsage` is priced per model (names resolved
 * with resolveModel, so `claude-opus-5[1m]` is Opus 5), the cache-write TTL
 * split comes from the worker session's own transcript, and the CLI figure is
 * kept beside the cost as `cli_reported_cost_usd`, with a warning when the
 * two differ by more than 0.5%.
 *
 * The fixture is a token-only copy of a real `claude -p` run (2026-09-14,
 * Claude Code 2.1.270): an Opus 5 [1m] session writing 1-hour cache, one
 * Opus 4.8 helper writing 5-minute cache, and a Haiku 4.5 side call that is
 * billed but never logged. See fixtures/claude-cli-worker/README.md.
 *
 * `claude` is never spawned: spawn and the binary probe are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeCliAdapter } from "../dist/adapters/ClaudeCliAdapter.js";
import { computeCostUsd, round6 } from "../dist/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "claude-cli-worker");
const PROJECTS = join(FIXTURE, "projects");
const RESULT = JSON.parse(readFileSync(join(FIXTURE, "result.json"), "utf-8"));
const DISPATCH = () => new Date("2026-09-14T11:18:55Z");

// Anthropic's page, 2026-09-14 (base input, cache read, output, 5m write, 1h write).
const OPUS = { input: 5, input_cached: 0.5, output: 25, input_cache_write: 6.25, input_cache_write_1h: 10 };
const HAIKU_4_5 = { input: 1, input_cached: 0.1, output: 5, input_cache_write: 1.25, input_cache_write_1h: 2 };

// Per-model ledgers from the fixture: modelUsage tokens, TTL split from the transcript.
const OPUS_5_TOKENS = { input: 34, input_cached: 28810, input_cache_write: 0, input_cache_write_1h: 8837, output: 154 };
const OPUS_4_8_TOKENS = { input: 2, input_cached: 0, input_cache_write: 12202, input_cache_write_1h: 0, output: 4 };
const HAIKU_TOKENS = { input: 928, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 15 };
const OPUS_5_USD = computeCostUsd(OPUS_5_TOKENS, OPUS);
const OPUS_4_8_USD = computeCostUsd(OPUS_4_8_TOKENS, OPUS);
const HAIKU_USD = computeCostUsd(HAIKU_TOKENS, HAIKU_4_5);
const LEDGER_USD = round6(OPUS_5_USD + OPUS_4_8_USD + HAIKU_USD);

const CONFIG = { id: "opus-cli", adapter: "claude-cli", model_name: "claude-opus-5" };

const PACKET = {
  id: "pkt-t8",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "t8",
};

function fakeSpawn(stdout, calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.write(stdout);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

/** Run fn with stderr captured; returns [value, captured text]. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    return [await fn(), captured];
  } finally {
    process.stderr.write = original;
  }
}

function adapterFor(result, { config = CONFIG, projectsDir = PROJECTS, calls } = {}) {
  return new ClaudeCliAdapter(config, {
    probeBinary: () => {},
    spawnFn: fakeSpawn(JSON.stringify(result), calls),
    projectsDir,
    now: DISPATCH,
  });
}

const scaled = (result, k) => ({
  ...result,
  total_cost_usd: result.total_cost_usd * k,
  modelUsage: Object.fromEntries(Object.entries(result.modelUsage).map(([n, v]) => [n, { ...v, costUSD: v.costUSD * k }])),
});

test("T8 a claude-cli worker is priced from its ledger: modelUsage per model, TTL split from its own transcript", async () => {
  const [out, stderr] = await captureStderr(() => adapterFor(RESULT).execute(PACKET));
  assert.equal(out.success, true);
  assert.deepEqual(out.result, { ok: true });

  const attempt = out.attempts[0];
  assert.equal(out.cost_usd, LEDGER_USD, "cost is the list-priced ledger, not the CLI's dollars");
  assert.equal(attempt.cost_usd, LEDGER_USD);
  assert.ok(Math.abs(LEDGER_USD - 0.1841705) <= 0.000001, `the ledger reproduces the real receipt: ${LEDGER_USD}`);
  assert.equal(attempt.cli_reported_cost_usd, RESULT.total_cost_usd, "the CLI figure is kept beside the cost");
  assert.equal(attempt.price_basis, "list");
  assert.equal(attempt.ttl_split, "transcript");
  assert.deepEqual(attempt.unpriced_models, []);

  // Tokens now cover every model the CLI billed (the top-level `usage` holds
  // the session model only), with the 5-minute and 1-hour writes disjoint.
  assert.deepEqual(out.tokens, { input: 964, input_cached: 28810, input_cache_write: 12202, input_cache_write_1h: 8837, output: 173 });

  const byModel = Object.fromEntries(attempt.per_model.map((m) => [m.model, m]));
  assert.deepEqual(Object.keys(byModel).sort(), ["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-5"]);
  assert.deepEqual(byModel["claude-opus-5"].reported_as, ["claude-opus-5[1m]"], "[1m] resolves to Opus 5 at the Opus 5 price");
  assert.equal(byModel["claude-opus-5"].cost_usd, OPUS_5_USD);
  assert.deepEqual(byModel["claude-opus-5"].tokens, OPUS_5_TOKENS);
  assert.equal(byModel["claude-opus-4-8"].cost_usd, OPUS_4_8_USD);
  assert.deepEqual(byModel["claude-opus-4-8"].tokens, OPUS_4_8_TOKENS, "the helper's writes are 5-minute, as its transcript says");
  assert.equal(byModel["claude-haiku-4-5"].cost_usd, HAIKU_USD, "a receipt-only side call is priced from the list");
  assert.equal(byModel["claude-haiku-4-5"].cli_cost_usd, 0.001003);

  assert.doesNotMatch(stderr, /pricing\.cli_cost_mismatch/, "an agreeing CLI figure raises no warning");
});

test("T8 a Claude Code figure at 0.6x the list is a warning, never the cost", async () => {
  // The 2026-08-24 shape: Claude Code's price table billed Opus at 0.6x.
  const stale = scaled(RESULT, 0.6);
  const [out, stderr] = await captureStderr(() => adapterFor(stale).execute(PACKET));
  assert.equal(out.success, true);
  assert.equal(out.cost_usd, LEDGER_USD);
  assert.equal(out.attempts[0].cli_reported_cost_usd, stale.total_cost_usd);
  assert.match(stderr, /WARN\s+pricing\.cli_cost_mismatch/);
  assert.match(stderr, /delta_pct=-40\.00\b/, "two decimals, so a -0.53% difference cannot print as -0.5");
  assert.match(stderr, /model_id=opus-cli/);
});

test("T8 no readable worker transcript: the split comes from usage.cache_creation capped per model, flagged approximate", async () => {
  const empty = mkdtempSync(join(tmpdir(), "t8-no-transcripts-"));
  const [out, stderr] = await captureStderr(() => adapterFor(RESULT, { projectsDir: empty }).execute(PACKET));
  const attempt = out.attempts[0];
  assert.equal(attempt.ttl_split, "approximate");
  const byModel = Object.fromEntries(attempt.per_model.map((m) => [m.model, m]));
  // usage.cache_creation says 8837 1-hour writes; each model's 1-hour share is capped at that.
  assert.deepEqual(byModel["claude-opus-5"].tokens, { ...OPUS_5_TOKENS, input_cache_write: 0, input_cache_write_1h: 8837 });
  assert.deepEqual(byModel["claude-opus-4-8"].tokens, { ...OPUS_4_8_TOKENS, input_cache_write: 3365, input_cache_write_1h: 8837 });
  const approx = round6(
    computeCostUsd(byModel["claude-opus-5"].tokens, OPUS) + computeCostUsd(byModel["claude-opus-4-8"].tokens, OPUS) + HAIKU_USD,
  );
  assert.equal(out.cost_usd, approx);
  // The approximation disagrees with the CLI here, and the warning says the split was approximate.
  assert.match(stderr, /pricing\.cli_cost_mismatch/);
  assert.match(stderr, /ttl_split=approximate/);
});

test("T8 a model the list cannot price: cost is the priced part, the model is listed unpriced, a warning is logged", async () => {
  const withUnknown = {
    ...RESULT,
    total_cost_usd: RESULT.total_cost_usd + 0.00075,
    modelUsage: {
      ...RESULT.modelUsage,
      "claude-opus-4-9": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00075 },
    },
  };
  const [out, stderr] = await captureStderr(() => adapterFor(withUnknown).execute(PACKET));
  const attempt = out.attempts[0];
  assert.equal(out.success, true, "the work itself succeeded; only its price is incomplete");
  assert.equal(out.cost_usd, LEDGER_USD, "the priced part only, never a borrowed rate for the unknown model");
  assert.equal(attempt.unpriced_models.length, 1);
  assert.equal(attempt.unpriced_models[0].model, "claude-opus-4-9");
  assert.match(attempt.unpriced_models[0].reason, /unknown model/);
  assert.match(stderr, /WARN\s+pricing\.unpriced/);
  assert.doesNotMatch(stderr, /pricing\.cli_cost_mismatch/, "priced models are checked one by one, so the unknown one cannot fake a mismatch");
});

test("T8 a worker model the list cannot price is refused before claude is spawned", async () => {
  const calls = [];
  const adapter = adapterFor(RESULT, { config: { ...CONFIG, model_name: "claude-opus-4-9" }, calls });
  const [out] = await captureStderr(() => adapter.execute(PACKET));
  assert.equal(calls.length, 0, "no unpriced work is ever dispatched");
  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.match(out.error, /unpriced/);
  assert.match(out.error, /claude-opus-4-9/);
  assert.equal(out.cost_usd, 0);
});

test("T8 pricing_override on the claude-cli leaf bills its block for that model only, labelled custom", async () => {
  const CUSTOM = { input: 4, input_cached: 0.4, output: 20, input_cache_write: 5, input_cache_write_1h: 8 };
  const config = { ...CONFIG, pricing: CUSTOM, pricing_override: true };
  const [out, stderr] = await captureStderr(() => adapterFor(RESULT, { config }).execute(PACKET));
  const attempt = out.attempts[0];
  const byModel = Object.fromEntries(attempt.per_model.map((m) => [m.model, m]));
  assert.equal(attempt.price_basis, "custom");
  assert.equal(byModel["claude-opus-5"].price_basis, "custom");
  assert.equal(byModel["claude-opus-5"].cost_usd, computeCostUsd(OPUS_5_TOKENS, CUSTOM));
  assert.equal(byModel["claude-opus-4-8"].price_basis, "list", "the override prices the leaf's own model, not its helpers");
  assert.equal(out.cost_usd, round6(computeCostUsd(OPUS_5_TOKENS, CUSTOM) + OPUS_4_8_USD + HAIKU_USD));
  assert.doesNotMatch(stderr, /pricing\.cli_cost_mismatch/, "a deliberate custom price is not compared with the CLI's list figure");
});

/**
 * A copy of the fixture's transcript tree with the first Opus 5 line's usage
 * edited. Found by a $0 probe on the real 2026-09-10 headless run: Opus 4.8
 * lines there carry no `speed` on some lines and `"standard"` on others, and
 * reading those as two request types marked $13.70 of $14.20 unpriced.
 */
function transcriptsWithFirstLine(edit) {
  const dir = mkdtempSync(join(tmpdir(), "t8-modifiers-"));
  cpSync(PROJECTS, dir, { recursive: true });
  const main = join(dir, "-fixture-worker-project", `${RESULT.session_id}.jsonl`);
  let edited = false;
  const lines = readFileSync(main, "utf-8").split("\n").map((line) => {
    if (edited || !line.includes('"type":"assistant"')) return line;
    const obj = JSON.parse(line);
    edit(obj.message.usage);
    edited = true;
    return JSON.stringify(obj);
  });
  writeFileSync(main, lines.join("\n"));
  return dir;
}

test("T8 transcript lines that spell the same price differently (no `speed` on one line) are one price", async () => {
  const dir = transcriptsWithFirstLine((usage) => { delete usage.speed; delete usage.inference_geo; });
  const [out, stderr] = await captureStderr(() => adapterFor(RESULT, { projectsDir: dir }).execute(PACKET));
  const attempt = out.attempts[0];
  assert.deepEqual(attempt.unpriced_models, [], "an absent modifier is the API default, not a second request type");
  assert.equal(attempt.ttl_split, "transcript");
  assert.equal(out.cost_usd, LEDGER_USD);
  assert.doesNotMatch(stderr, /pricing\.unpriced/);
});

test("T8 transcript lines at two different prices for one model leave that model unpriced", async () => {
  // One Opus 5 request in fast mode beside a standard one: the result's
  // per-model totals cannot be split between the two prices.
  const dir = transcriptsWithFirstLine((usage) => { usage.speed = "fast"; });
  const [out, stderr] = await captureStderr(() => adapterFor(RESULT, { projectsDir: dir }).execute(PACKET));
  const attempt = out.attempts[0];
  assert.equal(attempt.unpriced_models.length, 1);
  assert.equal(attempt.unpriced_models[0].model, "claude-opus-5[1m]");
  assert.match(attempt.unpriced_models[0].reason, /more than one price/);
  assert.equal(out.cost_usd, round6(OPUS_4_8_USD + HAIKU_USD), "the other models are still priced");
  assert.match(stderr, /WARN\s+pricing\.unpriced/);
});

test("T8 a session id that is not a plain id is never used as a path", async () => {
  const hostile = { ...RESULT, session_id: "../../58591543-407d-4a7a-8a86-b29f035f1e7d" };
  const [out] = await captureStderr(() => adapterFor(hostile).execute(PACKET));
  assert.equal(out.attempts[0].ttl_split, "approximate");
});
