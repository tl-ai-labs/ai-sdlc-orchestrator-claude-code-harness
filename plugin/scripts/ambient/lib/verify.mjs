/**
 * Verification before hand-back (the pipeline's 0.7.4 change 2, brought to the chat):
 * the server runs the job's declared test command against the worker's change
 * in a SCRATCH COPY of the project before the thinker ever hears of it. A
 * failing run goes back to the worker with the tail of the output; the thinker
 * is told only after the retries. Measured on the pipeline: "test run and
 * fixes" fell from $2.54 to about zero per run.
 *
 * The scratch copy is a detached git worktree of the job's snapshot tree (so
 * it holds exactly what the worker was shown, untracked files included), with
 * the checked files written over it and the repository's ignored top-level
 * entries (node_modules, .venv, build caches) linked in so the tests can run.
 * The real working tree is never touched. The worktree is removed afterwards,
 * whatever happened.
 *
 * Nothing runs on its own: the thinker named the test command in the tool
 * call, the setting `jobs.verify_before_handback` is on, and the worker still
 * never executes anything; this is the plugin's own code running the person's
 * own test command in a copy of their project.
 */
import { execFileSync } from "node:child_process";

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, mmoHome, safeId } from "./paths.mjs";

const GIT_ENV = { GIT_AUTHOR_NAME: "mmo", GIT_AUTHOR_EMAIL: "mmo@localhost", GIT_COMMITTER_NAME: "mmo", GIT_COMMITTER_EMAIL: "mmo@localhost" };

