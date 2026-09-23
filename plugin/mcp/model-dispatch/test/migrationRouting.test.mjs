/**
 * A database migration is the one codegen task where a plausible-looking wrong
 * answer destroys data, and it is low volume, so nothing is saved by sending it
 * to the cheap tier. It sat in the "schema-driven boilerplate" list of every
 * two-model policy. It now falls through to each policy's premium default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");

test("no shipped policy sends a migration to a worker model", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yaml"))) {
    const policy = loadPolicy({ policyName: file.slice(0, -5) });
    const premium = pickModel({ phase: "architecture_design", task_type: "design", module: "all", retry_count: 0 }, policy, {}).modelId;
    const got = pickModel({ phase: "codegen", task_type: "migration", module: "db", retry_count: 0 }, policy, {}).modelId;
    if (file.startsWith("flash-")) continue; // a single-model policy has no premium tier to fall back to
    assert.equal(got, premium, `${file}: a migration went to ${got}, the design phase goes to ${premium}`);
    const dto = pickModel({ phase: "codegen", task_type: "dto", module: "api", retry_count: 0 }, policy, {}).modelId;
    if (!file.startsWith("opus-only")) assert.notEqual(dto, premium, `${file}: ordinary boilerplate must still go to the worker`);
  }
});
