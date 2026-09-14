/**
 * T9 (core): the effective price of a policy model (src/effectivePrice.ts).
 *
 * A policy `pricing:` block no longer prices a dispatch by default. The price
 * is the dated list's (src/prices.ts) for the model on the dispatch day; a
 * block that differs from it by more than 0.5% on any rate it declares is
 * ignored with a warning that names both prices (the shape of a hand-copied
 * wrong card, such as a 3.5 Flash card carried into another policy); a block
 * is billed only with `pricing_override: true`, and is then labelled custom.
 * A model the list cannot price, without an override, is unpriced: never a
 * borrowed or remembered rate.
 *
 * Imports from dist/ (this suite runs via `npm run build && node --test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as ep from "../dist/effectivePrice.js";

const DAY = "2026-09-14";
const OPUS5_LIST = { input: 5, input_cached: 0.5, input_cache_write: 6.25, input_cache_write_1h: 10, output: 25 };
const SONNET5_LIST = { input: 2, input_cached: 0.2, input_cache_write: 2.5, input_cache_write_1h: 4, output: 10 };

const model = (over = {}) => ({ id: "leaf", adapter: "builtin-anthropic", model_name: "claude-opus-5", ...over });

test("T9 no pricing block: the list prices the model, labelled list, with its period", () => {
  const r = ep.effectivePrice(model(), DAY);
  assert.equal(r.unpriced, false);
  assert.equal(r.basis, "list");
  assert.deepEqual(r.pricing, OPUS5_LIST);
  assert.equal(r.period.from, "2026-01-01");
  assert.equal(r.period.verified, "2026-09-14");
  assert.deepEqual(r.warnings, []);
});

test("T9 a block equal to the list is silent and changes nothing", () => {
  const r = ep.effectivePrice(model({ pricing: { input: 5, input_cached: 0.5, output: 25 } }), DAY);
  assert.equal(r.basis, "list");
  assert.deepEqual(r.pricing, OPUS5_LIST);
  assert.deepEqual(r.warnings, []);
});

test("T9 a block more than 0.5% off the list is ignored, with a warning naming both prices", () => {
  // The old Sonnet 5 card (3.00 / 0.30 / 15.00) against the list's 2 / 0.2 / 10.
  const r = ep.effectivePrice(
    model({ id: "sonnet", model_name: "claude-sonnet-5", pricing: { input: 3, input_cached: 0.3, output: 15 } }),
    DAY,
  );
  assert.equal(r.unpriced, false);
  assert.equal(r.basis, "list", "a mismatched block must never be billed silently");
  assert.deepEqual(r.pricing, SONNET5_LIST);
  assert.equal(r.warnings.length, 1);
  const w = r.warnings[0];
  assert.match(w, /sonnet/);
  assert.match(w, /claude-sonnet-5/);
  assert.match(w, /input 3\b/, "names the policy's price");
  assert.match(w, /input 2\b/, "names the list's price");
  assert.match(w, /input, input_cached, output/, "names every component that differs");
  assert.match(w, /pricing_override: true/, "says how to bill the policy's price on purpose");
});

test("T9 the 0.5% tolerance: 0.4% off is silent, 0.6% off warns; only declared rates are compared", () => {
  assert.deepEqual(ep.effectivePrice(model({ pricing: { input: 5.02, input_cached: 0.5, output: 25 } }), DAY).warnings, []);
  const off = ep.effectivePrice(model({ pricing: { input: 5.03, input_cached: 0.5, output: 25 } }), DAY);
  assert.equal(off.warnings.length, 1);
  assert.match(off.warnings[0], /differs on input\b/);
  // A declared write rate is compared too.
  const w = ep.effectivePrice(model({ pricing: { input: 5, input_cached: 0.5, output: 25, input_cache_write_1h: 6.25 } }), DAY);
  assert.match(w.warnings[0], /input_cache_write_1h/);
  assert.ok(ep.POLICY_PRICE_TOLERANCE === 0.005);
});

test("T9 pricing_override: true bills the policy block and labels it custom", () => {
  const block = { input: 3, input_cached: 0.3, output: 15 };
  const r = ep.effectivePrice(model({ model_name: "claude-sonnet-5", pricing: block, pricing_override: true }), DAY);
  assert.equal(r.unpriced, false);
  assert.equal(r.basis, "custom");
  assert.deepEqual(r.pricing, block);
  assert.equal(r.period, null, "a custom price has no list period");
  assert.deepEqual(r.warnings, [], "an override is deliberate: no mismatch warning");
});

test("T9 pricing_override prices a model the list does not know, and only through the override", () => {
  const block = { input: 1, input_cached: 0.1, output: 4 };
  const custom = ep.effectivePrice(model({ model_name: "gemini-3.5-flash-lite", pricing: block, pricing_override: true }), DAY);
  assert.equal(custom.basis, "custom");
  assert.deepEqual(custom.pricing, block);
  // Same block, no override: unpriced, never the block.
  const refused = ep.effectivePrice(model({ model_name: "gemini-3.5-flash-lite", pricing: block }), DAY);
  assert.equal(refused.unpriced, true);
  assert.equal(refused.pricing, undefined);
  assert.match(refused.reason, /gemini-3\.5-flash-lite/);
  assert.match(refused.reason, /pricing_override/, "the reason says what would price it");
});

test("T9 a dated gap is unpriced: Gemini 3.7 Flash on 2027-01-02 has no list period", () => {
  const leaf = model({ model_name: "gemini-3.7-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 } });
  assert.equal(ep.effectivePrice(leaf, DAY).unpriced, false);
  const later = ep.effectivePrice(leaf, "2027-01-02");
  assert.equal(later.unpriced, true);
  assert.match(later.reason, /no price period/);
  // A Date is priced on its UTC day.
  assert.equal(ep.effectivePrice(leaf, new Date("2026-12-31T23:59:59Z")).unpriced, false);
  assert.equal(ep.effectivePrice(leaf, new Date("2027-01-01T00:00:00Z")).unpriced, true);
});

test("T9 the mismatch check compares the standard card, so a fast-mode dispatch never warns on an equal block", () => {
  const r = ep.effectivePrice(model({ pricing: { input: 5, input_cached: 0.5, output: 25 } }), DAY, { speed: "fast" });
  assert.equal(r.basis, "list");
  assert.equal(r.pricing.input, 10);
  assert.deepEqual(r.warnings, []);
});

test("sameModel: a Claude Code option or snapshot suffix names the same model; a different id does not", () => {
  assert.equal(ep.sameModel("claude-opus-5[1m]", "claude-opus-5"), true);
  assert.equal(ep.sameModel("claude-haiku-4-5-20251001", "claude-haiku-4-5"), true);
  assert.equal(ep.sameModel("my-gateway-model[1m]", "my-gateway-model"), true, "an unlisted name matches itself with an option");
  assert.equal(ep.sameModel("claude-fable-5-1", "claude-fable-5"), false);
  assert.equal(ep.sameModel("claude-opus-4-8", "claude-opus-5"), false);
});
