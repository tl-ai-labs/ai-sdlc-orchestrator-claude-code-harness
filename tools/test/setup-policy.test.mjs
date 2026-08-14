/**
 * Unit tests for plugin/scripts/setup-policy.mjs — the shepherd helper that
 * writes per-project default_policy and reads it back for the commands.
 *
 * Interactive-flow paths (dev-server spawn, browser open, stdin prompt) are
 * not tested here — they need a live Next.js dev server. Scripted and
 * --print-only paths are the ones the commands depend on at runtime, and
 * both must work with and without git.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "setup-policy.mjs");

function run(cwd, args) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function newTmpDir() {
  return mkdtempSync(join(tmpdir(), "setup-policy-test-"));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("--print-only in a folder without .sdlc/ prints an empty line and exits 0", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "", "no default_policy → empty stdout");
  } finally { cleanup(dir); }
});

test("--print-only tolerates a folder without git — does not fail", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0, "must never fail --print-only, even without git");
  } finally { cleanup(dir); }
});

test("--policy=<name> writes to .sdlc/project.json in a non-git folder (with a git-fallback note)", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--policy=opus-only"]);
    assert.equal(r.code, 0);
    const path = join(dir, ".sdlc", "project.json");
    assert.ok(existsSync(path), "must create .sdlc/project.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.default_policy, "opus-only");
    assert.match(r.stderr, /not inside a git repository/i, "must surface the git-fallback note");
  } finally { cleanup(dir); }
});

test("--print-only reads back what --policy just wrote", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=opus-plus-flash"]);
    const r = run(dir, ["--print-only"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "opus-plus-flash", "round-trip must preserve the name");
  } finally { cleanup(dir); }
});

test("--policy rejects an unknown policy name (fail-loud)", () => {
  const dir = newTmpDir();
  try {
    const r = run(dir, ["--policy=nonexistent-policy-xyz"]);
    assert.notEqual(r.code, 0, "unknown policy must fail");
    assert.match(r.stderr, /not found/i, "must name the failure");
  } finally { cleanup(dir); }
});

test("--policy is idempotent — running twice with the same name is safe", () => {
  const dir = newTmpDir();
  try {
    run(dir, ["--policy=opus-only"]);
    const r = run(dir, ["--policy=opus-only"]);
    assert.equal(r.code, 0, "second run must succeed");
    const parsed = JSON.parse(readFileSync(join(dir, ".sdlc", "project.json"), "utf8"));
    assert.equal(parsed.default_policy, "opus-only");
  } finally { cleanup(dir); }
});

test("--policy preserves other fields in an existing project.json", () => {
  const dir = newTmpDir();
  try {
    // Simulate an existing project.json written earlier by discovery.
    const sdlcDir = join(dir, ".sdlc");
    mkdirSync(sdlcDir, { recursive: true });
    writeFileSync(
      join(sdlcDir, "project.json"),
      JSON.stringify({ schema_version: 1, stacks: ["nest"], test_command: "npm test" }),
    );
    run(dir, ["--policy=opus-only"]);
    const parsed = JSON.parse(readFileSync(join(sdlcDir, "project.json"), "utf8"));
    assert.deepEqual(parsed.stacks, ["nest"], "must preserve pre-existing stacks");
    assert.equal(parsed.test_command, "npm test", "must preserve pre-existing test_command");
    assert.equal(parsed.default_policy, "opus-only", "must add the new field");
  } finally { cleanup(dir); }
});
