/**
 * The repo scout (pipeline skill, Phase 2) is a `discovery` packet with
 * task_type `repo_scout`. Every multi-model preset routes it to its
 * mechanical tier ahead of the generic discovery rule; the single-model
 * presets have no such rule, which is how the orchestrator knows to skip it.
 * A multi-model preset may opt out the same way (SCOUT_OFF).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyFromPath } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";

const POLICIES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const scout = { phase: "discovery", task_type: "repo_scout", module: "cross", retry_count: 0, intent: "feature-extend" };
// The scout's anchors were wrong four rows running on the study brief; the study preset skips it (0.8.5).
const SCOUT_OFF = new Set(["opus-plus-flash-v38"]);
const discovery = { phase: "discovery", task_type: "repo_snapshot", module: "cross", retry_count: 0, intent: "feature-extend" };

for (const file of readdirSync(POLICIES).filter((f) => f.endsWith(".yaml"))) {
  const policy = loadPolicyFromPath(join(POLICIES, file));
  const multi = policy.models.length > 1 && !/^flash-agsdk-only/.test(policy.name);
  const hasRule = policy.rules.some((r) => r.when?.task_type === "repo_scout");
  const off = !multi || SCOUT_OFF.has(policy.name);
  test(`${file}: ${off ? "has no repo_scout rule (scout skipped)" : "routes repo_scout to the mechanical tier, discovery stays premium"}`, () => {
    if (off) {
      assert.equal(hasRule, false);
      return;
    }
    assert.equal(hasRule, true, "every multi-model preset declares the scout rule");
    const s = pickModel(scout, policy);
    const d = pickModel(discovery, policy);
    assert.notEqual(s.modelId, d.modelId, `scout (${s.modelId}) must not route where discovery routes (${d.modelId})`);
    const codegen = pickModel({ phase: "codegen", task_type: "service_method", module: "api", retry_count: 0, intent: "feature-extend" }, policy);
    assert.equal(s.modelId, codegen.modelId, "the scout uses the same mechanical leaf as codegen");
  });
}
