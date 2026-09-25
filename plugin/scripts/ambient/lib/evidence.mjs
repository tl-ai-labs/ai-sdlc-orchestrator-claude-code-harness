/**
 * What this machine has learned about its own worker jobs, and what it feeds
 * back into the two rules that decide.
 *
 * The value rule (value-rule.mjs) always had a slot for "this machine's own
 * decayed counts" per cell; until 22 Sep 2026 nothing filled it, so every
 * verdict came from the seed rows alone and a job's outcome was recorded and
 * shown but never changed the next verdict. This file fills the slot:
 *
 *   - `recordChecks(cell, passed, env, { newJob })`: did the worker's answer
 *     pass the code checks? Written under the cell of the WORKER THAT ANSWERED
 *     (23 Sep: a cascade once credited Sonnet's rescue to Flash's cell). Every
 *     rejected answer is a fail for that worker; a chain that never answered
 *     (timeout, vendor error) is a fail too. `newJob` counts the job once, at
 *     its first record; a resend within the same job adds a fail, not a job.
 *   - `recordLanding(cell, "good" | "bad")`: the change was PROVEN right or
 *     wrong: its declared tests passed or failed in the scratch copy at
 *     hand-back, a later test run passed (held), it was undone, or the thinker
 *     rewrote the landed file before any passing run (wrong). A failed test run
 *     alone settles nothing: a half-built project fails for its own reasons.
 *   - every new outcome first ages the cell's counts by DECAY, so a bad week
 *     cannot close a cell for ever and a good one cannot open it for ever;
 *     the counts are pseudo-observations, never a raw total.
 *
 * The typing rule (cost-rule.mjs) guesses two extra requests per hand-over
 * (the start call and one collect). `recordHandoverRequests(n)` measures the
 * real number from the start call plus every job_result poll, as a decayed
 * mean, and `measuredExtraRequests()` hands it to the break-even.
 *
 * One private, user-level file: <MMO_HOME>/evidence.json (mode 0600, written
 * atomically). A repository cannot write it. A corrupt file counts as empty.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, mmoHome } from "./paths.mjs";
import { DECAY } from "./value-rule.mjs";

const SCHEMA = 1;
/** Polls per job fade faster than cell counts: the model's habits change with every app version. */
const REQUESTS_DECAY = 0.9;

export function evidenceFile(env = process.env) {
  return join(mmoHome(env), "evidence.json");
}

export function readEvidence(env = process.env) {
  try {
    const e = JSON.parse(readFileSync(evidenceFile(env), "utf8"));
    if (e && typeof e === "object" && e.schema_version === SCHEMA && e.cells && typeof e.cells === "object") return e;
  } catch { /* none yet, or unreadable: start empty */ }
  return { schema_version: SCHEMA, cells: {}, handover: null };
}

