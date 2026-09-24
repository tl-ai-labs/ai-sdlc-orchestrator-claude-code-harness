/**
 * The shared executor (execute_stage) with fake typists: routing by the
 * policy on every attempt, the three-attempt ladder, transport waits, the
 * repair stage and its edit contract, warming a cold cache first, the checks
 * (exports, imports, a present toolchain), the files it writes, the bill it
 * emits, the receipt it returns, and the run state it requires. No model calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeStage, backoffMs, applyEdits, LEAN_OPUS_CACHE_TTL_MS } from "../dist/executor/run.js";
import { checkAnswer, checkPython, toolchainProblem } from "../dist/executor/checks.js";
import { EXECUTOR_TOOLS, handleExecutorTool, reviewRepairs, STAGE_CONCURRENCY, TRANSPORT } from "../dist/executor/tools.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const SOLO = loadPolicyFromPath(join(POLICIES, "opus-only-v5.yaml"));
const ORCH = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));

const unit = (id, path, kind, phase = "codegen") => ({
  id, path, phase, kind, exports: [{ name: "thing", kind: "function", params: [], returns: "int" }],
  behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5,
});
const SPEC = {
  spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] },
  units: [
    unit("U01", "app/models.py", "entity"),          // v38 → Flash
    unit("U02", "app/config.py", "other"),           // v38 → default Opus
    unit("U03", "app/routes.py", "controller_handler"), // v38 → Flash
    unit("U04", "tests/test_x.py", "test_unit", "tests"), // another stage
  ],
};
const GOOD = (u) => ({ path: u.path, content: "def thing():\n    return 1\n" });
const tokens = { input: 100, input_cached: 0, output: 50 };

/** A fake typist that answers from a script of results, recording every request. */
function fake(door, modelId, script = () => ({})) {
  const calls = [];
  return {
    door, modelId, modelName: `${door}-model`, calls,
    async type(req) {
      calls.push(req);
      const s = script(req, calls.length);
      return { answer: s.answer === undefined ? GOOD(req.unit) : s.answer, error: s.error, transport: !!s.transport, retry_after_ms: s.retry_after_ms, tokens, cost_usd: s.cost ?? 0.01, latency_ms: 1 };
    },
  };
}
const OPTS = (policy, dir, over = {}) => ({ stage: "codegen", codeDir: dir, passId: "p1", policy, concurrency: 2, routedAttempts: 2, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 }, ...over });
const okCheck = () => ({ ok: true, checked: "parsed" });

test("solo: every unit of the stage goes to the lean Opus typist, is written, and is billed once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const r = await executeStage(SPEC, OPTS(SOLO, dir), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(r.units, 3, "only the codegen stage");
  assert.equal(r.written, 3);
  assert.deepEqual(r.failed, []);
  assert.equal(opus.calls.length, 3);
  assert.deepEqual(Object.keys(r.by_door), ["lean-opus"]);
  assert.equal(r.cost_usd, 0.03);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.door === "lean-opus" && e.success && e.provenance === "vendor" && e.pass === "p1"));
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 1\n");
  assert.equal(existsSync(join(dir, "tests/test_x.py")), false, "the tests stage is not typed by a codegen call");
});

test("orchestrator: the policy's own rules send each unit to its typist; the shared block and framed brief reach every typist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const flash = fake("flash-completion", "flash-completion");
  const opus = fake("lean-opus", "opus");
  const typistFor = (id) => (id === "opus" ? opus : flash);
  const r = await executeStage(SPEC, OPTS(ORCH, dir), { typistFor, fallback: opus, shared: "SHARED-BLOCK", sharedFile: "/tmp/shared", emit: () => {}, check: okCheck });
  assert.deepEqual(flash.calls.map((c) => c.unit.id).sort(), ["U01", "U03"]);
  assert.deepEqual(opus.calls.map((c) => c.unit.id), ["U02"]);
  assert.equal(r.by_door["flash-completion"].units_written, 2);
  assert.equal(r.by_door["lean-opus"].units_written, 1);
  for (const c of [...flash.calls, ...opus.calls]) {
    assert.equal(c.shared, "SHARED-BLOCK");
    assert.equal(c.sharedFile, "/tmp/shared");
    assert.equal(c.contract, "file");
    assert.ok(c.framed.startsWith(`## Task — ${c.unit.id} (codegen / ${c.packet.task_type})`));
  }
});

