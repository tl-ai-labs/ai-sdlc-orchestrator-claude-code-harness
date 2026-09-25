/**
 * Prompt labels for reports. A fixed regex list shipped with the plugin, first
 * match wins, first 4 KB only. What is stored is the rule id, never the text.
 *
 * Labels are descriptive. No routing decision reads them, because more than
 * half of real prompts match nothing and land in "other"; decisions are made
 * later from what the session is actually doing.
 *
 * A short follow-up ("yes", "continue") carries the previous label forward, so
 * an episode is not split by a one-word reply.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_FILE = resolve(HERE, "..", "..", "..", "config", "ambient-labels.json");
export const LABEL_WINDOW_CHARS = 4096;

let cached = null;

export function loadRules(file = RULES_FILE) {
  if (cached && cached.file === file) return cached.value;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const value = {
    rules: raw.rules.map((r) => ({ id: r.id, re: new RegExp(r.pattern, "i") })),
    inherit: { maxChars: raw.inherit.max_chars, re: new RegExp(raw.inherit.pattern, "i") },
  };
  cached = { file, value };
  return value;
}

/** Returns { label, inherited }. `previous` is the last stored label of the session, if any. */
export function labelPrompt(prompt, previous = null, rules = loadRules()) {
  const head = typeof prompt === "string" ? prompt.slice(0, LABEL_WINDOW_CHARS) : "";
  const trimmed = head.trim();
  if (previous && trimmed.length <= rules.inherit.maxChars && rules.inherit.re.test(trimmed)) {
    return { label: previous, inherited: true };
  }
  for (const rule of rules.rules) {
    if (rule.re.test(head)) return { label: rule.id, inherited: false };
  }
  return { label: "other", inherited: false };
}

/**
 * The plugin's own command names, read from its commands folder, so this list
 * can never drift from what the plugin ships.
 */
const COMMANDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commands");
export const PLUGIN_COMMANDS = (() => {
  try { return new Set(readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))); } catch { return new Set(); }
})();

/**
 * A command name, as a typed line or an expansion reports it, that is one of
 * the plugin's own: "mmo:bugfix", "/mmo:bugfix" or, typed without the prefix
 * where Claude Code allows it, "bugfix" (independent review, 25 Sep). Reading
 * another plugin's same-named command this way only makes zero-touch stand
 * down, the safe side.
 */
export function isPluginCommandName(name) {
  const m = /^\/?(?:mmo:)?([a-z][a-z-]*)$/i.exec(String(name ?? "").trim());
  return Boolean(m) && PLUGIN_COMMANDS.has(m[1].toLowerCase());
}

/** A prompt that types one of the plugin's commands makes the session a pipeline session. */
export function isPipelineCommand(prompt) {
  if (typeof prompt !== "string") return false;
  const m = /^\s*(\/[\w:-]+)/.exec(prompt);
  return Boolean(m) && isPluginCommandName(m[1]);
}

/**
 * Turn-level opt-outs: plain phrases that mean "give me the whole thing". When
 * one is present the valves stand down for that prompt.
 */
export function wantsFullOutput(prompt) {
  const head = typeof prompt === "string" ? prompt.slice(0, LABEL_WINDOW_CHARS) : "";
  return /\b(whole file|entire file|full file|full output|show me the output|complete output|don'?t (trim|truncate|summari[sz]e)|untrimmed)\b/i.test(head);
}
