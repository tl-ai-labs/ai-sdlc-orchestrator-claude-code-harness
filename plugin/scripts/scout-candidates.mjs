#!/usr/bin/env node
/**
 * scout-candidates — pick the repo files worth showing the mechanical tier
 * before the architect plans, with no model call.
 *
 * Why: on the 2026-09-18 row-4 run the architect (Opus) read 79 files to
 * write a 17-unit plan — ten test files opened to choose one mirror, a
 * 970-line index.ts in five chunks, node_modules internals — 110 messages
 * and $3.75, against 61 messages and $2.11 when the same architect planned
 * for itself. Most of that reading is search, not judgment. This script
 * narrows the repo to a candidate set by requirement-term hits; a cheap
 * scout packet (pipeline skill, Phase 2) reads the candidates and returns
 * mirrors, anchors and facts; the architect reads those slices.
 *
 * Scoring, per tracked text file: hits of the requirement terms in the path
 * (×3) and in the content (×1, capped per term), a boost for files under the
 * run's write-contract allowlist (they are the edit targets and the
 * neighbours of new files), and a boost for a test whose name matches a
 * high-scoring source file. Excluded: off-limits and generated paths,
 * binaries, files over --max-file-bytes, lockfiles.
 *
 * Output: `{ terms, candidates: [{ path, bytes, lines, score, hits }] }` —
 * at most --max-files entries and --max-bytes total, best first.
 *
 * Usage: node scout-candidates.mjs --project-root <dir> --requirements <requirements.md>
 *          [--brief <intent_brief.md>] [--max-files 40] [--max-bytes 250000]
 *          [--max-file-bytes 120000] [--out scout-candidates.json] [--json]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, basename, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULTS = { maxFiles: 40, maxBytes: 250_000, maxFileBytes: 120_000 };

const EXCLUDE = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)\.next\//, /(^|\/)coverage\//, /(^|\/)\.git\//,
  /(^|\/)\.sdlc\//, /(^|\/)\.claude\//, /(^|\/)\.cursor\//, /(^|\/)\.agents\//,
  /\.(lock|min\.js|min\.css|map|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|mp4|mp3|wasm)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[\w-]+-lock\.json)$/, /\.gen\.[cm]?[jt]sx?$/, /^\.env/, /(^|\/)\.env/,
  /(^|\/)\.[^/]+$/, // dotfiles (.mintignore, .gitignore, …)
];

const STOP = new Set(("the a an and or of to in on for with by as is are be this that it its from at into via not no " +
  "must should when then than each per all any one two new add adds added existing return returns returning use uses using " +
  "user users id name page route routes api web app apps src test tests file files field fields value values string number " +
  "true false null undefined default object array list type types data set get put post delete request response " +
  "fr nfr scope out in-scope non functional requirement requirements acceptance criteria open question questions " +
  "shall will can may only also same other more less about after before under over between within without " +
  "auth alt check git env next docs doc json error errors status http https path paths line lines code src index " +
  "public private static const function export import async await client server config option options").split(/\s+/));

/** Requirement terms: identifiers, kebab/snake names, path-like strings, quoted words. Weighted by how they appear. */
export function extractTerms(text) {
  const weights = new Map();
  const bump = (t, w) => {
    const k = t.toLowerCase();
    if (k.length < 3 || STOP.has(k) || /^\d+$/.test(k)) return;
    if (/[*?]/.test(k) || k.startsWith(".") || k.startsWith("/") || k.startsWith("@")) return; // globs, dotfiles, routes, scopes
    weights.set(k, Math.max(weights.get(k) ?? 0, w));
  };
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) {
    let s = m[1];
    const dirGlob = s.match(/^([^\s*?]+\/)\*{1,2}$/); // `components/public-project/*` names a directory
    if (dirGlob) s = dirGlob[1];
    if (/[\/.]/.test(s) && !/\s/.test(s)) bump(s, 4); // a path or dotted name
    // A part of a backticked string is a strong term only when it is identifier-shaped; a plain word (`dist`, `build`) is weak.
    for (const part of s.split(/[^A-Za-z0-9_$-]+/)) bump(part, /[-_.]|[a-z][A-Z]|\.[a-z]+$/.test(part) ? 3 : 1);
  }
  for (const m of text.matchAll(/\b[a-z]+(?:-[a-z0-9]+)+\b/g)) bump(m[0], 3); // kebab-case: routes, files, keys
  for (const m of text.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) bump(m[0], 3); // camelCase identifiers
  for (const m of text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) bump(m[0], 2); // snake_case
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]{4,}\b/g)) bump(m[0], 1); // plain words, low weight
  return [...weights.entries()].map(([term, weight]) => ({ term, weight })).sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
}

