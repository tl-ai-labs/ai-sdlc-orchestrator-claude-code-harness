#!/usr/bin/env node
/**
 * test-mcp.mjs — chains the bundled MCP server's own test suite into the
 * root `npm test`.
 *
 * The server is a separate npm package written in TypeScript, and its tests
 * run against the compiled output, so they need its dependencies installed.
 * The root suite deliberately needs nothing installed at all — `npm test` on
 * a fresh clone is a check a first-time user should be able to run before
 * anything else — so the two cannot simply be globbed together.
 *
 * The rule here: run the server's tests when the server is installed, and
 * when it is not, say so loudly and name the command that fixes it. What this
 * never does is pass silently, which would report a green suite while a whole
 * package went untested.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(ROOT, "plugin", "mcp", "gemini-flash-server");

if (!existsSync(join(SERVER_DIR, "node_modules"))) {
  console.log(
    "\n! MCP server tests NOT RUN — plugin/mcp/gemini-flash-server has no installed\n" +
      "  dependencies, so its TypeScript cannot be compiled. Everything above passed.\n" +
      "  To include them:  npm run verify -- --fix   (then re-run npm test)\n",
  );
  process.exit(0);
}

console.log("\n> MCP server tests (plugin/mcp/gemini-flash-server)\n");
const result = spawnSync("npm", ["test"], { cwd: SERVER_DIR, stdio: "inherit" });
process.exit(result.status ?? 1);
