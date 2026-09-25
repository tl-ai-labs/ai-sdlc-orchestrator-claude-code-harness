/**
 * End-to-end pins for plugin/scripts/cache-ttl-check.mjs — the run-start check
 * that the project's Claude Code `subagentPromptCacheTtl` matches the policy's
 * `subagent_cache_ttl`, with --fix writing it.
 *
 * Lives here for the same reason driverModelCheck.test.mjs does: the script
 * imports the compiled loadPolicy from this package's dist/, and this suite
 * runs after `npm run build`. Every case spawns the real CLI — the exit codes
 * (0 ok / 1 mismatch / 2 fixed-relaunch) are the contract the orchestrator's
 * rule 0 acts on. Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "cache-ttl-check.mjs");
const SHIPPED = join(HERE, "..", "..", "..", "config", "policies");

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A minimal valid policy file with the given top-level extras appended. */
function policyFile(dir, name, extra = "") {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(
    path,
    [
      "version: 1",
      `name: ${name}`,
      "models:",
      "  - id: opus",
      "    adapter: builtin-anthropic",
      "    model_name: claude-opus-5",
      "rules:",
      "  - default: opus",
      extra,
      "",
    ].join("\n")
  );
  return path;
}

function project(settings) {
  const root = mkdtempSync(join(tmpdir(), "cache-ttl-"));
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.local.json"), settings);
  }
  return root;
}

const settingsOf = (root) => JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8"));

test("policy without subagent_cache_ttl: exit 0, settings untouched", () => {
  const root = project('{"env":{"X":"1"}}');
  try {
    const pol = policyFile(root, "plain");
    const r = run(["--project-root", root, "--policy-path", pol, "--fix"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /declares no subagent_cache_ttl/);
    assert.deepEqual(settingsOf(root), { env: { X: "1" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent key counts as 5m: a 5m policy passes with no settings file at all", () => {
  const root = project(undefined);
  try {
    const pol = policyFile(root, "short", "subagent_cache_ttl: 5m");
    const r = run(["--project-root", root, "--policy-path", pol]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /key absent = default/);
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mismatch without --fix: exit 1, names the file and the fix, writes nothing", () => {
  const root = project('{"subagentPromptCacheTtl":"1h"}');
  try {
    const pol = policyFile(root, "short", "subagent_cache_ttl: 5m");
    const r = run(["--project-root", root, "--policy-path", pol]);
    assert.equal(r.code, 1);
    assert.match(r.err, /is 1h .* wants 5m/);
    assert.match(r.err, /remove "subagentPromptCacheTtl"/);
    assert.match(r.err, /Relaunch claude/);
    assert.deepEqual(settingsOf(root), { subagentPromptCacheTtl: "1h" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--fix to 1h: writes the key, keeps every other key, exit 2 with relaunch instruction", () => {
  const root = project('{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"claude-opus-5"},"enabledMcpjsonServers":["x"]}');
  try {
    const pol = policyFile(root, "long", "subagent_cache_ttl: 1h");
    const r = run(["--project-root", root, "--policy-path", pol, "--fix"]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /UPDATED .*5m → 1h/);
    assert.match(r.err, /Relaunch claude/);
    assert.deepEqual(settingsOf(root), {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" },
      enabledMcpjsonServers: ["x"],
      subagentPromptCacheTtl: "1h",
    });
    // Second run: the file now matches, so the check passes and stays silent about relaunch.
    const again = run(["--project-root", root, "--policy-path", pol, "--fix"]);
    assert.equal(again.code, 0, again.err);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--fix to 5m: removes the key rather than writing \"5m\", creates the file if absent", () => {
  const root = project('{"subagentPromptCacheTtl":"1h","other":true}');
  try {
    const pol = policyFile(root, "short", "subagent_cache_ttl: 5m");
    const r = run(["--project-root", root, "--policy-path", pol, "--fix"]);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /key removed/);
    assert.deepEqual(settingsOf(root), { other: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const bare = project(undefined);
  try {
    const pol = policyFile(bare, "long", "subagent_cache_ttl: 1h");
    const r = run(["--project-root", bare, "--policy-path", pol, "--fix"]);
    assert.equal(r.code, 2, r.err);
    assert.deepEqual(settingsOf(bare), { subagentPromptCacheTtl: "1h" });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("unparsable settings file: exit 1 and never overwritten, even with --fix", () => {
  const root = project("{ not json");
  try {
    const pol = policyFile(root, "long", "subagent_cache_ttl: 1h");
    const r = run(["--project-root", root, "--policy-path", pol, "--fix"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not valid JSON/);
    assert.equal(readFileSync(join(root, ".claude", "settings.local.json"), "utf8"), "{ not json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy with an invalid TTL is refused at load", () => {
  const root = project(undefined);
  try {
    const pol = policyFile(root, "bad", "subagent_cache_ttl: 60m");
    const r = run(["--project-root", root, "--policy-path", pol]);
    assert.equal(r.code, 1);
    assert.match(r.err, /'subagent_cache_ttl' must be one of 5m, 1h/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shipped presets: every policy, single-model included, wants 1h", () => {
  const want = {
    "flash-agsdk-only": "1h",
    "opus-only": "1h",
    "opus-only-v5": "1h",
    "opus-plus-flash": "1h",
    "opus-plus-flash-v37": "1h",
    "opus-plus-flash-v38": "1h",
    "opus-plus-sonnet": "1h",
    "opus-plus-sonnet-max": "1h",
    "sonnet-plus-flash": "1h",
  };
  const root = project(undefined);
  try {
    for (const [name, ttl] of Object.entries(want)) {
      const r = run(["--project-root", root, "--policy-path", join(SHIPPED, `${name}.yaml`), "--print-only"]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out.trim(), ttl, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
