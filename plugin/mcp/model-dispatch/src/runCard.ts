/**
 * The run card pre-flight records: which code and which cache rules a run used.
 *
 * Two runs are comparable only when they ran the same code under the same
 * prompt-cache rules. The plugin pins them: the orchestrator helper writes a
 * one-hour cache (its frontmatter), every lean Opus typist a five-minute one
 * (its environment). Claude Code lets four things override that silently —
 * found by probe P9 and in the 2.1.280 binary:
 *   - FORCE_PROMPT_CACHING_5M (every cache write becomes five minutes);
 *   - any DISABLE_PROMPT_CACHING* variable (no caching at all, or none for one
 *     model family);
 *   - CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL and the subagentPromptCacheTtl
 *     setting (they replace a helper's own cacheTtl).
 * CLAUDE_CODE_PROMPT_CACHE_TTL / promptCacheTtl set only the main
 * conversation's lifetime, which no helper or typist uses, so they are not
 * overrides.
 *
 * Pre-flight names each override it finds (the name and where it was set,
 * never a value) as a warning, and records the plugin's version and commit,
 * whether its tree had uncommitted changes, Claude Code's version, and a
 * digest of the settings files. A user who set an override on purpose still
 * gets a run; a comparison refuses one (its launcher reads this card).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OVERRIDE_ENV = ["FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"];
const OVERRIDE_ENV_PREFIX = "DISABLE_PROMPT_CACHING";
const OVERRIDE_SETTINGS = ["subagentPromptCacheTtl"];

const isOverrideEnv = (k: string) => OVERRIDE_ENV.includes(k) || k === OVERRIDE_ENV_PREFIX || k.startsWith(`${OVERRIDE_ENV_PREFIX}_`);

/** Each cache override found, as "where: name" — names only, sorted within each source. */
export function cacheOverrides(env: Record<string, string | undefined>, settings: { source: string; json: any }[]): string[] {
  const found = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "" && isOverrideEnv(k)).sort().map((k) => `environment: ${k}`);
  for (const { source, json } of settings) {
    const own = [
      ...Object.keys(json?.env ?? {}).filter(isOverrideEnv).map((k) => `env.${k}`),
      ...OVERRIDE_SETTINGS.filter((k) => json?.[k] !== undefined),
    ].sort();
    found.push(...own.map((k) => `${source}: ${k}`));
  }
  return found;
}

/** The settings files Claude Code reads for a session: the user's (under CLAUDE_CONFIG_DIR when set), then the project's and the project's local file. */
export function settingsFiles(env: Record<string, string | undefined>, projectRoot?: string): string[] {
  const user = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "settings.json") : join(env.HOME ?? "", ".claude", "settings.json");
  return [user, ...(projectRoot ? [join(projectRoot, ".claude", "settings.json"), join(projectRoot, ".claude", "settings.local.json")] : [])];
}

export interface RunCard {
  plugin_version: string;
  plugin_commit: string | null;
  plugin_tree_dirty: boolean | null;
  claude_code_version: string | null;
  cache_overrides: string[];
  settings_sha256: string;
}

const run = (cmd: string, args: string[]): string | null => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};

export function runCard(opts: { pluginDir: string; pluginVersion: string; env: Record<string, string | undefined>; projectRoot?: string; exec?: (cmd: string, args: string[]) => string | null }): RunCard {
  const exec = opts.exec ?? run;
  const files = settingsFiles(opts.env, opts.projectRoot).filter((f) => existsSync(f));
  const settings: { source: string; json: any }[] = [];
  const digest = createHash("sha256");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    digest.update(`${f}\n${text}\n`);
    try { settings.push({ source: f, json: JSON.parse(text) }); } catch { settings.push({ source: f, json: {} }); }
  }
  const commit = exec("git", ["-C", opts.pluginDir, "rev-parse", "HEAD"]);
  const status = commit === null ? null : exec("git", ["-C", opts.pluginDir, "status", "--porcelain"]);
  const cli = exec("claude", ["--version"]);
  return {
    plugin_version: opts.pluginVersion,
    plugin_commit: commit === null ? null : commit.trim(),
    plugin_tree_dirty: status === null ? null : status.trim().length > 0,
    claude_code_version: cli === null ? null : cli.trim(),
    cache_overrides: cacheOverrides(opts.env, settings),
    settings_sha256: digest.digest("hex"),
  };
}
