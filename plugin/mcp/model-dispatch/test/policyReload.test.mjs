/**
 * Two caches that went stale without anyone noticing:
 *   - the active policy was cached on (name, root, path) only, so an edited
 *     routing-policy.yaml kept routing by the OLD rules until the server
 *     restarted, which in a long session can be hours;
 *   - an adapter was cached on the leaf id only, so after such an edit a leaf
 *     that kept its id but changed model or endpoint kept the old adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFileFor, policyStamp } from "../dist/policy.js";
import { adapterCacheKey } from "../dist/adapters/index.js";

test("the policy stamp changes when the file's size or time changes, and names the file that would load", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    const file = join(dir, "routing-policy.yaml");
    assert.match(policyFileFor({ policyName: "opus-only", projectRoot: dir }), /config\/policies\/opus-only\.yaml$/);
    writeFileSync(file, "version: 1\n");
    assert.equal(policyFileFor({ policyName: "opus-only", projectRoot: dir }), file, "a project file outranks the preset, as in loadPolicy");
    const first = policyStamp(file);
    writeFileSync(file, "version: 1\nname: x\n");
    assert.notEqual(policyStamp(file), first, "a size change must be seen");
    const second = policyStamp(file);
    utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    assert.notEqual(policyStamp(file), second, "same size, newer time must be seen");
    assert.equal(policyStamp(join(dir, "missing.yaml")), "missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an adapter is cached on what it talks to, not only on its leaf id", () => {
  const a = { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.7-flash" };
  assert.equal(adapterCacheKey(a), adapterCacheKey({ ...a }));
  assert.notEqual(adapterCacheKey(a), adapterCacheKey({ ...a, model_name: "gemini-3.8-flash" }));
  assert.notEqual(adapterCacheKey(a), adapterCacheKey({ ...a, adapter: "antigravity-worker" }));
  assert.notEqual(adapterCacheKey(a), adapterCacheKey({ ...a, endpoint: "https://elsewhere" }));
});
