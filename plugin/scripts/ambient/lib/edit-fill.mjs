/**
 * Landing a small checked change as NATIVE edits. The thinker sends
 *
 *     Edit { file_path: <the real file>, old_string: "mmo-apply:<job>:<n>", new_string: <anything> }
 *
 * and this module returns the input that replaces it: the find/replace pair
 * number n of that staged job, exactly as the checks approved it. The thinker
 * spends about twenty output tokens per hunk instead of re-typing the code, and
 * the person still gets Claude Code's own diff view, approval, checkpoint and
 * rewind, because a real Edit is what runs.
 *
 * This is a safety check, so every doubt REFUSES (the caller turns a refusal
 * into a deny). Nothing here ever falls back to "let the marker Edit through".
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedTarget, jobDir } from "../apply.mjs";
import { isHardDenied, isSecretFile, safeRelPath } from "./deny-paths.mjs";
import { ensureDir } from "./paths.mjs";

const MARKER = /^mmo-apply:([A-Za-z0-9_-]{1,80}):(\d{1,3})$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function parseMarker(oldString) {
  const m = MARKER.exec(String(oldString ?? "").trim());
  return m ? { jobId: m[1], n: Number(m[2]) } : null;
}

function occurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function fillEdit({ jobId, n, filePath, maxEdits = 5 }, env = process.env) {
  const no = (reason) => ({ ok: false, reason });
  const dir = jobDir(jobId, env);
  if (!existsSync(join(dir, "change.json")) || !existsSync(join(dir, "staged.sha256"))) return no(`job ${jobId} has no staged change`);
  const text = readFileSync(join(dir, "change.json"), "utf8");
  if (sha256(text) !== readFileSync(join(dir, "staged.sha256"), "utf8").trim()) return no("the staged change was altered after it was checked");
  if (existsSync(join(dir, "applied.json"))) return no("this job was already applied with apply.mjs");
  const change = JSON.parse(text);
  const edits = Array.isArray(change.edits) ? change.edits : [];
  const hasCreates = change.files.some((f) => f.base_sha256 === null);
  if (hasCreates || edits.length > maxEdits) return no("this change is too large for marker edits; land it with apply.mjs");
  const edit = edits[n];
  if (!edit) return no(`job ${jobId} has no edit number ${n}`);

  const rel = safeRelPath(edit.path);
  if (!rel || isHardDenied(rel) || isSecretFile(rel)) return no("the edit names a path a worker change may never touch");
  let target;
  try { target = checkedTarget(change.repo_root, rel); } catch (e) { return no(e.message); }
  let asked;
  try { asked = realpathSync(filePath); } catch { return no("the file named in the Edit does not exist"); }
  if (asked !== target) return no(`edit ${n} belongs to ${rel}, not to the file named in the Edit`);

  // Hunks of one file were checked in order against the evolving text, so they
  // must land in that order: the first against the exact base, later ones only
  // after the ones before them.
  const earlier = edits.map((e, i) => ({ e, i })).filter(({ e, i }) => i < n && e.path === edit.path);
  const filled = (i) => existsSync(join(dir, "filled", String(i)));
  if (filled(n)) return no(`edit ${n} was already applied`);
  if (!earlier.every(({ i }) => filled(i))) return no(`apply the earlier edits of ${rel} first`);
  const current = readFileSync(target, "utf8");
  if (earlier.length === 0) {
    const base = change.files.find((f) => f.path === rel);
    if (!base || sha256(readFileSync(target)) !== base.base_sha256) return no(`${rel} changed since the worker was shown it (stale)`);
  }
  if (occurrences(current, edit.find) !== 1) return no(`the text to replace no longer matches exactly once in ${rel}`);

  return { ok: true, rel, input: { file_path: target, old_string: edit.find, new_string: edit.replace, replace_all: false } };
}

/** Called after the native Edit succeeded. Returns whether the file now equals what the checks approved. */
export function recordFilled({ jobId, n }, env = process.env) {
  const dir = jobDir(jobId, env);
  ensureDir(join(dir, "filled"));
  writeFileSync(join(dir, "filled", String(n)), "", { mode: 0o600 });
  const change = JSON.parse(readFileSync(join(dir, "change.json"), "utf8"));
  const path = change.edits[n].path;
  const all = change.edits.map((e, i) => ({ e, i })).filter(({ e }) => e.path === path);
  if (!all.every(({ i }) => existsSync(join(dir, "filled", String(i))))) return { complete: false, path };
  const file = change.files.find((f) => f.path === path);
  const now = sha256(readFileSync(checkedTarget(change.repo_root, path)));
  return { complete: true, path, matches_checked_result: now === file.new_sha256 };
}
