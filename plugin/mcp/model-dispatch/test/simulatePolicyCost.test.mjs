/*
 * What-if replay pricing (routing.ts simulatePolicyCost, the `simulate_policy`
 * MCP tool).
 *
 * Pins that a replayed event is priced by the SAME arithmetic the live path
 * uses (pricing.ts computeCostUsd) on the SAME disjoint buckets a telemetry
 * event stores. The replay used to compute `input_tokens - input_tokens_cached`
 * before pricing — but `input_tokens` is already the fresh count, so every
 * cache-hit event was under-priced by its cached count and a cache-heavy event
 * replayed NEGATIVE. The only earlier test (selectSlots.test.mjs) used
 * input_tokens_cached: 0, which is why it never fired.
 *
 * Offline; shipped policy only; no adapters constructed, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPolicy } from "../dist/policy.js";
import { simulatePolicyCost } from "../dist/routing.js";
import {
  computeCostUsd,
  CACHE_WRITE_PREMIUM,
  CACHE_WRITE_PREMIUM_1H,
} from "../dist/pricing.js";

const policy = loadPolicy({ policyName: "opus-plus-flash-v37" });

// Every event below matches the same rule, so the replay routes all of them
// to one model; read that model back from the replay itself rather than
// hardcoding an id that a future policy edit could move.
const base = { phase: "tests", task_type: "test_unit", module: "cross", retry_count: 0 };
function modelFor(ev) {
  const { per_model } = simulatePolicyCost([ev], policy);
  const ids = Object.keys(per_model);
  assert.equal(ids.length, 1, "fixture event must route to exactly one model");
  return policy.models.find((m) => m.id === ids[0]);
}
// computeCostUsd rounds EVERY event to 6 decimals (round6), exactly as the
// live path does before an event's cost_usd is written, so a difference of
// two replayed prices can sit up to 1e-6 off the exact rate arithmetic.
const near = (a, b) => Math.abs(a - b) <= 1e-6;

test("a cache-hit event replays at the live price, never negative", () => {
  const ev = { ...base, input_tokens: 20_000, input_tokens_cached: 80_000, output_tokens: 3_000 };
  const model = modelFor(ev);
  const live = computeCostUsd({ input: 20_000, input_cached: 80_000, output: 3_000 }, model.pricing);
  const replay = simulatePolicyCost([ev], policy);

  assert.ok(live > 0);
  assert.equal(replay.total_cost_usd, live);
  assert.equal(replay.per_model[model.id], live);

  // Regression guard: the pre-fix arithmetic on this very event went below
  // zero (fresh = 20k − 80k). If this ever stops being negative the fixture
  // no longer exercises the bug and needs bigger cached counts.
  const preFix =
    ((20_000 - 80_000) / 1e6) * model.pricing.input +
    (80_000 / 1e6) * model.pricing.input_cached +
    (3_000 / 1e6) * model.pricing.output;
  assert.ok(preFix < 0, "fixture must be one the old subtraction priced negative");
});

test("cache reads only ever ADD their discounted cost to an event", () => {
  const noCache = { ...base, input_tokens: 20_000, input_tokens_cached: 0, output_tokens: 3_000 };
  const withCache = { ...noCache, input_tokens_cached: 80_000 };
  const model = modelFor(noCache);

  const a = simulatePolicyCost([noCache], policy).total_cost_usd;
  const b = simulatePolicyCost([withCache], policy).total_cost_usd;

  assert.ok(b > a, "adding cache reads must not lower the price");
  assert.ok(near(b - a, (80_000 / 1e6) * model.pricing.input_cached));
});

test("5-minute and 1-hour cache writes replay at their own premiums", () => {
  const ev5m = { ...base, input_tokens: 10_000, input_tokens_cached: 0, input_tokens_cache_write: 5_000, output_tokens: 1_000 };
  const ev1h = { ...ev5m, input_tokens_cache_write: 0, input_tokens_cache_write_1h: 5_000 };
  const model = modelFor(ev5m);

  const c5m = simulatePolicyCost([ev5m], policy).total_cost_usd;
  const c1h = simulatePolicyCost([ev1h], policy).total_cost_usd;

  assert.equal(c5m, computeCostUsd({ input: 10_000, input_cached: 0, input_cache_write: 5_000, output: 1_000 }, model.pricing));
  assert.equal(c1h, computeCostUsd({ input: 10_000, input_cached: 0, input_cache_write_1h: 5_000, output: 1_000 }, model.pricing));

  // The two tiers differ by exactly their rate gap on the written tokens
  // (explicit per-model rates when the policy declares them, else the
  // fresh-rate premiums pricing.ts defines).
  const rate5m = model.pricing.input_cache_write ?? model.pricing.input * CACHE_WRITE_PREMIUM;
  const rate1h = model.pricing.input_cache_write_1h ?? model.pricing.input * CACHE_WRITE_PREMIUM_1H;
  assert.ok(near(c1h - c5m, (5_000 / 1e6) * (rate1h - rate5m)));
});

test("a mixed batch replays to the sum of its live prices", () => {
  const events = [
    // pre-bucket shape: no cache-write key at all
    { ...base, input_tokens: 1_000, input_tokens_cached: 0, output_tokens: 100 },
    // the cache-heavy shape that used to go negative
    { ...base, input_tokens: 20_000, input_tokens_cached: 80_000, output_tokens: 3_000 },
    // all three input buckets populated
    { ...base, input_tokens: 500, input_tokens_cached: 4_500, input_tokens_cache_write: 2_000, output_tokens: 50 },
  ];
  const model = modelFor(events[0]);
  const expected = events.reduce(
    (sum, ev) =>
      sum +
      computeCostUsd(
        { input: ev.input_tokens, input_cached: ev.input_tokens_cached, input_cache_write: ev.input_tokens_cache_write, output: ev.output_tokens },
        model.pricing
      ),
    0
  );

  const out = simulatePolicyCost(events, policy);
  assert.ok(out.total_cost_usd > 0);
  assert.ok(near(out.total_cost_usd, expected));
  assert.ok(near(out.per_model[model.id], expected));
});