test("the ladder: two routed attempts with the refusal fed back, then one lean Opus attempt; each attempt is billed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/models.py", content: "x = 1\n" } }));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: (u, a) => checkAnswer(u, a, "python3") });
  assert.equal(flash.calls.length, 2);
  assert.ok(!flash.calls[0].packet.instruction.includes("previous answer was refused"));
  assert.match(flash.calls[1].packet.instruction, /## Your previous answer was refused\nthese declared exports are not defined: thing/);
  assert.equal(opus.calls.length, 1, "the lean Opus attempt");
  assert.match(opus.calls[0].packet.instruction, /previous answer was refused/);
  assert.equal(r.written, 1);
  assert.equal(r.by_door["lean-opus"].units_written, 1);
  assert.deepEqual(events.map((e) => [e.door, e.attempt_number, e.success]), [["flash-completion", 1, false], ["flash-completion", 2, false], ["lean-opus", 3, true]]);
  assert.equal(events[2].routing.rule_index, -1);
  assert.equal(r.calls, 3);
});

test("a unit every attempt refuses is reported failed, and nothing is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const bad = fake("lean-opus", "opus", () => ({ answer: null, error: "the reply was not one JSON object {path, content}" }));
  const one = { ...SPEC, units: [SPEC.units[1]] };
  const r = await executeStage(one, OPTS(SOLO, dir), { typistFor: () => bad, fallback: bad, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(bad.calls.length, 3, "solo gets the same three attempts, all lean Opus");
  assert.deepEqual(r.failed, [{ id: "U02", path: "app/config.py", reason: "the reply was not one JSON object {path, content}" }]);
  assert.equal(existsSync(join(dir, "app/config.py")), false);
});

test("a transport failure waits (the vendor's own delay when given, else jittered backoff) and is not an attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const waits = [];
  const flaky = fake("flash-completion", "flash-completion", (req, n) => (n === 1 ? { answer: null, transport: true, error: "429 RESOURCE_EXHAUSTED", retry_after_ms: 7000, cost: 0 } : n === 2 ? { answer: null, transport: true, error: "503 UNAVAILABLE", cost: 0 } : {}));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  const r = await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flaky), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  assert.deepEqual(waits, [7000, 1000], "the vendor's 7 s, then 0.5 × min(8000, 1000·2^1)");
  assert.equal(r.transport_waits, 2);
  assert.equal(r.written, 1);
  assert.equal(opus.calls.length, 0, "no attempt was used up");
  assert.deepEqual(events.map((e) => [e.retry_reason, e.attempt_number, e.success]), [["transport", 1, false], ["transport", 1, false], [undefined, 1, true]]);
});

test("an answer for another path, or an unsafe one, is refused", () => {
  const u = SPEC.units[0];
  assert.match(checkAnswer(u, { path: "app/other.py", content: "def thing(): pass\n" }, "python3").reason, /names app\/other\.py, not app\/models\.py/);
  assert.equal(checkAnswer({ ...u, path: "../x.py" }, { path: "../x.py", content: "def thing(): pass\n" }, "python3").ok, false);
  assert.equal(checkAnswer(u, { path: u.path, content: "   \n" }, "python3").reason, "the file is empty");
  assert.match(checkAnswer(u, { path: u.path, content: "def thing(:\n" }, "python3").reason, /does not parse/);
  const ts = { ...u, path: "src/a.ts", exports: [{ name: "run", kind: "function", params: [], returns: "void" }] };
  assert.equal(checkAnswer(ts, { path: "src/a.ts", content: "export function run(): void {}\n" }, "python3").ok, true);
  assert.match(checkAnswer(ts, { path: "src/a.ts", content: "function run(): void {}\n" }, "python3").reason, /not defined: run/);
});

