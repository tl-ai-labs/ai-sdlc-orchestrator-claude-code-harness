/**
 * The documents that describe zero-touch agree with the code, and with each other.
 *
 * Why this test exists: zero-touch was built in several steps (workflow routing first, hand-off mode after it), and
 * each step left sentences behind in a document the step did not reopen. Found on 30 Sep 2026 while writing hand-off
 * mode's documents: the repo guide still counted eight zero-touch hooks where the plugin registers twelve; the
 * zero-touch manual said hand-off mode "adds two" and that the server lists "the pipeline's and the executor's" tools
 * only; both plugin descriptions, the README and the setup guide knew of one mode; and the version notes described
 * four earlier builds that were never released, in tables about parts that no longer exist.
 *
 * So the numbers a document states are counted from the code here, and the names it uses are the code's:
 *   - the hook count, from plugin/hooks/hooks.json;
 *   - the hand-off tools, from the server's own list (its source file, so this test needs no build);
 *   - the settings, from the shipped settings file;
 *   - one zero-touch note in the version notes, under the plugin's own version.
 *
 * All offline: files of this repository are read, nothing is run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const MANUAL = read("docs", "ambient-mode.md");
const NOTES = read("docs", "methodology.md");
const GUIDE = read("docs", "repo-guide.md");

/** The moments zero-touch hooks: every hooks.json command that goes through its shim. */
function zeroTouchHooks() {
  const hooks = JSON.parse(read("plugin", "hooks", "hooks.json")).hooks;
  const names = [];
  for (const entries of Object.values(hooks)) {
    for (const e of entries) for (const h of e.hooks) {
      const m = /ambient\.sh" (\S+)$/.exec(h.command);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/** The hand-off tools, as the server's source names them (handoff/tools.ts, `name: "..."` inside HANDOFF_TOOLS). */
function handoffTools() {
  const src = read("plugin", "mcp", "model-dispatch", "src", "handoff", "tools.ts");
  const list = src.slice(src.indexOf("export const HANDOFF_TOOLS"));
  return [...list.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

/** The one zero-touch note: the version notes' section for the plugin's own version. */
function zeroTouchNote() {
  const version = JSON.parse(read("plugin", ".claude-plugin", "plugin.json")).version;
  const start = NOTES.indexOf(`### v${version}\n`);
  assert.ok(start >= 0, `docs/methodology.md has a "### v${version}" section`);
  const next = NOTES.indexOf("\n### v", start + 1);
  return NOTES.slice(start, next < 0 ? undefined : next);
}

test("every document that counts zero-touch's hooks states the number hooks.json registers", () => {
  const hooks = zeroTouchHooks();
  const word = WORDS[hooks.length];
  assert.ok(word, `a number word for ${hooks.length} hooks`);
  // The manual's heading and its table: one row per hook, no row for a hook that is not registered.
  assert.match(MANUAL, new RegExp(`^## The ${word} hooks$`, "m"), `the manual's heading counts ${hooks.length}`);
  const table = MANUAL.slice(MANUAL.indexOf(`## The ${word} hooks`), MANUAL.indexOf("## What is stored"));
  const rows = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.slice().sort(), hooks.slice().sort(), "the manual's hook table lists exactly the registered hooks");
  // Every other count in the documents: "zero-touch's <number> ... hooks", "<number> zero-touch hooks".
  for (const [name, text] of [["docs/repo-guide.md", GUIDE], ["docs/methodology.md", zeroTouchNote()], ["docs/ambient-mode.md", MANUAL], ["zero-touch/README.md", read("zero-touch", "README.md")]]) {
    for (const m of text.matchAll(/\b(?:zero-touch's (\w+)(?: \w+)? hooks|(\w+) zero-touch hooks)\b/gi)) {
      const stated = (m[1] ?? m[2]).toLowerCase();
      if (!WORDS.includes(stated) && !/^\d+$/.test(stated)) continue; // "its own zero-touch hooks": no number
      assert.ok(stated === word || stated === String(hooks.length), `${name} says "${m[0]}"; hooks.json registers ${hooks.length}`);
    }
  }
  assert.match(GUIDE, new RegExp(`zero-touch's ${word} hooks`), "the repo guide's hooks row counts zero-touch's hooks");
});

test("the hand-off tools the server lists are the ones the documents name, all of them", () => {
  const tools = handoffTools();
  assert.equal(tools.length, 4, `four hand-off tools in handoff/tools.ts (found ${tools.join(", ")})`);
  const note = zeroTouchNote();
  for (const tool of tools) {
    assert.ok(MANUAL.includes("`" + tool + "`"), `the manual names ${tool}`);
    assert.ok(note.includes("`" + tool + "`"), `the version note names ${tool}`);
  }
  // The architecture page counts the server's tools and lists them: the hand-off tools are four of them.
  const architecture = read("docs", "architecture.md");
  for (const tool of tools) assert.ok(architecture.includes("`" + tool + "`"), `docs/architecture.md names ${tool}`);
  assert.doesNotMatch(architecture, /exposes eight tools/, "the architecture page's tool count includes the hand-off tools");
  // No document may still say the server lists the pipeline's and the executor's tools only.
  for (const [name, text] of [["docs/ambient-mode.md", MANUAL], ["docs/methodology.md", note]]) {
    assert.doesNotMatch(text, /tool list is the pipeline's and the executor's again|The pipeline's and the executor's only/, name);
  }
});

test("the documents' settings table is the shipped settings file", () => {
  const shipped = JSON.parse(read("plugin", "config", "ambient.default.json"));
  const section = MANUAL.slice(MANUAL.indexOf("## Settings and who may change them"), MANUAL.indexOf("## Routing a recognised task"));
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.slice().sort(), Object.keys(shipped).filter((k) => k !== "schema_version").sort());
  assert.ok(section.includes("`" + shipped.handoff.chat_model + "`") && section.includes("`" + shipped.handoff.policy + "`"), "hand-off mode's two defaults are the shipped ones");
  assert.ok(section.includes("`" + shipped.routing_defaults.policy + "`") && section.includes("`" + shipped.routing_defaults.auth + "`"), "routing's two defaults are the shipped ones");
});

test("the version notes hold one zero-touch note, under the plugin's version, and it covers both modes", () => {
  const note = zeroTouchNote();
  // The builds before this one were never released. Their notes described parts that no longer exist (a savings
  // ledger, worker jobs, a board) in tables longer than everything else in the file; git keeps them.
  for (const old of ["v0.8.0", "v0.8.1", "v0.8.2", "v0.8.3"]) {
    assert.doesNotMatch(NOTES, new RegExp(`^### ${old.replace(/\./g, "\\.")}\\b`, "m"), `no separate ${old} section`);
  }
  assert.match(note, /workflow mode/i);
  assert.match(note, /hand-off mode/i);
  assert.match(note, /\]\(ambient-mode\.md\)/, "the note links the manual");
  // What a reader of cost numbers must find here: where a hand-off's bill is written, and that nothing is claimed.
  assert.match(note, /handoff-telemetry\.jsonl/);
  assert.match(note, /No dispatched event is priced differently/);
});

test("no document points a reader at a build that was never released", () => {
  const docs = {
    "README.md": read("README.md"), "SETUP.md": read("SETUP.md"), "docs/README.md": read("docs", "README.md"),
    "docs/setup.md": read("docs", "setup.md"), "docs/running.md": read("docs", "running.md"), "docs/repo-guide.md": GUIDE,
    "docs/ambient-mode.md": MANUAL, "docs/methodology.md": NOTES, "zero-touch/README.md": read("zero-touch", "README.md"),
  };
  for (const [name, text] of Object.entries(docs)) {
    // The archive's tag carries a version in its own name; it is a git name, not a pointer to a section.
    const hits = text.replace(/generic-orchestrator-0\.8\.3/g, "").match(/\bv?0\.8\.[0-3]\b/g) ?? [];
    assert.deepEqual(hits, [], `${name} names a version before the plugin's first zero-touch release`);
  }
});

test("every document that introduces zero-touch says it has two modes", () => {
  for (const name of ["README.md", "SETUP.md", "docs/README.md", "docs/repo-guide.md", "docs/architecture.md", "zero-touch/README.md"]) {
    const text = read(...name.split("/"));
    assert.match(text, /workflow mode/i, `${name} names workflow mode`);
    assert.match(text, /hand-off mode/i, `${name} names hand-off mode`);
  }
  // The repo guide is the map of the repository: the switch plugin's folder, the server's hand-off folder and the
  // shipped settings file are on it.
  for (const path of ["`zero-touch/`", "`plugin/mcp/model-dispatch/src/handoff/`", "`config/ambient.default.json`"]) {
    assert.ok(GUIDE.includes(path), `docs/repo-guide.md has a row for ${path}`);
  }
  // In the manual, "the hand-off" means hand-off mode's own act. The step that starts a recognised job's workflow
  // once had that name too; two meanings of one word in one page.
  assert.doesNotMatch(MANUAL, /^### The hand-off \(/m, "workflow mode's start step is not called the hand-off");
});
