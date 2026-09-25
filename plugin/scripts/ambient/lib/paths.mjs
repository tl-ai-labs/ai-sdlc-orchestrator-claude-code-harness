/**
 * Where ambient mode keeps its local state, and the permissions it is kept under.
 *
 * Everything lives under one per-user directory (default `~/.mmo-ambient`, override
 * with MMO_HOME for tests). Directories are 0700 and files 0600 because the
 * records can name file paths and commands: other local accounts must not be
 * able to read them. Nothing here is ever written inside a repository, so a
 * worktree, a fresh clone or `git clean` cannot lose or leak it.
 */
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function mmoHome(env = process.env) {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/**
 * Session ids arrive from hook input and become directory names. An id that is
 * not a plain token is replaced by a hash of itself, so a crafted id can never
 * walk out of the sessions directory.
 */
export function safeId(id) {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

/** mkdir -p with 0700 on every level this call creates; chmod covers a loose umask. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change; reads still work */ }
  return dir;
}

export function sessionDir(sessionId, env = process.env) {
  return join(mmoHome(env), "sessions", safeId(sessionId));
}

export function ensureSessionDir(sessionId, env = process.env) {
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "sessions"));
  return ensureDir(sessionDir(sessionId, env));
}

/** Append-only write of one small buffer, file created 0600. */
export function appendPrivate(file, text) {
  const fd = openSync(file, "a", 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/**
 * Create a file only if it does not exist yet. Returns true when this call
 * created it. Used for markers that must have exactly one writer (the arm).
 */
export function createExclusive(file, text) {
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    throw e;
  }
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return true;
}
