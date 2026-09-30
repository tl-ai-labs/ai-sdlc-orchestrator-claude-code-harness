/**
 * Pins for which model the five driver agents run on in estimated mode.
 *
 * History. Until 2 Sep 2026 (PR #34) every driver agent carried `model: opus`,
 * and nothing checked it against the policy: the judgment tier always ran
 * Opus while the report priced it as the policy's driver model (cost
 * misattribution). That fix removed the pins and moved the decision to the
 * user's CLAUDE_CODE_SUBAGENT_MODEL setting, verified at run start by
 * plugin/scripts/driver-model-check.mjs. This file was then
 * driver-agents-unpinned.test.mjs and asserted the pins stayed out.
 *
 * Now (v0.8.3, 25 Sep 2026, decided after a live desktop check):
 * the pin is back as ONE exact model id, `claude-opus-5`, in all five files,
 * and the run-start check compares THAT with the policy. The reasons:
 *  - The setting belongs to the user's whole machine (every helper agent in
 *    every chat), is read only when a chat starts, and had to be added by
 *    hand before any no-API-key run: an install step no plugin can do.
 *  - Since Claude Code 2.1.251 an agent file's `model:` wins over both that
 *    setting and the chat's model (read in the 2.1.281 source; live on
 *    25 Sep: chat on Sonnet 5, a pinned helper ran Opus 5, an unpinned one
 *    ran Sonnet 5), so the pin holds whatever model the person picks.
 * The 2 Sep defect stays closed because the pin is checked: a policy whose
 * judgment tier is another model stops the run instead of being priced wrong.
 * The script's behavior is tested in
 * plugin/mcp/model-dispatch/test/driverModelCheck.test.mjs (after the build).
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS = ["orchestrator", "architect", "discovery", "senior-reviewer", "security-reviewer"];

/** The YAML block between the first pair of --- fences. */
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "agent file has no frontmatter block");
  return m[1];
}

/** The one model every driver agent names: the judgment model of the default policy, opus-plus-flash-v38. */
const PINNED = "claude-opus-5";

for (const name of AGENTS) {
  test(`driver agent '${name}' names the exact model ${PINNED} in its frontmatter`, () => {
    const md = readFileSync(join(REPO, "plugin", "agents", `${name}.md`), "utf-8");
    const lines = frontmatter(md).split("\n").filter((l) => /^model:/.test(l));
    assert.equal(lines.length, 1, `${name}.md must have exactly one model: line`);
    // An exact id, never an alias: "opus" follows whichever Opus is newest, which is the 2 Sep
    // defect again (the policy prices one model, another runs).
    assert.equal(lines[0].replace(/^model:\s*/, "").replace(/["']/g, "").trim(), PINNED);
  });
}

test("the orchestrator's operating rules include the run-start driver-model check, and it no longer asks for the user setting", () => {
  const md = readFileSync(join(REPO, "plugin", "agents", "orchestrator.md"), "utf-8");
  // Rule 0 only: from "0. **" to rule 1, so words elsewhere in the file cannot satisfy it.
  const rule0 = md.split("# Operating rules")[1].split(/\n1\. \*\*Read the brief first/)[0];
  assert.match(rule0, /driver-model-check\.mjs/, "rule 0 must invoke the check script");
  // The failure handling is still the point: verify-and-STOP, never repair in-session.
  assert.match(rule0, /print the script's output verbatim and\s+STOP/i);
  assert.match(rule0, /agent files/i, "the rule must say the helpers' model is named in the agent files");
  assert.doesNotMatch(rule0, /decides their execution\s+model from the `CLAUDE_CODE_SUBAGENT_MODEL`/, "the old claim that the setting decides it");
  assert.doesNotMatch(rule0, /settings\.json|settings\.local\.json|relaunch/i, "no instruction to set the old user setting and relaunch");
});

test("no workflow instruction still tells anyone to set CLAUDE_CODE_SUBAGENT_MODEL", () => {
  for (const rel of ["commands/greenfield.md", "commands/pass.md", "skills/brownfield-guide/SKILL.md", "agents/orchestrator.md"]) {
    const md = readFileSync(join(REPO, "plugin", rel), "utf-8");
    assert.doesNotMatch(md, /requires `?CLAUDE_CODE_SUBAGENT_MODEL`?/i, `${rel} still says the setting is required`);
  }
});

/*
 * Structural pin for the operating-rules list.
 *
 * The driver-model paragraph was inserted over rule 1 rather than before it,
 * deleting "Read the brief first" and orphaning its "Confirm scope" sentence
 * onto the end of the vendor-skip paragraph, where it read as scoping the env
 * check. Nothing caught it: orchestrator.md is a model-executed prompt, and no
 * test looked at its rule structure, so the build stayed green over a missing
 * instruction. A contiguity check is cheap and catches the whole class.
 */
test("orchestrator operating rules are numbered contiguously from 0", () => {
  const md = readFileSync(join(REPO, "plugin", "agents", "orchestrator.md"), "utf8");
  const section = md.split("# Operating rules")[1];
  assert.ok(section, "orchestrator.md must have an '# Operating rules' section");
  // Stop at the next h1/h2 so the numbered lists in later sections are excluded.
  const body = section.split(/\n#{1,2} /)[0];
  const numbers = [...body.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.ok(numbers.length >= 8, `expected the full rule list, found ${numbers.length} rules`);
  numbers.forEach((n, i) => {
    assert.equal(n, i, `rule list must run 0,1,2,… without gaps — found ${n} at position ${i} (a rule was deleted or renumbered)`);
  });
});

test("the orchestrator is still told to read the brief before starting", () => {
  const md = readFileSync(join(REPO, "plugin", "agents", "orchestrator.md"), "utf8");
  assert.match(
    md,
    /^1\. \*\*Read the brief first\.\*\*/m,
    "rule 1 must exist as its own rule — it is the instruction to scope-confirm before any spend",
  );
});
