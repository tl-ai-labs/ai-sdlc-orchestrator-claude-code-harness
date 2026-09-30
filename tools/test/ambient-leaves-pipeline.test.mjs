/**
 * Zero-touch (ambient mode) is added on top of 0.7.7 without changing anything
 * 0.7.7 does (25 Sep 2026: "none of 0.7.6 or 0.7.7 behaviour of plugins
 * should change after zero-touch additions"). The zero-touch branch (ed8e701)
 * had made every command and skill typed-only (`disable-model-invocation`) and
 * added "Runs only inside a typed /mmo: command" to every agent's description.
 * That static text changed 0.7.7 for everyone, zero-touch on or off, and the
 * router this branch builds starts a recognised task's /mmo: command through
 * the model. So the commands, skills and agents read as 0.7.7 has them; with
 * zero-touch on, its hooks decide which /mmo: command the model may start.
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

test("commands and skills carry no zero-touch switch: the model can start them exactly as on 0.7.7", () => {
  const dir = join(ROOT, "plugin", "commands");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 13, "a new command must be added to this count on purpose");
  for (const f of files) assert.doesNotMatch(frontmatter(join(dir, f)), /disable-model-invocation/, f);
  const skills = join(ROOT, "plugin", "skills");
  for (const name of readdirSync(skills)) assert.doesNotMatch(frontmatter(join(skills, name, "SKILL.md")), /disable-model-invocation/, `skill ${name}`);
  const refactor = readFileSync(join(dir, "refactor.md"), "utf8");
  // By the installed plugin's own path since 0.8.4 (tools/test/plugin-paths.test.mjs): a repository path exists only in a clone.
  assert.match(refactor, /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/brownfield-guide\/SKILL\.md/, "commands keep reaching the guide by file path");
});

test("agent descriptions carry no zero-touch sentence", () => {
  const dir = join(ROOT, "plugin", "agents");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    assert.doesNotMatch(frontmatter(join(dir, f)), /Runs only inside a typed|never start it from ordinary chat/, f);
  }
});
