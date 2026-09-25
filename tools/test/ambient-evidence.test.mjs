/**
 * The evidence this machine gathers about its own jobs, and how it changes the
 * verdicts. Everything here is offline: a private MMO_HOME, no vendor.
 *
 *   - every job's checks outcome (pass / fail) and every landed job's fate
 *     (undone or the next test run failing = wrong; a passing run = held) are
 *     counted per cell and fed to the value rule's `local` slot;
 *   - old counts fade (DECAY per new outcome), so a bad week does not close a
 *     cell for ever and a good one does not open it for ever;
 *   - the number of requests a hand-over really costs (the start call plus
 *     every job_result poll) is measured and replaces the typing rule's guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { recordChecks, recordLanding, localFor, recordHandoverRequests, measuredExtraRequests, readEvidence, recordTypedChars, expectedCharsPerFile } = await import(join(A, "lib", "evidence.mjs"));
const { cellFor, loadSeeds } = await import(join(A, "lib", "offers.mjs"));
const { handoverNet } = await import(join(A, "lib", "cost-rule.mjs"));
const { loadConfig } = await import(join(A, "lib", "config.mjs"));

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-evidence-"));
  writeFileSync(join(dir, "ambient.json"), JSON.stringify({ mode: "on" }));
  return { env: { MMO_HOME: dir, HOME: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a cell the policy opens is CLOSED by this machine's own failures, and reopens as later jobs pass; old counts fade", () => {
  const h = home();
  const { config } = loadConfig({ env: h.env });
  const seeds = loadSeeds();
  const cell = "tests|js_ts|flash|completion";
  assert.equal(cellFor(config, "tests", "js_ts", seeds, "flash", h.env).state, "open", "the policy lane starts open");
  for (let i = 0; i < 12; i++) recordChecks(cell, false, h.env);
  const closed = cellFor(config, "tests", "js_ts", seeds, "flash", h.env);
  assert.equal(closed.state, "closed", `twelve failed jobs close it (P=${closed.P.toFixed(2)})`);
  for (let i = 0; i < 40; i++) recordChecks(cell, true, h.env);
  const again = cellFor(config, "tests", "js_ts", seeds, "flash", h.env);
  assert.notEqual(again.state, "closed", `forty passes after that reopen it (P=${again.P.toFixed(2)})`);
  const local = localFor(cell, h.env);
  assert.ok(local.g[0] + local.g[1] < 52, "counts are decayed, never a raw total");
  assert.ok(local.g[1] < 12, "the twelve old failures have faded");
  h.cleanup();
});

test("a landed job that was undone or failed its next test run counts as WRONG; a held one as right; both reach the verdict", () => {
  const h = home();
  const { config } = loadConfig({ env: h.env });
  const seeds = loadSeeds();
  const cell = "boilerplate|python|flash|completion";
  const before = cellFor(config, "boilerplate", "python", seeds, "flash", h.env);
  for (let i = 0; i < 10; i++) recordLanding(cell, "bad", h.env);
  const worse = cellFor(config, "boilerplate", "python", seeds, "flash", h.env);
  assert.ok(worse.P < before.P, "ten wrong landings lower the chance the cell pays");
  for (let i = 0; i < 30; i++) recordLanding(cell, "good", h.env);
  const better = cellFor(config, "boilerplate", "python", seeds, "flash", h.env);
  assert.ok(better.P > worse.P, "thirty held landings raise it again");
  const ev = readEvidence(h.env);
  assert.equal(ev.cells[cell].jobs, 0, "a landing settles a job already counted at its checks; it adds no job");
  assert.equal(typeof ev.cells[cell].updated, "string");
  h.cleanup();
});

test("the requests a hand-over really costs are measured from the polls and raise the break-even", () => {
  const h = home();
  assert.equal(measuredExtraRequests(h.env), null, "nothing measured yet: the rule keeps its guess");
  recordHandoverRequests(6, h.env);
  recordHandoverRequests(8, h.env);
  const m = measuredExtraRequests(h.env);
  assert.ok(m > 6 && m < 8, `a decayed mean of the two (${m})`);
  const prices = { in: 5e-6, out: 25e-6, r: 0.5e-6, w: 6.25e-6 };
  const worker = { in: 0.75e-6, out: 3.75e-6 };
  const guessed = handoverNet({ chars: 10000, C: 100000, prices, worker, extraRequests: 2 });
  const measured = handoverNet({ chars: 10000, C: 100000, prices, worker, extraRequests: m });
  assert.ok(measured.breakEvenChars > guessed.breakEvenChars, "more requests per hand-over: a higher break-even");
  h.cleanup();
});

test("evidence is a private user-level file, written atomically, and a corrupt file is treated as empty", () => {
  const h = home();
  recordChecks("x|any|flash|completion", true, h.env);
  const file = join(h.dir, "evidence.json");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("x|any|flash|completion"));
  writeFileSync(file, "{ not json");
  assert.equal(localFor("x|any|flash|completion", h.env), null);
  recordChecks("x|any|flash|completion", true, h.env);
  assert.deepEqual(localFor("x|any|flash|completion", h.env).g.map(Math.round), [1, 0]);
  h.cleanup();
});

test("jobs are counted once per job at its checks: a resend within the same job adds a fail, not a job", () => {
  const h = home();
  const cell = "tests|js_ts|flash|completion";
  recordChecks(cell, false, h.env, { newJob: true });
  recordChecks(cell, false, h.env, { newJob: false });
  recordChecks(cell, true, h.env, { newJob: false });
  const c = readEvidence(h.env).cells[cell];
  assert.equal(c.jobs, 1);
  assert.ok(Math.round(c.g[1]) === 2 && Math.round(c.g[0]) === 1, JSON.stringify(c.g));
  h.cleanup();
});

test("the size of a job's typing per file is learned from real answers: the seed counts as three files until real ones replace it", () => {
  const h = home();
  assert.equal(expectedCharsPerFile("tests", h.env, 13000), 13000, "nothing learned yet: the seed");
  recordTypedChars("tests", [1000], h.env);
  const one = expectedCharsPerFile("tests", h.env, 13000);
  assert.ok(one < 13000 && one > 1000, `one real file moves the mean: ${one}`);
  for (let i = 0; i < 30; i++) recordTypedChars("tests", [1000], h.env);
  assert.ok(expectedCharsPerFile("tests", h.env, 13000) < 2500, "thirty real files leave the seed far behind (it still counts as three files, decayed against about twenty-four)");
  assert.equal(expectedCharsPerFile("docs", h.env, undefined), 3000, "no seed, nothing learned: a plain default");
  h.cleanup();
});