function trackedFiles(root) {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return r.stdout.split("\0").filter(Boolean);
  // Not a git repo: walk, shallowly bounded.
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    for (const e of readdirSafe(dir)) {
      const p = join(dir, e);
      const rel = p.slice(root.length + 1).split(sep).join("/");
      if (EXCLUDE.some((re) => re.test(rel + "/"))) continue;
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else out.push(rel);
      } catch { /* unreadable */ }
    }
  };
  walk(root, 0);
  return out;
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function readAllowlist(root) {
  const p = join(root, ".sdlc", "local", "write-contract.json");
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(c.allowlist) ? c.allowlist : [];
  } catch { return []; }
}

function globToRe(pattern) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${re}$`);
}

/** The directory an allowlist glob starts in (`apps/api/src/user/**` → `apps/api/src/user`). */
function globRoot(pattern) {
  const i = pattern.search(/[*?]/);
  const base = i === -1 ? dirname(pattern) : pattern.slice(0, i);
  return base.replace(/\/$/, "");
}

const TEST_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Files bigger than this are offered as hit windows (±WINDOW lines around the best term hits), not whole. */
export const LARGE_FILE_BYTES = 24_000;
const WINDOW = 25;
const MAX_WINDOWS = 4;
/** A term found in more than this share of scanned files says nothing about which file matters. */
const MAX_DF_SHARE = 0.12;

export function scoreFiles({ root, files, terms, allowlist, maxFileBytes }) {
  const allowRes = allowlist.map(globToRe);
  const allowRoots = allowlist.map(globRoot).filter(Boolean);
  const strong = terms.filter((t) => t.weight >= 2);
  const docs = [];
  const df = new Map();
  for (const rel of files) {
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > maxFileBytes || st.size === 0) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    if (isBinary(buf)) continue;
    const content = buf.toString("utf8");
    const lower = content.toLowerCase();
    const found = new Map(); // term → first hit offsets (≤5)
    for (const { term } of strong) {
      const offs = [];
      let i = 0;
      while (offs.length < 5 && (i = lower.indexOf(term, i)) !== -1) { offs.push(i); i += term.length; }
      if (offs.length) { found.set(term, offs); df.set(term, (df.get(term) ?? 0) + 1); }
    }
    docs.push({ rel, size: st.size, content, found });
  }
  const dfCut = Math.max(10, Math.floor(docs.length * MAX_DF_SHARE));
  const informative = new Set(strong.filter((t) => (df.get(t.term) ?? 0) <= dfCut).map((t) => t.term));
  const weightOf = new Map(strong.map((t) => [t.term, t.weight]));
  const scored = [];
  for (const d of docs) {
    const rel = d.rel;
    const pathLower = rel.toLowerCase();
    let score = 0;
    const hits = [];
    const hitOffsets = [];
    for (const { term, weight } of strong) {
      if (!informative.has(term)) continue;
      if (pathLower.includes(term)) { score += 3 * weight; hits.push(`path:${term}`); }
      const offs = d.found.get(term);
      if (offs) { score += Math.min(offs.length, 5) * weight * 0.5; hits.push(`${term}×${offs.length}`); for (const o of offs) hitOffsets.push([o, weight]); }
    }
    if (/\.(md|mdx|txt)$/i.test(rel) && !hits.some((h) => h.startsWith("path:"))) score *= 0.4; // prose only counts when named
    if (allowRes.some((re) => re.test(rel))) { score += 6; hits.push("allowlist"); }
    else if (allowRoots.some((r) => rel.startsWith(r + "/"))) { score += 3; hits.push("allowlist-neighbour"); }
    const entry = { path: rel, bytes: d.size, lines: d.content.split("\n").length, score, hits, test: TEST_RE.test(rel) };
    if (d.size > LARGE_FILE_BYTES) entry.windows = hitWindows(d.content, hitOffsets, entry.lines);
    scored.push(entry);
  }
  // A test whose base name matches a high-scoring source file is the mirror for the new test; a file in
  // the same directory as a top source is the kit the new files sit beside. Prose docs never lead.
  const topSources = scored.filter((s) => s.score > 0 && !s.test && !/\.(md|mdx|txt)$/i.test(s.path)).sort((a, b) => b.score - a.score).slice(0, 20);
  const topBases = new Set(topSources.map((s) => basename(s.path).replace(/\.[^.]+$/, "")));
  const topDirs = new Set(topSources.map((s) => dirname(s.path)));
  for (const s of scored) {
    if (/\.(md|mdx|txt)$/i.test(s.path) && !s.hits.some((h) => h.startsWith("path:"))) s.score = Math.min(s.score, 10);
    if (s.test) {
      const base = basename(s.path).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "");
      if (topBases.has(base)) { s.score += 15; s.hits.push("test-of-top-source"); }
      else if (s.hits.some((h) => h.startsWith("path:"))) { s.score += 6; s.hits.push("test-named"); }
    } else if (topDirs.has(dirname(s.path)) && !topSources.includes(s) && s.bytes <= LARGE_FILE_BYTES && !/\.json$/.test(s.path)) {
      s.score += 8; s.hits.push("beside-top-source");
    }
  }
  const positive = scored.filter((s) => s.score > 0);
  positive.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  // Sibling cap: files in one directory with one extension and the same hit signature (locale files,
  // migration snapshots) are one candidate, not fifteen — keep the path-named ones plus the best two.
  const groups = new Map();
  const kept = [];
  for (const s of positive) {
    const sig = `${dirname(s.path)}|${s.path.replace(/.*\./, "")}|${s.hits.filter((h) => !h.startsWith("path:")).join(",")}`;
    const g = groups.get(sig) ?? { n: 0 };
    groups.set(sig, g);
    if (s.hits.some((h) => h.startsWith("path:") && h.length > 10) || g.n < 2) { kept.push(s); g.n++; }
  }
  return kept;
}

