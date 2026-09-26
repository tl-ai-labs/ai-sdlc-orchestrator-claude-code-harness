/**
 * The stamp on every ambient MCP tool call. A PreToolUse hook adds
 * `_mmo: { session_id, prompt_id, arm, mode }` to the tool input; the server
 * refuses a call without it. Two purposes: the server learns the session and
 * arm from one authority (the hook side), and a call that arrives unstamped
 * proves the hooks are not running, so the server must not act.
 *
 * `updatedInput` REPLACES the whole input, so the original fields are carried
 * over untouched and only `_mmo` is added or overwritten. A model-supplied
 * `_mmo` is always discarded: the stamp cannot be forged from inside the chat.
 */
export const START_TOOLS = new Set(["repeat_edit_across_files", "write_files_from_specs", "write_tests_from_cases", "fix_from_analysis", "scout_repo", "consent_to_send"]);
export const FOLLOW_TOOLS = new Set(["job_result", "undo_job", "lookup", "write_files"]); // lookup, write_files: stamped for the record, never refused (optimizations, not delegations; both sides)
const NAME_RE = /^mcp__(?:plugin_mmo_)?model-dispatch__([a-z_]+)$/;

export function ambientToolName(toolName) {
  const m = NAME_RE.exec(String(toolName ?? ""));
  if (!m) return null;
  return START_TOOLS.has(m[1]) || FOLLOW_TOOLS.has(m[1]) ? m[1] : null;
}

export function isStartTool(name) {
  return START_TOOLS.has(name);
}

/**
 * `breakEvenChars` and `contextTokens` are the chat's own numbers at the moment
 * of the call, computed by the hook from the transcript (the server never sees
 * the chat): the typing rule's break-even and the context size. The server's
 * gate refuses a job whose expected typing is below the break-even. Null when
 * the hook could not price the chat; the server then does not gate.
 */
export function stampInput(toolInput, { sessionId, promptId, arm, mode, agent = null, breakEvenChars = null, contextTokens = null, cacheTier = null, model = null }) {
  const base = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? { ...toolInput } : {};
  base._mmo = {
    session_id: sessionId, prompt_id: promptId ?? null, arm, mode, agent: typeof agent === "string" && agent ? agent : null,
    break_even_chars: Number.isFinite(breakEvenChars) && breakEvenChars > 0 ? Math.ceil(breakEvenChars) : null,
    context_tokens: Number.isFinite(contextTokens) && contextTokens > 0 ? Math.round(contextTokens) : null,
    // The chat's prompt-cache lifetime ("5m" or "1h"): the server never lets a waiting call outlive it.
    cache_tier: cacheTier === "5m" || cacheTier === "1h" ? cacheTier : null,
    // The model the hook priced this chat at (26 Sep, option 3: the chat may be on any model). The server prices
    // its own gate and picks its worker at the same model, so the two can never judge the chat on different rates.
    model: typeof model === "string" && model ? model : null,
  };
  return base;
}
