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
import { readFileSync } from "node:fs";
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

/** A prompt that types an mmo command makes the session a pipeline session. */
export function isPipelineCommand(prompt) {
  return typeof prompt === "string" && /^\s*\/mmo:[a-z-]+/i.test(prompt);
}

/**
 * Turn-level opt-outs: plain phrases that mean "give me the whole thing". When
 * one is present the valves stand down for that prompt.
 */
export function wantsFullOutput(prompt) {
  const head = typeof prompt === "string" ? prompt.slice(0, LABEL_WINDOW_CHARS) : "";
  return /\b(whole file|entire file|full file|full output|show me the output|complete output|don'?t (trim|truncate|summari[sz]e)|untrimmed)\b/i.test(head);
}
