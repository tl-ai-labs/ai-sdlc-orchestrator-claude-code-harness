/**
 * The PreToolUse hook that keeps the pipeline's own helpers in the foreground
 * (plugin/scripts/foreground-helpers.mjs), and its registration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, PIPELINE_AGENTS } from "../../plugin/scripts/foreground-helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "plugin", "scripts", "foreground-helpers.mjs");
const launch = (subagent_type, run_in_background, tool_name = "Agent") => ({ tool_name, tool_input: { description: "d", prompt: "p", subagent_type, run_in_background } });

test("a background launch of one of the pipeline's helpers is refused with the way to launch it again", () => {
  for (const t of ["mmo:architect", "architect", "mmo:senior-reviewer", "security-reviewer", "mmo:orchestrator", "mmo:discovery"]) {
    const out = decide(launch(t, true));
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", t);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /run_in_background set to false/);
  }
  assert.equal(decide(launch("mmo:architect", true, "Task"))?.hookSpecificOutput?.permissionDecision, "deny", "the older Task tool name too");
});

test("every other launch is allowed untouched: foreground launches, other agents, other tools", () => {
  assert.equal(decide(launch("mmo:architect", false)), null);
  assert.equal(decide(launch("mmo:architect", undefined)), null);
  for (const t of ["general-purpose", "Explore", "other-plugin:architect", "my-architect"]) assert.equal(decide(launch(t, true)), null, t);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "ls", run_in_background: true } }), null);
  assert.equal(decide(null), null);
});

test("the list of pipeline helpers matches the plugin's agent files", () => {
  const names = readdirSync(join(ROOT, "plugin", "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual([...PIPELINE_AGENTS].sort(), names);
});

test("the script speaks the hook protocol: deny JSON on stdout for a refused launch, nothing otherwise; registered for Agent|Task", () => {
  const deny = spawnSync("node", [SCRIPT], { input: JSON.stringify(launch("mmo:architect", true)), encoding: "utf8" });
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allow = spawnSync("node", [SCRIPT], { input: JSON.stringify(launch("general-purpose", true)), encoding: "utf8" });
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout, "");
  const garbage = spawnSync("node", [SCRIPT], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 0, "a payload it cannot read is allowed, never an error");
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"));
  const entry = hooks.hooks.PreToolUse.find((h) => h.matcher === "Agent|Task");
  assert.ok(entry, "registered in hooks.json");
  assert.match(entry.hooks[0].command, /scripts\/foreground-helpers\.mjs/);
});


test("the hook answers when the plugin sits under a path with a space or behind a symlink", async () => {
  const { mkdtempSync, copyFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "scripts", "foreground-helpers.mjs");
  const base = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(base, "with space"));
  copyFileSync(src, join(base, "with space", "foreground-helpers.mjs"));
  symlinkSync(join(base, "with space"), join(base, "link"));
  const payload = JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "mmo:architect", run_in_background: true } });
  for (const p of [join(base, "with space", "foreground-helpers.mjs"), join(base, "link", "foreground-helpers.mjs")]) {
    const r = spawnSync(process.execPath, [p], { input: payload, encoding: "utf8" });
    assert.match(r.stdout, /"permissionDecision":"deny"/, p);
  }
});
