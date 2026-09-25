/**
 * Text-only checks on a change a worker proposed. They run on strings taken
 * from the snapshot, never on the working tree, and they never execute code
 * from the repository. Passing them does NOT mean the change is correct: on
 * measured bug fixes 99% of worker results passed local checks while under
 * half passed the hidden tests. These checks only stop a change that touches
 * what it must not, or that cannot be applied exactly as written. Whether the
 * change is right is decided afterwards by the thinker running the tests.
 *
 *   change = { edits: [{ path, find, replace }], creates: [{ path, content }] }
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { globToRegExp, isHardDenied, isSecretFile, safeRelPath } from "./deny-paths.mjs";
import { sha256 } from "./snapshot.mjs";

const MAX_EDITS = 400;
const MAX_NEW_FILE_BYTES = 512 * 1024;

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + Math.max(needle.length, 1))) n++;
  return n;
}

/** Parser check where one is available without running repository code. */
export function syntaxCheck(path, content) {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    try { JSON.parse(content); return { checked: true, ok: true }; } catch (e) { return { checked: true, ok: false, detail: String(e.message).slice(0, 200) }; }
  }
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    // `node --check file.js` exits 0 on a broken ES module (seen on node 26:
    // the module-style guess swallows the error). The style is therefore named
    // through the extension. A plain .js file may be either style, so it passes
    // when it parses as one of them and fails only when it parses as neither.
    const styles = ext === ".js" ? [".mjs", ".cjs"] : [ext];
    const dir = mkdtempSync(join(tmpdir(), "mmo-syntax-"));
    let detail = "";
    try {
      for (const style of styles) {
        const file = join(dir, "candidate" + style);
        writeFileSync(file, content, { mode: 0o600 });
        try {
          execFileSync(process.execPath, ["--check", file], { timeout: 8000, stdio: ["ignore", "ignore", "pipe"] });
          return { checked: true, ok: true };
        } catch (e) {
          detail ||= String(e.stderr ?? e.message).split("\n").filter((l) => /Error/.test(l)).slice(0, 1).join(" ").slice(0, 300);
        }
      }
      return { checked: true, ok: false, detail };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { checked: false, ok: true };
}

/**
 * `snapshotFiles` is the output of readFromSnapshot for every declared file
 * that exists. `protectedPaths` are files the worker must leave alone (the
 * reproduce test). Returns { ok, failures, files } where files carry the base
 * hash and the full new content, ready for the apply step.
 */
/**
 * The one definition of what a worker job may write, used by the door (a job
 * that commissions a file outside it is refused before anyone is paid) and by
 * the completeness rule (a commissioned job is never asked for such a file).
 * 23 Sep, pair 10: the two had never been reconciled, so a job commissioning
 * jest.config.js was unwinnable: write it and fail hard-deny, leave it out and
 * fail missing-files. Five worker calls were paid to discover that.
 */
export function workerMayWrite(rel, neverDelegate = []) {
  if (isHardDenied(rel) || isSecretFile(rel)) return false;
  return !neverDelegate.map(globToRegExp).some((re) => re.test(rel));
}

