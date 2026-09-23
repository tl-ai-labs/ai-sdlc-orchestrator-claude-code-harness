/**
 * Picking the worker: one value rule per cell (job x file kind x worker x door).
 *
 *   net = g*S - (1-g)*C_retry - g*(e_w - e_t)*C_bad
 *
 *   g        chance the worker's result passes the code checks
 *   e_w,e_t  chance a checked result is still wrong, for the worker and for the
 *            thinker doing the same job. Only the DIFFERENCE costs anything, so
 *            the bar is "as good as the thinker", not "perfect".
 *   S        dollars saved when the worker's result is used
 *   C_retry  dollars lost when the checks reject it and the thinker redoes it
 *   C_bad    the organisation's one number: what a wrong result costs
 *
 * g, e_w and e_t are Beta posteriors, so the rule returns a PROBABILITY that
 * the cell pays, P(net > 0), computed by exact numeric integration (no random
 * sampling: the same evidence always gives the same answer).
 *
 *   P >= 0.8  open      P <= 0.2  closed      between: delegate with chance P
 *
 * P alone ignores how MUCH is lost when the cell does not pay. Where a wrong
 * result is expensive, a cell can sit at P = 0.4 while losing dollars per job
 * on average. So the expected net value is computed too, and a cell whose
 * expected value is negative is closed whatever P says.
 *
 * Evidence is one-sided where it is weak. A row measured under a weaker
 * success definition may lower P and never raise it. A row from an older
 * version of the model may raise P and never lower it. A row from another door
 * counts at a quarter weight. With no trusted evidence at all a cell can be
 * explored and never fully opened. A lane the governed policy already gives to
 * a worker starts open; evidence can close it.
 */
import { join } from "node:path";
import { createExclusive, ensureSessionDir, sessionDir } from "./paths.mjs";
import { existsSync, readFileSync } from "node:fs";
import { randomInt } from "node:crypto";

export const OPEN_AT = 0.8;
export const CLOSED_AT = 0.2;
export const EXPLORE_FLOOR = 0.02;
export const DECAY = 0.98;
const OTHER_DOOR_WEIGHT = 0.25;
const STRONG = new Set(["hidden_tests", "kept_result"]);

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b): the Beta(a, b) CDF at x. */
export function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Points that split a Beta(a, b) into `n` equal-probability slices (midpoint of each, by bisection). */
function quantileGrid(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const target = (i + 0.5) / n;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (betaCdf(mid, a, b) < target) lo = mid; else hi = mid;
    }
    out.push((lo + hi) / 2);
  }
  return out;
}

/**
 * P(net > 0). Each of `g` and `e_t` is cut into equal-probability slices; for
 * every pair the largest tolerable e_w is solved in closed form and the e_w
 * CDF gives the chance of staying under it.
 */
export function probNetPositive({ g, ew, et, S, Cretry, Cbad }, slices = 48) {
  if (![S, Cretry, Cbad].every(Number.isFinite) || Cbad <= 0) return 0;
  const gs = quantileGrid(g[0], g[1], slices);
  const ts = quantileGrid(et[0], et[1], slices);
  let total = 0;
  for (const gv of gs) {
    const headroom = (gv * S - (1 - gv) * Cretry) / (gv * Cbad);
    for (const tv of ts) total += betaCdf(headroom + tv, ew[0], ew[1]);
  }
  return total / (gs.length * ts.length);
}

const mean = (beta) => beta[0] / (beta[0] + beta[1]);

/** E[net]. g is independent of the two error rates, so the product of means is exact. */
export function expectedNetUsd({ g, ew, et, S, Cretry, Cbad }) {
  const gm = mean(g);
  return gm * S - (1 - gm) * Cretry - gm * (mean(ew) - mean(et)) * Cbad;
}

function addCounts(target, hits, trials, weight = 1) {
  target[0] += hits * weight;
  target[1] += (trials - hits) * weight;
}

/** Turn seed rows for one cell into Beta pseudo-counts, keeping weak rows apart. */
function seedCounts(rows, door, skip) {
  const fresh = () => ({ g: [1, 1], ew: [1, 1], et: [1, 1], used: 0 });
  const c = fresh();
  for (const row of rows) {
    if (row.cost_only || skip(row)) continue;
    const weight = row.door === door ? 1 : OTHER_DOOR_WEIGHT;
    if (row.paired) {
      addCounts(c.ew, row.paired.only_thinker_right, row.paired.n, weight);
      addCounts(c.et, row.paired.only_worker_right, row.paired.n, weight);
    } else if (row.rate) {
      // An unpaired success rate says how often the result was acceptable; its
      // complement is charged to the worker alone.
      addCounts(c.ew, row.rate[1] - row.rate[0], row.rate[1], weight);
    }
    if (row.checks_passed) addCounts(c.g, row.checks_passed[0] * row.checks_passed[1], row.checks_passed[1], weight);
    c.used++;
  }
  return c;
}