/** Up to MAX_WINDOWS merged ±WINDOW-line ranges around the heaviest hits, as [from, to] 1-based. */
export function hitWindows(content, hitOffsets, totalLines) {
  if (hitOffsets.length === 0) return [[1, Math.min(WINDOW * 2, totalLines)]];
  const lineOf = (off) => { let n = 1; for (let i = 0; i < off; i++) if (content.charCodeAt(i) === 10) n++; return n; };
  const ranked = [...hitOffsets].sort((a, b) => b[1] - a[1]).slice(0, MAX_WINDOWS * 3).map(([o]) => lineOf(o));
  const ranges = [...new Set(ranked)].map((l) => [Math.max(1, l - WINDOW), Math.min(totalLines, l + WINDOW)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged.slice(0, MAX_WINDOWS);
}

/** Bytes a candidate costs the scout: the whole file, or its windows (≈ 40 bytes per line). */
function costOf(s) {
  if (!s.windows) return s.bytes;
  return s.windows.reduce((a, [f, t]) => a + (t - f + 1) * 40, 0);
}

export function pickCandidates(scored, { maxFiles, maxBytes }) {
  const out = [];
  let bytes = 0;
  for (const s of scored) {
    if (out.length >= maxFiles) break;
    const c = costOf(s);
    if (bytes + c > maxBytes) continue;
    out.push({ ...s, input_bytes: c });
    bytes += c;
  }
  return out.map(({ test, ...rest }) => rest);
}

function parseArgs(argv) {
  const out = { projectRoot: null, requirements: null, brief: null, outFile: null, json: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a.startsWith("--project-root")) out.projectRoot = val();
    else if (a.startsWith("--requirements")) out.requirements = val();
    else if (a.startsWith("--brief")) out.brief = val();
    else if (a.startsWith("--max-files")) out.maxFiles = Number(val());
    else if (a.startsWith("--max-bytes")) out.maxBytes = Number(val());
    else if (a.startsWith("--max-file-bytes")) out.maxFileBytes = Number(val());
    else if (a.startsWith("--out")) out.outFile = val();
    else if (a === "--json") out.json = true;
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !args.requirements) {
    process.stderr.write("usage: scout-candidates.mjs --project-root <dir> --requirements <requirements.md> [--brief <intent_brief.md>] [--max-files N] [--max-bytes N] [--out file] [--json]\n");
    return 2;
  }
  const root = resolve(args.projectRoot);
  let text = "";
  for (const f of [args.requirements, args.brief]) {
    if (!f) continue;
    if (!existsSync(f)) { process.stderr.write(`scout-candidates: ${f} does not exist\n`); return 2; }
    text += readFileSync(f, "utf8") + "\n";
  }
  const terms = extractTerms(text);
  const files = trackedFiles(root);
  const scored = scoreFiles({ root, files, terms, allowlist: readAllowlist(root), maxFileBytes: args.maxFileBytes });
  const candidates = pickCandidates(scored, { maxFiles: args.maxFiles, maxBytes: args.maxBytes });
  const result = { terms: terms.filter((t) => t.weight >= 2).slice(0, 60), scanned: files.length, scored: scored.length, candidates };
  if (args.outFile) writeFileSync(args.outFile, JSON.stringify(result, null, 2) + "\n");
  const bytes = candidates.reduce((a, c) => a + c.input_bytes, 0);
  process.stdout.write(args.json
    ? JSON.stringify({ scanned: files.length, scored: scored.length, candidates: candidates.length, bytes, out: args.outFile }) + "\n"
    : `scout-candidates: ${candidates.length} of ${scored.length} scoring files (${files.length} scanned), ${bytes} bytes${args.outFile ? ` → ${args.outFile}` : ""}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