test("the checker's interpreter is MMO_CHECK_PYTHON or python3, never read out of the architect's free text", () => {
  assert.equal(checkPython({}), "python3");
  assert.equal(checkPython({ MMO_CHECK_PYTHON: "/p" }), "/p");
});

test("a stage whose checker cannot run refuses before any typist is paid", async () => {
  assert.equal(toolchainProblem(["a.py", "b.ts"], "python3"), null);
  assert.match(toolchainProblem(["a.py"], "/no/such/python"), /did not run \(set MMO_CHECK_PYTHON/);
  assert.equal(toolchainProblem(["README.md"], "/no/such/python"), null, "no Python files, no interpreter needed");
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const saved = process.env.MMO_CHECK_PYTHON;
  process.env.MMO_CHECK_PYTHON = "/no/such/python";
  try {
    await assert.rejects(executeStage(SPEC, OPTS(SOLO, dir), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {} }), /did not run/);
  } finally {
    if (saved === undefined) delete process.env.MMO_CHECK_PYTHON; else process.env.MMO_CHECK_PYTHON = saved;
  }
  assert.equal(opus.calls.length, 0);
});

test("dotted exports are checked as members: a method of a class, a key of an exported object", () => {
  const py = { path: "app/store.py", exports: [{ name: "NoteStore", kind: "class", params: [], returns: "" }, { name: "NoteStore.add", kind: "function", params: [], returns: "Note" }] };
  assert.equal(checkAnswer(py, { path: py.path, content: "class NoteStore:\n    def add(self, n):\n        return n\n" }, "python3").ok, true);
  assert.match(checkAnswer(py, { path: py.path, content: "class NoteStore:\n    pass\n\ndef add(n):\n    return n\n" }, "python3").reason, /not defined: NoteStore\.add/);
  const ts = { path: "src/api.ts", exports: [{ name: "Api.list", kind: "function", params: [], returns: "" }, { name: "routes.home", kind: "constant", params: [], returns: "" }] };
  assert.equal(checkAnswer(ts, { path: ts.path, content: "export class Api { list() { return []; } }\nexport const routes = { home: '/' };\n" }, "python3").ok, true);
  assert.match(checkAnswer(ts, { path: ts.path, content: "export class Api {}\nexport const routes = { home: '/' };\n" }, "python3").reason, /Api\.list/);
});

test("imports of the project's own code must resolve to a file the spec writes, with names it declares", () => {
  const u = (id, path, names) => ({ ...unit(id, path, "other"), exports: names.map((n) => ({ name: n, kind: "function", params: [], returns: "" })) });
  const spec = { ...SPEC, commands: [{ name: "tests", run: "pytest -q", cwd: "backend" }], units: [
    u("U01", "backend/app/models.py", ["Note"]), u("U02", "backend/app/routes/notes.py", ["router"]), u("U03", "backend/app/routes/__init__.py", []),
    u("U10", "frontend/src/api.ts", ["listNotes"]), u("U11", "frontend/src/App.tsx", ["App"]),
  ] };
  const chk = (path, content) => checkAnswer({ path, exports: [] }, { path, content }, "python3", spec);
  // Python: the standard library and third-party packages are not the spec's to judge.
  assert.equal(chk("backend/app/main.py", "import os, logging\nfrom fastapi import FastAPI\nfrom app.models import Note\nfrom app.routes.notes import router\n").ok, true);
  assert.equal(chk("backend/app/routes/notes.py", "from ..models import Note\nfrom . import notes\n").ok, true, "relative imports resolve by path");
  assert.match(chk("backend/app/main.py", "from app.logging import get_logger\n").reason, /imports app\.logging, which no unit of the spec writes/);
  assert.match(chk("backend/app/main.py", "from app.models import Notes\n").reason, /imports Notes from app\.models, which its spec entry does not export \(it exports: Note\)/);
  assert.match(chk("backend/app/routes/notes.py", "from ..schemas import NoteIn\n").reason, /imports \.\.schemas, which no unit of the spec writes/);
  // TypeScript: relative code imports only; packages, aliases, styles and default imports are not judged by name.
  assert.equal(chk("frontend/src/main.tsx", "import React from 'react';\nimport App from './App';\nimport './index.css';\nimport { listNotes } from './api';\nimport * as api from './api.js';\n").ok, true);
  assert.match(chk("frontend/src/main.tsx", "import { fetchNotes } from './api';\n").reason, /imports fetchNotes from '\.\/api', which its spec entry does not export/);
  assert.match(chk("frontend/src/main.tsx", "import { x } from './helpers';\n").reason, /imports '\.\/helpers', which no unit of the spec writes/);
});

