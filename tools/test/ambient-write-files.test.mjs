/**
 * The batch write: the thinker's own files, many in one call, written and
 * tested by the plugin. On both sides of a pair; no worker. Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { writeFiles } = await import(join(A, "write-files.mjs"));

function world() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-write-files-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, "src", "old.js"), "old\n");
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on", delegation: "off" }));
  const env = { MMO_HOME: home, HOME: home, PATH: process.env.PATH };
  const stamp = { session_id: "s1", prompt_id: "p1", arm: "on", mode: "on" };
  const events = () => { const f = join(home, "sessions", "s1", "events.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  return { dir, repo, home, env, stamp, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("many files in one call: new ones created, an existing one overwritten, the tests run in the same call, and the record says so; it works with delegation off", () => {
  const w = world();
  try {
    const r = writeFiles({ files: [{ path: "src/a.js", content: "export const a = 1;\n" }, { path: "src/deep/b.js", content: "export const b = 2;\n" }, { path: "src/old.js", content: "new\n" }], testCommand: "node -e \"process.exit(0)\"", projectDir: w.repo, stamp: w.stamp, env: w.env });
    assert.equal(r.status, "written", JSON.stringify(r));
    assert.deepEqual(r.created, ["src/a.js", "src/deep/b.js"]);
    assert.deepEqual(r.overwritten, ["src/old.js"]);
    assert.equal(readFileSync(join(w.repo, "src", "deep", "b.js"), "utf8"), "export const b = 2;\n");
    assert.equal(readFileSync(join(w.repo, "src", "old.js"), "utf8"), "new\n");
    assert.deepEqual([r.tests.ran, r.tests.passed], [true, true]);
    const e = w.events().find((x) => x.type === "write_files.used");
    assert.deepEqual([e.files, e.created, e.overwritten, e.tests_passed], [3, 2, 1, true]);
    const bad = writeFiles({ files: [{ path: "src/c.js", content: "x" }], testCommand: "node -e \"console.log('2 failing'); process.exit(1)\"", projectDir: w.repo, stamp: w.stamp, env: w.env });
    assert.equal(bad.status, "written", "the files are written even when the tests then fail");
    assert.equal(bad.tests.passed, false);
    assert.match(bad.tests.tail, /2 failing/);
    assert.match(bad.next, /FAILED/);
    const none = writeFiles({ files: [{ path: "src/d.js", content: "x" }], projectDir: w.repo, stamp: w.stamp, env: w.env });
    assert.equal(none.tests.ran, false);
    assert.match(none.next, /run the tests yourself/);
  } finally { w.cleanup(); }
});

test("refused before anything is written: no files, a secret file, a path outside the project, a symlinked way in, too many files", () => {
  const w = world();
  try {
    assert.equal(writeFiles({ files: [], projectDir: w.repo, stamp: w.stamp, env: w.env }).status, "refused");
    assert.match(writeFiles({ files: [{ path: ".env", content: "K=1" }], projectDir: w.repo, stamp: w.stamp, env: w.env }).reason, /never written/);
    assert.equal(writeFiles({ files: [{ path: "../outside.js", content: "x" }], projectDir: w.repo, stamp: w.stamp, env: w.env }).status, "refused");
    assert.ok(!existsSync(join(w.dir, "outside.js")));
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", jobs: { max_files: 1 } }));
    assert.match(writeFiles({ files: [{ path: "src/x.js", content: "1" }, { path: "src/y.js", content: "2" }], projectDir: w.repo, stamp: w.stamp, env: w.env }).reason, /more than 1 files/);
    assert.ok(!existsSync(join(w.repo, "src", "x.js")), "a refused call writes nothing");
  } finally { w.cleanup(); }
});
