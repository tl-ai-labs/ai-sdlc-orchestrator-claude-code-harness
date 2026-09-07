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

// ── SiteNotes regression: cross-repo writes and pre-contract safety net ────

test("cross-repo write: denies an absolute path that resolves outside cwd's contract (SiteNotes bug)", async () => {
  // Reproduces the SiteNotes bug: session's cwd is repoA (with an active
  // contract), but the model issues an Edit whose file_path is an absolute
  // path in a completely different tree (repoB — here, the plugin's own
  // worktree). Old code found repoA's contract, computed the target
  // relative to repoA's root as "../../repoB/…", and either allowed (no
  // matching off_limits) or denied with "not in allowlist" — treating a
  // category error as merely out-of-scope. New code detects the escape
  // upfront and denies with a category-error message.
  const repoA = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "repo-a-run",
    allowlist: ["src/**"], off_limits: [],
  });
  const repoB = mkdtempSync(join(tmpdir(), "write-contract-repo-b-"));
  try {
    const absTargetInB = join(repoB, "plugin", "scripts", "verify-setup.mjs");
    mkdirSync(join(repoB, "plugin", "scripts"), { recursive: true });
    // cwd=repoA, target=absolute path in repoB. Upfront cwd-anchored escape
    // check fires: target is outside repoA's contracted tree → deny.
    const r = await runHook(repoA, { tool_input: { file_path: absTargetInB } });
    assert.equal(r.code, 1, `escape must deny; stderr=${r.stderr}`);
    assert.match(r.stderr, /OUTSIDE the calling session's contracted repo|Cross-project writes/,
      "must be labeled as a category error, not just out-of-scope");
  } finally { cleanup(repoA); cleanup(repoB); }
});

test("cross-repo write with contract on BOTH sides: escape from A's contract is denied", async () => {
  // Sharper case: both trees carry contracts. Session cwd = repoA. Target
  // resolves to an absolute path in repoB. Since target-anchored resolution
  // finds repoB's contract first, the write is checked against repoB's
  // contract (which may or may not allow it) — but critically, if the
  // caller manages to force cwd=repoA lookup via a relative path that
  // escapes A, the escape check fires.
  const repoA = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "repo-a",
    allowlist: ["src/**"], off_limits: [],
  });
  try {
    // Relative path that escapes repoA when resolved against repoA.
    const escapingRelative = "../../../../etc/passwd";
    const r = await runHook(repoA, { tool_input: { file_path: escapingRelative } });
    assert.equal(r.code, 1, `escape must deny; stderr=${r.stderr}`);
    assert.match(r.stderr, /OUTSIDE the contract's repo root|Cross-project writes/,
      "escape must be labeled as a category error, not just out-of-scope");
  } finally { cleanup(repoA); }
});

test("pre-contract safety net: denies .env write even when no contract exists", async () => {
  const dir = makeRepo(undefined); // no contract
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".env" } });
    assert.equal(r.code, 1, "always-off-limits path must deny even without a contract");
    assert.match(r.stderr, /always-off-limits/, "must name the safety-net rule");
  } finally { cleanup(dir); }
});

test("pre-contract safety net: denies .mcp.json write even when no contract exists", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: ".mcp.json" } });
    assert.equal(r.code, 1, "MCP config write is refused pre-contract");
    assert.match(r.stderr, /always-off-limits/);
  } finally { cleanup(dir); }
});

test("pre-contract safety net: allows an ordinary src/ write when no contract exists", async () => {
  const dir = makeRepo(undefined);
  try {
    const r = await runHook(dir, { tool_input: { file_path: "src/lib/foo.ts" } });
    assert.equal(r.code, 0, "pre-contract safety net only blocks the constant list, not everything");
  } finally { cleanup(dir); }
});

test("target-anchored contract resolution: absolute target inside a contracted repo hits its contract", async () => {
  // cwd is a neutral scratch dir with no contract. Target is an absolute
  // path inside a fully separate contracted repo. The hook must find the
  // repo's contract by walking up from the target file's parent, not from
  // cwd — otherwise it would fall through to the greenfield "allow" branch.
  const neutralCwd = mkdtempSync(join(tmpdir(), "write-contract-neutral-"));
  const contracted = makeRepo({
    schema_version: 1, active: true, strict: true, run_id: "target-anchored",
    allowlist: ["docs/**"], off_limits: [],
  });
  try {
    const absTarget = join(contracted, "src", "should-not-be-written.ts");
    mkdirSync(join(contracted, "src"), { recursive: true });
    const r = await runHook(neutralCwd, { tool_input: { file_path: absTarget } });
    assert.equal(r.code, 1, "target-anchored contract must be found and enforced");
    assert.match(r.stderr, /not in the confirmed allowlist/i,
      "allowlist-default-deny must trigger against the target's contract");
  } finally { cleanup(neutralCwd); cleanup(contracted); }
});
