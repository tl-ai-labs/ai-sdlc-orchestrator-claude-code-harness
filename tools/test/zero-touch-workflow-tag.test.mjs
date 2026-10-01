/**
 * How a workflow zero-touch starts learns the person's models (1 Oct 2026).
 *
 * Zero-touch starts a workflow the way a person typing its command would, with one tag at the front of the command's
 * arguments: `[zero-touch policy=<name> auth=<vendor|estimated>]`, then the person's own words for the job. The
 * commands read the tag as this run's choice, which wins over the project's saved choice and over a repo-local
 * routing-policy.yaml (the explicit-file rule /mmo:pass already follows). A tag and not flags on purpose: a person
 * typing a command gets exactly the surface they had (tools/test/command.test.mjs keeps flags out of the wizard).
 *
 * This test holds the two sides to one format: what zero-touch sends (route-flow.mjs startArgs) and what the command
 * texts say they read. It also checks that the typed path says what it said before.
 *
 * Offline: files of this repository only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const read = (...p) => readFileSync(join(PLUGIN, ...p), "utf8");
const R = await import(join(PLUGIN, "scripts", "ambient", "lib", "route-flow.mjs"));
const TEMPLATE = "[zero-touch policy=<name> auth=<vendor|estimated>]";
const ALIASES = ["bugfix", "deps", "docs", "feature-extend", "feature-new", "refactor", "test"];

test("what zero-touch sends is exactly the documented tag, then the person's words", () => {
  assert.equal(R.startArgs({ policy: "opus-plus-sonnet", auth: "estimated" }), "[zero-touch policy=opus-plus-sonnet auth=estimated]");
  assert.equal(R.startArgs({ policy: "opus-only-v5", auth: "vendor", args: "fix the login bug" }), "[zero-touch policy=opus-only-v5 auth=vendor] fix the login bug");
  assert.equal(R.startArgs({ policy: "../../etc/passwd", auth: "free" }), "[zero-touch policy=opus-plus-flash-v38 auth=estimated]", "anything odd becomes the standard pick and the standard recording");
  const shape = /^\[zero-touch policy=[A-Za-z0-9][A-Za-z0-9._-]* auth=(vendor|estimated)\]( .+)?$/;
  for (const args of ["", "x"]) assert.match(R.startArgs({ policy: "opus-plus-flash-v38", auth: "estimated", args }), shape);
  // The instruction Claude gets names the Skill call with that tag, and tells it not to ask about the two choices.
  const line = R.startInstruction({ job: "bugfix", args: "fix it", auth: "estimated", policy: "opus-plus-sonnet" });
  assert.match(line, /skill "mmo:bugfix", args "\[zero-touch policy=opus-plus-sonnet auth=estimated\] fix it"/);
  assert.match(line, /do not ask about either/);
});

test("the new-app command reads the tag: this run's policy wins over the saved choice and routing-policy.yaml, as an explicit file", () => {
  const g = read("commands", "greenfield.md");
  assert.ok(g.includes(TEMPLATE), "the tag, word for word");
  assert.match(g, /wins\s+over the project's saved choice and over a repo-local `routing-policy\.yaml`/);
  assert.match(g, /policy_path: \$\{CLAUDE_PLUGIN_ROOT\}\/config\/policies\/<name>\.yaml/);
  assert.match(g, /its `auth=` is the mode: say which, and do\s+not ask/);
  // The typed path says what it said before.
  assert.match(g, /This command takes no arguments\. Everything it needs it asks for\./);
  assert.match(g, /Otherwise, read the policy name written by\s+setup:/);
});

test("the existing-project guide and all seven job commands read the tag the same way", () => {
  const guide = read("skills", "brownfield-guide", "SKILL.md");
  assert.match(guide, /`policy: <name>` and `auth_mode: <vendor\|estimated>` present — a run zero-touch started/);
  assert.match(guide, /when the handover carries `policy: <name>` \(a run zero-touch started\), that is this\s+run's policy/);
  assert.match(guide, /when the handover carries `auth_mode`, show it and do not ask/);
  assert.match(guide, /`policy_path: \$\{CLAUDE_PLUGIN_ROOT\}\/config\/policies\/<name>\.yaml` — only when the handover carried/);
  for (const job of ALIASES) {
    const text = read("commands", `${job}.md`);
    assert.ok(text.includes(`\`${TEMPLATE}\``), `${job}.md names the tag`);
    assert.match(text, /`seed_description:` — the text of \$ARGUMENTS, verbatim, if non-empty, after a leading zero-touch tag\./, job);
    // The typed path's own rule stays under its own bullet (1 Oct 2026, found in review: it had slid under the tag's
    // bullet, where "empty" could be read as "no tag", so a typed description would be ignored).
    assert.match(text, /after a leading zero-touch tag\.\n  Empty means run the normal step-4b interview\.\n- `policy:` and `auth_mode:`/, `${job}: the interview rule belongs to seed_description`);
  }
  // The generic command is never started by zero-touch (typed only), so it has no tag.
  assert.ok(!read("commands", "brownfield.md").includes("[zero-touch"), "brownfield.md is typed only");
});

test("every job zero-touch starts is one of the commands that read the tag", async () => {
  const { WORKFLOW_COMMANDS } = await import(join(PLUGIN, "scripts", "ambient", "lib", "commands.mjs"));
  const routed = Object.keys(R.PLAIN);
  for (const job of routed) {
    assert.ok(WORKFLOW_COMMANDS.has(job), `${job} is a workflow command`);
    assert.ok(job === "greenfield" || ALIASES.includes(job), `${job} reads the tag`);
  }
});