test("never more units in flight than the stated limit, and the receipt stays short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let inFlight = 0, peak = 0;
  const slow = {
    door: "lean-opus", modelId: "opus", modelName: "m",
    async type(req) { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answer: null, error: "x".repeat(400), transport: false, tokens, cost_usd: 0, latency_ms: 1 }; },
  };
  const many = { ...SPEC, units: Array.from({ length: 30 }, (_, i) => unit(`U${String(i + 10).padStart(2, "0")}`, `f${i}.py`, "other")) };
  const r = await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => slow, fallback: slow, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.equal(peak, 4);
  assert.equal(r.failed.length + r.failed_not_listed, 30, "every failure is either listed or counted");
  assert.ok(r.failed.length >= 1);
  assert.ok(r.failed.every((f) => f.reason.length <= 160));
  assert.ok(JSON.stringify(r).length <= 2048, `receipt is ${JSON.stringify(r).length} bytes`);
});

test("a typist that throws fails only that attempt; the stage carries on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let n = 0;
  const shaky = { door: "lean-opus", modelId: "opus", modelName: "m", async type(req) { if (++n === 1) throw new Error("spawn claude ENOENT"); return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0.01, latency_ms: 1 }; } };
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[1]] };
  const r = await executeStage(one, OPTS(SOLO, dir), { typistFor: () => shaky, fallback: shaky, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.equal(r.written, 1);
  assert.match(events[0].error, /the lean-opus typist failed: spawn claude ENOENT/);
  assert.deepEqual(events.map((e) => [e.attempt_number, e.success]), [[1, false], [2, true]]);
});

test("a typist that cannot be built stops the stage before any unit is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  const typistFor = (id) => { if (id !== "opus") throw new Error("no Python for the agent door"); return opus; };
  await assert.rejects(executeStage(SPEC, OPTS(ORCH, dir), { typistFor, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck }), /no Python for the agent door/);
  assert.equal(opus.calls.length, 0, "nothing was paid for");
});

test("backoff is full jitter under a cap", () => {
  assert.equal(backoffMs(0, 1000, 8000, () => 0.999), 999);
  assert.equal(backoffMs(5, 1000, 8000, () => 0.5), 4000, "capped at 8 s before the jitter");
  assert.equal(backoffMs(3, 1000, 8000, () => 0), 0);
});

