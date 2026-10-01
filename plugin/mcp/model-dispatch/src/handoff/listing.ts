/**
 * Whether this server lists zero-touch's four hand-off tools (1 Oct 2026).
 *
 * Why: Claude Code gives the model every tool a server lists, in every chat, with every message, and the four
 * hand-off tools' descriptions are about 1,600 tokens. They are usable only in a zero-touch Hand-off chat, but Claude
 * Code does not tell a server which chat it serves (only the project folder), so until now they were listed in every
 * chat where the mmo plugin is on, also for people who never installed zero-touch.
 *
 * The rule, read when the server starts:
 *   - MMO_HANDOFF_TOOLS=on|off decides outright (tests, a developer's run);
 *   - zero-touch not installed → not listed: a hand-off chat cannot exist without it;
 *   - zero-touch switched off (enabledPlugins false, at the scope that decides) → not listed;
 *   - zero-touch's saved settings say Workflows or Off → not listed, and the settings file is watched (server.ts): if
 *     it later says Hand-off, the tools are added and Claude Code is told the list changed (probed live on Claude Code
 *     2.1.286: it lists the tools again at once). They are never taken away while the server runs: a chat that has
 *     them keeps them;
 *   - anything else (Hand-off saved, nothing chosen yet, so the first chat may choose Hand-off, or anything that cannot
 *     be read) → listed. When in doubt, the tools are listed, as before: the worst case is the old behaviour.
 *
 * Where Claude Code keeps what is read here: `<config>/plugins/installed_plugins.json` (which plugins are installed),
 * the settings files' `enabledPlugins` (managed, then the project's local file, then the project's, then the user's:
 * the first that names the plugin decides), and `<config>/plugins/data/<plugin id, other characters as "-">/
 * settings.json` (zero-touch's own settings, its ${CLAUDE_PLUGIN_DATA}). `<config>` is CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ListingDecision {
  list: boolean;
  /** Why, in a word: for the server's log. */
  reason: "override" | "no-zero-touch" | "zero-touch-off" | "other-mode" | "handoff" | "not-chosen" | "unreadable";
  /** Zero-touch settings files to watch, when the tools are not listed only because of the saved mode. */
  watch: string[];
}

type Env = Record<string, string | undefined>;

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The folder Claude Code keeps its settings and plugins in. */
export function claudeConfigDir(env: Env): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return set ? set : join(env.HOME?.trim() || homedir(), ".claude");
}

/** The organisation's managed settings file (the same places zero-touch's mark.mjs reads). */
function managedSettingsFile(env: Env): string {
  if (env.MMO_MANAGED_SETTINGS?.trim()) return env.MMO_MANAGED_SETTINGS.trim();
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** A plugin's data folder name: its id with characters other than letters, digits, "_" and "-" as "-". */
export const dataFolderName = (pluginId: string) => pluginId.replace(/[^A-Za-z0-9_-]/g, "-");

/** Whether a plugin is switched on: the first settings scope that names it decides; none names it → on (installing turns it on). */
function enabled(pluginId: string, layers: unknown[]): boolean {
  for (const layer of layers) {
    const value = isObject(layer) && isObject(layer.enabledPlugins) ? layer.enabledPlugins[pluginId] : undefined;
    if (typeof value === "boolean") return value;
  }
  return true;
}

export function handoffListing(env: Env = process.env): ListingDecision {
  const override = env.MMO_HANDOFF_TOOLS?.trim().toLowerCase();
  if (override === "on" || override === "off") return { list: override === "on", reason: "override", watch: [] };

  const config = claudeConfigDir(env);
  const installed = readJson(join(config, "plugins", "installed_plugins.json"));
  if (!isObject(installed)) return { list: true, reason: "unreadable", watch: [] };
  const plugins = isObject(installed.plugins) ? installed.plugins : installed;
  const ids = Object.keys(plugins).filter((id) => id.startsWith("zero-touch@"));
  if (!ids.length) return { list: false, reason: "no-zero-touch", watch: [] };

  const project = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const layers = [
    readJson(managedSettingsFile(env)),
    readJson(join(project, ".claude", "settings.local.json")),
    readJson(join(project, ".claude", "settings.json")),
    readJson(join(config, "settings.json")),
  ];
  const on = ids.filter((id) => enabled(id, layers));
  if (!on.length) return { list: false, reason: "zero-touch-off", watch: [] };

  const watch: string[] = [];
  for (const id of on) {
    const file = join(config, "plugins", "data", dataFolderName(id), "settings.json");
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (e: any) {
      if (e?.code === "ENOENT") return { list: true, reason: "not-chosen", watch: [] };
      return { list: true, reason: "unreadable", watch: [] };
    }
    let saved: unknown;
    try { saved = JSON.parse(text); } catch { return { list: true, reason: "unreadable", watch: [] }; }
    const mode = isObject(saved) ? saved.mode : undefined;
    if (mode === "handoff") return { list: true, reason: "handoff", watch: [] };
    if (mode !== "workflows" && mode !== "off") return { list: true, reason: "unreadable", watch: [] };
    watch.push(file);
  }
  return { list: false, reason: "other-mode", watch };
}
