#!/usr/bin/env node
/**
 * Lands a checked worker change in the real working tree, or takes it back.
 *
 *   node apply.mjs <job-id> <sha256-of-change.json>
 *   node apply.mjs --undo <job-id>
 *
 * The thinker runs this through its own Bash tool, so Claude Code shows the
 * command and asks as it would for any other. The hash in the command line is
 * the contract: what was reviewed is what is applied, byte for byte.
 *
 * Why not `git apply <file>`: a patch file can rename, change modes, create
 * symlinks and write outside the declared files, and its content is whatever
 * is on disk at the moment it runs. Here every file is named, hashed and
 * checked again, right before it is written:
 *   - change.json must hash to the value on the command line
 *   - every path is re-checked against the hard-deny list
 *   - the landing path must be inside the repo with no symlink on the way
 *   - the file on disk must still be the exact base the worker was shown
 *     ("stale" otherwise, and NOTHING is written)
 *   - pre-images are saved first, writes are atomic, and a failure half way
 *     rolls back what was already written
 *
 * Undo restores a pre-image only while the file still holds exactly what this
 * job wrote. A file edited since then is left alone and reported.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isHardDenied, isSecretFile, safeRelPath } from "./lib/deny-paths.mjs";
import { ensureDir, ensureSessionDir, mmoHome, safeId, sessionDir } from "./lib/paths.mjs";
import { appendEvent } from "./lib/events.mjs";
import { recordLanding } from "./lib/evidence.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function jobDir(jobId, env = process.env) {
  return join(mmoHome(env), "jobs", safeId(jobId));
}

/** Writes change.json for a checked change and returns the hash the apply command must carry. */
export function stageJob(jobId, { repoRoot, files, edits = [] }, env = process.env) {
  const dir = jobDir(jobId, env);
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "jobs"));
  ensureDir(dir);
  // `edits` are the find/replace pairs that passed the checks, kept in order.
  // A small change lands as native Edits: the thinker sends a marker Edit and a
  // hook swaps in edits[n], so the hunks must be stored exactly as checked.
  const text = JSON.stringify({ schema_version: 1, repo_root: repoRoot, files, edits }, null, 2);
  writeFileSync(join(dir, "change.json"), text, { mode: 0o600 });
  writeFileSync(join(dir, "staged.sha256"), sha256(text), { mode: 0o600 });
  return { dir, sha256: sha256(text) };
}

/** The real directory a file will be written into; throws when any part of the way is a symlink or leaves the repo. */
export function checkedTarget(repoRoot, rel) {
  const realRoot = realpathSync(repoRoot);
  let dir = realRoot;
  const parts = rel.split("/");
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    if (existsSync(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${rel}: ${relative(realRoot, dir)} is not a plain directory`);
    }
  }
  const target = join(realRoot, ...parts);
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${rel}: not a regular file`);
  }
  const back = relative(realRoot, target);
  if (back.startsWith(".." + sep) || back === "..") throw new Error(`${rel}: outside the repository`);
  return target;
}

function atomicWrite(target, content, mode) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + ".mmo-tmp-" + process.pid;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, target);
}

/**
 * `runTests`: after a successful landing, run the job's declared test command
 * (job.json `test_command`, named by the thinker in the tool call) in the
 * repository, inside the thinker's own Bash call, and report pass or fail with
 * the last lines of output. The landing's verdict then settles at once instead
 * of waiting for a later test run the hook happens to see. Files stay written
 * either way; `--undo` takes them back. Nothing runs on its own: the thinker
 * chose the command and runs this program.
 */
