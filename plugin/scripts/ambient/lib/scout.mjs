/**
 * The scout job (design v1.1 §5.1 "bulk reading that returns verified quoted
 * lines"; the pipeline's change 7): a cheaper model reads the likely
 * files of an existing project and reports WHERE to look or edit, each place
 * with an exact Read range and a line quoted verbatim, so the thinker opens a
 * handful of ranges instead of forty files. Pipeline measurement: the architect
 * opened ~80 files for $4.28 before Flash scouted for it.
 *
 * Deterministic on both ends: code picks the candidate files (git grep for the
 * terms, ranked by hits, bounded by count and bytes; secret and denied files
 * never included) and code checks the reply (only files that were shown, line
 * ranges inside the file, a quote that really sits in that range; anything
 * else is dropped and counted). The worker never executes anything.
 */
import { execFileSync } from "node:child_process";
import { isHardDenied, isSecretFile, safeRelPath } from "./deny-paths.mjs";

const MAX_FILES_CAP = 40;
const BYTE_BUDGET = 300 * 1024;
const MAX_PLACES = 30;
const MAX_SPAN = 400;
const TEXTLIKE = /\.(m?[jt]sx?|py|go|rb|rs|java|kt|cs|php|c|cc|cpp|h|hpp|swift|scala|sh|sql|json|ya?ml|toml|md|txt|html?|css|scss|vue|svelte)$/i;

function git(projectDir, args) {
  try {
    return execFileSync("git", args, { cwd: projectDir, timeout: 8000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch (e) {
    if (e && typeof e.status === "number" && e.status === 1) return e.stdout ? e.stdout.toString() : "";
    throw e;
  }
}

/** Candidate files, ranked: most hits for the terms first, then smaller files; bounded by count and bytes. */
export function candidateFiles(projectDir, { terms = [], paths = [], maxFiles = MAX_FILES_CAP, byteBudget = BYTE_BUDGET } = {}) {
  const cap = Math.max(1, Math.min(MAX_FILES_CAP, Number(maxFiles) || MAX_FILES_CAP));
  const globs = paths.filter((p) => typeof p === "string" && p.trim() && !p.startsWith("-")).slice(0, 10);
  const clean = terms.filter((t) => typeof t === "string" && t.trim().length >= 2).map((t) => t.trim()).slice(0, 8);
  const hits = new Map();
  if (clean.length) {
    const args = ["grep", "-c", "-I", "-F", "--untracked"];
    for (const t of clean) args.push("-e", t);
    args.push("--", ...globs);
    for (const row of git(projectDir, args).split("\n")) {
      const m = /^(.+?):(\d+)$/.exec(row);
      if (m) hits.set(m[1], Number(m[2]));
    }
  } else {
    for (const p of git(projectDir, ["ls-files", "--", ...globs]).split("\n")) if (p) hits.set(p, 0);
  }
  const ranked = [];
  for (const [raw, n] of hits) {
    const rel = safeRelPath(raw);
    if (!rel || isHardDenied(rel) || isSecretFile(rel) || !TEXTLIKE.test(rel)) continue;
    ranked.push({ path: rel, hits: n });
  }
  ranked.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  return { files: ranked.slice(0, cap).map((f) => f.path), cap, byteBudget, considered: ranked.length };
}

function numbered(content) {
  return content.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`).join("\n");
}

/** The brief: the question, then the files with line numbers, then the reply contract. */
export function renderScoutBrief({ question, files }) {
  return [
    "You are reading part of an existing project to tell a senior engineer WHERE to look or edit. Do not write code. Do not change anything.",
    "QUESTION:\n" + question,
    "Reply with ONE JSON object and nothing else:",
    '{"places": [{"path": "<a file shown below>", "start": <first line>, "end": <last line>, "why": "<one sentence: what is here and why it matters for the question>", "quote": "<one line copied exactly from between start and end>"}], "summary": "<at most six sentences: what to copy, where to edit, the style to follow>"}',
    `Rules: at most ${MAX_PLACES} places, most useful first; every place must be inside a file shown here; start and end are line numbers as shown; a span is at most ${MAX_SPAN} lines; the quote must be one line copied verbatim from inside that span.`,
    ...files.map((f) => `=== FILE ${f.path} (${f.content.split("\n").length} lines) ===\n${numbered(f.content)}\n=== END ${f.path} ===`),
  ].join("\n\n");
}

/** Strict reading of the reply: only places that check out are kept; the rest are counted as dropped. */
export function checkScoutAnswer(text, files) {
  let raw = String(text ?? "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fence) raw = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "the reply is not one JSON object", places: [], summary: "", dropped: 0 }; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.places)) return { ok: false, reason: "the reply has no places list", places: [], summary: "", dropped: 0 };
  const byPath = new Map(files.map((f) => [f.path, f.content.split("\n")]));
  const places = [];
  let dropped = 0;
  for (const p of parsed.places.slice(0, 200)) {
    const rel = safeRelPath(p?.path);
    const lines = rel ? byPath.get(rel) : null;
    const start = Number(p?.start);
    const end = Number(p?.end);
    if (!lines || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length || end - start > MAX_SPAN) { dropped++; continue; }
    const why = typeof p?.why === "string" ? p.why.trim().slice(0, 240) : "";
    const quote = typeof p?.quote === "string" ? p.quote.trim() : "";
    if (quote) {
      const span = lines.slice(start - 1, end).map((l) => l.trim());
      if (!span.includes(quote)) { dropped++; continue; }
    }
    places.push({ path: rel, start, end, why, quote });
    if (places.length >= MAX_PLACES) break;
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2000) : "";
  const ok = places.length > 0 || summary.length > 0;
  return { ok, reason: ok ? undefined : "no place could be verified against the files shown", places, summary, dropped };
}

/** The text the thinker gets: every place with its exact Read range, then the summary. Bounded. */
export function renderScoutResult({ places, summary, dropped, filesShown }) {
  const lines = [`${places.length} place${places.length === 1 ? "" : "s"} found in ${filesShown} file${filesShown === 1 ? "" : "s"} read by the worker${dropped ? ` (${dropped} unverifiable place${dropped === 1 ? "" : "s"} dropped)` : ""}. Each has the exact Read range that shows it.`];
  for (const p of places) {
    lines.push(`- ${p.path} L${p.start}-L${p.end}: ${p.why || "(no reason given)"}${p.quote ? `  «${p.quote.slice(0, 120)}»` : ""}  → Read ${p.path} offset ${p.start} limit ${p.end - p.start + 1}`);
  }
  if (summary) lines.push("", "Summary: " + summary);
  let text = lines.join("\n");
  if (text.length > 8000) text = text.slice(0, 7940) + "\n… cut at the size limit.";
  return text;
}
