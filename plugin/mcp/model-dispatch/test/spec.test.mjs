/**
 * The typed build spec: its vocabulary, its schema, the section-by-section
 * hand-over, the coverage check and the briefs rendered from it.
 * Pure functions and a temp directory; no model calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { SPEC_KINDS } from "../dist/spec/kinds.js";
import { SPEC_HEADER_SCHEMA, SPEC_UNIT_SCHEMA, SPEC_UNITS_SECTION_SCHEMA, UNIT_MAX_LINES, UNITS_PER_SECTION, validate } from "../dist/spec/schema.js";
import { submitSpecSection, finalizeSpec, storedUnits, isSafeRelativePath, requiredIds, loadSpec } from "../dist/spec/store.js";
import { renderShared, renderUnitInstruction, renderRepairInstruction, framedUnit, unitPacket } from "../dist/executor/brief.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { buildUserPrompt } from "../dist/adapters/GeminiFlashAdapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "..", "..", "..");
const YAML = createRequire(import.meta.url)("yaml");

// A tiny made-up project: a to-do API. Enough to exercise every rule.
const HEADER = {
  stack: ["Python 3.13", "FastAPI", "pytest"],
  commands: [{ name: "backend tests", run: "pytest -q", cwd: "backend" }],
  decisions: [{ topic: "ids", choice: "integer autoincrement", rejected: ["uuid"], reason: "simplest for SQLite" }],
  shared: {
    conventions: ["snake_case for Python names"],
    data_model: [{ name: "Todo", fields: [{ name: "id", type: "int", constraints: "primary key" }, { name: "title", type: "str" }] }],
    api: [{ method: "POST", path: "/todos", access: "any", request: "TodoCreate", response: "Todo", success_status: 201, error_statuses: [422] }],
  },
};
const unit = (id, path, over = {}) => ({
  id, path, phase: "codegen", kind: "dto",
  exports: [{ name: "Todo", kind: "class", params: [], returns: "Todo" }],
  behaviour: "Pydantic models for a to-do.", depends_on: [], style_from: { reason: "first file of its kind" },
  covers: ["FR-1.1"], tests: [{ name: "valid", given: "a title", expect: "a Todo" }], approx_lines: 20, ...over,
});
const REQUIREMENTS = "# Requirements\nFR-1.1 create a to-do.\nFR-1.2 list to-dos.\nAC-1 a to-do can be created.\nNFR-1 fast.\n";

test("the spec's kinds include every task type the shipped policies and the pipeline skill use", () => {
  const policiesDir = join(PLUGIN, "config", "policies");
  const used = new Set();
  for (const f of readdirSync(policiesDir).filter((f) => f.endsWith(".yaml"))) {
    for (const r of YAML.parse(readFileSync(join(policiesDir, f), "utf8")).rules ?? []) for (const t of [].concat(r.when?.task_type ?? [])) used.add(t);
  }
  const skill = readFileSync(join(PLUGIN, "skills", "pipeline", "SKILL.md"), "utf8");
  const table = skill.slice(skill.indexOf("### Phase 4 — plan_task_packets"), skill.indexOf("### Brownfield-mode task types"));
  for (const m of table.matchAll(/^\| `([a-z_]+)` \|/gm)) used.add(m[1]);
  assert.ok(used.size > 10, "found the policies' and the skill's task types");
  for (const t of used) assert.ok(SPEC_KINDS.includes(t), `SPEC_KINDS is missing '${t}'`);
  assert.ok(SPEC_KINDS.includes("other"), "the policy's own fallback label is available");
});

test("the schema accepts a well-formed header and unit and names each problem by path", () => {
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, HEADER), []);
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "backend/app/schemas.py")), []);
  const bad = validate(SPEC_UNIT_SCHEMA, { ...unit("U1", "x.py"), kind: "config", extra: 1, behaviour: "two\nlines" });
  const paths = bad.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/behaviour", "/extra", "/id", "/kind"]);
  assert.match(bad.find((e) => e.path === "/behaviour").message, /must match/);
  assert.match(validate(SPEC_HEADER_SCHEMA, { stack: [] })[0].message, /missing required field 'commands'/);
});

test("the plan refuses on structure, not on characters; only a unit's size and a section's size are bounded, each by a stated derivation", () => {
  // No character caps: a long one-line choice is fine (a 160-character cap refused four real step-3 decisions).
  assert.deepEqual(validate(SPEC_HEADER_SCHEMA, { ...HEADER, decisions: [{ topic: "t", choice: "c".repeat(182), reason: "r" }] }), []);
  assert.match(validate(SPEC_HEADER_SCHEMA, { ...HEADER, decisions: [{ topic: "t", choice: "a\nb", reason: "r" }] })[0].message, /must match/);
  // Dotted export names are members (Class.method); anything else is not a name.
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { exports: [{ name: "NoteStore.add", kind: "function", params: [], returns: "Note" }] })), []);
  assert.equal(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { exports: [{ name: "GET /notes", kind: "function", params: [], returns: "x" }] }))[0].path, "/exports/0/name");
  // A unit's file must fit the smallest output cap of any shipped typist: floor(8,192 / (11.7 × 1.3)) = 538.
  assert.equal(UNIT_MAX_LINES, 538);
  assert.deepEqual(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { approx_lines: 538 })), []);
  assert.match(validate(SPEC_UNIT_SCHEMA, unit("U01", "a.py", { approx_lines: 539 }))[0].message, /≤ 538/);
  const caps = readdirSync(join(PLUGIN, "config", "policies")).filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => loadPolicyFromPath(join(PLUGIN, "config", "policies", f)).models.map((m) => m.max_output_tokens_absolute).filter(Boolean));
  assert.ok(caps.length > 0);
  assert.ok(UNIT_MAX_LINES * 11.7 * 1.3 <= Math.min(...caps), `a ${UNIT_MAX_LINES}-line file must fit every shipped cap (smallest ${Math.min(...caps)}); re-derive UNIT_MAX_LINES if a policy lowers one`);
  // A section must be written inside the architect's five-minute cache: floor(300 × 0.5 × 110 / 525) = 31.
  assert.equal(UNITS_PER_SECTION, 31);
  const many = (n) => Array.from({ length: n }, (_, i) => unit(`U${String(i + 1).padStart(2, "0")}`, `f${i}.py`));
  assert.deepEqual(validate(SPEC_UNITS_SECTION_SCHEMA, { units: many(31) }), []);
  assert.match(validate(SPEC_UNITS_SECTION_SCHEMA, { units: many(32) })[0].message, /at most 31 items/);
  // The architect's prompt states both bounds; it must state the ones the schema enforces.
  const architect = readFileSync(join(PLUGIN, "agents", "architect.md"), "utf8");
  assert.ok(architect.includes(`at most ${UNITS_PER_SECTION} per call`), "architect.md names the section bound");
  assert.ok(architect.includes(`at most ${UNIT_MAX_LINES} lines`), "architect.md names the unit-size bound");
});

test("paths the executor may write are relative, normalised and stay inside the code directory", () => {
  for (const ok of ["backend/app/main.py", "README.md", ".env.example"]) assert.equal(isSafeRelativePath(ok), true, ok);
  for (const no of ["/etc/passwd", "../x.py", "a/../../x", "a//b.py", "./a.py", "a\\b.py", ""]) assert.equal(isSafeRelativePath(no), false, no);
});

test("sections arrive header first, each checked on arrival; a refused batch stores nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const early = submitSpecSection(dir, { section: "units", units: [unit("U01", "a.py")] });
  assert.equal(early.ok, false);
  assert.match(early.errors[0].message, /header section first/);

  assert.equal(submitSpecSection(dir, { section: "header", header: HEADER }).ok, true);
  // U02 depends on U03, which has not been sent: the whole batch is refused.
  const forward = submitSpecSection(dir, { section: "units", units: [unit("U02", "b.py", { depends_on: ["U03"] }), unit("U03", "c.py")] });
  assert.equal(forward.ok, false);
  assert.match(forward.errors[0].message, /U03 is not an earlier unit/);
  assert.equal(storedUnits(dir).length, 0, "nothing stored from a refused batch");

  const first = submitSpecSection(dir, { section: "units", units: [unit("U01", "a.py"), unit("U02", "b.py", { depends_on: ["U01"], style_from: { unit: "U01", reason: "same kind" } })] });
  assert.deepEqual([first.ok, first.stored_units, first.total_units], [true, 2, 2]);
  const dup = submitSpecSection(dir, { section: "units", units: [unit("U02", "d.py"), unit("U04", "a.py"), unit("U05", "../e.py")] });
  assert.equal(dup.ok, false);
  const msgs = dup.errors.map((e) => e.message).join(" | ");
  assert.match(msgs, /duplicate unit id U02/);
  assert.match(msgs, /another unit already writes a\.py/);
  assert.match(msgs, /not a safe relative path: \.\.\/e\.py/);
  assert.equal(storedUnits(dir).length, 2);
});

test("finalize refuses a spec that leaves a requirement uncovered, then writes spec.json and design.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const req = join(dir, "requirements.md");
  writeFileSync(req, REQUIREMENTS);
  assert.deepEqual(requiredIds(REQUIREMENTS).sort(), ["AC-1", "FR-1.1", "FR-1.2"], "NFR ids are not required to be covered");
  submitSpecSection(dir, { section: "header", header: HEADER });
  submitSpecSection(dir, { section: "units", units: [unit("U01", "backend/app/schemas.py")] });
  const short = finalizeSpec(dir, req);
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing_coverage.sort(), ["AC-1", "FR-1.2"]);
  assert.equal(existsSync(join(dir, "spec.json")), false);

  submitSpecSection(dir, { section: "units", units: [unit("U02", "backend/tests/test_todos.py", { phase: "tests", kind: "test_integration", depends_on: ["U01"], covers: ["FR-1.2", "AC-1"] })] });
  const done = finalizeSpec(dir, req);
  assert.equal(done.ok, true);
  assert.deepEqual(done.by_phase, { codegen: 1, tests: 1 });
  const spec = loadSpec(done.spec_path);
  assert.equal(spec.spec_version, "1");
  assert.deepEqual(spec.units.map((u) => u.id), ["U01", "U02"]);
  const design = readFileSync(done.design_path, "utf8");
  assert.match(design, /\| U02 \| backend\/tests\/test_todos\.py \| tests \| test_integration \|/);
  assert.match(design, /\| ids \| integer autoincrement \| simplest for SQLite \| uuid \|/);
});

test("briefs: the shared block is identical for every unit, the unit block names its dependencies, and the frame is the completion door's own", () => {
  const spec = { spec_version: "1", ...HEADER, units: [unit("U01", "backend/app/schemas.py"), unit("U02", "backend/app/main.py", { kind: "module_wiring", depends_on: ["U01"], style_from: { unit: "U01", reason: "same package" } })] };
  const shared = renderShared(spec);
  assert.equal(shared, renderShared(JSON.parse(JSON.stringify(spec))), "deterministic");
  assert.ok(shared.startsWith("# Write one file of a project"));
  assert.ok(!shared.includes("U01"), "no unit ids in the shared block");
  assert.ok(shared.endsWith("## Every file of the project, with what it exports (import only these modules and names)\n- backend/app/schemas.py: Todo\n- backend/app/main.py: Todo"), "the same file index in every brief, so no typist invents a module");

  const ins = renderUnitInstruction(spec, spec.units[1]);
  assert.match(ins, /- backend\/app\/schemas\.py — Pydantic models for a to-do\.\n  exports: Todo\(\) -> Todo \[class\]/);
  assert.match(ins, /- style: follow the conventions of backend\/app\/schemas\.py \(Pydantic models for a to-do\.\) — same package/, "the style file as its spec entry, which the typist can use");
  assert.match(ins, /Return ONLY a JSON object \{"path": "backend\/app\/main\.py", "content": "<the complete file>"\}/);
  assert.ok(!ins.includes("previous answer was refused"));
  assert.match(renderUnitInstruction(spec, spec.units[1], "missing exports: app"), /## Your previous answer was refused\nmissing exports: app\nWrite the whole file again, correcting that\./);

  const framed = framedUnit(spec.units[1], ins, "p1");
  assert.equal(framed, buildUserPrompt(unitPacket(spec.units[1], ins, "p1", 0), ""));
  assert.ok(framed.startsWith("## Task — U02 (codegen / module_wiring)"));

  const fix = renderRepairInstruction(spec, { path: "backend/app/main.py", unit: spec.units[1] }, ["blocker: wrong status — fix: return 201"]);
  assert.match(fix, /## The file to fix\n- path: backend\/app\/main\.py/);
  assert.match(fix, /## What must change\n- blocker: wrong status — fix: return 201/);
  assert.match(fix, /Return ONLY a JSON object \{"path": "backend\/app\/main\.py", "edits": \[\{"search": /);
  assert.match(renderRepairInstruction(spec, { path: ".env.test" }, ["missing"]), /a supporting file the specification does not list/);
});
