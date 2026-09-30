/**
 * Zero-touch hand-off mode: the scratch copy a hand-off is checked in, and the record that lets a landed hand-off be
 * undone.
 *
 * Tests written by the hand-off model, and a change repeated across files, are RUN before they reach the project: in
 * a scratch copy of the project, with the project's own command. The copy holds the project's files as they are now
 * (uncommitted work included), as real copies, so nothing a test run writes lands in the project; what git ignores
 * (installed dependencies, build output) is linked in, not copied, so the command can run. A project that is not a
 * git repository has no way to tell its own files from installed dependencies, so no copy is made and the hand-off
 * is refused.
 *
 * Every hand-off that changes the project is recorded with what each file held before, so one call undoes it; a file
 * changed since is left alone and reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeScratchCopy, runInScratch } from "../dist/handoff/scratch.js";
import { recordLanding, undoLanding, landings } from "../dist/handoff/landing.js";

function project({ git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-scratch-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  writeFileSync(join(repo, "package.json"), '{"name":"shop","type":"module"}\n');
  writeFileSync(join(repo, "src", "cart.js"), "export const total = (items) => items.reduce((n, i) => n + i.price, 0);\n");
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "export const dep = 1;\n");
  writeFileSync(join(repo, "debug.log"), "noise\n");
  if (git) {
    const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "first");
  }
  // Work since the last commit: a changed file and a new one. The copy must hold both.
  writeFileSync(join(repo, "src", "cart.js"), "export const total = (items) => items.reduce((n, i) => n + i.price, 0); // edited\n");
  writeFileSync(join(repo, "src", "new.js"), "export const fresh = true;\n");
  return { dir, repo, session: join(dir, "session"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the scratch copy holds the project as it is now, as real copies; what git ignores is linked in", () => {
  const p = project();
  let copy;
  try {
    copy = makeScratchCopy(p.repo);
    assert.ok(copy.dir, copy.refused);
    assert.match(readFileSync(join(copy.dir, "src", "cart.js"), "utf8"), /\/\/ edited/, "uncommitted work is in the copy");
    assert.ok(existsSync(join(copy.dir, "src", "new.js")), "a new, untracked file is in the copy");
    assert.ok(!lstatSync(join(copy.dir, "src", "cart.js")).isSymbolicLink(), "the project's own files are copies");
    assert.ok(lstatSync(join(copy.dir, "node_modules")).isSymbolicLink(), "installed dependencies are linked, not copied");
    assert.equal(readlinkSync(join(copy.dir, "node_modules")), join(p.repo, "node_modules"));
    assert.ok(!existsSync(join(copy.dir, ".git")), "the repository's own records are not part of the copy");
    // Writing in the copy never reaches the project.
    writeFileSync(join(copy.dir, "src", "cart.js"), "changed in the copy\n");
    writeFileSync(join(copy.dir, "src", "extra.test.js"), "x\n");
    assert.match(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), /\/\/ edited/);
    assert.ok(!existsSync(join(p.repo, "src", "extra.test.js")));
    const where = copy.dir;
    copy.remove();
    assert.ok(!existsSync(where), "the copy is removed afterwards");
    assert.ok(existsSync(join(p.repo, "node_modules", "dep", "index.js")), "removing the copy removes the link, never what it points at");
  } finally { p.cleanup(); }
});

test("a project that is not a git repository gets no copy, with the reason", () => {
  const p = project({ git: false });
  try {
    const copy = makeScratchCopy(p.repo);
    assert.equal(copy.dir, undefined);
    assert.match(copy.refused, /not a git repository/);
  } finally { p.cleanup(); }
});

test("a command runs in the copy: its exit code and output come back, and one that hangs is stopped", async () => {
  const p = project();
  const copy = makeScratchCopy(p.repo);
  try {
    const ok = await runInScratch(copy.dir, "node -e \"import('./src/cart.js').then(m => console.log('total', m.total([{price:2},{price:3}])))\"", { timeoutMs: 20000 });
    assert.equal(ok.code, 0);
    assert.match(ok.output, /total 5/);
    const bad = await runInScratch(copy.dir, "echo before; echo problem >&2; exit 3", { timeoutMs: 20000 });
    assert.equal(bad.code, 3);
    assert.match(bad.output, /before[\s\S]*problem/, "both streams, in order");
    const hung = await runInScratch(copy.dir, "sleep 30", { timeoutMs: 300 });
    assert.equal(hung.timedOut, true);
    assert.notEqual(hung.code, 0);
    const env = await runInScratch(copy.dir, "echo CI=$CI", { timeoutMs: 20000 });
    assert.match(env.output, /CI=1/, "runners are told not to wait for a person");
    const long = await runInScratch(copy.dir, "node -e \"for (let i = 0; i < 5000; i++) console.log('line ' + i)\"", { timeoutMs: 20000 });
    assert.match(long.output, /line 4999/, "the end of a long output is kept");
    assert.doesNotMatch(long.output, /line 0\n/, "its start is cut");
    assert.match(long.output, /^\[earlier output cut\]/);
  } finally { copy.remove(); p.cleanup(); }
});

test("a landed hand-off is recorded with what each file held before, and one call undoes it", () => {
  const p = project();
  try {
    const before = readFileSync(join(p.repo, "src", "cart.js"), "utf8");
    // A hand-off changed one file and created another.
    const id = recordLanding(p.session, p.repo, { tool: "repeat_edit_across_files", files: [{ path: "src/cart.js", content: "new cart\n" }, { path: "tests/cart.test.js", content: "a test\n" }] });
    assert.equal(id, "h1");
    assert.equal(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), "new cart\n", "recording a landing writes its files");
    assert.equal(readFileSync(join(p.repo, "tests", "cart.test.js"), "utf8"), "a test\n");
    assert.deepEqual(landings(p.session).map((l) => [l.id, l.tool, l.undone ?? false]), [["h1", "repeat_edit_across_files", false]]);

    const undone = undoLanding(p.session, p.repo, "h1");
    assert.deepEqual(undone.restored.sort(), ["src/cart.js", "tests/cart.test.js"]);
    assert.equal(readFileSync(join(p.repo, "src", "cart.js"), "utf8"), before, "a changed file gets its earlier text back");
    assert.ok(!existsSync(join(p.repo, "tests", "cart.test.js")), "a created file is removed");
    assert.match(undoLanding(p.session, p.repo, "h1").refused, /already undone/);
    assert.match(undoLanding(p.session, p.repo, "h9").refused, /no hand-off h9/);
  } finally { p.cleanup(); }
});

test("undo leaves a file alone when it was changed after the hand-off, and says so", () => {
  const p = project();
  try {
    const a = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/a.md", content: "A\n" }, { path: "docs/b.md", content: "B\n" }] });
    const b = recordLanding(p.session, p.repo, { tool: "write_document", files: [{ path: "docs/c.md", content: "C\n" }] });
    assert.deepEqual([a, b], ["h1", "h2"], "each landing of a chat gets the next number");
    writeFileSync(join(p.repo, "docs", "b.md"), "B, corrected by hand\n");
    const undone = undoLanding(p.session, p.repo, "h1");
    assert.deepEqual(undone.restored, ["docs/a.md"]);
    assert.deepEqual(undone.left_alone, ["docs/b.md"]);
    assert.equal(readFileSync(join(p.repo, "docs", "b.md"), "utf8"), "B, corrected by hand\n");
    assert.ok(existsSync(join(p.repo, "docs", "c.md")), "another hand-off's file is untouched");
  } finally { p.cleanup(); }
});
