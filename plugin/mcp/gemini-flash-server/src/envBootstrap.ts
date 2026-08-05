/**
 * MUST be imported before any SDK. Deletes plugin-declared env vars whose
 * value is the literal `${NAME}` placeholder — the state plugin.json's env
 * pass-throughs leave in the child process when the host never set the
 * variable. ES module evaluation order is the only guarantee this runs before
 * third-party trees (like @google/genai) read process.env.
 */
import { sanitizePluginEnv } from "./env.js";

const removed = sanitizePluginEnv();

if (removed.length > 0) {
  // stderr, never stdout: stdout is the MCP stdio transport and any stray byte
  // corrupts JSON-RPC framing. Names only, never values — the stripped set
  // includes API keys, and a partially-substituted placeholder could carry one.
  process.stderr.write(
    `[gemini-flash-server] ignored ${removed.length} unset environment ` +
      `variable(s) that arrived as unexpanded placeholders: ${removed.join(", ")}. ` +
      `Credential discovery will fall back to Application Default Credentials.\n`,
  );
}