function merge(a, b) {
  const sum = (x, y) => [x[0] + y[0] - 1, x[1] + y[1] - 1]; // both start from Beta(1,1); count it once
  return { g: sum(a.g, b.g), ew: sum(a.ew, b.ew), et: sum(a.et, b.et) };
}

/**
 * `local` holds this machine's own decayed counts for the cell:
 *   { g:[pass,fail], ew:[bad,good], et:[bad,good] }   (raw counts, no prior)
 * `rows` are the seed rows already filtered to this job, file kind and worker.
 */
export function evaluateCell({ rows = [], local = null, door, S, Cretry, Cbad, policyLaneOpen = false }) {
  const mine = { g: [1, 1], ew: [1, 1], et: [1, 1] };
  if (local) for (const k of ["g", "ew", "et"]) { mine[k][0] += local[k][0]; mine[k][1] += local[k][1]; }

  const weak = (r) => !STRONG.has(r.success_definition);
  const old = (r) => r.older_model_version === true;
  const solid = seedCounts(rows, door, (r) => weak(r) || old(r));
  const withWeak = seedCounts(rows, door, (r) => old(r));
  const withOld = seedCounts(rows, door, (r) => weak(r));

  const p = (counts) => probNetPositive({ ...merge(mine, counts), S, Cretry, Cbad });
  const ev = (counts) => expectedNetUsd({ ...merge(mine, counts), S, Cretry, Cbad });
  // weak evidence may only close; an older model's evidence may only open
  const P = Math.max(Math.min(p(solid), p(withWeak)), p(withOld));
  const expected = Math.max(Math.min(ev(solid), ev(withWeak)), ev(withOld));

  const trusted = policyLaneOpen || solid.used > 0 || withOld.used > 0;
  let state = expected < 0 || P <= CLOSED_AT ? "closed" : P >= OPEN_AT ? "open" : "explore";
  if (state === "open" && !trusted) state = "explore";
  // The governed policy is a decision the organisation already made: a lane it
  // gives to a worker starts OPEN in chat. Evidence can still CLOSE it (the
  // branch above); what the policy removes is only the in-between coin flip.
  let openedBy = state === "open" ? "evidence" : null;
  if (policyLaneOpen && state === "explore") { state = "open"; openedBy = "policy"; }
  const delegateProbability = state === "open" ? 1 : state === "closed" ? 0 : Math.max(EXPLORE_FLOOR, Math.min(P, trusted ? 1 : 0.5));
  return { P, expected_net_usd: expected, state, delegateProbability, trusted, opened_by: openedBy };
}

/** Every job, delegated or not, ages the cell's counts a little, so stale evidence fades. */
export function decay(local, factor = DECAY) {
  const out = {};
  for (const k of ["g", "ew", "et"]) out[k] = [local[k][0] * factor, local[k][1] * factor];
  return out;
}

/** A new model version is a different worker that resembles the old one: keep a quarter. */
export function onModelVersionChange(local) {
  return decay(local, 0.25);
}

/**
 * The delegate-or-not draw for one session and cell, made once. A cell that is
 * being explored must not flip between yes and no in the middle of a session.
 * The probability is stored with the answer so every eligible job, delegated or
 * not, can be weighted correctly later.
 */
export function drawForSession(sessionId, cellKey, probability, env = process.env, draw = () => randomInt(0, 1_000_000) / 1_000_000) {
  const dir = ensureSessionDir(sessionId, env);
  const name = "cell." + cellKey.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) + ".json";
  const file = join(dir, name);
  if (!existsSync(file)) {
    createExclusive(file, JSON.stringify({ cell: cellKey, probability, delegate: draw() < probability, drawn_at: new Date().toISOString() }));
  }
  return JSON.parse(readFileSync(join(sessionDir(sessionId, env), name), "utf8"));
}

/** Dollars saved per job for a cell, from the most specific cost row that exists. */
export function seedSavingUsd(seeds, job, fileKind, worker) {
  const base = seeds.base_job_cost_usd?.[job];
  if (typeof base !== "number") return null;
  const costRows = seeds.rows.filter((r) => r.cost_only && r.job === job && r.worker === worker);
  const row = costRows.find((r) => r.file_kind === fileKind) ?? costRows.find((r) => r.file_kind === "any");
  return row ? (base * row.saving_pct) / 100 : null;
}
