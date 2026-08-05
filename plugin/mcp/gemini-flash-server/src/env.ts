/**
 * Environment sanitation for the plugin install route.
 *
 * WHY THIS EXISTS
 *
 * `plugin/.claude-plugin/plugin.json` declares the MCP server's environment as
 * pass-throughs from the host:
 *
 *   "env": { "GOOGLE_CLOUD_PROJECT": "${GOOGLE_CLOUD_PROJECT}", ... }
 *
 * When the named variable IS set in the environment that launched Claude Code, the
 * value is substituted and everything works. When it is NOT set, the placeholder is
 * handed to the server process **verbatim** — the child receives the literal nine-to-
 * thirty-character string `${GOOGLE_CLOUD_PROJECT}`, not an empty value and not an
 * absent key. Verified against a live server process on 2026-08-04: all six declared
 * variables arrived unexpanded.
 *
 * This is not a corner case. Claude Code launched from the macOS/Windows desktop app
 * does not inherit a login shell, so a user who has never exported these variables —
 * which is the default state of anyone following the two-prompt setup — hits it every
 * time.
 *
 * WHAT IT BROKE
 *
 * The literal is truthy, so every consumer treated it as a real setting:
 *
 *   - `selectGeminiBackend` read GEMINI_BACKEND, failed to match "vertex" or "api-key",
 *     and threw. Every mechanical-tier dispatch died at adapter construction, so a run
 *     silently executed all phases on the premium tier — the exact opposite of the
 *     cost story this plugin exists to demonstrate.
 *   - GEMINI_API_KEY, also literal, outranks ADC in the precedence order, so the
 *     api-key door would have been chosen with a garbage key.
 *   - `resolveGcpProject` would have returned "${GOOGLE_CLOUD_PROJECT}" as a project id.
 *   - verify-setup reported credentials as present and gave the run a green light.
 *
 * THE FIX
 *
 * Strip these values at process entry, before anything reads them. Deleting the keys
 * from `process.env` in place (rather than passing a cleaned copy around) is deliberate:
 * the Google GenAI SDK reads GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION from
 * `process.env` on its own, inside library code we do not call directly and cannot hand
 * a sanitized object to. Cleaning the real environment is the only place that covers
 * both our code and theirs.
 *
 * After stripping, an unset variable is genuinely absent, which is a state every
 * consumer already handles correctly: the backend selector falls through to the ADC
 * file, and the project resolver reads the quota project out of the credentials.
 */

/**
 * Matches a shell-style placeholder that was never substituted — `${NAME}` and nothing
 * else. Anchored on both ends so a legitimate value that merely *contains* a dollar
 * sign (a filesystem path, a passphrase) is left alone.
 */
export const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** True when a value carries no information: absent, empty, or an unexpanded placeholder. */
export function isUnusableEnvValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || UNEXPANDED_PLACEHOLDER.test(trimmed);
}

/**
 * The variables this plugin declares in plugin.json, and the only ones we touch.
 *
 * Stripping the whole environment would be overreach: plenty of unrelated variables are
 * legitimately empty, and deleting them could change the behaviour of tools we shell out
 * to. Kept in sync by hand with DECLARED_ENV in plugin/scripts/verify-setup.mjs, which
 * runs before `npm ci` and so cannot import this module — if one list changes, change both.
 */
export const PLUGIN_DECLARED_ENV = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  // The run's answers to the policy's select slots, e.g.
  // "gemini-flash=flash-agsdk-worker". It belongs on this list for the same
  // reason as the rest: left unexpanded it arrives as the literal
  // "${SDLC_SELECT}", which is a truthy string that parses as neither a valid
  // slot spec nor an empty one — so every dispatch would die at policy load
  // on a machine where the variable was simply never set.
  "SDLC_SELECT",
  // An operator-supplied interpreter for the Antigravity agent worker, for
  // people who already maintain a Python >= 3.10 with the SDK installed and
  // would rather not have a second one built inside the plugin. Unexpanded it
  // is a path that does not exist, and resolveWorkerPython() refuses a
  // non-existent override outright — a clear failure, but for the wrong
  // reason, on a machine whose own virtualenv was sitting there working.
  "GEMINI_WORKER_PYTHON",
] as const;

/**
 * Sanitize exactly the plugin-declared variables. Call once at process entry, before
 * any adapter is constructed or any SDK is imported for use.
 */
export function sanitizePluginEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of PLUGIN_DECLARED_ENV) {
    if (key in env && isUnusableEnvValue(env[key])) {
      removed.push(key);
      delete env[key];
    }
  }
  return removed;
}
