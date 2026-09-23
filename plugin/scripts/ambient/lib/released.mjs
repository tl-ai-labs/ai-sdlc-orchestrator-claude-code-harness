/**
 * Files the thinker may type itself although a worker would be cheaper: a job
 * for them FAILED (after the resends and the cascade), or the gate refused it
 * as too small. The server writes the marker; the hook reads it before refusing
 * a by-hand write. One empty file per path hash under the chat's folder, never
 * the path itself.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDir, ensureSessionDir, sessionDir } from "./paths.mjs";

/**
 * The hook writes the path the editor handed it; the server writes the one git
 * reports, which has every symbolic link resolved (on macOS a project under
 * /var is really under /private/var). Two spellings of one file would be two
 * different markers, so both sides hash the resolved spelling. The file itself
 * may not exist yet, which is the whole point of the marker, so the FOLDER is
 * resolved and the name put back on. A path that cannot be resolved at all is
 * hashed as it came.
 */
const canonical = (absPath) => {
  const p = String(absPath);
  try { return realpathSync(p); } catch { /* not there yet */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
};

const key = (absPath) => createHash("sha256").update(canonical(absPath)).digest("hex").slice(0, 32);

export function releaseFile(sessionId, absPath, env = process.env) {
  const dir = join(ensureSessionDir(sessionId, env), "released");
  ensureDir(dir);
  writeFileSync(join(dir, key(absPath)), "", { mode: 0o600 });
}

export function isReleased(sessionId, absPath, env = process.env) {
  return existsSync(join(sessionDir(sessionId, env), "released", key(absPath)));
}
