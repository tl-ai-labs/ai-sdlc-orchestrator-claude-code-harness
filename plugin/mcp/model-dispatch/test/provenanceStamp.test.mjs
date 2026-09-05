/**
 * Regression tests for the server-side provenance stamp on dispatched
 * telemetry events. docs/methodology.md always claimed every event carries
 * a `provenance` field ("vendor" / "estimated" / "transcript"), and
 * tools/report.mjs keys the run's cost label off it — but the dispatch
 * server never wrote the field, so every `execute_with_model` event fell
 * to "unknown" and the report disowned the whole run's numbers.
 *
 * The direct-tier half of the fix (log_telemetry defaulting to
 * "estimated") is behavior-tested in logTelemetry.test.mjs. This file
 * pins the server half: dispatched events are stamped "vendor" — the
 * numbers come from the vendor's own usage report, in BOTH auth modes.
 *
 * We check the compiled source rather than importing the ESM module
 * (server.ts starts a Server on import; we don't want side effects in a
 * unit test) — the same pattern as executeWithModelSchema.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("compiled server stamps dispatched events with provenance \"vendor\"", () => {
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /provenance: "vendor"/, "dispatched telemetry events must carry the vendor stamp");
});

test("the vendor stamp sits inside the dispatched-event construction", () => {
  const src = readFileSync(SERVER, "utf8");
  // The event the execute_with_model handler builds is the only place that
  // sets routed_by: "orchestrator" as a literal next to the model dispatch;
  // the provenance stamp must be part of that same object, not a stray
  // string elsewhere in the bundle.
  const routedIdx = src.indexOf('routed_by: "orchestrator"');
  const stampIdx = src.indexOf('provenance: "vendor"');
  assert.notEqual(routedIdx, -1, "baseEvent's routed_by literal must be findable");
  assert.notEqual(stampIdx, -1, "vendor stamp must be findable");
  assert.ok(
    stampIdx > routedIdx && stampIdx - routedIdx < 1000,
    "vendor stamp must sit in the same event object as routed_by",
  );
});

test("the server never mislabels a dispatched event as an estimate", () => {
  const src = readFileSync(SERVER, "utf8");
  // "estimated" belongs exclusively to the direct tier: the absence-filling
  // `??` default in normalizeDirectTierEvent (compiled separately into
  // dist/telemetry.js). If a hard "estimated" stamp ever appears in the
  // server module itself, a dispatched, vendor-measured event is being
  // mislabeled as a guess.
  assert.doesNotMatch(src, /provenance: "estimated"/, "no dispatched event may be hard-stamped as an estimate");
});
