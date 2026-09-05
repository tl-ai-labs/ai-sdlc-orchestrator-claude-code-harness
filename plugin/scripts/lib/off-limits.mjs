/**
 * Shared off-limits pattern lists. Two consumers:
 *   - plugin/scripts/setup-policy.mjs writes OFF_LIMITS_DEFAULT to
 *     `.sdlc/project.json` so Gate 0 can name them once and skip repeating
 *     the constants each ticket.
 *   - plugin/scripts/write-contract-check.mjs uses HARDCODED_OFF_LIMITS as
 *     the pre-contract safety net: even without an active brownfield contract,
 *     always-sensitive paths (credentials, MCP config, other-AI-tool state)
 *     are refused.
 *
 * HARDCODED_OFF_LIMITS is a strict subset of OFF_LIMITS_DEFAULT, and
 * off-limits.test.mjs asserts that containment so the two cannot drift apart.
 * Everything in this file is a pattern the shared matchesAtAnyDepth() below
 * will match against a target at any nesting depth.
 */

/** The full project-wide default list, written to project.json by setup. */
export const OFF_LIMITS_DEFAULT = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".sdlc/**",
  ".git/**",
];

/**
 * The pre-contract safety-net subset — enforced when no contract exists, so it
 * holds only paths unsafe to write with no run to scope them: credentials,
 * machine config, another tool's rules, and git's object store.
 *
 * Build output (`dist/**`, `build/**`, `.next/**`, `node_modules/**`) and the
 * plugin's own `.sdlc/**` stay out of this list. A contracted run still
 * enforces them from OFF_LIMITS_DEFAULT; blocking them with no contract
 * refuses ordinary edits in every repository the plugin is installed in.
 */
export const HARDCODED_OFF_LIMITS = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  ".git/**",
];
