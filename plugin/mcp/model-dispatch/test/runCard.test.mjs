/**
 * The run card pre-flight records, and the settings that would silently change
 * a run's prompt caching.
 *
 * Two runs are comparable only if they ran the same code under the same cache
 * rules. The orchestrator helper pins a one-hour cache and every typist a
 * five-minute one; Claude Code lets four things override that (probe P9 and
 * the 2.1.280 binary): FORCE_PROMPT_CACHING_5M, any DISABLE_PROMPT_CACHING*
 * variable, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, and the
 * subagentPromptCacheTtl setting. Pre-flight names each one it finds (never a
 * value) and records the code and CLI version, so a comparison can refuse a
 * run that differs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheOverrides, runCard, settingsFiles } from "../dist/runCard.js";

test("every setting that overrides the pinned cache lifetimes is named, by name only, wherever it is set", () => {
  const env = { FORCE_PROMPT_CACHING_5M: "1", DISABLE_PROMPT_CACHING_OPUS: "1", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" };
  const settings = [
    { source: "/u/.claude/settings.json", json: { subagentPromptCacheTtl: "5m", env: { DISABLE_PROMPT_CACHING: "1", SECRET_TOKEN: "abc" } } },
    { source: "/p/.claude/settings.json", json: { model: "opus" } },
  ];
  assert.deepEqual(cacheOverrides(env, settings), [
    "environment: CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
    "environment: DISABLE_PROMPT_CACHING_OPUS",
    "environment: FORCE_PROMPT_CACHING_5M",
    "/u/.claude/settings.json: env.DISABLE_PROMPT_CACHING",
    "/u/.claude/settings.json: subagentPromptCacheTtl",
  ]);
  assert.deepEqual(cacheOverrides({ PATH: "/bin", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, []), [], "the main conversation's own lifetime changes no helper or typist");
});

test("the settings files Claude Code reads: the user's (or CLAUDE_CONFIG_DIR's), the project's, the project's local", () => {
  assert.deepEqual(settingsFiles({ HOME: "/h" }, "/p"), ["/h/.claude/settings.json", "/p/.claude/settings.json", "/p/.claude/settings.local.json"]);
  assert.deepEqual(settingsFiles({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" }, undefined), ["/cfg/settings.json"]);
});

test("the run card: plugin version, commit and whether the tree is clean, Claude Code's version, the overrides found, and a digest of the settings (never their contents)", () => {
  const home = mkdtempSync(join(tmpdir(), "card-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { API_TOKEN: "secret-value" }, subagentPromptCacheTtl: "5m" }));
  const exec = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    if (key === "claude --version") return "2.1.280 (Claude Code)\n";
    if (key.endsWith("rev-parse HEAD")) return "abc123\n";
    if (key.endsWith("status --porcelain")) return " M src/x.ts\n";
    return null;
  };
  const card = runCard({ pluginDir: "/plug", pluginVersion: "0.7.5", env: { HOME: home }, exec });
  assert.equal(card.plugin_version, "0.7.5");
  assert.equal(card.plugin_commit, "abc123");
  assert.equal(card.plugin_tree_dirty, true);
  assert.equal(card.claude_code_version, "2.1.280 (Claude Code)");
  assert.deepEqual(card.cache_overrides, [`${join(home, ".claude", "settings.json")}: subagentPromptCacheTtl`]);
  assert.match(card.settings_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(card).includes("secret-value"), "a settings value never appears on the card");
  const outside = runCard({ pluginDir: "/plug", pluginVersion: "0.7.5", env: { HOME: home }, exec: () => null });
  assert.equal(outside.plugin_commit, null, "not a git checkout: recorded as unknown, not guessed");
  assert.equal(outside.plugin_tree_dirty, null);
  assert.equal(outside.claude_code_version, null);
});
