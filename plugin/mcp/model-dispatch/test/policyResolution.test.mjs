/**
 * Policy resolution + validation pins for the routing-policy.yaml override
 * story. Three families:
 *
 *   1. Loader precedence — a repo-local routing-policy.yaml beats the named
 *      preset when project_root is passed, and the preset loads when the
 *      override file is absent. This is the behavior greenfield.md and
 *      pass.md now promise, so it gets an executable pin.
 *   2. Load-time validation — an unknown `adapter:` id fails at policy load
 *      (it used to pass validation and only explode when createAdapter ran
 *      mid-run, after premium phases were billed), and the not-found error's
 *      "Available:" list is read from the shipped-preset directory, never
 *      hardcoded (the hardcoded list already went stale once: it said two
 *      presets while seven shipped).
 *   3. simulate_policy server wiring — dist-greps, because importing
 *      dist/server.js starts a Server on import. Pins that the handler no
 *      longer hardcodes `undefined` for project_root and that the tool's
 *      inputSchema declares the argument.
 *
 * Offline; temp dirs only, no network, no adapters constructed (loadPolicy
 * validates but never instantiates adapters).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy, loadPolicyFromPath } from "../dist/policy.js";
import { KNOWN_ADAPTER_IDS } from "../dist/adapters/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Minimal valid policy YAML; adapter must be a registered id to pass validation. */
const policyYaml = (name, adapter = "builtin-anthropic") => `
version: 1
name: ${name}
models:
  - id: m1
    adapter: ${adapter}
    model_name: claude-opus-5
    pricing: { input: 1, input_cached: 0.1, output: 5 }
rules:
  - default: m1
`;

test("a repo-local routing-policy.yaml beats the named preset when project_root is passed", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    writeFileSync(join(root, "routing-policy.yaml"), policyYaml("repo-override"));
    const policy = loadPolicy({ policyName: "opus-only", projectRoot: root });
    assert.equal(policy.name, "repo-override", "the project file wins over the preset name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without an override file the named preset loads", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    const policy = loadPolicy({ policyName: "opus-only", projectRoot: root });
    assert.equal(policy.name, "opus-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown policy name lists the shipped presets read from disk, not a hardcoded pair", () => {
  assert.throws(
    () => loadPolicy({ policyName: "no-such-policy" }),
    (err) => {
      // Names beyond the stale two prove the list is live: these presets
      // shipped while the old message still said "opus-only, opus-plus-flash".
      assert.match(err.message, /flash-agsdk-only/);
      assert.match(err.message, /opus-plus-sonnet-max/);
      // And the durable-override guidance replaced the plugin-dir suggestion
      // that /plugin update would silently wipe.
      assert.match(err.message, /routing-policy\.yaml/);
      return true;
    },
  );
});

test("a model naming an unregistered adapter fails at policy load, not mid-run", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    const path = join(root, "bad-adapter.yaml");
    writeFileSync(path, policyYaml("bad-adapter", "totally-made-up"));
    assert.throws(
      () => loadPolicyFromPath(path),
      /unknown adapter 'totally-made-up'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the legacy Gemini adapter alias still validates (compat shim preserved)", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    const path = join(root, "legacy.yaml");
    writeFileSync(path, policyYaml("legacy-alias", "mcp:gemini-flash-server"));
    const policy = loadPolicyFromPath(path);
    assert.equal(policy.models[0].adapter, "mcp:gemini-flash-server");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KNOWN_ADAPTER_IDS carries every registered id including the legacy alias", () => {
  for (const id of [
    "builtin-anthropic",
    "claude-cli",
    "mcp:model-dispatch",
    "mcp:gemini-flash-server",
    "antigravity-worker",
  ]) {
    assert.ok(KNOWN_ADAPTER_IDS.has(id), `registry is missing '${id}'`);
  }
});

// --- simulate_policy wiring pins (dist-grep — server.js starts a Server on import) ---

const serverSrc = readFileSync(join(HERE, "..", "dist", "server.js"), "utf-8");

test("no tool handler hardcodes undefined for ensurePolicy's projectRoot", () => {
  // simulate_policy used to call ensurePolicy(a.policy_name, undefined, a.policy_path),
  // so a simulation for a project with a repo-local routing-policy.yaml
  // silently priced the shipped preset instead of the policy the run used.
  assert.doesNotMatch(serverSrc, /ensurePolicy\(a\.policy_name,\s*undefined/);
});

test("the simulate_policy inputSchema declares project_root like its siblings", () => {
  const schemaBlock = serverSrc.match(
    /name: "simulate_policy"[\s\S]*?required: \["events"\]/,
  );
  assert.ok(schemaBlock, "could not locate the simulate_policy tool schema in dist/server.js");
  assert.match(schemaBlock[0], /project_root/);
});

/*
 * Session project-root memory. The preview passes `project_root` and the billed
 * dispatch did not, so the two keyed the policy cache differently and the
 * dispatch reloaded the shipped preset. These pin the behaviour, not the text.
 */
import { resolveProjectRoot, resetProjectRootMemory } from "../dist/project-root.js";

test("a caller that omits project_root reuses the one an earlier caller supplied", () => {
  resetProjectRootMemory();
  assert.equal(resolveProjectRoot("/repo/a"), "/repo/a");
  assert.equal(resolveProjectRoot(undefined), "/repo/a", "the dispatch must not fall back to no root");
});

test("an explicitly supplied project_root wins over the remembered one", () => {
  resetProjectRootMemory();
  resolveProjectRoot("/repo/a");
  assert.equal(resolveProjectRoot("/repo/b"), "/repo/b");
  assert.equal(resolveProjectRoot(undefined), "/repo/b", "the newer root replaces the remembered one");
});

test("with no root ever supplied the result stays undefined", () => {
  resetProjectRootMemory();
  assert.equal(resolveProjectRoot(undefined), undefined);
});

test("a dispatch that omits project_root still resolves the repo-local override", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-policy-"));
  try {
    resetProjectRootMemory();
    writeFileSync(join(root, "routing-policy.yaml"), policyYaml("repo-override"));
    // Preview: passes the root, as greenfield.md instructs.
    const preview = loadPolicy({ policyName: "opus-only", projectRoot: resolveProjectRoot(root) });
    assert.equal(preview.name, "repo-override");
    // Billed dispatch: omits it. Before the fallback this loaded "opus-only".
    const dispatched = loadPolicy({ policyName: "opus-only", projectRoot: resolveProjectRoot(undefined) });
    assert.equal(dispatched.name, "repo-override", "the billed path must route under the policy the preview named");
  } finally {
    resetProjectRootMemory();
    rmSync(root, { recursive: true, force: true });
  }
});
