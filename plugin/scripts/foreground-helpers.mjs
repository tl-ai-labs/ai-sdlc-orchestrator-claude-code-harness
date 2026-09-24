#!/usr/bin/env node
/**
 * PreToolUse hook (matcher Agent|Task): keeps the pipeline's own helpers in the
 * foreground.
 *
 * Why: a run's orchestrator that launches the architect or a reviewer in the
 * background ends its turn and waits for a notice, and a helper's five-minute
 * prompt cache can expire in the meantime; worse, a background helper's result
 * can arrive after the orchestrator has moved on. A launch of one of this
 * plugin's agents (`mmo:<name>`, or the bare name inside the plugin's own
 * orchestrator) that asks for the background is refused with a reason, and
 * the model launches it again in the foreground (checked live: the refused
 * launch was retried with run_in_background false and the helper answered).
 *
 * Scope: ONLY this plugin's agents. Every other agent launch, in any session,
 * is allowed untouched — the plugin must not change how people use helpers
 * outside a run.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The plugin's own agents (plugin/agents/*.md). */
export const PIPELINE_AGENTS = new Set(["orchestrator", "architect", "senior-reviewer", "security-reviewer", "discovery"]);

/** The hook's decision for one tool call: a PreToolUse deny object, or null to allow. */
export function decide(input) {
  if (!input || !["Agent", "Task"].includes(input.tool_name)) return null;
  const ti = input.tool_input ?? {};
  if (ti.run_in_background !== true) return null;
  const type = String(ti.subagent_type ?? "");
  const bare = type.startsWith("mmo:") ? type.slice(4) : type;
  if (!PIPELINE_AGENTS.has(bare)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `The ${type} helper runs in the foreground during an mmo run: launch it again with run_in_background set to false and wait for its answer.`,
    },
  };
}

// Run as the hook when this file is the entry point. Compared as resolved file
// URLs: a plugin under a path with a space (URL-encoded in import.meta.url) or
// behind a symlink (Node resolves the entry to its real path) must still match.
const entry = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === entry) {
  let input = null;
  try { input = JSON.parse(readFileSync(0, "utf8") || "null"); } catch { /* not a hook payload: allow */ }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
}
