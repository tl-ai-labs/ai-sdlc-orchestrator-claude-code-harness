/**
 * Pins for buildManifest's orchestrator-overhead partition (src/telemetry.ts).
 *
 * The post-run collector appends a `tier: "orchestrator"` event to
 * telemetry.jsonl. The structural guarantee under test: re-deriving a
 * manifest from collector-touched telemetry keeps every dispatched sum and
 * breakdown IDENTICAL to what untouched telemetry produced, surfaces the
 * overhead only in its own labeled block, and adds a true total. If the
 * partition ever regresses, the two spends blend silently — the exact
 * falsification the whole workstream exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../dist/telemetry.js";

/** Minimal dispatched event; overrides let each case vary what matters. */
function ev(overrides = {}) {
  return {
    ts: "2026-08-31T10:00:00.000Z",
    pass: "p1",
    phase: "codegen",
    task_type: "code",
    task_id: "t-1",
    module: "core",
    model: "worker-model",
    model_id: "worker",
    routed_by: "mcp",
    provenance: "vendor",
    routing: { policy_name: "test", policy_version: 1, rule_index: 0, rule_reason: "test" },
    input_tokens: 1000,
    input_tokens_cached: 500,
    output_tokens: 200,
    cost_usd: 0.01,
    latency_ms: 100,
    success: true,
    retry_count: 0,
    ...overrides,
  };
}

/** The collector's event: stamped after the run, priced at the driver model. */
function orchEv(overrides = {}) {
  return ev({
    ts: "2026-08-31T12:00:00.000Z",
    phase: "orchestrator_overhead",
    task_type: "orchestrator_overhead",
    task_id: "orchestrator-overhead-p1",
    module: "orchestrator",
    model: "driver-model",
    model_id: "driver",
    routed_by: "orchestrator",
    provenance: "transcript",
    tier: "orchestrator",
    input_tokens: 50_000,
    input_tokens_cached: 900_000,
    input_tokens_cache_write: 300_000,
    output_tokens: 40_000,
    cost_usd: 2.5,
    latency_ms: null,
    ...overrides,
  });
}

const OPTS = { pass: "p1", policy_name: "test" };

test("without orchestrator events the new fields stay absent — old manifests unchanged in shape", () => {
  const m = buildManifest([ev(), ev({ ts: "2026-08-31T10:05:00.000Z", task_id: "t-2" })], OPTS);
  assert.equal(m.orchestrator_overhead, undefined);
  assert.equal(m.true_total_cost_usd, undefined);
  // The cache-write total is always summed (0 for telemetry without the bucket).
  assert.equal(m.total_input_tokens_cache_write, 0);
  assert.equal(m.total_cost_usd, 0.02);
});

test("orchestrator events are partitioned OUT of every dispatched sum and breakdown", () => {
  const dispatched = [ev(), ev({ ts: "2026-08-31T10:05:00.000Z", task_id: "t-2" })];
  const withoutOrch = buildManifest(dispatched, OPTS);
  const withOrch = buildManifest([...dispatched, orchEv()], OPTS);

  // Dispatched figures identical to the letter — the blend-proof guarantee.
  assert.equal(withOrch.total_cost_usd, withoutOrch.total_cost_usd);
  assert.equal(withOrch.total_input_tokens, withoutOrch.total_input_tokens);
  assert.equal(withOrch.total_output_tokens, withoutOrch.total_output_tokens);
  assert.deepEqual(withOrch.model_breakdown, withoutOrch.model_breakdown);
  assert.deepEqual(withOrch.phase_breakdown, withoutOrch.phase_breakdown);
  assert.deepEqual(withOrch.module_breakdown, withoutOrch.module_breakdown);
  assert.deepEqual(withOrch.task_type_breakdown, withoutOrch.task_type_breakdown);
  // The driver model must NOT appear in the dispatched model breakdown.
  assert.equal(withOrch.model_breakdown["driver-model"], undefined);

  // The overhead surfaces only in its own block, plus the true total.
  assert.deepEqual(withOrch.orchestrator_overhead, {
    cost_usd: 2.5,
    input_tokens: 50_000,
    input_tokens_cached: 900_000,
    input_tokens_cache_write: 300_000,
    output_tokens: 40_000,
    events: 1,
    provenance: "transcript",
  });
  assert.equal(withOrch.true_total_cost_usd, 2.52);
});

test("the run window comes from dispatched events — the collector's post-run stamp never stretches it", () => {
  // The orchestrator event is stamped at collection time (12:00), two hours
  // after the run's last dispatched event (10:05). Duration must reflect the
  // run, not the collection.
  const m = buildManifest([ev(), ev({ ts: "2026-08-31T10:05:00.000Z", task_id: "t-2" }), orchEv()], OPTS);
  assert.equal(m.started_at, "2026-08-31T10:00:00.000Z");
  assert.equal(m.ended_at, "2026-08-31T10:05:00.000Z");
  assert.equal(m.duration_sec, 300);
});

test("overhead-only input (degenerate) still builds, with the overhead event as the only clock", () => {
  const m = buildManifest([orchEv()], OPTS);
  assert.equal(m.total_cost_usd, 0);
  assert.equal(m.orchestrator_overhead.cost_usd, 2.5);
  assert.equal(m.true_total_cost_usd, 2.5);
  assert.equal(m.started_at, "2026-08-31T12:00:00.000Z");
});

test("serialized manifests carry no undefined keys — absent means absent on the wire", () => {
  const m = buildManifest([ev()], OPTS);
  const wire = JSON.parse(JSON.stringify(m));
  assert.equal("orchestrator_overhead" in wire, false);
  assert.equal("true_total_cost_usd" in wire, false);
});