test("every attempt is routed with its own retry count: a fix under the orchestrator policy goes Flash, Flash, then lean Opus; under solo, lean Opus throughout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app/models.py"), "def thing():\n    return 0\n");
  const refuse = () => ({ answer: { path: "app/models.py", edits: [{ search: "not in the file", replace: "x" }] } });
  const flash = fake("flash-completion", "flash-completion", refuse);
  const opus = fake("lean-opus", "opus", refuse);
  const events = [];
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [{ path: "app/models.py", problems: ["thing() must return 1"] }] }), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck });
  assert.deepEqual(events.map((e) => [e.phase, e.door, e.retry_count]), [["debug", "flash-completion", 0], ["debug", "flash-completion", 1], ["debug", "lean-opus", 2]]);
  assert.deepEqual(events.slice(0, 2).map((e) => e.routing.rule_reason), ["Most debugs have clear cause", "Most debugs have clear cause"]);
  assert.equal(r.failed.length, 1);
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 0\n", "a refused fix leaves the file untouched");
  const soloEvents = [];
  const opus2 = fake("lean-opus", "opus", refuse);
  await executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [{ path: "app/models.py", problems: ["x"] }] }), { typistFor: () => opus2, fallback: opus2, shared: "S", sharedFile: "/dev/null", emit: (e) => soloEvents.push(e), check: okCheck });
  assert.deepEqual(soloEvents.map((e) => e.door), ["lean-opus", "lean-opus", "lean-opus"]);
});

test("a fix: the brief carries the current text and the problems; exact edits apply; several problems for one file are one job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app/models.py"), "def thing():\n    return 0\n");
  writeFileSync(join(dir, "app/test_models.py"), "def test_thing():\n    assert thing() == 1\n");
  const flash = fake("flash-completion", "flash-completion", () => ({ answer: { path: "app/models.py", edits: [{ search: "return 0", replace: "return 1" }] } }));
  const r = await executeStage(SPEC, OPTS(ORCH, dir, { stage: "repair", repairs: [
    { path: "app/models.py", problems: ["test_thing: assert 0 == 1"], context_paths: ["app/test_models.py"] },
    { path: "app/models.py", problems: ["major: thing() returns the wrong value — fix: return 1"] },
  ] }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: (u, a) => checkAnswer(u, a, "python3", SPEC) });
  assert.equal(r.units, 1, "one job per file");
  assert.equal(r.written, 1);
  assert.equal(readFileSync(join(dir, "app/models.py"), "utf8"), "def thing():\n    return 1\n");
  const req = flash.calls[0];
  assert.equal(req.contract, "edit");
  assert.equal(req.packet.phase, "debug");
  assert.match(req.packet.instruction, /## What must change\n- test_thing: assert 0 == 1\n- major: thing\(\) returns the wrong value — fix: return 1/);
  assert.match(req.framed, /### app\/models\.py  — current text \(your edits apply to this\)\n```\ndef thing\(\):\n    return 0\n/);
  assert.match(req.framed, /### app\/test_models\.py  — for reference only; do not edit/);
});

test("the edit contract fails closed: a search found twice or not at all changes nothing; a whole file is accepted", () => {
  assert.deepEqual(applyEdits("a b a", [{ search: "b", replace: "c" }]), { content: "a c a" });
  assert.match(applyEdits("a b a", [{ search: "a", replace: "c" }]).reason, /edit 1: its search text appears 2 times/);
  assert.match(applyEdits("a b", [{ search: "b", replace: "c" }, { search: "z", replace: "y" }]).reason, /edit 2: its search text appears 0 times/);
  assert.deepEqual(applyEdits("x", [{ search: "x", replace: "$&$1" }]), { content: "$&$1" }, "replacement text is literal");
});

test("a fix whose path leaves the code directory is refused before anything is read or sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const opus = fake("lean-opus", "opus");
  await assert.rejects(executeStage(SPEC, OPTS(SOLO, dir, { stage: "repair", repairs: [{ path: "../etc/passwd", problems: ["x"] }] }), { typistFor: () => opus, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck }), /outside the code directory/);
  assert.equal(opus.calls.length, 0);
});