export function checkChange(change, { declared, snapshotFiles, protectedPaths = [], neverDelegate = [], salvage = false, commissioned = false, already = [] }) {
  const failures = [];
  // With `salvage`, a change to a file the job may not change is DROPPED and
  // reported with its reason instead of failing the whole answer: nothing out
  // of scope lands either way, and the correct declared files are not thrown
  // away with it (22 Sep: a 22-file job died over one stray file; 23 Sep, pair
  // 7: three Flash answers died in ten seconds over a read-only context file
  // on a greenfield job). That covers files outside the declared list,
  // protected files (the reproduce test, a held-out test, a context file) and
  // never-delegate paths. A create that repeats a read-only file unchanged is
  // a no-op, not a drop. Only secret and hard-denied paths still fail the
  // answer outright. Without `salvage` the old strictness holds.
  const dropped = [];
  const drops = [];
  const dropAs = (rel, why) => { if (!dropped.includes(rel)) { dropped.push(rel); drops.push({ path: rel, why }); } return null; };
  const fail = (gate, path, detail) => failures.push({ gate, path, detail });
  const declaredSet = new Set(declared.map(safeRelPath).filter(Boolean));
  const protectedSet = new Set(protectedPaths);
  const never = neverDelegate.map(globToRegExp);
  const base = new Map(snapshotFiles.map((f) => [f.path, f]));
  const edits = Array.isArray(change?.edits) ? change.edits : [];
  const creates = Array.isArray(change?.creates) ? change.creates : [];
  if (edits.length + creates.length === 0) fail("empty", null, "the change holds no edits");
  if (edits.length + creates.length > MAX_EDITS) fail("too-large", null, `more than ${MAX_EDITS} edits`);

  const pathOk = (raw, item) => {
    const rel = safeRelPath(raw);
    if (!rel) return fail("path", String(raw).slice(0, 80), "not a safe repo-relative path"), null;
    // Most specific reason first: a worker that rewrites a file it may only read
    // is reported as exactly that, not as "outside the declared files".
    if (protectedSet.has(rel)) {
      if (!salvage) return fail("protected", rel, "a file the job may read but not change (the reproduce test, a held-out test or a context file)"), null;
      if (item && typeof item.content === "string" && base.get(rel)?.content === item.content) return null;
      return dropAs(rel, "protected");
    }
    if (isHardDenied(rel) || isSecretFile(rel)) return fail("hard-deny", rel, "a worker job may never change this path"), null;
    if (never.some((re) => re.test(rel))) return salvage ? dropAs(rel, "never_delegate") : (fail("never-delegate", rel, "listed under never_delegate_paths"), null);
    if (!declaredSet.has(rel)) return salvage ? dropAs(rel, "outside") : (fail("declared-files", rel, "outside the files declared for this job"), null);
    return rel;
  };

  const working = new Map();
  for (const e of edits) {
    const rel = pathOk(e?.path);
    if (!rel) continue;
    if (typeof e.find !== "string" || typeof e.replace !== "string" || e.find.length === 0) { fail("edit-shape", rel, "find and replace must be strings, find not empty"); continue; }
    if (e.find === e.replace) { fail("edit-shape", rel, "find and replace are identical"); continue; }
    const file = base.get(rel);
    if (!file) { fail("base", rel, "not a regular file in the snapshot"); continue; }
    const current = working.get(rel) ?? file.content;
    const hits = countOccurrences(current, e.find);
    if (hits !== 1) { fail("find-once", rel, `find text matches ${hits} times; it must match exactly once`); continue; }
    working.set(rel, current.replace(e.find, () => e.replace));
  }
  for (const c of creates) {
    const rel = pathOk(c?.path, c);
    if (!rel) continue;
    if (typeof c.content !== "string" || Buffer.byteLength(c.content) > MAX_NEW_FILE_BYTES || c.content.includes("\0")) { fail("create-shape", rel, "content must be text under the size limit"); continue; }
    if (base.has(rel) || working.has(rel)) { fail("create-exists", rel, "the file already exists; use an edit"); continue; }
    working.set(rel, c.content);
  }

  if (salvage && dropped.length && working.size === 0) {
    // Everything the worker sent was dropped: that is a failed answer, named by its first drop.
    const first = drops[0];
    fail(first.why === "protected" ? "protected" : first.why === "never_delegate" ? "never-delegate" : "declared-files", first.path,
      first.why === "outside" ? "every change was outside the files declared for this job" : "every change was to a file the job may not change");
  }
  // A COMMISSIONED job (one spec, or one list of cases, per file) is finished
  // only when every file it commissioned is in the answer. The checks used to
  // forbid only files OUTSIDE the declared list; absence was never a failure.
  // 23 Sep, pair 9: a fourteen-file job came back with one file, passed here,
  // and was then verified in a scratch copy rebuilt from the snapshot, where
  // the other thirteen did not exist, so the tests could not pass and three
  // attempts bought nothing. Naming the missing files makes the resend exact.
  // An edit job commissions nothing: a file that needs no edit is rightly absent.
  if (commissioned) {
    // `already` are files an earlier attempt got right and the runner is carrying forward,
    // so a retry that repairs one file is complete without resending the rest (the pipeline's 0.7.4 fix 4).
    const have = new Set(already);
    const missing = [...declaredSet].filter((rel) => workerMayWrite(rel, neverDelegate) && !base.has(rel) && !working.has(rel) && !dropped.includes(rel) && !have.has(rel));
    if (missing.length) fail("missing-files", missing[0], `${missing.length} commissioned file${missing.length === 1 ? "" : "s"} not written: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", and more" : ""}`);
  }

  const files = [];
  for (const [rel, content] of working) {
    const syn = syntaxCheck(rel, content);
    if (!syn.ok) fail("syntax", rel, syn.detail);
    const file = base.get(rel);
    files.push({ path: rel, base_sha256: file ? file.sha256 : null, new_sha256: sha256(content), new_content: content, syntax_checked: syn.checked });
  }
  return { ok: failures.length === 0, failures, files, dropped, drops };
}