function writeEvidence(ev, env) {
  ensureDir(mmoHome(env));
  const file = evidenceFile(env);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(ev, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function cellOf(ev, cellKey) {
  if (!ev.cells[cellKey]) ev.cells[cellKey] = { g: [0, 0], ew: [0, 0], et: [0, 0], jobs: 0, updated: null };
  return ev.cells[cellKey];
}

/** One more observation for a cell: age everything first, then count it. `countJob` counts a job, once, at its first checks record. */
function bump(cell, key, index, countJob = false) {
  for (const k of ["g", "ew", "et"]) cell[k] = [cell[k][0] * DECAY, cell[k][1] * DECAY];
  cell[key][index] += 1;
  if (countJob) cell.jobs += 1;
  cell.updated = new Date().toISOString();
}

export function recordChecks(cellKey, passed, env = process.env, { newJob = true } = {}) {
  if (typeof cellKey !== "string" || !cellKey) return;
  const ev = readEvidence(env);
  bump(cellOf(ev, cellKey), "g", passed ? 0 : 1, newJob);
  writeEvidence(ev, env);
}

export function recordLanding(cellKey, outcome, env = process.env) {
  if (typeof cellKey !== "string" || !cellKey) return;
  const ev = readEvidence(env);
  bump(cellOf(ev, cellKey), "ew", outcome === "bad" ? 0 : 1);
  writeEvidence(ev, env);
}

/** The value rule's `local` input for a cell, or null when this machine has seen nothing of it. */
export function localFor(cellKey, env = process.env) {
  const c = readEvidence(env).cells[cellKey];
  if (!c) return null;
  return { g: [...c.g], ew: [...c.ew], et: [...c.et] };
}

/** Plain counts for the board: jobs seen, passes, fails, wrong and held after landing (rounded, decayed). */
export function localSummary(cellKey, env = process.env) {
  const c = readEvidence(env).cells[cellKey];
  if (!c) return null;
  const r = (x) => Math.round(x);
  return { jobs: c.jobs, passed: r(c.g[0]), failed: r(c.g[1]), wrong: r(c.ew[0]), held: r(c.ew[1]), updated: c.updated };
}

export function recordHandoverRequests(n, env = process.env) {
  if (!Number.isFinite(n) || n <= 0) return;
  const ev = readEvidence(env);
  const h = ev.handover ?? { sum: 0, weight: 0, jobs: 0 };
  ev.handover = { sum: h.sum * REQUESTS_DECAY + n, weight: h.weight * REQUESTS_DECAY + 1, jobs: h.jobs + 1, updated: new Date().toISOString() };
  writeEvidence(ev, env);
}

/** The seed counts as this many files until real ones replace it. */
const CHARS_PROJECT_CAP = 40;
const CHARS_PRIOR_WEIGHT = 3;
const CHARS_DEFAULT = 3000;

/**
 * How much typing one file of a job kind really holds, learned from every
 * staged answer (a created file's length; for an edited file the length of
 * what was replaced in). The gate (jobs.mjs) multiplies it by the files a job
 * declares to know whether the job clears the chat's break-even BEFORE any
 * worker is called. The seed (`cost.expected_chars_per_file`, measured on the
 * 23 Sep jobs and the census) counts as three files until real ones replace it.
 */
export function recordTypedChars(job, charsPerFile, env = process.env) {
  if (typeof job !== "string" || !job || !Array.isArray(charsPerFile)) return;
  const sizes = charsPerFile.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (!sizes.length) return;
  const ev = readEvidence(env);
  ev.chars = ev.chars && typeof ev.chars === "object" ? ev.chars : {};
  const c = ev.chars[job] ?? { sum: 0, weight: 0, files: 0 };
  let { sum, weight } = c;
  for (const n of sizes) { sum = sum * DECAY + n; weight = weight * DECAY + 1; }
  ev.chars[job] = { sum, weight, files: (c.files ?? 0) + sizes.length, updated: new Date().toISOString() };
  writeEvidence(ev, env);
}

/** The expected characters of typing per file for a job kind: the learned mean, blended with the seed while few files were seen. */
export function expectedCharsPerFile(job, env = process.env, seed = undefined, project = null) {
  const prior = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Number(seed) : CHARS_DEFAULT;
  const c = readEvidence(env).chars?.[job];
  const learned = !c || !(c.weight > 0) ? prior : (c.sum + prior * CHARS_PRIOR_WEIGHT) / (c.weight + CHARS_PRIOR_WEIGHT);
  // This project's own files of the same kind, weighed by how many there are (his goal 2:
  // a task nobody has seen is sized from itself, not from tasks that were seen). Two files
  // nudge the learned number; forty of them decide it. A project with none keeps `learned`.
  if (!project || !(project.samples > 0) || !(project.chars > 0)) return learned;
  const n = Math.min(project.samples, CHARS_PROJECT_CAP);
  return (project.chars * n + learned * CHARS_PRIOR_WEIGHT) / (n + CHARS_PRIOR_WEIGHT);
}

/** The decayed mean of requests per hand-over measured here, or null until a job was collected. */
export function measuredExtraRequests(env = process.env) {
  const h = readEvidence(env).handover;
  if (!h || !(h.weight > 0)) return null;
  return h.sum / h.weight;
}
