/**
 * The architect pins CURRENT package versions, looked up, not remembered (24 Sep, receivables).
 *
 * The defect: in executor mode the architect writes every package version into the spec's
 * `stack`, and it had no shell, so the versions came from the model's memory. Both 0.7.5 arms
 * pinned releases a year or more old; a fresh install printed 13 deprecation notices (and 8
 * notices npm itself prints for packages whose install scripts are not approved), so the
 * brief's "installs without warnings" criterion failed, and the security review found high
 * advisories it could only accept. 0.7.3's typing helpers had a shell and looked every package
 * up (their transcripts show one registry query per package, run in a scratch folder), then
 * settled what a trial install printed — zero warnings.
 *
 * The fix gives the architect a shell for exactly that and one rule that names no language,
 * package manager or registry: the model already knows which tool belongs to the stack the brief
 * fixes. These pins keep the rule from being lost, and keep it language-free.
 *
 * Offline, reads repo files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const md = readFileSync(join(REPO, "plugin", "agents", "architect.md"), "utf-8");
const front = md.match(/^---\n([\s\S]*?)\n---/)[1];
// Line breaks in the markdown are not meaning: the section is read with runs of whitespace as one space.
const executor = md.slice(md.indexOf("# Executor mode"), md.indexOf("# Brownfield mode")).replace(/\s+/g, " ");

test("the architect has a shell, for registry lookups and a trial install", () => {
  const tools = front.match(/^tools:\s*(.*)$/m)[1].split(",").map((t) => t.trim());
  assert.ok(tools.includes("Bash"), `tools: ${tools.join(", ")}`);
});

test("executor mode tells the architect to pin the registry's current release, and what to do when it cannot", () => {
  assert.match(executor, /\*\*Versions\.\*\*/);
  assert.match(executor, /package registry/);
  assert.match(executor, /current release/);
  assert.match(executor, /scratch folder outside the code directory/);
  assert.match(executor, /\(not checked: /, "a version that could not be looked up is marked, never passed off as checked");
  assert.match(executor, /trial install/, "when the brief's criteria forbid install warnings, what the install prints is settled in the spec");
  assert.match(executor, /never write into the code directory/);
});

test("the rule names no language, framework, package manager or registry", () => {
  const named = executor.match(/\b(npm|npx|pip|pipx|yarn|pnpm|cargo|crates|gem|bundler|maven|mvn|gradle|go list|go get|poetry|uv|composer|nuget|dotnet|PyPI|NestJS|Prisma|Django|FastAPI|Express|React|Python|TypeScript|JavaScript|Node\.js|Rust|Golang|Java)\b/g);
  assert.equal(named, null, `executor mode names: ${named}`);
});
