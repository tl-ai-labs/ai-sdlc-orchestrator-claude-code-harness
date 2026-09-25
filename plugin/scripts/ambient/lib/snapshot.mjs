/**
 * Builds what a worker is shown, from GIT OBJECTS of one snapshot commit.
 *
 * Reading the working tree would follow symlinks, race with edits in flight
 * and pick up files git never tracked. Reading objects of one commit cannot:
 * the brief and the later exact-base check both refer to the same frozen
 * content. `git stash create` captures uncommitted work without touching the
 * index, the stash list or the tree; with nothing to capture, HEAD is used.
 *
 * Every refusal THROWS. The caller ends the job; nothing is sent "anyway".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, isSecretFile, safeRelPath } from "./deny-paths.mjs";
import { scanSecrets } from "./secret-shapes.mjs";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BRIEF_BYTES = 2 * 1024 * 1024;

function git(repoDir, args, { maxBuffer = 4 * 1024 * 1024, indexFile } = {}) {
  return execFileSync("git", args, {
    cwd: repoDir, encoding: "buffer", timeout: 8000, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
    // A clean environment: no pager, no prompts, no optional locks, and no
    // config or hooks pulled in from variables a repository could influence.
    // `indexFile` points git at a throwaway index (the snapshot), never the real one.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
  });
}

export function sha256(bufOrText) {
  return createHash("sha256").update(bufOrText).digest("hex");
}

/** Returns { repoRoot, commit, source } where source is "stash" or "head". */
export function takeSnapshot(repoDir) {
  const repoRoot = git(repoDir, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  // The tree as it is on disk right now, INCLUDING files git does not track
  // yet: in a new project every file the model just wrote is untracked, and a
  // job that cannot see them is refused (16 refusals in one live build).
  // Built in a throwaway index file, so the developer's own index, working
  // tree and stash list are never touched; .gitignore still applies, so
  // node_modules and the like never enter the snapshot.
  const gitDir = git(repoRoot, ["rev-parse", "--git-dir"]).toString("utf8").trim();
  const index = join(gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir), `mmo-snapshot-${process.pid}-${Date.now()}.index`);
  try {
    try { git(repoRoot, ["read-tree", "HEAD"], { indexFile: index }); } catch { /* no commit yet: start from an empty index */ }
    git(repoRoot, ["add", "-A", "--", "."], { indexFile: index });
    const tree = git(repoRoot, ["write-tree"], { indexFile: index }).toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("snapshot: could not write the tree");
    return { repoRoot, commit: tree, source: "index" };
  } finally {
    try { rmSync(index, { force: true }); } catch { /* already gone */ }
  }
}

/** True when `rel` is a tracked entry of the snapshot commit (of any type). */
export function existsInSnapshot(snapshot, rel) {
  return git(snapshot.repoRoot, ["ls-tree", "-z", snapshot.commit, "--", rel]).length > 0;
}

/** `Read(...)` deny rules from Claude Code settings become globs the brief must honour. */
export function readDenyGlobs(settingsObjects) {
  const globs = [];
  for (const s of settingsObjects) {
    for (const rule of s?.permissions?.deny ?? []) {
      const m = /^Read\((.+)\)$/.exec(String(rule));
      if (m) globs.push(m[1].replace(/^\.?\/+/, ""));
    }
  }
  return globs;
}

/**
 * Reads the named files out of the snapshot commit. Returns
 * [{ path, content, sha256, mode }]. Throws on: an unsafe path, a path that is
 * not a regular file in the commit (symlink, submodule, directory, missing), a
 * secret file, a user deny rule, a binary or oversized file, a secret shape.
 */
export function readFromSnapshot(snapshot, paths, { denyGlobs = [] } = {}) {
  const deny = denyGlobs.map(globToRegExp);
  const out = [];
  let total = 0;
  for (const raw of paths) {
    const rel = safeRelPath(raw);
    if (!rel) throw new Error(`snapshot: unsafe path ${JSON.stringify(raw)}`);
    if (isSecretFile(rel)) throw new Error(`snapshot: ${rel} is a secret-bearing file and is never sent`);
    if (deny.some((re) => re.test(rel))) throw new Error(`snapshot: ${rel} is covered by a Read(...) deny rule`);

    const listing = git(snapshot.repoRoot, ["ls-tree", "-z", snapshot.commit, "--", rel]).toString("utf8");
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/.exec(listing);
    if (!m) throw new Error(`snapshot: ${rel} is not in the snapshot (untracked or missing)`);
    const [, mode, type, object] = m;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`snapshot: ${rel} is not a regular file (mode ${mode}); symlinks and submodules are refused`);
    }
    const size = Number(git(snapshot.repoRoot, ["cat-file", "-s", object]).toString("utf8").trim());
    if (!(size <= MAX_FILE_BYTES)) throw new Error(`snapshot: ${rel} is larger than ${MAX_FILE_BYTES} bytes`);
    const buf = git(snapshot.repoRoot, ["cat-file", "blob", object], { maxBuffer: MAX_FILE_BYTES + 1024 });
    if (buf.includes(0)) throw new Error(`snapshot: ${rel} is binary`);
    const content = buf.toString("utf8");
    const findings = scanSecrets(content);
    if (findings.length) throw new Error(`snapshot: ${rel} holds a secret shape (${findings[0].name}, line ${findings[0].line}); job ended`);
    total += buf.length;
    if (total > MAX_BRIEF_BYTES) throw new Error("snapshot: brief is larger than the 2 MB limit");
    out.push({ path: rel, content, sha256: sha256(buf), mode });
  }
  return out;
}

/** The local record of what left the machine: paths, sizes and hashes, never content. */
export function egressManifest(snapshot, files, { worker, door, job }) {
  return {
    at: new Date().toISOString(), job, worker, door, commit: snapshot.commit, snapshot_source: snapshot.source,
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: f.sha256 })),
  };
}
