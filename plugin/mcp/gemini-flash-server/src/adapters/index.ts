import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";

/**
 * Adapter registry.
 *
 * The two policies that ship with this repo need exactly two adapters:
 *   - builtin-anthropic       → Claude Opus (subagent's own tier)
 *   - mcp:gemini-flash-server → Google Gemini 3.5 Flash (mechanical tier)
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
  throw new Error(
    `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`,
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
