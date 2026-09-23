/**
 * The scout job: a cheaper model reads the likely files and reports where to
 * look, each place verified against the files by code. Offline: a throwaway
 * git repository and the stub door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const A = join(ROOT, "plugin", "scripts", "ambient");
const { candidateFiles, checkScoutAnswer, renderScoutBrief } = await import(join(A, "lib", "scout.mjs"));
const { startScout, jobResult } = await import(join(A, "jobs.mjs"));
const { stubDoor } = await import(join(A, "lib", "door.mjs"));
const { localSummary } = await import(join(A, "lib", "evidence.mjs"));

function world() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-scout-"));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  for (const d of [join(repo, "src"), home, stubs]) mkdirSync(d, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "src", "orders.js"), "export function createOrder(req, res) {\n  const total = computeTotal(req.body.items);\n  return res.json({ total });\n}\n");
  writeFileSync(join(repo, "src", "items.js"), "export function computeTotal(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n");
  writeFileSync(join(repo, "src", "unrelated.js"), "export const nothing = 1;\n");
  writeFileSync(join(repo, ".env"), "SECRET=computeTotal\n");
  git("add", "-A");
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on", vendors_allowed_everywhere: ["google"], jobs: { block_ms: 0, landing: "manual" } }));
  const env = { MMO_HOME: home, HOME: home, PATH: process.env.PATH, MMO_AMBIENT_STUB_DIR: stubs };
  const stamp = { session_id: "s1", prompt_id: "p1", arm: "on", mode: "on" };
  const events = () => readFileSync(join(home, "sessions", "s1", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, repo, home, stubs, env, stamp, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("candidates come from the terms, ranked by hits, never a secret file; the brief numbers every line; the checks keep only places that exist and quotes that really sit there", async () => {
  const w = world();
  try {
    const c = candidateFiles(w.repo, { terms: ["computeTotal"], maxFiles: 10 });
    assert.deepEqual(c.files, ["src/items.js", "src/orders.js"], "both hits, no .env, no unrelated file");
    const files = c.files.map((p) => ({ path: p, content: readFileSync(join(w.repo, p), "utf8") }));
    const brief = renderScoutBrief({ question: "Where is the order total computed, and where is it used?", files });
    assert.match(brief, /   1\| export function computeTotal/);
    const answer = {
      places: [
        { path: "src/orders.js", start: 1, end: 4, why: "The route that computes and returns the total.", quote: "const total = computeTotal(req.body.items);" },
        { path: "src/items.js", start: 1, end: 3, why: "The total itself.", quote: "NOT A REAL LINE" },
        { path: "src/nope.js", start: 1, end: 2, why: "invented", quote: "" },
        { path: "src/items.js", start: 2, end: 99, why: "out of range", quote: "" },
      ],
      summary: "Edit computeTotal in items.js; createOrder in orders.js calls it.",
    };
    const checked = checkScoutAnswer(JSON.stringify(answer), files);
    assert.equal(checked.ok, true);
    assert.equal(checked.places.length, 1, "one place verified");
    assert.equal(checked.dropped, 3, "a wrong quote, an unknown file and an out-of-range span are dropped");
    assert.equal(checkScoutAnswer("Sure, here it is", files).ok, false);
  } finally { w.cleanup(); }
});

test("a scout job runs through the door like any job: recorded, priced, checked; the thinker gets places with exact Read ranges, never the files", async () => {
  const w = world();
  try {
    writeFileSync(join(w.stubs, "scout_repo.json"), JSON.stringify({
      answer: { places: [{ path: "src/orders.js", start: 1, end: 4, why: "The route that computes the total.", quote: "return res.json({ total });" }, { path: "src/items.js", start: 1, end: 3, why: "Where the total is summed.", quote: "return items.reduce((s, i) => s + i.price * i.qty, 0);" }], summary: "Change computeTotal; createOrder only calls it." },
      usage: { input_tokens: 3000, output_tokens: 200 }, model: "gemini-3.8-flash",
    }));
    const started = await startScout({ args: { question: "Where is the order total computed and where is it used?", terms: ["computeTotal"] }, stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env });
    assert.equal(started.status, "running", JSON.stringify(started));
    assert.equal(started.files_sent, 2);
    const r = await jobResult(started.job_id, { waitMs: 8000, env: w.env });
    assert.equal(r.status, "ready", JSON.stringify(r));
    assert.equal(r.places.length, 2);
    assert.match(r.text, /Read src\/orders\.js offset 1 limit 4/);
    assert.match(r.text, /Summary: Change computeTotal/);
    assert.ok(!("landing" in r), "nothing to land: a scout changes nothing");
    assert.ok(r.worker_cost_usd > 0);
    const ev = w.events();
    assert.equal(ev.find((e) => e.type === "job.started")?.tool, "scout_repo");
    assert.equal(ev.find((e) => e.type === "job.ready")?.places, 2);
    assert.equal(localSummary("scout|js_ts|flash|completion", w.env).passed, 1, "a verified report teaches the cell");
    const bad = world();
    try {
      writeFileSync(join(bad.stubs, "scout_repo.json"), JSON.stringify({ text: "I could not read the files.", usage: { input_tokens: 10, output_tokens: 5 } }));
      writeFileSync(join(bad.home, "ambient.json"), JSON.stringify({ mode: "on", vendors_allowed_everywhere: ["google"], jobs: { block_ms: 0, landing: "manual", answer_retries: 0, worker_cascade: false } }));
      const s2 = await startScout({ args: { question: "Where is the order total computed and where is it used?", terms: ["computeTotal"] }, stamp: bad.stamp, projectDir: bad.repo, callWorker: stubDoor(bad.env), env: bad.env });
      const r2 = await jobResult(s2.job_id, { waitMs: 8000, env: bad.env });
      assert.equal(r2.status, "failed");
      assert.match(r2.reason, /not one JSON object/);
    } finally { bad.cleanup(); }
  } finally { w.cleanup(); }
});

test("a scout is refused before anything leaves when the question is too short, no candidate file matches, or delegation is off", async () => {
  const w = world();
  try {
    assert.equal((await startScout({ args: { question: "where?", terms: ["computeTotal"] }, stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env })).status, "refused");
    assert.equal((await startScout({ args: { question: "Where is the order total computed and where is it used?", terms: ["zzz-nothing-zzz"] }, stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env })).status, "refused");
    writeFileSync(join(w.home, "ambient.json"), JSON.stringify({ mode: "on", delegation: "off" }));
    const off = await startScout({ args: { question: "Where is the order total computed and where is it used?", terms: ["computeTotal"] }, stamp: w.stamp, projectDir: w.repo, callWorker: stubDoor(w.env), env: w.env });
    assert.equal(off.status, "refused");
    assert.match(off.reason, /delegation: off/);
  } finally { w.cleanup(); }
});
