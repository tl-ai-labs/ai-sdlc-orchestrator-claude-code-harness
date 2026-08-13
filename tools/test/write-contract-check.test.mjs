/**
 * Unit tests for plugin/scripts/write-contract-check.mjs — the PreToolUse
 * hook that refuses off-limits or not-in-manifest writes during brownfield
 * runs (ticket §7.1, §10.1).
 *
 * Testing shape: subprocess-based, piping the Claude Code hook input shape
 * on stdin and asserting the exit code + stderr. Exit 0 = allow, 1 = deny.
 * Fail-open: bad or missing contract → allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "write-contract-check.mjs");

/**
 * Run the hook with the given tool call payload from the given cwd.
 * Returns { code, stderr }.
 */
function runHook(cwd, payload) {
  return new Promise((resolvePromise) => {
    const p = spawn("node", [HOOK], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("close", (code) => resolvePromise({ code, stderr }));
    p.stdin.end(JSON.stringify(payload));
  });
}

function makeRepo(contract) {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  if (contract !== undefined) {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("allows any write when no contract file exists (greenfield case)", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/anything.ts" } });
    assert.equal(r.code, 0, "must allow when no contract present");
  } finally { cleanup(dir); }
});

test("allows any write when contract.active is false", async () => {
  const dir = makeRepo({ schema_version: 1, active: false, allowlist: [], off_limits: [] });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/anything.ts" } });
    assert.equal(r.code, 0, "inactive contract must allow");
  } finally { cleanup(dir); }
});

test("allows a path that matches the allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: ["src/**"], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/lib/foo.ts" } });
    assert.equal(r.code, 0, `expected allow; stderr=${r.stderr}`);
  } finally { cleanup(dir); }
});

test("denies a path that hits off_limits — even if it also matches allowlist", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-1",
    allowlist: ["**/*"], off_limits: [".env", ".env.*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env.production" } });
    assert.equal(r.code, 1, "off_limits must deny even when allowlist would match");
    assert.match(r.stderr, /off-limits/, "reason must name the rule class");
  } finally { cleanup(dir); }
});

test("denies a path that is not in the allowlist (allowlist-default-deny)", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "test-2",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: "docs/README.md" } });
    assert.equal(r.code, 1, "not-in-allowlist must deny in strict mode");
    assert.match(r.stderr, /not in the confirmed allowlist/i);
  } finally { cleanup(dir); }
});

test("strict=false downgrades an off_limits hit to WARN + allow", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: false,
    allowlist: [], off_limits: [".env*"],
  });
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env" } });
    assert.equal(r.code, 0, "strict=false must allow even off-limits");
    assert.match(r.stderr, /WARN/, "must warn instead of denying");
  } finally { cleanup(dir); }
});

test("fails open when the contract file is not valid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-contract-test-"));
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), "this is not json {[}");
    const r = await runHook(dir, { tool_input: { file_path: "anything" } });
    assert.equal(r.code, 0, "corrupt contract must fail open, not block");
  } finally { cleanup(dir); }
});

test("fails open when the tool call has no file_path", async () => {
  const dir = makeRepo({
    schema_version: 1, active: true, strict: true,
    allowlist: [], off_limits: ["**/*"],
  });
  try {
    const r = await runHook(dir, { tool_input: {} });
    assert.equal(r.code, 0, "no file_path in payload → allow");
  } finally { cleanup(dir); }
});
