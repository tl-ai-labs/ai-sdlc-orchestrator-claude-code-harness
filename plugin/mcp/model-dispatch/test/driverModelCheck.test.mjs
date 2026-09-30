/**
 * End-to-end pins for plugin/scripts/driver-model-check.mjs — the estimated-mode
 * run-start check that the model the driver subagents will execute on is the
 * model the policy prices.
 *
 * Since v0.8.3 (25 Sep 2026) that model is named in the plugin's own agent files
 * (`model: claude-opus-5` in all five driver agents), not in the user's
 * CLAUDE_CODE_SUBAGENT_MODEL setting: since Claude Code 2.1.251 an agent file's
 * model wins over that setting and over the chat's model, so no setting, no
 * relaunch and no install step is needed. The one exception is Claude Code's
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE switch, which makes the setting win again;
 * the check then compares the setting instead. The v0.7.x cases that tested
 * the setting's remediation text (export lines, settings files the desktop app
 * ignores) went with it: there is nothing left to set.
 *
 * The script lives in plugin/scripts/ but its tests live HERE, in the MCP
 * package's suite, because it imports the compiled routing from this package's
 * dist/ — the same pickModel/loadPolicy the dispatch server runs, so the check
 * can never disagree with real routing. This suite runs via `npm run build &&
 * node --test`, so dist/ is guaranteed fresh.
 *
 * Every case spawns the real CLI (exit codes and the printed lines ARE the
 * contract the orchestrator's rule 0 acts on). Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "driver-model-check.mjs");
const PINNED = "claude-opus-5";
const AGENT_NAMES = ["orchestrator", "architect", "discovery", "senior-reviewer", "security-reviewer"];

/** Run the script with a clean env: the variables under test never leak in from the host shell. */
function run(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  delete env.MMO_SELECT;
  for (const k of ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]) {
    if (!(k in envOverrides)) delete env[k];
  }
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf-8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A policy whose judgment tier is one model (not the pinned one) and whose mechanical tier is another. */
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

/** The same shape with the pinned model as its judgment tier. */
const PINNED_POLICY = UNIFIED_POLICY.replace("check-unified", "check-pinned").replace("claude-opus-4-8", PINNED);

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

/** A throwaway agents folder: `models` maps agent name -> the model: value (null = no model line, undefined = no file). */
function withAgents(models, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-dmc-agents-"));
  try {
    for (const name of AGENT_NAMES) {
      if (models[name] === undefined) continue;
      const line = models[name] === null ? "" : `model: ${models[name]}\n`;
      writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test\ntools: Read\n${line}---\nBody.\n`);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// ─── Where the helpers' model comes from (v0.8.3): the plugin's own agent files ───

test("the helpers' model is read from the plugin's agent files: all five name claude-opus-5", async () => {
  const { pinnedDriverModel } = await import(pathToFileURL(SCRIPT).href);
  assert.equal(pinnedDriverModel(), PINNED);
});

test("the agent files must agree: a missing file, a missing model line, an alias or two different models is a plugin defect, named", async () => {
  const { pinnedDriverModel } = await import(pathToFileURL(SCRIPT).href);
  const all = Object.fromEntries(AGENT_NAMES.map((n) => [n, PINNED]));
  withAgents(all, (dir) => assert.equal(pinnedDriverModel(dir), PINNED));
  withAgents({ ...all, "security-reviewer": '"claude-opus-5"' }, (dir) => assert.equal(pinnedDriverModel(dir), PINNED, "a quoted id reads the same"));
  withAgents({ ...all, discovery: null }, (dir) => assert.throws(() => pinnedDriverModel(dir), /discovery\.md.*no model: line/));
  withAgents({ ...all, architect: "claude-sonnet-5" }, (dir) => assert.throws(() => pinnedDriverModel(dir), /architect\.md[\s\S]*claude-sonnet-5[\s\S]*claude-opus-5|claude-opus-5[\s\S]*architect\.md[\s\S]*claude-sonnet-5/));
  withAgents({ ...all, orchestrator: "opus" }, (dir) => assert.throws(() => pinnedDriverModel(dir), /orchestrator\.md.*'opus'.*exact model id/));
  withAgents({ ...all, "senior-reviewer": undefined }, (dir) => assert.throws(() => pinnedDriverModel(dir), /senior-reviewer\.md/));
});

test("with no helper setting at all, a policy whose judgment tier is the pinned model passes", () => {
  withPolicy(PINNED_POLICY, (root) => {
    const r = run(["--project-root", root]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /driver-model-check ok/);
    assert.match(r.stdout, /agent files/);
  });
});

test("the shipped default preset, opus-plus-flash-v38, passes with no setting", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-dmc-"));
  try {
    const r = run(["--project-root", root, "--policy", "opus-plus-flash-v38"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a leftover setting for another model changes nothing (the agent file wins) and is reported as no longer needed", () => {
  withPolicy(PINNED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5.*no longer needed/s);
  });
});

test("a policy whose judgment tier is another model stops the run, names both models, and gives no setting advice", () => {
  withPolicy(UNIFIED_POLICY, (root) => {
    const r = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" });
    assert.equal(r.code, 1, "a matching setting no longer rescues it: the agent file wins");
    assert.match(r.stderr, /claude-opus-4-8/);
    assert.match(r.stderr, /claude-opus-5/);
    assert.match(r.stderr, /agent files/);
    assert.doesNotMatch(r.stderr, /export CLAUDE_CODE_SUBAGENT_MODEL|settings\.json|relaunch/, "there is nothing to set");
  });
});

test("the shipped Opus 4.7 presets (opus-plus-flash, opus-only) stop in estimated mode", () => {
  for (const policy of ["opus-plus-flash", "opus-only"]) {
    const root = mkdtempSync(join(tmpdir(), "mmo-dmc-"));
    try {
      const r = run(["--project-root", root, "--policy", policy]);
      assert.equal(r.code, 1, `${policy}: ${r.stdout}`);
      assert.match(r.stderr, /claude-opus-4-7/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CLAUDE_CODE_SUBAGENT_MODEL_FORCE makes Claude Code ignore the agent files, so the forced setting is what must match", () => {
  withPolicy(PINNED_POLICY, (root) => {
    assert.equal(run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: PINNED }).code, 0);
    const wrong = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "true", CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
    assert.match(wrong.stderr, /claude-sonnet-5/);
    const unset = run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "on" });
    assert.equal(unset.code, 1, "forced with no model: the helpers would follow the chat");
    assert.match(unset.stderr, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
    // Claude Code reads the switch as on only for 1/true/yes/on (any case); anything else is off.
    assert.equal(run(["--project-root", root], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0", CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5" }).code, 0);
  });
});

// ─── Unchanged from v0.7.x: policies an estimated-mode run cannot honour at all ───

test("a policy that splits the judgment tier across models is an error, not a vote", () => {
  withPolicy(SPLIT_POLICY, (root) => {
    const r = run(["--project-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /splits the judgment tier/);
    // The per-phase table names the odd one out so the user can see the split.
    assert.match(r.stderr, /security_review → claude-opus-5/);
  });
});

test("a judgment tier no Claude Code subagent can execute is an error directing to vendor mode", () => {
  withPolicy(NON_ANTHROPIC_POLICY, (root) => {
    const r = run(["--project-root", root]);
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

test("the settings-file helpers of v0.7.3 are gone: nothing reads a setting the check no longer uses", async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);
  for (const name of ["projectSettingsDeclarations", "declaredInProjectSettings", "declarationNote", "PROJECT_SETTINGS_FILES"]) {
    assert.equal(mod[name], undefined, name);
  }
});
