/**
 * Which files this session has only PARTLY shown the model, because a read was
 * replaced by an outline. One marker file per path, so there is no shared JSON
 * to corrupt when two hooks run at once.
 *
 * Claude Code allows Write after a read that a hook shortened (it sets no
 * partial-view notice), so without this record a file the model never saw in
 * full could be overwritten whole.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, ensureSessionDir, sessionDir } from "./paths.mjs";

function markerPath(sessionId, absPath, env) {
  const name = createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  return join(sessionDir(sessionId, env), "partial", name);
}

export function markPartial(sessionId, absPath, env = process.env) {
  ensureSessionDir(sessionId, env);
  ensureDir(join(sessionDir(sessionId, env), "partial"));
  writeFileSync(markerPath(sessionId, absPath, env), absPath, { mode: 0o600 });
}

export function isPartial(sessionId, absPath, env = process.env) {
  return existsSync(markerPath(sessionId, absPath, env));
}

export function clearPartial(sessionId, absPath, env = process.env) {
  try { rmSync(markerPath(sessionId, absPath, env), { force: true }); } catch { /* already gone */ }
}
