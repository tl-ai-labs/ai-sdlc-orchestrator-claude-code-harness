/**
 * The worker-side safety core: what a worker is shown (snapshot), what its
 * answer may change (gates), and how a checked change lands and is taken back
 * (apply). Every case uses a real throwaway git repository. No worker is
 * called: the "worker answer" is a plain object written by the test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { takeSnapshot, readFromSnapshot, readDenyGlobs, egressManifest } = await import(join(A, "lib", "snapshot.mjs"));
const { checkChange, syntaxCheck, workerMayWrite } = await import(join(A, "lib", "gates.mjs"));
const { scanSecrets } = await import(join(A, "lib", "secret-shapes.mjs"));
const { stageJob, applyJob, undoJob, keptStatus } = await import(join(A, "apply.mjs"));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-worker-core-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(home);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  writeFileSync(join(repo, "src", "date.js"), "export function parse(s) {\n  return new Date(s);\n}\n");
  writeFileSync(join(repo, "src", "date.test.js"), "import { parse } from './date.js';\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, ".env"), "TOKEN=x\n");
  symlinkSync("date.js", join(repo, "src", "link.js"));
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "init");
  return { dir, repo, home, env: { MMO_HOME: home }, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the snapshot captures uncommitted work without touching the tree, index or stash list", () => {
  const r = makeRepo();
  try {
    writeFileSync(join(r.repo, "src", "date.js"), "export function parse(s) {\n  return new Date(s + 'Z');\n}\n");
    const snap = takeSnapshot(r.repo);
    assert.equal(snap.source, "index");
    assert.match(readFromSnapshot(snap, ["src/date.js"])[0].content, /s \+ 'Z'/, "the brief shows what the developer has on disk");
    assert.equal(r.git("stash", "list").toString(), "", "no stash entry may be left behind");
    assert.match(r.git("status", "--porcelain").toString(), /^ M src\/date\.js/m, "the edit is still uncommitted and unstaged");
    assert.ok(!r.git("status", "--porcelain").toString().includes("A "), "nothing was staged in the real index");
    r.git("checkout", "--", "src/date.js");
    assert.equal(takeSnapshot(r.repo).source, "index");
  } finally { r.cleanup(); }
});

test("the snapshot refuses symlinks, secret files, deny rules, unsafe paths, missing files and secret shapes", () => {
  const r = makeRepo();
  try {
    const snap = takeSnapshot(r.repo);
    assert.throws(() => readFromSnapshot(snap, ["src/link.js"]), /not a regular file/);
    assert.throws(() => readFromSnapshot(snap, [".env"]), /secret-bearing/);
    assert.throws(() => readFromSnapshot(snap, ["../outside.js"]), /unsafe path/);
    assert.throws(() => readFromSnapshot(snap, ["/etc/hosts"]), /unsafe path/);
    assert.throws(() => readFromSnapshot(snap, ["src/gone.js"]), /not in the snapshot/);
    const globs = readDenyGlobs([{ permissions: { deny: ["Read(./src/**)", "Bash(rm *)"] } }]);
    assert.deepEqual(globs, ["src/**"]);
    assert.throws(() => readFromSnapshot(snap, ["src/date.js"], { denyGlobs: globs }), /deny rule/);

    // Built at run time so no token-shaped literal sits in this repository.
    const token = "gh" + "p_" + "A1b2C3d4E5f6".repeat(3);
    writeFileSync(join(r.repo, "src", "config.js"), `export const t = "${token}";\n`);
    r.git("add", "src/config.js");
    const withSecret = takeSnapshot(r.repo);
    assert.throws(() => readFromSnapshot(withSecret, ["src/config.js"]), /secret shape/);
    const manifest = egressManifest(snap, readFromSnapshot(snap, ["src/date.js"]), { worker: "flash", door: "completion", job: "j1" });
    assert.ok(!JSON.stringify(manifest).includes("new Date"), "the manifest records paths and hashes, never content");
  } finally { r.cleanup(); }
});

test("the wider secret scan finds common shapes and never returns the matched text", () => {
  const samples = {
    "github-token": "gh" + "o_" + "a".repeat(36),
    "slack-token": "xo" + "xb-" + "1234567890-abcdefghij",
    "stripe-key": "sk" + "_live_" + "a".repeat(24),
    "jwt": "ey" + "Jhbgciouyttrewq." + "ey" + "Jzdwiabcdefghij." + "sigsigsigsigsig",
    "url-with-password": "postgres://admin:" + "hunter2hunter2" + "@db.internal:5432/app",
    "assigned-secret": 'client_secret = "' + "z9y8x7w6v5u4t3s2" + '"',
  };
  for (const [name, text] of Object.entries(samples)) {
    const found = scanSecrets("line one\n" + text + "\n");
    assert.ok(found.length > 0, `${name} was not found`);
    assert.ok(found.every((f) => f.line === 2 || f.line === null));
    assert.ok(!JSON.stringify(found).includes(text.slice(8, 20)), `${name}: the finding echoes the secret`);
  }
  assert.deepEqual(scanSecrets("const sha = 'a3f5c2d19e8b7a6f4c3d2e1f0a9b8c7d6e5f4a3b';\nexport const id = 42;\n"), [], "a plain hash is not a secret");
});

test("gates: a change may only touch declared, ordinary files, and every find must match exactly once", () => {
  const r = makeRepo();
  try {
    const snap = takeSnapshot(r.repo);
    const declared = ["src/date.js", "src/util.js"];
    const snapshotFiles = readFromSnapshot(snap, ["src/date.js"]);
    const opts = { declared, snapshotFiles, protectedPaths: ["src/date.test.js"] };
    const good = checkChange({
      edits: [{ path: "src/date.js", find: "return new Date(s);", replace: "return new Date(s.trim());" }],
      creates: [{ path: "src/util.js", content: "export const trim = (s) => s.trim();\n" }],
    }, opts);
    assert.equal(good.ok, true, JSON.stringify(good.failures));
    assert.equal(good.files.length, 2);
    assert.equal(good.files[0].base_sha256, snapshotFiles[0].sha256);

    const gate = (change, o = opts) => checkChange(change, o).failures.map((f) => f.gate);
    const edit = (path, find = "return new Date(s);", replace = "x") => ({ edits: [{ path, find, replace }] });
    assert.deepEqual(gate(edit("src/other.js")), ["declared-files"]);
    assert.deepEqual(gate(edit("../x.js")), ["path"]);
    assert.deepEqual(gate(edit("src/date.js", "(s)")), ["find-once"], "an ambiguous find is refused, not guessed");
    assert.deepEqual(gate(edit("src/date.js", "no such text")), ["find-once"]);
    assert.deepEqual(gate(edit("src/date.js", "return new Date(s);", "return new Date(s;")), ["syntax"]);
    assert.deepEqual(gate({ creates: [{ path: "src/date.js", content: "x" }] }), ["create-exists"]);
    assert.deepEqual(gate({}), ["empty"]);
    for (const p of ["package-lock.json", ".github/workflows/ci.yml", "CLAUDE.md", ".claude/settings.json", "conftest.py", "jest.config.js", ".env"]) {
      assert.deepEqual(gate(edit(p), { ...opts, declared: [p] }), ["hard-deny"], p);
    }
    assert.deepEqual(gate(edit("src/date.test.js"), { ...opts, declared: ["src/date.test.js"] }), ["protected"], "the reproduce test stays as the thinker wrote it");
    assert.deepEqual(gate(edit("src/date.js"), { ...opts, neverDelegate: ["src/**"] }), ["never-delegate"]);
    assert.equal(syntaxCheck("a.py", "def x(:").checked, false, "no parser for this language: reported as unchecked, not as passed");
  } finally { r.cleanup(); }
});

test("a replacement containing $& or $1 lands literally", () => {
  const r = makeRepo();
  try {
    const snapshotFiles = readFromSnapshot(takeSnapshot(r.repo), ["src/date.js"]);
    const out = checkChange({ edits: [{ path: "src/date.js", find: "new Date(s)", replace: "fmt('$&', '$1')" }] }, { declared: ["src/date.js"], snapshotFiles });
    assert.match(out.files[0].new_content, /fmt\('\$&', '\$1'\)/);
  } finally { r.cleanup(); }
});

function staged(r, change, declared = ["src/date.js", "src/util.js"]) {
  const snap = takeSnapshot(r.repo);
  const checked = checkChange(change, { declared, snapshotFiles: readFromSnapshot(snap, ["src/date.js"]) });
  assert.equal(checked.ok, true, JSON.stringify(checked.failures));
  return stageJob("job-1", { repoRoot: snap.repoRoot, files: checked.files }, r.env);
}

const CHANGE = {
  edits: [{ path: "src/date.js", find: "return new Date(s);", replace: "return new Date(s.trim());" }],
  creates: [{ path: "src/util.js", content: "export const trim = (s) => s.trim();\n" }],
};

test("apply lands exactly the reviewed change, records what was kept, and undo restores every byte", () => {
  const r = makeRepo();
  try {
    const before = readFileSync(join(r.repo, "src", "date.js"), "utf8");
    const job = staged(r, CHANGE);
    assert.equal(applyJob("job-1", "0".repeat(64), r.env).reason, "hash-mismatch");
    const done = applyJob("job-1", job.sha256, r.env);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.match(readFileSync(join(r.repo, "src", "date.js"), "utf8"), /s\.trim\(\)/);
    assert.ok(existsSync(join(r.repo, "src", "util.js")));
    assert.deepEqual(keptStatus("job-1", r.env), { files: 2, kept: 2 });
    assert.equal(applyJob("job-1", job.sha256, r.env).reason, "already-applied");

    const undone = undoJob("job-1", r.env);
    assert.equal(undone.ok, true);
    assert.equal(readFileSync(join(r.repo, "src", "date.js"), "utf8"), before);
    assert.ok(!existsSync(join(r.repo, "src", "util.js")), "a file the job created is removed by undo");
  } finally { r.cleanup(); }
});

test("apply refuses a stale base and writes nothing at all", () => {
  const r = makeRepo();
  try {
    const job = staged(r, CHANGE);
    writeFileSync(join(r.repo, "src", "date.js"), "export function parse(s) {\n  return new Date(s); // edited meanwhile\n}\n");
    const res = applyJob("job-1", job.sha256, r.env);
    assert.equal(res.reason, "stale");
    assert.ok(!existsSync(join(r.repo, "src", "util.js")), "one stale file stops the whole job, including files that were fine");
  } finally { r.cleanup(); }
});

test("apply refuses a path that became a symlink, and a tampered change file", () => {
  const r = makeRepo();
  try {
    const outside = join(r.dir, "outside");
    mkdirSync(outside);
    const job = staged(r, { creates: [{ path: "src/gen/out.js", content: "export const a = 1;\n" }] }, ["src/gen/out.js"]);
    symlinkSync(outside, join(r.repo, "src", "gen"));
    assert.equal(applyJob("job-1", job.sha256, r.env).reason, "unsafe-target");
    assert.ok(!existsSync(join(outside, "out.js")), "nothing may be written through the symlink");

    const file = join(job.dir, "change.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("src/gen/out.js", ".github/workflows/x.yml"));
    assert.equal(applyJob("job-1", job.sha256, r.env).reason, "hash-mismatch", "editing the staged change voids the reviewed hash");
  } finally { r.cleanup(); }
});

test("undo leaves a file alone when it was edited after the job, and says so", () => {
  const r = makeRepo();
  try {
    const job = staged(r, CHANGE);
    applyJob("job-1", job.sha256, r.env);
    writeFileSync(join(r.repo, "src", "util.js"), "export const trim = (s) => s.trim(); // the developer's own follow-up\n");
    const res = undoJob("job-1", r.env);
    assert.equal(res.ok, false);
    assert.deepEqual(res.left, [{ path: "src/util.js", why: "edited-since" }]);
    assert.deepEqual(res.restored, ["src/date.js"]);
    assert.match(readFileSync(join(r.repo, "src", "util.js"), "utf8"), /own follow-up/);
    assert.deepEqual(keptStatus("job-1", r.env), { files: 2, kept: 0 });
  } finally { r.cleanup(); }
});

test("the apply command line reports JSON and a non-zero exit on refusal", () => {
  const r = makeRepo();
  try {
    const job = staged(r, CHANGE);
    const cli = (...args) => {
      try { return { code: 0, out: execFileSync("node", [join(A, "apply.mjs"), ...args], { env: { ...process.env, ...r.env }, stdio: "pipe" }).toString() }; }
      catch (e) { return { code: e.status, out: e.stdout.toString() }; }
    };
    assert.equal(cli("job-1", "f".repeat(64)).code, 1);
    const ok = cli("job-1", job.sha256);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.out).ok, true);
    assert.equal(JSON.parse(cli("--undo", "job-1").out).ok, true);
    assert.equal(JSON.parse(cli("nonsense").out).reason, "usage");
  } finally { r.cleanup(); }
});

test("the JavaScript syntax check is right for both module styles, whatever the extension says", () => {
  const esmBad = "export function parse(s) {\n  return new Date(s;\n}\n";
  assert.equal(syntaxCheck("a.js", esmBad).ok, false, "`node --check a.js` alone exits 0 on this; the check must not");
  assert.equal(syntaxCheck("a.js", "export const a = 1;\n").ok, true);
  assert.equal(syntaxCheck("a.js", "const fs = require('fs');\nmodule.exports = fs;\n").ok, true);
  assert.equal(syntaxCheck("a.js", "const x = await load();\nexport default x;\n").ok, true, "top-level await is valid in a module");
  assert.equal(syntaxCheck("a.js", "function a( {\n").ok, false);
  assert.equal(syntaxCheck("a.cjs", "export const a = 1;\n").ok, false, "a .cjs file is judged as CommonJS only");
  assert.equal(syntaxCheck("a.json", "{ \"a\": 1, }").ok, false);
});

test("files the model just created are in the snapshot; ignored files are not; a repository with no commit yet still works", () => {
  // Seen live on 22 Sep in a greenfield build: every file was untracked, so every job was refused with
  // "not in the snapshot" until the model ran git add itself, 16 refusals at a full request each.
  const r = makeRepo();
  try {
    mkdirSync(join(r.repo, "src", "routes"), { recursive: true });
    writeFileSync(join(r.repo, "src", "routes", "items.js"), "export const items = 1;\n");
    mkdirSync(join(r.repo, "node_modules", "x"), { recursive: true });
    writeFileSync(join(r.repo, "node_modules", "x", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(r.repo, ".gitignore"), "node_modules/\n");
    const snap = takeSnapshot(r.repo);
    assert.match(readFromSnapshot(snap, ["src/routes/items.js"])[0].content, /items = 1/, "an untracked file the model wrote is what the worker must see");
    assert.throws(() => readFromSnapshot(snap, ["node_modules/x/index.js"]), /not in the snapshot/, "ignored files never go anywhere");
    assert.equal(r.git("status", "--porcelain").toString().includes("A  src/routes"), false, "the real index is untouched");
    assert.equal(r.git("stash", "list").toString(), "");
  } finally { r.cleanup(); }
  const fresh = mkdtempSync(join(tmpdir(), "mmo-fresh-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fresh });
    writeFileSync(join(fresh, "a.js"), "export const a = 1;\n");
    const snap = takeSnapshot(fresh);
    assert.match(readFromSnapshot(snap, ["a.js"])[0].content, /a = 1/, "a folder that was just git-inited has no commit, and the job must still work");
  } finally { rmSync(fresh, { recursive: true, force: true }); }
});

test("with salvage, a change to a read-only file is dropped with its reason, an unchanged repeat of it is ignored, a never-delegate path is dropped too, and the declared files go on", () => {
  const snapshotFiles = [{ path: "src/date.js", content: "const d = new Date(s);\n", sha256: "a" }, { path: "src/date.test.js", content: "import './date.js';\n", sha256: "b" }];
  const opts = { declared: ["src/date.js"], snapshotFiles, protectedPaths: ["src/date.test.js"], neverDelegate: ["docs/**"], salvage: true };
  const r = checkChange({
    edits: [{ path: "src/date.js", find: "new Date(s)", replace: "new Date(s + 'Z')" }, { path: "src/date.test.js", find: "import './date.js';", replace: "// gone" }, { path: "docs/x.md", find: "a", replace: "b" }],
    creates: [{ path: "src/date.test.js", content: "import './date.js';\n" }],
  }, opts);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.deepEqual(r.files.map((f) => f.path), ["src/date.js"], "only the declared file is staged");
  assert.deepEqual(r.drops, [{ path: "src/date.test.js", why: "protected" }, { path: "docs/x.md", why: "never_delegate" }], "each drop carries its reason; the unchanged repeat is not a drop");
  assert.deepEqual(r.dropped, ["src/date.test.js", "docs/x.md"]);
  const only = checkChange({ edits: [{ path: "src/date.test.js", find: "import './date.js';", replace: "// gone" }] }, opts);
  assert.equal(only.ok, false, "an answer that changes nothing it may change still fails");
  assert.equal(only.failures[0].gate, "protected");
  assert.match(only.failures[0].detail, /may not change/);
  const strict = checkChange({ edits: [{ path: "src/date.test.js", find: "import './date.js';", replace: "// gone" }] }, { ...opts, salvage: false });
  assert.deepEqual(strict.failures.map((f) => f.gate), ["protected", "empty"].filter((g) => strict.failures.some((f) => f.gate === g)), "without salvage the old strictness holds");
});

/**
 * 23 Sep, pair 9: a fourteen-file job came back with ONE file. The checks only
 * ever forbade files OUTSIDE the declared list; absence was never a failure. The
 * scratch copy is rebuilt from the snapshot on every attempt, so that one file
 * was then tested in a project missing the other thirteen and could not pass.
 * A job that commissioned a file per spec is finished only when all of them are
 * there; an edit job commissions nothing, so a file needing no edit may be absent.
 */
