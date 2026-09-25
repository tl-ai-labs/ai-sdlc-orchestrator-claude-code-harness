/**
 * Two things are held here: the worker-picking value rule, and an AUDIT of the
 * shipped seed table. The audit exists because every one of these mistakes was
 * made while the design was drafted: rows counting runs where the worker was
 * never called, rows bucketed on something that only exists after the worker
 * ran, and cells opened on a handful of jobs under a weak success definition.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const V = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "value-rule.mjs"));
const O = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "offers.mjs"));
const SEEDS = JSON.parse(readFileSync(join(ROOT, "plugin", "config", "ambient-seeds.json"), "utf8"));
const DEFAULTS = JSON.parse(readFileSync(join(ROOT, "plugin", "config", "ambient.default.json"), "utf8"));

const rowsFor = (job, worker) => SEEDS.rows.filter((r) => r.job === job && r.worker === worker);
// One cell = the rows measured on THIS file kind (the pooled "any" rows only when the kind has none of its own).
const cell = (job, kind, worker, over = {}) =>
  V.evaluateCell({
    rows: O.rowsForCell(SEEDS, job, kind, worker), door: "completion", Cretry: 0.4, Cbad: DEFAULTS.cost_of_bad_result_usd,
    S: V.seedSavingUsd(SEEDS, job, kind, worker), ...over,
  });

test("the Beta CDF matches known values", () => {
  assert.ok(Math.abs(V.betaCdf(0.5, 1, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(V.betaCdf(0.3, 2, 5) - 0.579825) < 1e-5);
  // Independent check: for whole-number parameters the Beta CDF is a binomial tail.
  const choose = (n, k) => { let c = 1; for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i; return c; };
  const tail = (x, a, b) => { const n = a + b - 1; let t = 0; for (let j = a; j <= n; j++) t += choose(n, j) * x ** j * (1 - x) ** (n - j); return t; };
  for (const [x, a, b] of [[0.9, 40, 3], [0.02, 4, 130], [0.5, 15, 15], [0.97, 520, 4]]) {
    assert.ok(Math.abs(V.betaCdf(x, a, b) - tail(x, a, b)) < 1e-9, `betaCdf(${x}, ${a}, ${b})`);
  }
  assert.equal(V.betaCdf(0, 2, 2), 0);
  assert.equal(V.betaCdf(1, 2, 2), 1);
});

test("seed audit: no never-dispatched rows, no post-treatment buckets, every row names its source", () => {
  for (const row of SEEDS.rows) {
    const id = `${row.job}/${row.file_kind}/${row.worker}`;
    assert.ok(typeof row.source === "string" && row.source.length > 10, `${id}: a seed without a source is a guess`);
    assert.ok(["none", "pre_treatment"].includes(row.bucketed_on), `${id}: bucketed on something that exists only after the worker ran`);
    if (row.cost_only) continue;
    assert.equal(row.dispatched_only, true, `${id}: rows must count only runs where the worker was really called`);
    assert.ok(["hidden_tests", "kept_result", "valid_result", "edit_format"].includes(row.success_definition), id);
    assert.ok(row.paired || row.rate, `${id}: needs paired counts or a rate`);
    if (row.paired) assert.ok(row.paired.only_thinker_right + row.paired.only_worker_right <= row.paired.n, id);
  }
});

test("seed audit: weak or thin evidence can never open a cell on its own", () => {
  const weakOnly = new Map();
  for (const row of SEEDS.rows.filter((r) => !r.cost_only)) {
    const key = `${row.job}|${row.worker}`;
    const strong = ["hidden_tests", "kept_result"].includes(row.success_definition) && !row.older_model_version;
    weakOnly.set(key, (weakOnly.get(key) ?? true) && !strong);
  }
  for (const [key, isWeakOnly] of weakOnly) {
    if (!isWeakOnly) continue;
    const [job, worker] = key.split("|");
    const verdict = V.evaluateCell({ rows: rowsFor(job, worker).filter((r) => r.success_definition !== "edit_format"), door: "completion", S: 5, Cretry: 0, Cbad: 0.01 });
    assert.notEqual(verdict.state, "open", `${key}: opened by 'valid result' telemetry alone, with no trusted source`);
  }
});

test("bug-fix code, per language from the SWE-bench Pro runs: Flash on Python and JS/TS, Sonnet on Go, Flash when the language is unknown", () => {
  // Each language has its own paired rows for BOTH workers, from the same bugs: the same 264 Python bugs went
  // to Opus alone, to Opus+Flash and to Opus+Sonnet. A cell is judged on its own language's rows.
  for (const kind of ["go", "js_ts", "python"]) {
    for (const worker of ["flash", "sonnet"]) {
      const rows = O.rowsForCell(SEEDS, "bugfix_code", kind, worker);
      assert.equal(rows.length, 1, `${kind}/${worker}: exactly one paired row of its own`);
      assert.equal(rows[0].file_kind, kind);
      assert.ok(rows[0].paired.n >= 100, `${kind}/${worker}: ${rows[0].paired.n} bugs is too thin to pick on`);
    }
    const [f, s] = ["flash", "sonnet"].map((w) => O.rowsForCell(SEEDS, "bugfix_code", kind, w)[0]);
    assert.ok(Math.abs(f.paired.n - s.paired.n) <= 15, `${kind}: both workers were measured on the same bugs`);
  }
  assert.equal(O.rowsForCell(SEEDS, "bugfix_code", "any", "flash")[0].file_kind, "any", "an unknown language falls back to the pooled rows");
  assert.equal(O.rowsForCell(SEEDS, "bugfix_code", "rust", "flash")[0].file_kind, "any");

  // The real cell rule (bug-fix code is a lane the policy already gives to a worker, so evidence can close it
  // and an in-between score opens it). Per language the counts are thinner than pooled: JS/TS Flash scores
  // just under the 0.8 bar on its 129 bugs alone and is opened by the policy lane, not by the evidence.
  const real = (kind, worker) => O.cellFor(DEFAULTS, "bugfix_code", kind, SEEDS, worker);
  for (const [kind, worker] of [["python", "flash"], ["js_ts", "flash"], ["go", "sonnet"], ["js_ts", "sonnet"], ["any", "flash"], ["any", "sonnet"]]) {
    const v = real(kind, worker);
    assert.equal(v.state, "open", `${kind}/${worker} P=${v.P.toFixed(3)} E=${v.expected_net_usd.toFixed(3)}`);
    assert.ok(v.expected_net_usd > 0, `${kind}/${worker}: an open cell must be worth money on average`);
  }
  assert.equal(real("any", "flash").opened_by, "evidence", "pooled over 523 bugs, Flash is opened by the evidence itself");
  assert.equal(real("go", "flash").state, "closed", "on the Go repos Flash cost MORE than the thinker alone: nothing to save");
  assert.equal(real("python", "sonnet").state, "closed", "on Python Sonnet lost 15 bugs and won 3: the loss outweighs 7.8% cheaper");

  // The pick: the open worker with the most saved per job, for the language of the files in the job.
  const pick = (kind, config = DEFAULTS) => O.pickWorker(config, "bugfix_code", kind, SEEDS);
  assert.deepEqual(["python", "js_ts", "go", "any", "rust"].map((k) => pick(k).worker), ["flash", "flash", "sonnet", "flash", "flash"]);
  assert.equal(pick("go").model, "claude-sonnet-5");
  assert.equal(pick("python").model, "gemini-3.8-flash");
  assert.equal(pick("go").cell.cellKey, "bugfix_code|go|sonnet|completion");
  assert.deepEqual(pick("go").considered.map((c) => [c.worker, c.state]), [["flash", "closed"], ["sonnet", "open"]]);
  assert.ok(pick("js_ts").considered.every((c) => c.state === "open"), "on JS/TS both are open; Flash is picked because it saves more per job");
  const closedByHand = pick("python", { ...DEFAULTS, closed_cells: ["bugfix_code|python|flash|completion"] });
  assert.equal(closedByHand.worker, null, "Flash closed by settings and Sonnet closed by evidence: nobody, the thinker keeps it");
  assert.equal(closedByHand.cell.state, "closed");
  const sonnetFirst = pick("js_ts", { ...DEFAULTS, workers: { ...DEFAULTS.workers, default: "sonnet" } });
  assert.equal(sonnetFirst.worker, "flash", "the default worker only breaks a tie; it never overrides a measured difference");
});

test("the worker settings name each worker's model and which one is the default", () => {
  assert.deepEqual(Object.keys(DEFAULTS.workers).sort(), ["default", "flash", "sonnet"]);
  assert.equal(DEFAULTS.workers.default, "flash");
  const pick = O.pickWorker({ ...DEFAULTS, workers: { flash: "gemini-3.8-flash", default: "flash" } }, "bugfix_code", "go", SEEDS);
  assert.equal(pick.worker, null, "with Sonnet removed from the lineup, a Go bug fix has no open worker");
});

test("the one organisation number moves the answer the right way", () => {
  const cheapMistakes = cell("bugfix_code", "any", "flash", { Cbad: 2 });
  const dearMistakes = cell("bugfix_code", "any", "flash", { Cbad: 400 });
  assert.ok(cheapMistakes.P > 0.95);
  assert.ok(dearMistakes.P > 0.2 && dearMistakes.expected_net_usd < 0, "the odds alone would still explore this cell, at a loss per job");
  assert.equal(dearMistakes.state, "closed", "where a wrong fix is very expensive the thinker keeps the job");
  assert.equal(dearMistakes.delegateProbability, 0);
});

test("local results move a cell: bad local outcomes close it, and they fade with decay", () => {
  const bad = { g: [20, 0], ew: [15, 5], et: [0, 20] };
  assert.equal(cell("bugfix_code", "any", "flash", { local: bad }).state, "closed", "a local event may close a cell");
  let faded = bad;
  for (let i = 0; i < 400; i++) faded = V.decay(faded);
  assert.equal(cell("bugfix_code", "any", "flash", { local: faded }).state, "open", "old evidence ages out");
  assert.deepEqual(V.onModelVersionChange({ g: [8, 0], ew: [4, 4], et: [0, 8] }).ew, [1, 1], "a new model version keeps a quarter");
});

test("with no trusted evidence a cell is explored at no more than even odds, never opened", () => {
  const v = V.evaluateCell({ rows: [], local: { g: [30, 0], ew: [0, 30], et: [0, 30] }, door: "completion", S: 1, Cretry: 0.1, Cbad: 9 });
  assert.equal(v.state, "explore");
  assert.ok(v.delegateProbability <= 0.5);
  const lane = V.evaluateCell({ rows: [], local: { g: [30, 0], ew: [0, 30], et: [0, 30] }, door: "completion", S: 1, Cretry: 0.1, Cbad: 9, policyLaneOpen: true });
  assert.equal(lane.state, "open", "a lane the governed policy already gives to a worker is a trusted prior");
});

test("evidence from an older model version may open a cell and never close it", () => {
  const rows = [{ job: "x", worker: "flash", door: "completion", success_definition: "hidden_tests", older_model_version: true, rate: [2, 40] }];
  const withOld = V.evaluateCell({ rows, door: "completion", S: 0.5, Cretry: 0.1, Cbad: 9 });
  const without = V.evaluateCell({ rows: [], door: "completion", S: 0.5, Cretry: 0.1, Cbad: 9 });
  assert.ok(withOld.P >= without.P, "a poor record of an older version must not drag the new one down");
});

test("the delegate draw is made once per session and cell, with its probability stored", () => {
  const home = mkdtempSync(join(tmpdir(), "mmo-ambient-draw-"));
  try {
    const env = { MMO_HOME: home };
    const first = V.drawForSession("s1", "bugfix_code|python|flash|completion", 0.6, env, () => 0.1);
    const second = V.drawForSession("s1", "bugfix_code|python|flash|completion", 0.6, env, () => 0.99);
    assert.deepEqual(second, first, "a cell must not flip between yes and no inside one session");
    assert.equal(first.delegate, true);
    assert.equal(first.probability, 0.6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
