import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
import { AntigravityWorkerAdapter } from "./AntigravityWorkerAdapter.js";

/**
 * Adapter registry, keyed on the policy YAML's `adapter:` field.
 *   builtin-anthropic  → Claude, direct SDK
 *   mcp:model-dispatch → Gemini as a model (one completion call)
 *   antigravity-worker → Gemini as an agent (Antigravity SDK session)
 */

/** MMO-D8 compat shim: a hand-authored policy may still use the pre-rename id. */
const LEGACY_GEMINI_ADAPTER_ID = "mcp:gemini-flash-server";
let legacyAdapterIdWarned = false;

export function createAdapter(config: ModelConfig): ModelAdapter {
  if (config.adapter === "builtin-anthropic") return new BuiltinAnthropicAdapter(config);
  if (config.adapter === "mcp:model-dispatch") return new GeminiFlashAdapter(config);
  if (config.adapter === LEGACY_GEMINI_ADAPTER_ID) {
    if (!legacyAdapterIdWarned) {
      legacyAdapterIdWarned = true;
      process.stderr.write(
        `model-dispatch: adapter id '${LEGACY_GEMINI_ADAPTER_ID}' is deprecated, use 'mcp:model-dispatch' instead\n`
      );
    }
    return new GeminiFlashAdapter(config);
  }
  if (config.adapter === "antigravity-worker") return new AntigravityWorkerAdapter(config);
  throw new Error(
    `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`,
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