test("gates: a commissioned job is finished only when every file it commissioned is there", () => {
  const r = makeRepo();
  try {
    const snap = takeSnapshot(r.repo);
    const opts = { declared: ["src/a.js", "src/b.js", "src/c.js"], snapshotFiles: readFromSnapshot(snap, []), salvage: true, commissioned: true };
    const one = { creates: [{ path: "src/a.js", content: "export const a = 1;\n" }] };
    const short = checkChange(one, opts);
    assert.equal(short.ok, false, "one file out of three is not a finished answer");
    assert.deepEqual(short.failures.map((f) => f.gate), ["missing-files"]);
    assert.match(short.failures[0].detail, /src\/b\.js/, "the failure names what is missing, so the resend asks for exactly those");
    assert.match(short.failures[0].detail, /src\/c\.js/);
    const all = { creates: ["a", "b", "c"].map((n) => ({ path: `src/${n}.js`, content: `export const ${n} = 1;\n` })) };
    const whole = checkChange(all, opts);
    assert.equal(whole.ok, true, JSON.stringify(whole.failures));
    assert.equal(checkChange(one, { ...opts, commissioned: false }).ok, true, "only a commissioned job requires every declared file");
  } finally { r.cleanup(); }
});

test("one definition of what a worker may write, shared by the door and the completeness rule", () => {
  const r = makeRepo();
  try {
    assert.equal(typeof workerMayWrite, "function");
    assert.equal(workerMayWrite("src/a.js"), true);
    assert.equal(workerMayWrite("jest.config.js"), false, "a test-runner config is hard-denied");
    assert.equal(workerMayWrite(".env.example"), false, "an env file of any suffix is hard-denied");
    assert.equal(workerMayWrite("package-lock.json"), false);
    assert.equal(workerMayWrite("docs/x.md", ["docs/**"]), false, "a never-delegate path is not writable either");
    // A commissioned job never demands a file the worker may not write.
    const snap = takeSnapshot(r.repo);
    const opts = { declared: ["src/a.js", "docs/x.md"], snapshotFiles: readFromSnapshot(snap, []), salvage: true, commissioned: true, neverDelegate: ["docs/**"] };
    const one = { creates: [{ path: "src/a.js", content: "export const a = 1;\n" }] };
    const ok = checkChange(one, opts);
    assert.equal(ok.ok, true, JSON.stringify(ok.failures));
  } finally { r.cleanup(); }
});
