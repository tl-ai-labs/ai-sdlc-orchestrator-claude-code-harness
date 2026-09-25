/**
 * Landing a small checked change as native Edits. The thinker sends an Edit
 * whose old_string is only a marker; the hook swaps in the checked find/replace
 * or refuses. Every doubt must REFUSE: this is a safety check, not a cost rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { takeSnapshot, readFromSnapshot } = await import(join(A, "lib", "snapshot.mjs"));
const { checkChange } = await import(join(A, "lib", "gates.mjs"));
const { stageJob, applyJob } = await import(join(A, "apply.mjs"));
const { parseMarker } = await import(join(A, "lib", "edit-fill.mjs"));

const SOURCE = "export function parse(s) {\n  return new Date(s);\n}\nexport function year(s) {\n  return parse(s).getFullYear();\n}\n";
const EDITS = [
  { path: "src/date.js", find: "return new Date(s);", replace: "return new Date(String(s).trim());" },
  { path: "src/date.js", find: "return parse(s).getFullYear();", replace: "return parse(s).getUTCFullYear();" },
];

function setup(edits = EDITS, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-edit-fill-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(home);
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "dev@example.com"); git("config", "user.name", "dev");
  writeFileSync(join(repo, "src", "date.js"), SOURCE);
  writeFileSync(join(repo, "src", "other.js"), "export const x = 1;\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  const snap = takeSnapshot(repo);
  const checked = checkChange({ edits, ...extra }, { declared: ["src/date.js", "src/other.js", "src/new.js"], snapshotFiles: readFromSnapshot(snap, ["src/date.js", "src/other.js"]) });
  assert.equal(checked.ok, true, JSON.stringify(checked.failures));
  const job = stageJob("job-7", { repoRoot: snap.repoRoot, files: checked.files, edits }, { MMO_HOME: home });
  return { dir, repo, home, job, file: join(repo, "src", "date.js"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function hook(event, payload, s) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], {
      cwd: s.repo, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PROJECT_DIR: s.repo, MMO_AMBIENT: "on", MMO_AMBIENT_ARM: "on" },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => done(out ? JSON.parse(out).hookSpecificOutput : null));
    p.stdin.end(JSON.stringify(payload));
  });
}

const edit = (s, n, file = s.file, id = "toolu_" + n) => ({ session_id: "s1", cwd: s.repo, tool_name: "Edit", tool_use_id: id, tool_input: { file_path: file, old_string: `mmo-apply:job-7:${n}`, new_string: "x" } });

/** What Claude Code does with the input the hook returned. */
function runNativeEdit(input) {
  const text = readFileSync(input.file_path, "utf8");
  assert.equal(text.split(input.old_string).length - 1, 1, "a native Edit needs exactly one match");
  writeFileSync(input.file_path, text.replace(input.old_string, () => input.new_string));
}

test("the marker is strict", () => {
  assert.deepEqual(parseMarker("mmo-apply:job-7:0"), { jobId: "job-7", n: 0 });
  for (const no of ["mmo-apply:job-7", "mmo-apply:../x:0", "mmo-apply:job-7:0 and more", "return new Date(s);", "", "mmo-apply:job-7:9999"]) {
    assert.equal(parseMarker(no), null, no);
  }
});

test("an ordinary Edit is never touched", async () => {
  const s = setup();
  try {
    const out = await hook("pre-edit", { session_id: "s1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: s.file, old_string: "return new Date(s);", new_string: "return 1;" } }, s);
    assert.equal(out, null);
  } finally { s.cleanup(); }
});

test("marker edits land in order as complete native Edit inputs, and the file ends equal to the checked result", async () => {
  const s = setup();
  try {
    const early = await hook("pre-edit", edit(s, 1), s);
    assert.equal(early.permissionDecision, "deny", "hunk 1 was checked against the text AFTER hunk 0");
    assert.match(early.permissionDecisionReason, /earlier edits/);

    const first = await hook("pre-edit", edit(s, 0), s);
    assert.deepEqual(Object.keys(first.updatedInput).sort(), ["file_path", "new_string", "old_string", "replace_all"], "updatedInput replaces the WHOLE input, so it must be a complete Edit");
    assert.equal(first.updatedInput.old_string, EDITS[0].find);
    assert.equal(first.updatedInput.replace_all, false);
    assert.equal(first.permissionDecision, undefined, "the person's own approval of the Edit is left to Claude Code");
    runNativeEdit(first.updatedInput);
    await hook("post-edit", edit(s, 0), s);

    assert.equal((await hook("pre-edit", edit(s, 0, s.file, "toolu_again"), s)).permissionDecision, "deny", "the same hunk twice");
    const second = await hook("pre-edit", edit(s, 1), s);
    runNativeEdit(second.updatedInput);
    await hook("post-edit", edit(s, 1), s);

    const log = readFileSync(join(s.home, "sessions", "s1", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const landed = log.filter((e) => e.type === "edit_fill.landed");
    assert.deepEqual(landed.map((e) => [e.n, e.file_complete, e.matches_checked_result]), [[0, false, undefined], [1, true, true]]);
    assert.ok(!JSON.stringify(log).includes("getUTCFullYear"), "code text must not reach the event log");
    assert.equal(applyJob("job-7", s.job.sha256, { MMO_HOME: s.home }).reason, "stale", "a job landed by edits cannot be applied a second time in bulk");
  } finally { s.cleanup(); }
});

test("refused: a stale file, a tampered job, the wrong file, a symlinked file, an unknown job or hunk", async () => {
  const cases = {
    stale: (s) => writeFileSync(s.file, SOURCE + "// edited meanwhile\n"),
    tampered: (s) => writeFileSync(join(s.job.dir, "change.json"), readFileSync(join(s.job.dir, "change.json"), "utf8").replace("trim()", "trim() || require('child_process')")),
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const s = setup();
    try {
      breakIt(s);
      const out = await hook("pre-edit", edit(s, 0), s);
      assert.equal(out.permissionDecision, "deny", name);
      assert.equal(out.updatedInput, undefined, `${name}: a refusal must never also rewrite the input`);
      assert.equal(readFileSync(s.file, "utf8").includes("trim"), false, name);
    } finally { s.cleanup(); }
  }
  const s = setup();
  try {
    assert.match((await hook("pre-edit", edit(s, 0, join(s.repo, "src", "other.js")), s)).permissionDecisionReason, /belongs to src\/date\.js/);
    symlinkSync(s.file, join(s.repo, "src", "alias.js"));
    assert.equal((await hook("pre-edit", edit(s, 0, join(s.repo, "src", "alias.js")), s)).permissionDecision, undefined, "a symlink that resolves to the right file is the right file");
    assert.equal((await hook("pre-edit", edit(s, 5), s)).permissionDecision, "deny");
    const unknown = edit(s, 0); unknown.tool_input.old_string = "mmo-apply:no-such-job:0";
    assert.equal((await hook("pre-edit", unknown, s)).permissionDecision, "deny");
  } finally { s.cleanup(); }
});

test("a change with new files, or with more hunks than the limit, must go through apply.mjs", async () => {
  const s = setup(EDITS, { creates: [{ path: "src/new.js", content: "export const n = 1;\n" }] });
  try {
    const out = await hook("pre-edit", edit(s, 0), s);
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /apply\.mjs/);
  } finally { s.cleanup(); }
});
