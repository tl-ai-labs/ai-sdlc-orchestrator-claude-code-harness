/**
 * Whether a trigger's line is SHOWN. Two things decide it.
 *
 * 1. The cell must not be closed: the same value rule that will later pick the
 *    worker says whether this kind of job is worth handing over at all.
 * 2. A coin flip with a stored probability. Showing the line is itself a
 *    treatment; without sessions where an eligible trigger fired and nothing
 *    was shown, there is no way to tell what the line changed.
 *
 * The flip happens once per session and trigger kind (exclusive-create marker),
 * so a session never sees the same offer come and go. Every eligible firing is
 * logged, shown or not.
 */
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExclusive, ensureSessionDir, sessionDir, ensureDir } from "./paths.mjs";
import { evaluateCell, seedSavingUsd } from "./value-rule.mjs";
import { localFor } from "./evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDS_FILE = resolve(HERE, "..", "..", "..", "config", "ambient-seeds.json");
/** Lanes the governed policy already gives to a worker start as a trusted prior. */
const POLICY_LANES = new Set(["boilerplate", "tests", "docs", "repeat_edit", "bugfix_code", "scout"]);

export function loadSeeds(file = SEEDS_FILE) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { rows: [], base_job_cost_usd: {} }; }
}

/** The workers a chat job can go to, in the order they are weighed. `config.workers` maps each to its model. */
export const WORKER_KEYS = ["flash", "sonnet"];

/**
 * The evidence rows for ONE cell: the rows measured on this file kind. When
 * the kind has no rows of its own (an unknown language, mixed files), the
 * rows pooled over all languages ("any") stand in. Evidence from one language
 * is never used for another: Python results say nothing about Go.
 */
export function rowsForCell(seeds, job, fileKind, worker) {
  const rows = seeds.rows.filter((r) => !r.cost_only && r.job === job && r.worker === worker);
  const own = rows.filter((r) => r.file_kind === fileKind);
  return own.length ? own : rows.filter((r) => r.file_kind === "any");
}

export function cellFor(config, job, fileKind, seeds = loadSeeds(), worker = "flash", env = process.env) {
  const cellKey = `${job}|${fileKind}|${worker}|completion`;
  if ((config.closed_cells ?? []).includes(cellKey)) return { cellKey, state: "closed", P: 0, expected_net_usd: 0, saving_basis: "closed-by-settings" };
  const measured = seedSavingUsd(seeds, job, fileKind, worker);
  const S = measured ?? Number(config.offers?.assumed_saving_usd ?? 0.25);
  // This machine's own outcomes (evidence.mjs) enter through the rule's `local` slot:
  // a job that failed the checks or went wrong after landing lowers the verdict here,
  // a job that passed and held raises it, and old outcomes fade.
  const verdict = evaluateCell({
    rows: rowsForCell(seeds, job, fileKind, worker), local: localFor(cellKey, env), door: "completion",
    S, Cretry: Number(config.offers?.retry_cost_usd ?? 0.1), Cbad: Number(config.cost_of_bad_result_usd ?? 9),
    policyLaneOpen: POLICY_LANES.has(job),
  });
  return { cellKey, ...verdict, saving_basis: measured === null ? "assumed" : "measured" };
}

const STATE_RANK = { open: 2, explore: 1, closed: 0 };

/**
 * Which worker a job goes to. Every worker in the lineup is weighed on the
 * cell for THIS job and THIS file kind (see rowsForCell), and the pick is:
 *   1. never a closed cell (the evidence or the settings say it does not pay);
 *   2. an open cell before one still being explored;
 *   3. the larger expected net saving per job: the dollars saved, minus the
 *      expected cost of the bugs it gets wrong that the thinker would have
 *      got right (the value rule's E[net]);
 *   4. on a tie, `workers.default`.
 * `reachable(model)` (from the server) drops workers the active chat policy
 * has no text-only model for; they are listed in `unreachable` so a refusal
 * can name them. With no open or explored cell, `worker` is null and the
 * thinker keeps the job.
 */
export function pickWorker(config, job, fileKind, seeds = loadSeeds(), { reachable, env = process.env } = {}) {
  const lineup = WORKER_KEYS.filter((w) => typeof config.workers?.[w] === "string" && config.workers[w].length > 0);
  const unreachable = reachable ? lineup.filter((w) => !reachable(config.workers[w])) : [];
  const considered = lineup.filter((w) => !unreachable.includes(w)).map((w) => ({ worker: w, model: config.workers[w], ...cellFor(config, job, fileKind, seeds, w, env) }));
  const preferred = config.workers?.default;
  const ranked = considered.filter((c) => c.state !== "closed").sort((a, b) =>
    STATE_RANK[b.state] - STATE_RANK[a.state] ||
    (Math.abs(b.expected_net_usd - a.expected_net_usd) > 1e-9 ? b.expected_net_usd - a.expected_net_usd : 0) ||
    (a.worker === preferred ? -1 : b.worker === preferred ? 1 : 0));
  const summary = considered.map((c) => ({ worker: c.worker, state: c.state, p_pays: c.P, expected_net_usd: c.expected_net_usd }));
  const best = ranked[0];
  if (best) return { worker: best.worker, model: best.model, cell: best, considered: summary, unreachable };
  // Nobody pays: report the default worker's cell (or the first weighed) as the closed one.
  const shown = considered.find((c) => c.worker === preferred) ?? considered[0] ?? { cellKey: `${job}|${fileKind}|none|completion`, P: 0, expected_net_usd: 0, saving_basis: "no-worker" };
  return { worker: null, model: null, cell: { ...shown, state: "closed" }, considered: summary, unreachable };
}

/** Returns { shown, propensity, first } — `first` is false when this session already drew for this kind. */
export function drawOffer(sessionId, kind, share, env = process.env, draw = () => randomInt(0, 1_000_000) / 1_000_000, scope = null) {
  // `scope` is a helper agent's own folder under the chat; the parent chat draws in its own.
  const dir = scope ? ensureDir(scope) : ensureSessionDir(sessionId, env);
  const file = join(dir, `offer.${kind.replace(/[^a-z_]/g, "")}.json`);
  const propensity = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 0.5;
  const first = !existsSync(file);
  if (first) createExclusive(file, JSON.stringify({ kind, propensity, shown: draw() < propensity, drawn_at: new Date().toISOString() }));
  const rec = JSON.parse(readFileSync(join(dir, `offer.${kind.replace(/[^a-z_]/g, "")}.json`), "utf8"));
  return { shown: rec.shown, propensity: rec.propensity, first };
}
