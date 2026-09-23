/**
 * The write-contract hook compared the path as written. A symlink inside an
 * allowed directory that points at `.env`, or out of the repository, passed
 * every check while the write landed somewhere else. These tests pin the
 * repair: the place a write really lands is checked as well as its name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract-check.mjs");

function runHook(cwd, payload) {
  return new Promise((done) => {
    const p = spawn("node", [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => done({ code, stderr }));
    p.stdin.end(JSON.stringify(payload));
  });
}

function repo(contract) {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-symlink-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".env"), "KEY=value\n");
  if (contract) {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return dir;
}

const ACTIVE = { schema_version: 1, active: true, run_id: "r1", strict: true, allowlist: ["src/**"], off_limits: [".env", ".git/**"] };

test("with no contract, a symlink that lands on .env is refused like .env itself", async () => {
  const dir = repo(null);
  try {
    symlinkSync(join(dir, ".env"), join(dir, "src", "settings.txt"));
    const r = await runHook(dir, { tool_input: { file_path: "src/settings.txt" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /symlink|\.env/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("under a contract, an allowlisted name that lands on an off-limits file is refused", async () => {
  const dir = repo(ACTIVE);
  try {
    symlinkSync(join(dir, ".env"), join(dir, "src", "config.ts"));
    const r = await runHook(dir, { tool_input: { file_path: "src/config.ts" } });
    assert.equal(r.code, 2, "src/** allows the name, but the write lands on .env");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("under a contract, a symlinked directory that leaves the repository is refused", async () => {
  const dir = repo(ACTIVE);
  const outside = mkdtempSync(join(tmpdir(), "write-contract-outside-"));
  try {
    symlinkSync(outside, join(dir, "src", "vendor"));
    const r = await runHook(dir, { tool_input: { file_path: "src/vendor/new-file.ts" } });
    assert.equal(r.code, 2, "the new file would be created outside the contracted repository");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink that stays inside the allowlist is still allowed", async () => {
  const dir = repo(ACTIVE);
  try {
    mkdirSync(join(dir, "src", "real"));
    symlinkSync(join(dir, "src", "real"), join(dir, "src", "alias"));
    const r = await runHook(dir, { tool_input: { file_path: "src/alias/a.ts" } });
    assert.equal(r.code, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