function runDeclaredTests(dir, repoRoot, env) {
  let command = null;
  try { command = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")).test_command ?? null; } catch { /* no record */ }
  if (typeof command !== "string" || !command.trim()) return { ran: false, reason: "no test command was declared for this job; run the tests yourself" };
  const t0 = Date.now();
  let out = "";
  let code = 0;
  try {
    out = execFileSync("sh", ["-c", command], { cwd: repoRoot, env, timeout: 600_000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 1;
    out = (e?.stdout?.toString?.() ?? "") + (e?.stderr?.toString?.() ?? "") + (e?.status === null ? "\n(test command killed: timeout or signal)" : "");
  }
  const lines = out.split("\n");
  return { ran: true, command, passed: code === 0, exit_code: code, ms: Date.now() - t0, tail: lines.slice(-40).join("\n") };
}

export function applyJob(jobId, expectedSha, env = process.env, { runTests = false, by = "thinker" } = {}) {
  const dir = jobDir(jobId, env);
  const text = readFileSync(join(dir, "change.json"), "utf8");
  if (sha256(text) !== expectedSha) return { ok: false, reason: "hash-mismatch", detail: "change.json is not the change that was reviewed" };
  if (existsSync(join(dir, "applied.json"))) return { ok: false, reason: "already-applied" };
  const change = JSON.parse(text);

  // Pass 1: decide everything before touching anything.
  const plan = [];
  for (const f of change.files) {
    const rel = safeRelPath(f.path);
    if (!rel || isHardDenied(rel) || isSecretFile(rel)) return { ok: false, reason: "denied-path", detail: String(f.path) };
    if (sha256(f.new_content) !== f.new_sha256) return { ok: false, reason: "content-hash-mismatch", detail: rel };
    let target;
    try { target = checkedTarget(change.repo_root, rel); } catch (e) { return { ok: false, reason: "unsafe-target", detail: e.message }; }
    const exists = existsSync(target);
    if (f.base_sha256 === null) {
      if (exists) return { ok: false, reason: "stale", detail: `${rel} was created since the snapshot` };
      plan.push({ rel, target, pre: null, mode: 0o644, content: f.new_content, new_sha256: f.new_sha256 });
    } else {
      if (!exists) return { ok: false, reason: "stale", detail: `${rel} no longer exists` };
      const pre = readFileSync(target);
      if (sha256(pre) !== f.base_sha256) return { ok: false, reason: "stale", detail: `${rel} changed since the worker was shown it` };
      plan.push({ rel, target, pre, mode: lstatSync(target).mode & 0o777, content: f.new_content, new_sha256: f.new_sha256 });
    }
  }

  // Pass 2: save pre-images, then write. A failure restores what was written.
  ensureDir(join(dir, "pre"));
  plan.forEach((p, i) => { if (p.pre) writeFileSync(join(dir, "pre", String(i)), p.pre, { mode: 0o600 }); });
  const done = [];
  try {
    for (const p of plan) { atomicWrite(p.target, p.content, p.mode); done.push(p); }
  } catch (e) {
    for (const p of done) { if (p.pre) atomicWrite(p.target, p.pre, p.mode); else rmSync(p.target, { force: true }); }
    return { ok: false, reason: "write-failed", detail: e.message };
  }
  const record = { applied_at: new Date().toISOString(), repo_root: change.repo_root, files: plan.map((p, i) => ({ path: p.rel, pre: p.pre ? String(i) : null, new_sha256: p.new_sha256, mode: p.mode })) };
  writeFileSync(join(dir, "applied.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  // A landed job waits for PROOF: a later passing test run (held), an undo or a rewrite of one of
  // its files by the thinker before any passing run (wrong). A failed test run alone settles nothing.
  // One small marker per job, in the chat's folder, naming the cell and the files. A job whose
  // declared tests already ran in the scratch copy was judged at hand-back and waits for nothing.
  try {
    const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    if (typeof job.session === "string" && typeof job.cell === "string") {
      if (!job.verdict_at_handback) {
        const pending = join(ensureSessionDir(job.session, env), "landed-pending");
        ensureDir(pending);
        writeFileSync(join(pending, safeId(jobId)), JSON.stringify({ cell: job.cell, files: plan.map((p) => p.rel) }), { mode: 0o600 });
      }
      appendEvent(job.session, "job.applied", { job: jobId, cell: job.cell, files: plan.length, by, judged_at_handback: job.verdict_at_handback ?? undefined }, env);
    }
  } catch { /* an unreadable job record never blocks a landing */ }
  const result = { ok: true, files: plan.map((p) => p.rel) };
  if (runTests) {
    result.tests = runDeclaredTests(dir, change.repo_root, env);
    if (result.tests.ran) {
      // A passing run right after landing proves the change held. A failing one proves only that the
      // project fails; the marker stays and an undo or a rewrite settles it. A job judged in the
      // scratch copy at hand-back is not judged twice.
      try {
        const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
        if (typeof job.cell === "string" && !job.verdict_at_handback && result.tests.passed) {
          recordLanding(job.cell, "good", env);
          if (typeof job.session === "string") {
            rmSync(join(sessionDir(job.session, env), "landed-pending", safeId(jobId)), { force: true });
            appendEvent(job.session, "job.outcome", { job: jobId, cell: job.cell, outcome: "good", via: "apply-test", exit_code: result.tests.exit_code }, env);
          }
        }
      } catch { /* the verdict is a bonus; the landing already happened */ }
      result.next = result.tests.passed ? "Tests passed. Carry on." : "Tests failed. Read the tail, then either fix it yourself or take the change back with `--undo`.";
    }
  }
  return result;
}

export function undoJob(jobId, env = process.env) {
  const dir = jobDir(jobId, env);
  if (!existsSync(join(dir, "applied.json"))) return { ok: false, reason: "not-applied" };
  const record = JSON.parse(readFileSync(join(dir, "applied.json"), "utf8"));
  const restored = [];
  const left = [];
  for (const f of record.files) {
    let target;
    try { target = checkedTarget(record.repo_root, f.path); } catch { left.push({ path: f.path, why: "unsafe-target" }); continue; }
    if (!existsSync(target)) { left.push({ path: f.path, why: "missing" }); continue; }
    if (sha256(readFileSync(target)) !== f.new_sha256) { left.push({ path: f.path, why: "edited-since" }); continue; }
    if (f.pre === null) rmSync(target, { force: true });
    else atomicWrite(target, readFileSync(join(dir, "pre", f.pre)), f.mode);
    restored.push(f.path);
  }
  if (left.length === 0) renameSync(join(dir, "applied.json"), join(dir, "undone.json"));
  // Taking a change back is the clearest "wrong" there is; the cell learns it at once.
  try {
    const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    if (typeof job.cell === "string") {
      recordLanding(job.cell, "bad", env);
      if (typeof job.session === "string") {
        rmSync(join(sessionDir(job.session, env), "landed-pending", safeId(jobId)), { force: true });
        appendEvent(job.session, "job.outcome", { job: jobId, cell: job.cell, outcome: "bad", via: "undo" }, env);
      }
    }
  } catch { /* nothing to learn from an unreadable record */ }
  return { ok: left.length === 0, restored, left };
}

/** "Kept" is read from the files, never from events: does each file still hold what the job wrote? */
export function keptStatus(jobId, env = process.env) {
  const dir = jobDir(jobId, env);
  if (!existsSync(join(dir, "applied.json"))) return null;
  const record = JSON.parse(readFileSync(join(dir, "applied.json"), "utf8"));
  const kept = record.files.filter((f) => {
    try { return sha256(readFileSync(join(realpathSync(record.repo_root), ...f.path.split("/")))) === f.new_sha256; } catch { return false; }
  });
  return { files: record.files.length, kept: kept.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let result;
  try {
    if (args[0] === "--undo" && args[1]) result = undoJob(args[1]);
    else if ((args.length === 2 || (args.length === 3 && args[2] === "--test")) && /^[0-9a-f]{64}$/.test(args[1])) result = applyJob(args[0], args[1], process.env, { runTests: args[2] === "--test" });
    else result = { ok: false, reason: "usage", detail: "apply.mjs <job-id> <sha256> [--test] | apply.mjs --undo <job-id>" };
  } catch (e) {
    result = { ok: false, reason: "error", detail: e.message };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}
