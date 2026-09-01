/**
 * End-to-end pins for plugin/scripts/driver-model-check.mjs — the estimated-mode
 * run-start check that the model the driver subagents will execute on
 * (CLAUDE_CODE_SUBAGENT_MODEL, set at launch) is the model the policy prices.
 *
 * The script lives in plugin/scripts/ but its tests live HERE, in the MCP
 * package's suite, because it imports the compiled routing from this package's
 * dist/ — the same pickModel/loadPolicy the dispatch server runs, so the check
 * can never disagree with real routing. This suite runs via `npm run build &&
 * node --test`, so dist/ is guaranteed fresh; the root tools/test suite runs
 * before any build and could see a stale or absent dist.
 *
 * Every case spawns the real CLI (exit codes and the printed export line ARE
 * the contract the orchestrator's rule 0 acts on). Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "driver-model-check.mjs");

/** Run the script with a clean env: the two vars under test never leak in from the host shell. */
function run(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  delete env.MMO_SELECT;
  if (!("CLAUDE_CODE_SUBAGENT_MODEL" in envOverrides)) delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf-8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A policy whose judgment tier is one model and whose mechanical tier is another. */
const UNIFIED_POLICY = `
version: 1
name: check-unified
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: worker
    adapter: mcp:model-dispatch
    model_name: gemini-3.5-flash
    pricing: { input: 0.1, input_cached: 0.01, output: 0.4 }
rules:
  - when: { phase: codegen }
    use: worker
  - default: driver
`;

/** security_review lands on a different model than every other judgment phase. */
const SPLIT_POLICY = `
version: 1
name: check-split
models:
  - id: driver-a
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: driver-b
    adapter: builtin-anthropic
    model_name: claude-opus-5
    pricing: { input: 2, input_cached: 0.2, output: 10 }
rules:
  - when: { phase: security_review }
    use: driver-b
  - default: driver-a
`;

/** Judgment tier routed somewhere Claude Code cannot execute in-session. */
const NON_ANTHROPIC_POLICY = `
version: 1
name: check-agentic
models:
  - id: worker
    adapter: antigravity-worker
    model_name: gemini-3.5-flash
    pricing: { input: 0.1, input_cached: 0.01, output: 0.4 }
rules:
  - default: worker
`;

function withPolicy(yaml, fn) {
  const root = mkdtempSync(join(tmpdir(), "mmo-dmc-"));
  try {
    writeFileSync(join(root, "routing-policy.yaml"), yaml);
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--print-only derives the driver model from the judgment phases, ignoring mechanical routing", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root, "--print-only"]);
    assert.equal(r.code, 0, r.stderr);
    // codegen routes to gemini, but only judgment phases decide the driver model.
    assert.equal(r.stdout.trim(), "claude-opus-4-8");
  });
});

test("a matching CLAUDE_CODE_SUBAGENT_MODEL exits 0", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /driver-model-check ok/);
  });
});

test("an unset env var fails with the exact export remediation line", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /export CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-4-8/);
    // The line the orchestrator must relay: the fix happens before launch, not in-session.
    assert.match(r.stderr, /BEFORE claude launches/);
  });
});

test("a mismatched env var fails and names both models", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5/);
    assert.match(r.stderr, /claude-opus-4-8/);
  });
});

test("a policy that splits the judgment tier across models is an error, not a vote", () => {
  withPolicy(SPLIT_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /splits the judgment tier/);
    // The per-phase table names the odd one out so the user can see the split.
    assert.match(r.stderr, /security_review → claude-opus-5/);
  });
});

test("a judgment tier no Claude Code subagent can execute is an error directing to vendor mode", () => {
  withPolicy(NON_ANTHROPIC_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "gemini-3.5-flash" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a model Claude Code can run in-session/);
    assert.match(r.stderr, /--auth=vendor/);
  });
});

test("the shipped opus-plus-flash preset derives claude-opus-4-7 (the model its pricing block prices)", () => {
  const r = run(["--policy", "opus-plus-flash", "--print-only"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "claude-opus-4-7");
});

/*
 * The remediation has to be followable in the environment the reader is in.
 * A shell export never reaches Claude Code started from the desktop app, which
 * has no login shell — the repo states that rule for credentials in
 * verify-setup.mjs, but the driver-model check shipped without it, so an app
 * user hit the halt and could not act on what it printed.
 */
test("the failure remediation covers the desktop app, not just a shell export", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /export CLAUDE_CODE_SUBAGENT_MODEL=/, "the terminal route must still be given");
    assert.match(r.stderr, /\.claude\/settings\.json/, "the desktop-app route must be given too");
    assert.match(r.stderr, /login shell/, "and why an export cannot work there");
    assert.match(r.stderr, /project/, "the project file is the one to prefer");
  });
});
