/**
 * Worker jobs and the files they hold.
 *
 * Two jobs preparing changes to the SAME file against the same snapshot would
 * each pass the exact-base check and the second to land would find the first
 * one's file "stale"; worse, their briefs would describe a file the other is
 * about to change. So a job holds every file it declared, and a job that
 * shares a file with a running one waits. Jobs on different files run side by
 * side, up to `maxParallel`: eighteen one-file test jobs once waited in a
 * single line, half a minute each, while the model polled for them.
 *
 * One record per running job under <MMO_HOME>/locks/<repo>/: pid, time and
 * the files held. A record whose process is gone, or older than the longest a
 * job may run, is stale and cleared. A job that declares no files holds the
 * whole repository (a probe, or a caller from before per-file locks). A tiny
 * mutex file guards the read-then-write, so two starts in the same instant
 * cannot both pass the overlap check.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createExclusive, ensureDir, mmoHome } from "./paths.mjs";
import { repoKey } from "./repo-stats.mjs";

const STALE_MS = 10 * 60 * 1000;
const MUTEX_STALE_MS = 10 * 1000;

function lockDir(repoRoot, env) {
  return join(mmoHome(env), "locks", repoKey(repoRoot));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Live job records in the repository, stale ones removed on the way. */
function liveJobs(dir) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return out; }
  for (const name of names) {
    const file = join(dir, name);
    let rec = null;
    try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable: stale */ }
    if (rec && alive(rec.pid) && Date.now() - rec.at < STALE_MS) out.push(rec);
    else rmSync(file, { force: true });
  }
  return out;
}

function withMutex(dir, fn) {
  const mutex = join(dir, ".mutex");
  const deadline = Date.now() + 2000;
  for (;;) {
    if (createExclusive(mutex, String(process.pid))) break;
    let stale = true;
    try { stale = Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS; } catch { stale = true; }
    if (stale) { rmSync(mutex, { force: true }); continue; }
    if (Date.now() > deadline) return false; // another start is mid-way; the caller queues and tries again
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try { return fn(); } finally { rmSync(mutex, { force: true }); }
}

const overlaps = (a, b) => a.length === 0 || b.length === 0 || a.some((p) => b.includes(p));

/**
 * Takes the files for `jobId`. Returns true when the job may run now; false
 * when a running job holds one of its files (or the whole repository), or the
 * repository already runs `maxParallel` jobs. Never throws.
 */
export function acquireJobLock(repoRoot, jobId, env = process.env, { paths = [], maxParallel = 4 } = {}) {
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "locks"));
  const dir = lockDir(repoRoot, env);
  mkdirSync(dir, { recursive: true });
  const held = paths.map(String);
  const taken = withMutex(dir, () => {
    const live = liveJobs(dir);
    if (live.some((j) => j.job === jobId)) return true;
    if (live.length >= Math.max(1, maxParallel)) return false;
    if (live.some((j) => overlaps(j.paths ?? [], held))) return false;
    return createExclusive(join(dir, jobId + ".json"), JSON.stringify({ pid: process.pid, job: jobId, at: Date.now(), paths: held }));
  });
  return taken === true;
}

export function releaseJobLock(repoRoot, jobId, env = process.env) {
  try { rmSync(join(lockDir(repoRoot, env), jobId + ".json"), { force: true }); } catch { /* already released */ }
}
