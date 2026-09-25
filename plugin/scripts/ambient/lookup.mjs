/**
 * The bundled lookup: design v1.1, reading layer, item 5 ("a bundled lookup
 * tool whose results carry exact Read ranges").
 *
 * A hunt through existing code costs the thinker one round trip per search
 * and one per file it then reads, and every round trip re-reads the chat.
 * One call takes up to eight search terms and returns, for every match, the
 * line, the exact `Read offset/limit` that shows it, and the declaration it
 * sits in (from the same outline builder the read valve uses). Nothing leaves
 * the machine; nothing is written; the answer is bounded.
 *
 * It is the thinker's choice to call it (a model-chosen tool), it is named in
 * the start-of-chat note, and it is the same on both sides of a pair: an
 * optimization, not a delegation. Secret-bearing and hard-denied files are
 * never searched or named. Outside a git repository it refuses rather than
 * scanning a folder blind.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isHardDenied, isSecretFile, safeRelPath } from "./lib/deny-paths.mjs";
import { appendEvent } from "./lib/events.mjs";
import { findDeclarations } from "./lib/outline.mjs";

const MAX_TERMS = 8;
const MIN_TERM = 2;
const MAX_TERM = 120;
const MAX_HITS_CAP = 60;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 8000;
const LINE_CHARS = 160;

function refuse(reason) {
  return { status: "refused", reason };
}

function gitGrep(projectDir, terms, paths) {
  const args = ["grep", "-n", "-I", "-F", "--no-color", "--untracked"];
  for (const t of terms) args.push("-e", t);
  args.push("--");
  for (const p of paths) args.push(p);
  try {
    return execFileSync("git", args, { cwd: projectDir, timeout: 5000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch (e) {
    // git grep exits 1 for "no match" with empty output; anything else is a real failure
    if (e && e.status === 1 && !(e.stdout && e.stdout.length)) return "";
    if (e && typeof e.status === "number" && e.status === 1) return e.stdout.toString();
    throw e;
  }
}

/** The innermost declaration whose range holds the line, or null. */
function enclosing(decls, line) {
  let best = null;
  for (const d of decls) {
    if (d.start <= line && line <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
  }
  return best;
}

/** offset/limit for Read: the declaration when it is small enough to read whole, else a window around the hit. */
function rangeFor(decl, line, totalLines) {
  if (decl && decl.end - decl.start + 1 <= 80) return { offset: decl.start, limit: decl.end - decl.start + 1 };
  const offset = Math.max(1, line - 20);
  return { offset, limit: Math.min(41, Math.max(1, totalLines - offset + 1)) };
}

export function lookup({ terms, paths = [], maxHits = 40, projectDir, stamp = null, env = process.env }) {
  if (!Array.isArray(terms) || terms.length === 0) return refuse("terms must be a list of 1 to 8 search strings");
  if (terms.length > MAX_TERMS) return refuse(`at most ${MAX_TERMS} terms in one lookup; narrow them`);
  const clean = terms.map((t) => (typeof t === "string" ? t.trim() : ""));
  if (clean.some((t) => t.length < MIN_TERM || t.length > MAX_TERM)) return refuse(`each term must be ${MIN_TERM} to ${MAX_TERM} characters`);
  const globs = (Array.isArray(paths) ? paths : []).map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p && !p.startsWith("-") && p.length <= 200).slice(0, 10);
  const cap = Math.max(1, Math.min(MAX_HITS_CAP, Number(maxHits) || 40));
  if (typeof projectDir !== "string" || !projectDir) return refuse("no project folder");
  try { statSync(join(projectDir, ".git")); } catch { return refuse("not a git repository: the lookup searches tracked and untracked files of a repository only"); }

  let raw;
  try { raw = gitGrep(projectDir, clean, globs); } catch (e) { return refuse(`git grep failed: ${String(e?.message ?? e).slice(0, 120)}`); }

  // Parse "path:line:text", drop files that may never be shown, group per file in order of first hit.
  const byFile = new Map();
  let total = 0;
  for (const row of raw.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    const rel = safeRelPath(m[1]);
    if (!rel || isHardDenied(rel) || isSecretFile(rel)) continue;
    total++;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push({ line: Number(m[2]), text: m[3] });
  }
  if (total === 0) return { status: "empty", hits: 0, files: 0, text: `No match for ${clean.map((t) => JSON.stringify(t)).join(", ")}${globs.length ? " under " + globs.join(" ") : ""}.` };

  const lines = [];
  let shown = 0;
  let filesShown = 0;
  for (const [rel, hits] of byFile) {
    if (shown >= cap || filesShown >= MAX_FILES) break;
    let decls = [];
    let totalLines = 0;
    try {
      const abs = join(projectDir, rel);
      if (statSync(abs).size <= MAX_FILE_BYTES) {
        const text = readFileSync(abs, "utf8");
        const parsed = findDeclarations(text, rel);
        decls = parsed?.decls ?? [];
        totalLines = parsed?.totalLines ?? text.split("\n").length;
      }
    } catch { /* unreadable: still list the hits, without ranges from the file */ }
    filesShown++;
    lines.push(`${rel} (${hits.length} hit${hits.length === 1 ? "" : "s"})`);
    for (const h of hits) {
      if (shown >= cap) break;
      const decl = enclosing(decls, h.line);
      const r = rangeFor(decl, h.line, totalLines || h.line + 20);
      const where = decl ? ` (in ${decl.text.trim().slice(0, 70)} L${decl.start}-L${decl.end})` : "";
      lines.push(`  L${h.line}: ${h.text.trim().slice(0, LINE_CHARS)}  → Read ${rel} offset ${r.offset} limit ${r.limit}${where}`);
      shown++;
    }
  }
  const hidden = total - shown;
  const header = `${total} hit${total === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"} for ${clean.map((t) => JSON.stringify(t)).join(", ")}. Each line gives the exact Read range that shows it.`;
  let text = [header, ...lines].join("\n");
  if (hidden > 0) text += `\n${hidden} more hit${hidden === 1 ? "" : "s"} not shown: narrow the terms or add paths.`;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS - 60) + "\n… cut at the size limit: narrow the terms or add paths.";

  const sid = stamp && typeof stamp.session_id === "string" ? stamp.session_id : null;
  if (sid) {
    try { appendEvent(sid, "lookup.used", { terms: clean.length, hits: total, files: byFile.size, shown, chars: text.length, agent: typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined }, env); } catch { /* the answer matters more than the record */ }
  }
  return { status: "ok", hits: total, files: byFile.size, shown, text };
}
