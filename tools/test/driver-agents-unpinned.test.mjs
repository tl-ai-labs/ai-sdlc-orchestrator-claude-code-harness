/**
 * Regression pins for the estimated-mode driver-model fix.
 *
 * The defect: all five driver agents carried `model: opus` in their
 * frontmatter, so under --auth=estimated the judgment tier always executed
 * Opus (frontmatter overrides the session model) no matter what driver model
 * the policy named — the policy only priced the work. The fix removes the
 * pins and moves the execution decision to CLAUDE_CODE_SUBAGENT_MODEL,
 * verified at run start by plugin/scripts/driver-model-check.mjs.
 *
 * These pins keep the fix from regressing editorially: a `model:` key
 * reappearing in any driver agent's frontmatter would silently reintroduce
 * the override, and the orchestrator losing its run-start rule would let
 * unset/mismatched env vars go unnoticed again. The script's behavior itself
 * is tested in plugin/mcp/model-dispatch/test/driverModelCheck.test.mjs,
 * which runs after the MCP build (the script imports the compiled routing).
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

for (const name of AGENTS) {
  test(`driver agent '${name}' carries no model: frontmatter pin`, () => {
    const md = readFileSync(join(REPO, "plugin", "agents", `${name}.md`), "utf-8");
    assert.doesNotMatch(
      frontmatter(md),
      /^model:/m,
      `a model: pin in ${name}.md overrides both the session model and ` +
        `CLAUDE_CODE_SUBAGENT_MODEL's policy-derived value — the estimated-mode ` +
        `cost-misattribution bug this suite pins closed`
    );
  });
}

test("the orchestrator's operating rules include the run-start driver-model check", () => {
  const md = readFileSync(join(REPO, "plugin", "agents", "orchestrator.md"), "utf-8");
  assert.match(md, /driver-model-check\.mjs/, "rule 0 must invoke the check script");
  assert.match(md, /CLAUDE_CODE_SUBAGENT_MODEL/, "the rule must name the env var it verifies");
  // The failure handling is the point: verify-and-STOP, never repair in-session
  // (a mid-session export cannot reach the CLI process's environment).
  assert.match(md, /print the script's output verbatim and\s+STOP/i);
});
