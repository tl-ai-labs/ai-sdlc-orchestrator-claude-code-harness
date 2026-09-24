/**
 * /mmo:greenfield runs the executor flow (24 Sep).
 *
 * The goal is stated on /mmo:greenfield, the interactive command, but in 0.7.5 only
 * `/mmo:pass ... --executor` switched the executor on: /mmo:greenfield invoked the orchestrator
 * with no such setting, so an interactive run took the old flow (the orchestrator writing every
 * packet and receiving every file) and got none of the savings measured headless. These pins keep
 * the interactive command on the same flow as the measured runs; /mmo:pass keeps --executor as
 * its opt-in.
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(REPO, "plugin", ...p), "utf-8");

test("/mmo:greenfield hands the orchestrator executor mode", () => {
  const cmd = read("commands", "greenfield.md");
  const run = cmd.slice(cmd.indexOf("# 6. Run"), cmd.indexOf("# 7. Report"));
  assert.match(run, /`executor` — on/);
});

test("the pipeline skill and the orchestrator name both entry points of executor mode", () => {
  const skill = read("skills", "pipeline", "SKILL.md");
  assert.match(skill, /## Executor mode — greenfield: `\/mmo:greenfield`, and `\/mmo:pass \.\.\. --executor`/);
  const orch = read("agents", "orchestrator.md");
  assert.match(orch, /`\/mmo:greenfield` always runs it/);
});

test("/mmo:pass keeps --executor as its opt-in", () => {
  assert.match(read("commands", "pass.md"), /\[--executor\]/);
});
