/**
 * Every shipped policy declares `hard_cost_cap_usd` and the docs say a run
 * stops when it is reached, but no code read the field: a run could spend
 * without limit. These tests pin the enforcement. The spend is summed from the
 * run's telemetry FILE, so the cap holds across server restarts and sessions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpendUsd, checkCostCap } from "../dist/costCap.js";

const ev = (cost) => JSON.stringify({ ts: "2026-09-22T00:00:00Z", pass: "p1", cost_usd: cost });

test("run spend is the sum of every priced event, ignoring lines that are not numbers", () => {
  assert.equal(runSpendUsd([{ cost_usd: 1.5 }, { cost_usd: 2 }, { cost_usd: null }, { cost_usd: NaN }, {}]), 3.5);
});

test("under the cap a dispatch is allowed; at or over it, refused with the numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cap-"));
  try {
    const file = join(dir, "telemetry.jsonl");
    writeFileSync(file, [ev(20), ev(29.5)].join("\n") + "\n");
    assert.deepEqual(checkCostCap({ hard_cost_cap_usd: 50 }, file), { ok: true, spent: 49.5, cap: 50 });
    writeFileSync(file, [ev(20), ev(29.5), ev(0.5), "{ torn"].join("\n") + "\n");
    const over = checkCostCap({ hard_cost_cap_usd: 50 }, file);
    assert.equal(over.ok, false);
    assert.equal(over.spent, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no cap, a cap of zero or less, no telemetry file, or no path: nothing to enforce, never a crash", () => {
  assert.equal(checkCostCap({}, "/nonexistent/telemetry.jsonl").ok, true);
  assert.equal(checkCostCap({ hard_cost_cap_usd: 0 }, "/nonexistent/x").ok, true);
  assert.equal(checkCostCap({ hard_cost_cap_usd: 50 }, undefined).ok, true);
  assert.equal(checkCostCap({ hard_cost_cap_usd: 50 }, "/nonexistent/telemetry.jsonl").ok, true);
});
