/**
 * The 13 commands and 2 skills are typed-only: the model may not start them on
 * its own from ordinary chat. Before this, a plain "refactor the date helpers"
 * could be answered by the model invoking /mmo:refactor, which opens an
 * interview and Gate 0 that nobody asked for. Typing the command still works;
 * the skills are reached by file path from the commands, not through the
 * Skill tool, so they lose nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
  assert.ok(m, `${file} must open with a frontmatter block`);
  return m[1];
}

test("every command is typed-only", () => {
  const dir = join(ROOT, "plugin", "commands");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 13, "a new command must be added to this count on purpose");
  for (const f of files) {
    assert.match(frontmatter(join(dir, f)), /^disable-model-invocation: true$/m, `${f} can be started by the model`);
  }
});

test("every skill is typed-only and still reachable by path from the commands", () => {
  const dir = join(ROOT, "plugin", "skills");
  for (const name of readdirSync(dir)) {
    assert.match(frontmatter(join(dir, name, "SKILL.md")), /^disable-model-invocation: true$/m, `skill ${name}`);
  }
  const refactor = readFileSync(join(ROOT, "plugin", "commands", "refactor.md"), "utf8");
  assert.match(refactor, /plugin\/skills\/brownfield-guide\/SKILL\.md/, "commands must keep reaching the guide by file path");
});

test("every agent description says it belongs to a typed command", () => {
  const dir = join(ROOT, "plugin", "agents");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    assert.match(frontmatter(join(dir, f)), /^description: .*Runs only inside a typed \/mmo: command/m, f);
  }
});
