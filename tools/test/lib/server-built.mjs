/**
 * Some root tests call the workflows' own run-start check (plugin/scripts/driver-model-check.mjs), which imports the
 * bundled server's built router (plugin/mcp/model-dispatch/dist). A fresh clone has no dist yet. Build it when its
 * dependencies are installed; otherwise say loudly that those tests are NOT run, as tools/test-mcp.mjs does for the
 * server suite. Never pass silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const SERVER = join(ROOT, "plugin", "mcp", "model-dispatch");

/** null when the server is built (or was just built); else the reason the dependent tests are skipped. */
export function serverBuilt() {
  if (existsSync(join(SERVER, "dist", "routing.js")) && existsSync(join(SERVER, "dist", "policy.js"))) return null;
  if (!existsSync(join(SERVER, "node_modules"))) {
    const why = "NOT RUN: the bundled server is not built and its dependencies are not installed (npm run verify -- --fix, then npm test)";
    console.log(`\n! ${why}\n`);
    return why;
  }
  execFileSync("npm", ["run", "build"], { cwd: SERVER, stdio: "ignore" });
  return null;
}
