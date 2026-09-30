/**
 * The plugin's own /mmo: commands, as a typed line or a command expansion names them. A chat where the person typed
 * one is a workflow run, and zero-touch stands down in it until the run ends.
 *
 * 0.8.4: this file was lib/labels.mjs, which also labelled prompts for the generic orchestrator's savings board
 * (config/ambient-labels.json) and spotted "give me the whole file" turns for its Read outlines. Both went with the
 * generic orchestrator; only the command recognition is left.
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * The plugin's commands that start a workflow: a gated run with its own run log (`.sdlc/runs/<run-id>/
 * orchestrator.log`). Only these make a chat a workflow run, can wait in the queue, or be replaced (0.8.4). The
 * other commands (setup, policy, revert) are one-off tools: typing one never makes the chat a workflow run, which
 * until 0.8.4 left a zero-touch chat quiet for the rest of its life (no run log ever showed their end).
 * tools/test/zero-touch-queue.test.mjs checks every shipped command is classified here or in ONE_OFF_COMMANDS.
 */
export const WORKFLOW_COMMANDS = new Set(["greenfield", "brownfield", "bugfix", "feature-extend", "feature-new", "refactor", "test", "docs", "deps", "pass"]);
export const ONE_OFF_COMMANDS = new Set(["setup", "policy", "revert"]);

/** A typed line's plugin command: { name, args, workflow } (name without "mmo:"), or null for anything else. */
export function typedCommand(prompt) {
  if (!isPipelineCommand(prompt)) return null;
  const m = /^\s*\/(?:mmo:)?([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return { name, args: (m[2] ?? "").trim(), workflow: WORKFLOW_COMMANDS.has(name) };
}