function git(repoRoot, args, env) {
  return execFileSync("git", args, { cwd: repoRoot, env: { ...env, ...GIT_ENV }, timeout: 20000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

/** Top-level entries git ignores in the repository (dependency folders, build caches): linked into the scratch copy. */
function ignoredTopLevel(repoRoot, env) {
  try {
    const out = git(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], env);
    const names = new Set();
    for (const entry of out.split("\0")) {
      const top = entry.replace(/\/$/, "").split("/")[0];
      if (top && !top.startsWith(".git")) names.add(top);
    }
    return [...names];
  } catch { return []; }
}

/** Runs one command in a directory; returns { code, tail } or null when it could not run. */
function runIn(dir, testCommand, env, timeoutMs) {
  if (!dir) return null;
  try {
    const out = execFileSync("sh", ["-c", testCommand], { cwd: dir, env, timeout: timeoutMs, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { code: 0, tail: out.split("\n").slice(-20).join("\n").slice(-2000) };
  } catch (e) {
    const out = (e?.stdout?.toString?.() ?? "") + (e?.stderr?.toString?.() ?? "");
    return { code: typeof e?.status === "number" ? e.status : 1, tail: out.split("\n").slice(-20).join("\n").slice(-2000) };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp copy we cannot remove is not a failed job */ } }
}

/** The same snapshot tree with NO worker change written over it, for the baseline question above. */
function baselineCopy(repoRoot, jobId, tree, env) {
  const dir = join(mmoHome(env), "verify", safeId(jobId) + "-base-" + Date.now().toString(36));
  try {
    const commit = git(repoRoot, ["commit-tree", tree, "-m", "mmo baseline " + jobId], env);
    git(repoRoot, ["worktree", "add", "--detach", dir, commit], env);
    for (const name of ignoredTopLevel(repoRoot, env)) {
      const src = join(repoRoot, name), dst = join(dir, name);
      if (existsSync(src) && !existsSync(dst)) { try { symlinkSync(src, dst); } catch { /* a link we cannot make is a test we cannot help */ } }
    }
    return dir;
  } catch { return null; }
}

/**
 * Runs `testCommand` against `files` (path + new_content) written over the
 * snapshot tree `commit`. Returns { ran, passed, exit_code, ms, tail } or
 * { ran: false, reason } when no copy could be made.
 */
export function verifyInScratchCopy({ jobId, repoRoot, tree, files, testCommand, baselineShouldPass = false, env = process.env, timeoutMs = 600000 }) {
  if (typeof testCommand !== "string" || !testCommand.trim()) return { ran: false, reason: "no test command was declared for this job" };
  const base = join(mmoHome(env), "verify");
  ensureDir(base);
  const dir = join(base, safeId(jobId) + "-" + Date.now().toString(36));
  let commit;
  try {
    commit = git(repoRoot, ["commit-tree", tree, "-m", "mmo verify " + jobId], env);
    git(repoRoot, ["worktree", "add", "--detach", dir, commit], env);
  } catch (e) {
    return { ran: false, reason: "no scratch copy could be made: " + String(e?.message ?? e).slice(0, 160) };
  }
  const t0 = Date.now();
  try {
    for (const f of files) {
      const target = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.new_content);
    }
    for (const name of ignoredTopLevel(repoRoot, env)) {
      const src = join(repoRoot, name);
      const dst = join(dir, name);
      if (existsSync(src) && !existsSync(dst)) { try { symlinkSync(src, dst); } catch { /* a link we cannot make is a test we cannot help */ } }
    }
    let out = "";
    let code = 0;
    try {
      out = execFileSync("sh", ["-c", testCommand], { cwd: dir, env, timeout: timeoutMs, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      code = typeof e?.status === "number" ? e.status : 1;
      out = (e?.stdout?.toString?.() ?? "") + (e?.stderr?.toString?.() ?? "") + (e?.status === null ? "\n(test command killed: timeout or signal)" : "");
    }
    const tail = out.split("\n").slice(-60).join("\n").slice(-6000);
    // Did ANY test actually execute? A runner that dies in its own setup — a broken
    // jest globalSetup, a config error, a module that throws on load, no tests found —
    // reports a failed run while never judging the change. 23 Sep, pair 11: six worker
    // attempts, one on Flash and five on Sonnet after the cascade, all failing on the
    // same crash in a setup file the THINKER wrote; $1.71 and 22 minutes spent
    // re-judging correct files with a judge that could not start. Every runner we
    // support says how many tests it ran; when none of them does, no test ran.
    // A failing run does not always mean a failing CHANGE. A runner that dies in its own
    // setup — a broken jest globalSetup, a config error, a module that throws on load, no
    // tests found — reports failure while never judging anything. 23 Sep, pair 11: six
    // worker attempts (one Flash, five Sonnet after the cascade) all died on the same
    // crash in a setup file the THINKER had written; $1.71 and 22 minutes re-judging
    // correct files with a judge that could not start. No pattern of runner output can
    // tell the two apart — a bare assertion script prints nothing either way — but one
    // question can, and it is decisive: does the SAME command already fail on the same
    // tree WITHOUT the worker's change? If it does, the harness is broken and the change
    // is irrelevant. This costs one extra run, only when a run fails, and it knows
    // nothing about any test framework, so it holds on a task nobody has seen.
    // A failing run does not always mean a failing CHANGE. A runner that dies in its own
    // setup — a broken jest globalSetup, a config error, a module that throws on load —
    // reports failure while never judging anything. 23 Sep, pair 11: six worker attempts
    // (one Flash, five Sonnet after the cascade) all died on the same crash in a setup
    // file the THINKER had written; $1.71 and 22 minutes re-judging correct files with a
    // judge that could not start. The decisive question is whether the same command
    // ALREADY fails on the same tree without the worker's change — and it is only a fair
    // question for a job whose contract expects the suite green beforehand. A bug fix
    // declares the repro command, which MUST fail beforehand (that failure is the bug),
    // so it is never asked. This knows nothing about any test framework, so it holds on a
    // task nobody has seen, and it costs one extra run only when a run has already failed.
    if (code !== 0 && baselineShouldPass) {
      const before = runIn(baselineCopy(repoRoot, jobId, tree, env), testCommand, env, timeoutMs);
      if (before && before.code !== 0) {
        return { ran: false, harness: true, exit_code: code, ms: Date.now() - t0, tail,
          baseline_tail: before.tail,
          reason: "the test command already fails on this project without the worker's change, so nothing was judged: fix the test command or its setup yourself, then run the job again" };
      }
    }
    return { ran: true, passed: code === 0, exit_code: code, ms: Date.now() - t0, tail };
  } finally {
    try { git(repoRoot, ["worktree", "remove", "--force", dir], env); } catch { rmSync(dir, { recursive: true, force: true }); }
    try { git(repoRoot, ["worktree", "prune"], env); } catch { /* nothing to prune */ }
  }
}
