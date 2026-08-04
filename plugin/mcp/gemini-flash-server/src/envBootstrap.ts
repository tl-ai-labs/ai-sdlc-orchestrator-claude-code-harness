/**
 * Side-effect module: sanitize the process environment before anything reads it.
 *
 * WHY THIS IS A SEPARATE FILE RATHER THAN A CALL AT THE TOP OF server.ts
 *
 * ES module imports are hoisted and every imported module is fully evaluated before
 * the importing module's own body runs. A `sanitizePluginEnv()` call written as the
 * first statement of server.ts would therefore execute *after* @google/genai,
 * @anthropic-ai/sdk and our adapter modules had already been evaluated. Those are
 * third-party trees we do not control, and a dependency that reads process.env at
 * module scope — today or after a future upgrade — would capture the unexpanded
 * placeholder before we ever got to strip it.
 *
 * Importing this module first is the only ordering guarantee the language gives us:
 * imports are evaluated in source order, so a side-effect import placed above the
 * others provably runs before them. This is the same reason `import "dotenv/config"`
 * exists as a side-effect entry rather than a function call.
 *
 * Keeping the side effect here — and keeping env.ts free of one — means env.ts stays
 * importable from unit tests without mutating the test runner's own environment.
 */
import { sanitizePluginEnv } from "./env.js";

const removed = sanitizePluginEnv();

if (removed.length > 0) {
  // stderr, never stdout: stdout on this process is the MCP stdio transport and any
  // stray byte written there corrupts the JSON-RPC framing. Names only, never values —
  // the stripped set includes API keys, and a partially-substituted placeholder could
  // carry a real secret.
  process.stderr.write(
    `[gemini-flash-server] ignored ${removed.length} unset environment ` +
      `variable(s) that arrived as unexpanded placeholders: ${removed.join(", ")}. ` +
      `Credential discovery will fall back to Application Default Credentials.\n`,
  );
}
