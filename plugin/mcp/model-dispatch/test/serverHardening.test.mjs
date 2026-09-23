/**
 * Four hardening repairs, each a defect that was proven in the code first:
 *  1. the agent worker (an executing, allow-all process) inherited EVERY
 *     variable of the parent, including other vendors' keys and tokens;
 *  2. the claude-cli worker ran `claude -p` in the project with no safety flag,
 *     so it loaded that repository's hooks and .mcp.json servers unasked;
 *  3. `telemetry_path` and friends are chosen by the model and were used as
 *     given, so a steered model could append lines to any file the account
 *     can write;
 *  4. a call without project_root ignored CLAUDE_PROJECT_DIR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkerEnv } from "../dist/delegation/workerProcess.js";
import { claudeCliArgs } from "../dist/adapters/ClaudeCliAdapter.js";
import { pathIsAllowed } from "../dist/safePath.js";
import { resolveProjectRoot, resetProjectRootMemory } from "../dist/project-root.js";

test("the agent worker gets no secrets it has no use for, and keeps what Google auth needs", () => {
  const parent = {
    PATH: "/usr/bin", HOME: "/Users/dev", DYLD_LIBRARY_PATH: "/opt/x", LANG: "en_GB.UTF-8",
    GOOGLE_APPLICATION_CREDENTIALS: "/Users/dev/adc.json", GOOGLE_CLOUD_PROJECT: "old", CLOUDSDK_CONFIG: "/Users/dev/.config/gcloud",
    GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2",
    ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GITHUB_TOKEN: "t", NPM_TOKEN: "n", AWS_SECRET_ACCESS_KEY: "s", AWS_ACCESS_KEY_ID: "k",
    DATABASE_URL: "postgres://u:p@h/db", MY_APP_PASSWORD: "p", SLACK_WEBHOOK_URL: "https://hooks", CLAUDE_CODE_OAUTH_TOKEN: "c", SSH_AUTH_SOCK: "/tmp/agent",
  };
  const child = buildWorkerEnv(parent, { project: "proj", location: "us-central1" });
  for (const gone of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DATABASE_URL", "MY_APP_PASSWORD", "SLACK_WEBHOOK_URL", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK"]) {
    assert.equal(child[gone], undefined, `${gone} must not reach an executing worker`);
  }
  for (const kept of ["PATH", "HOME", "DYLD_LIBRARY_PATH", "LANG", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"]) assert.equal(child[kept], parent[kept], kept);
  assert.equal(child.GOOGLE_CLOUD_PROJECT, "proj");
  assert.equal(child.PYTHONUNBUFFERED, "1");
});

test("the claude worker is started with the safety flags this CLI really has, and none it lacks", () => {
  const help = "  --safe-mode   Start with all customizations disabled\n  --strict-mcp-config  Only use MCP servers from --mcp-config\n  --disable-slash-commands  Disable all skills\n";
  assert.deepEqual(claudeCliArgs("claude-sonnet-5", help, {}), ["-p", "--model", "claude-sonnet-5", "--output-format", "json", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]);
  assert.deepEqual(claudeCliArgs("claude-sonnet-5", "  --model <model>\n", {}), ["-p", "--model", "claude-sonnet-5", "--output-format", "json"], "an older CLI without the flags must keep working");
  assert.deepEqual(claudeCliArgs("m", help, { MMO_CLAUDE_CLI_PLAIN: "1" }), ["-p", "--model", "m", "--output-format", "json"], "one documented switch restores the old launch");
  assert.ok(!claudeCliArgs("m", "  --bare  Minimal mode", {}).includes("--bare"), "--bare skips keychain reads, which would break subscription login");
});

test("a chat worker started through the Claude login gets NO tools, and a CLI that cannot promise that is refused", () => {
  // A chat job's worker turns a brief into text. With tools it could read or write files the code checks never
  // see. `--tools ""` is Claude Code's own switch for "no tools at all" (2.1.270 --help).
  const help = "  --safe-mode   Start with all customizations disabled\n  --strict-mcp-config  Only use MCP servers\n  --disable-slash-commands  Disable all skills\n  --tools <tools...>  Use \"\" to disable all tools\n";
  const args = claudeCliArgs("claude-sonnet-5", help, {}, { noTools: true });
  assert.deepEqual(args.slice(-2), ["--tools", ""]);
  assert.ok(args.includes("--safe-mode") && args.includes("--strict-mcp-config"));
  assert.deepEqual(claudeCliArgs("claude-sonnet-5", help, { MMO_CLAUDE_CLI_PLAIN: "1" }, { noTools: true }).slice(-2), ["--tools", ""], "the plain-launch switch never gives a chat worker tools");
  assert.throws(() => claudeCliArgs("claude-sonnet-5", "  --model <model>\n", {}, { noTools: true }), /no --tools/);
  assert.ok(!claudeCliArgs("claude-sonnet-5", help, {}).includes("--tools"), "the pipeline's worker launch is unchanged");
});

test("a model-chosen path must land inside the project or the temp folder, symlinks resolved", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mmo-safe-")));
  try {
    const project = join(dir, "project");
    const outside = join(dir, "outside");
    mkdirSync(join(project, ".sdlc"), { recursive: true });
    mkdirSync(outside);
    const roots = [project];
    assert.equal(pathIsAllowed(join(project, ".sdlc", "runs", "r1", "telemetry.jsonl"), roots), true, "a file that does not exist yet, under the project");
    assert.equal(pathIsAllowed(join(outside, "telemetry.jsonl"), roots), false);
    assert.equal(pathIsAllowed(join(project, "..", "outside", "x.jsonl"), roots), false);
    assert.equal(pathIsAllowed("/etc/cron.d/x", roots), false);
    symlinkSync(outside, join(project, "link"));
    assert.equal(pathIsAllowed(join(project, "link", "x.jsonl"), roots), false, "a symlink that leaves the project");
    assert.equal(pathIsAllowed(join(tmpdir(), "anything", "t.jsonl"), [project, tmpdir()]), true);
    assert.equal(pathIsAllowed("", roots), false);
    assert.equal(pathIsAllowed("relative/path.jsonl", roots), false, "a relative path has no anchor the server can trust");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no project_root supplied, CLAUDE_PROJECT_DIR is the default; a supplied root still wins", () => {
  resetProjectRootMemory();
  const before = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "/work/repo";
    assert.equal(resolveProjectRoot(undefined), "/work/repo");
    assert.equal(resolveProjectRoot("/other"), "/other");
    assert.equal(resolveProjectRoot(undefined), "/other", "the remembered root outranks the environment");
    resetProjectRootMemory();
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolveProjectRoot(undefined), undefined);
  } finally {
    resetProjectRootMemory();
    if (before === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = before;
  }
});
