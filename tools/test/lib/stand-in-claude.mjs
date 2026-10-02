/**
 * Loaded before every root test file (package.json "test": node --test --import). Zero-touch checks for Claude Code's
 * `claude` program before a new-app workflow or a Claude hand-off, and says so when it is missing; tests of those
 * paths expect a computer with Claude Code, as every person using zero-touch has. A computer without it (GitHub's
 * test runner) gets a stand-in (stand-in-bin/claude) first on PATH, for this test process and every process it
 * starts. A real `claude` on PATH is never replaced, and tests of the "not installed" case set their own PATH.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hasClaude = String(process.env.PATH ?? "").split(delimiter).some((dir) => {
  if (!dir) return false;
  try { accessSync(join(dir, "claude"), constants.X_OK); return true; } catch { return false; }
});
if (!hasClaude) {
  const standIn = resolve(fileURLToPath(import.meta.url), "..", "stand-in-bin");
  process.env.PATH = [standIn, process.env.PATH].filter(Boolean).join(delimiter);
}