test("a cold lean Opus typist sends one job alone, then fans out; a warm one does not wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  let inFlight = 0;
  const seen = [];
  let clock = 0;
  const slow = { door: "lean-opus", modelId: "opus", modelName: "m", async type(req) { inFlight++; seen.push(inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0.01, latency_ms: 1 }; } };
  const many = { ...SPEC, units: Array.from({ length: 6 }, (_, i) => unit(`U${10 + i}`, `f${i}.py`, "other")) };
  await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => slow, fallback: slow, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck, now: () => clock });
  assert.equal(seen[0], 1, "the first call runs alone");
  assert.ok(Math.max(...seen) > 1, "then the others run together");
  const flashSeen = [];
  let f = 0;
  const flash = { door: "flash-completion", modelId: "flash-completion", modelName: "f", async type(req) { f++; flashSeen.push(f); await new Promise((r) => setTimeout(r, 5)); f--; return { answer: GOOD(req.unit), transport: false, tokens, cost_usd: 0, latency_ms: 1 }; } };
  await executeStage(many, OPTS(SOLO, dir, { concurrency: 4 }), { typistFor: () => flash, fallback: flash, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: okCheck });
  assert.ok(flashSeen[1] > 1, "the Gemini doors are not held back: no cache the executor controls");
  assert.equal(LEAN_OPUS_CACHE_TTL_MS, 300000, "the five-minute lifetime the typist is launched with");
});

test("a vendor pause longer than one rate-limit window is an attempt, not a wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const waits = [];
  const flash = fake("flash-completion", "flash-completion", (req, n) => (n === 1 ? { answer: null, transport: true, error: "429", retry_after_ms: 90_000, cost: 0 } : {}));
  const opus = fake("lean-opus", "opus");
  const events = [];
  const one = { ...SPEC, units: [SPEC.units[0]] };
  await executeStage(one, OPTS(ORCH, dir), { typistFor: (id) => (id === "opus" ? opus : flash), fallback: opus, shared: "S", sharedFile: "/dev/null", emit: (e) => events.push(e), check: okCheck, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, []);
  assert.match(events[0].error, /asked for a 90 s pause, longer than one 8 s rate-limit window/);
  assert.deepEqual(events.map((e) => [e.attempt_number, e.success]), [[1, false], [2, true]]);
  assert.equal(TRANSPORT.capMs, 60_000, "one 60 s rate-limit window");
});

test("execute_stage takes no auth mode, policy or concurrency from the model; it refuses to run before pre-flight", async () => {
  const props = EXECUTOR_TOOLS.find((t) => t.name === "execute_stage").inputSchema.properties;
  for (const k of ["auth_mode", "concurrency", "policy_name", "policy_path", "project_root"]) assert.equal(props[k], undefined, k);
  assert.equal(STAGE_CONCURRENCY, 4);
  const r = await handleExecutorTool("execute_stage", { spec_path: "/x/spec.json", stage: "codegen", code_dir: "/x" }, { run: () => undefined, overrides: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only after preflight_dispatch has recorded this run's auth mode and policy/);
});

test("a review's findings become fixes by file; a finding that cannot be placed is reported, never guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const rp = join(dir, "review.json");
  writeFileSync(rp, JSON.stringify({ module: "m", verdict: "needs_changes", findings: [
    { severity: "blocker", file: "app/models.py", issue: "wrong value", fix: "return 1" },
    { severity: "minor", file: join(dir, "app/routes.py"), issue: "naming", fix: "rename" },
    { severity: "major", file: "/elsewhere/x.py", issue: "i", fix: "f" },
    { severity: "major", issue: "no file" },
  ] }));
  const r = reviewRepairs([rp], dir);
  assert.deepEqual(r.items, [{ path: "app/models.py", problems: ["blocker: wrong value — fix: return 1"] }, { path: "app/routes.py", problems: ["minor: naming — fix: rename"] }]);
  assert.deepEqual(r.not_routed.map((x) => x.reason), ["outside the code directory", "a finding with no file"]);
});
