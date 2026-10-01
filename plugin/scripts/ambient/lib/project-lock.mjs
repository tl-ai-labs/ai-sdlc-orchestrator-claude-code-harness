/**
 * One workflow at a time in one project (0.8.4, zero-touch chats only).
 *
 * Why: two chats in the same folder, each running a workflow, write into the same `.sdlc/runs/`, and each chat's
 * reading of "has my workflow ended?" (lib/workflow-log.mjs) could then see the other's run. The lock is one file
 * per project under MMO_HOME, `projects/<key>/workflow.json` ({ sid, since, job }), the key a hash of the project's
 * real path, written when a zero-touch chat starts a workflow and removed when it ends there.
 *
 * Whether a lock still holds is decided from facts each time, never from its age: the owning chat must still be
 * running a workflow (its `sessions/<id>/pipeline` record exists; /clear and a workflow's end remove it) and that
 * workflow's own log must not show it ended. A lock that fails either test is stale and is replaced.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, mmoHome, safeId, sessionDir } from "./paths.mjs";
import { RUN_ID, workflowState } from "./workflow-log.mjs";

function key(projectDir) {
  let real = String(projectDir ?? "");
  try { real = realpathSync(real); } catch { /* keep the given path */ }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}
function lockFile(projectDir, env) {
  return join(mmoHome(env), "projects", key(projectDir), "workflow.json");
}
function readLock(projectDir, env) {
  try { return JSON.parse(readFileSync(lockFile(projectDir, env), "utf8")); } catch { return null; }
}

/** When the chat's workflow started, from its `pipeline` record (JSON since 0.8.4, a bare time before). */
export function pipelineSinceOf(sid, env = process.env) {
  const file = join(sessionDir(sid, env), "pipeline");
  try {
    const text = readFileSync(file, "utf8").trim();
    let since = text;
    try { const rec = JSON.parse(text); if (rec && typeof rec === "object") since = rec.since; } catch { /* a bare time */ }
    const ms = Date.parse(since);
    return Number.isFinite(ms) ? ms : NaN;
  } catch { return NaN; }
}

/** The run the chat has claimed as its workflow's own (hook.mjs claimRun), or null before it has. */
export function pipelineRunOf(sid, env = process.env) {
  try {
    const rec = JSON.parse(readFileSync(join(sessionDir(sid, env), "pipeline"), "utf8"));
    return rec && typeof rec.run_id === "string" && RUN_ID.test(rec.run_id) ? rec.run_id : null;
  } catch { return null; }
}

/**
 * Whether another chat has claimed this run as its own (its pipeline record names it). Read only when a run is about
 * to be stopped without a claim of this chat's (hook.mjs, "Replace it"), so a run another chat owns is never stopped.
 */
export function runClaimedByOther(runId, sid, env = process.env) {
  if (!runId || !RUN_ID.test(runId)) return false;
  const root = join(mmoHome(env), "sessions");
  let names = [];
  try { names = readdirSync(root); } catch { return false; }
  for (const name of names) {
    if (name === safeId(sid)) continue;
    if (pipelineRunOf(name, env) === runId) return true;
  }
  return false;
}

/** The chat that holds this project, when it is another chat whose workflow is still running; else null. */
export function heldByOther(projectDir, sid, env = process.env) {
  const lock = readLock(projectDir, env);
  if (!lock || lock.sid === sid) return null;
  if (!existsSync(join(sessionDir(lock.sid, env), "pipeline"))) return null;
  const since = pipelineSinceOf(lock.sid, env);
  if (workflowState(projectDir, since, pipelineRunOf(lock.sid, env)).state === "ended") return null;
  return lock;
}

export function acquire(projectDir, sid, job, env = process.env) {
  const file = lockFile(projectDir, env);
  ensureDir(join(mmoHome(env), "projects"));
  ensureDir(join(mmoHome(env), "projects", key(projectDir)));
  writeFileSync(file, JSON.stringify({ sid, job, since: new Date().toISOString() }), { mode: 0o600 });
}

/** Removes the lock when this chat holds it. */
export function release(projectDir, sid, env = process.env) {
  const lock = readLock(projectDir, env);
  if (lock && lock.sid === sid) { try { rmSync(lockFile(projectDir, env), { force: true }); } catch { /* already gone */ } }
}
