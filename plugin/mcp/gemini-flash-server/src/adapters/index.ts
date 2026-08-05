import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
import { AntigravityWorkerAdapter } from "./AntigravityWorkerAdapter.js";

/**
 * Adapter registry.
 *
 * The policies that ship with this repo need three adapters:
 *   - builtin-anthropic       → Claude Opus (subagent's own tier)
 *   - mcp:gemini-flash-server → Google Gemini as a MODEL: one completion call
 *   - antigravity-worker      → Google Gemini as an AGENT: an Antigravity SDK
 *                               session with a working directory, tools of its
 *                               own, and a bill to match
 *
 * The last two are the same model behind the same credentials. What differs is
 * whether the orchestrating session hands the model a finished prompt and
 * writes the answer to disk itself, or hands a worker a directory and lets it
 * do the reading, running and editing. Which one a phase gets is a line in a
 * policy YAML, not a code change.
 *
 * To add support for another model:
 *   1. Implement a new class conforming to ModelAdapter.
 *   2. Register it here, keyed on the string used in your policy YAML's
 *      `adapter:` field.
 *   3. Reference it from a policy under plugin/config/policies/.
 */
export function createAdapter(config: ModelConfig): ModelAdapter {
  if (config.adapter === "builtin-anthropic") return new BuiltinAnthropicAdapter(config);
  if (config.adapter === "mcp:gemini-flash-server") return new GeminiFlashAdapter(config);
  if (config.adapter === "antigravity-worker") return new AntigravityWorkerAdapter(config);
  throw new Error(
    `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`,
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
