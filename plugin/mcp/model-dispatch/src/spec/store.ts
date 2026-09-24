/**
 * The typed build spec, received in sections and assembled on disk.
 *
 * submit_spec_section stores the header, then batches of units, each checked
 * on arrival; finalize_spec assembles `spec.json`, checks that every FR- and
 * AC- requirement is covered, and renders `design.md` from the spec by code
 * (so Gate 2 and the reviewers read the same content the file writers get).
 *
 * A refused section stores nothing and says exactly why, so the architect
 * re-sends that section alone. Parts live under `<spec_dir>/spec.parts/`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { SPEC_HEADER_SCHEMA, SPEC_UNITS_SECTION_SCHEMA, validate, type SchemaError } from "./schema.js";

export interface SpecExport { name: string; kind: string; params: { name: string; type: string }[]; returns: string }
export interface SpecUnit {
  id: string; path: string; phase: "codegen" | "tests" | "docs"; kind: string;
  exports: SpecExport[]; behaviour: string; depends_on: string[];
  style_from: { unit?: string; reason: string }; covers: string[];
  tests: { name: string; given: string; expect: string }[]; approx_lines: number;
}
export interface SpecHeader {
  stack: string[];
  commands: { name: string; run: string; cwd: string }[];
  decisions: { topic: string; choice: string; rejected?: string[]; reason: string }[];
  shared: {
    conventions: string[];
    data_model: { name: string; fields: { name: string; type: string; constraints?: string }[] }[];
    api: { method: string; path: string; access: string; request: string; response: string; success_status: number; error_statuses: number[] }[];
  };
}
export interface Spec extends SpecHeader { spec_version: "1"; units: SpecUnit[] }

export interface SubmitResult {
  ok: boolean;
  section: "header" | "units";
  errors: SchemaError[];
  stored_units: number;
  total_units: number;
}

const partsDir = (specDir: string) => join(specDir, "spec.parts");
const headerFile = (specDir: string) => join(partsDir(specDir), "header.json");

/** Units already accepted, in the order they arrived. */
export function storedUnits(specDir: string): SpecUnit[] {
  const dir = partsDir(specDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^units-\d{3}\.json$/.test(f))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).units as SpecUnit[]);
}

/**
 * A path the executor may write: relative, already normalised, no `..`
 * segment. Anything else could land outside the code directory.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  const n = posix.normalize(p);
  return n === p && !n.split("/").includes("..") && n !== ".";
}

export function submitSpecSection(specDir: string, input: { section: "header"; header: unknown } | { section: "units"; units: unknown }): SubmitResult {
  mkdirSync(partsDir(specDir), { recursive: true });
  const prior = storedUnits(specDir);
  if (input.section === "header") {
    const errors = validate(SPEC_HEADER_SCHEMA, input.header, "/header");
    if (!errors.length) writeFileSync(headerFile(specDir), JSON.stringify(input.header, null, 2) + "\n");
    return { ok: !errors.length, section: "header", errors, stored_units: 0, total_units: prior.length };
  }

  if (!existsSync(headerFile(specDir))) {
    return { ok: false, section: "units", errors: [{ path: "/", message: "send the header section first (stack, commands, decisions, shared)" }], stored_units: 0, total_units: prior.length };
  }
  const errors = validate(SPEC_UNITS_SECTION_SCHEMA, { units: input.units }, "");
  if (errors.length) return { ok: false, section: "units", errors, stored_units: 0, total_units: prior.length };

  // Cross-checks the schema cannot express: uniqueness across batches, and
  // references that point only to units accepted earlier (or earlier in this
  // batch), which is what keeps the job graph acyclic.
  const batch = input.units as SpecUnit[];
  const seenIds = new Set(prior.map((u) => u.id));
  const seenPaths = new Set(prior.map((u) => u.path));
  batch.forEach((u, i) => {
    const at = `/units/${i}`;
    if (seenIds.has(u.id)) errors.push({ path: `${at}/id`, message: `duplicate unit id ${u.id}` });
    if (!isSafeRelativePath(u.path)) errors.push({ path: `${at}/path`, message: `not a safe relative path: ${u.path}` });
    if (seenPaths.has(u.path)) errors.push({ path: `${at}/path`, message: `another unit already writes ${u.path}` });
    for (const d of u.depends_on) {
      if (d === u.id) errors.push({ path: `${at}/depends_on`, message: `${u.id} depends on itself` });
      else if (!seenIds.has(d)) errors.push({ path: `${at}/depends_on`, message: `${d} is not an earlier unit (send units after the units they depend on)` });
    }
    // A path that is another unit's folder (src/config and src/config/app.py): both files cannot exist.
    for (const other of seenPaths) {
      if (other.startsWith(`${u.path}/`)) errors.push({ path: `${at}/path`, message: `${u.path} is also a folder of ${other}` });
      else if (u.path.startsWith(`${other}/`)) errors.push({ path: `${at}/path`, message: `${other} is also a folder of ${u.path}` });
    }
    const s = u.style_from?.unit;
    if (s !== undefined && !seenIds.has(s)) errors.push({ path: `${at}/style_from/unit`, message: `${s} is not an earlier unit` });
    seenIds.add(u.id);
    seenPaths.add(u.path);
  });
  if (errors.length) return { ok: false, section: "units", errors, stored_units: 0, total_units: prior.length };

  const n = readdirSync(partsDir(specDir)).filter((f) => /^units-\d{3}\.json$/.test(f)).length + 1;
  writeFileSync(join(partsDir(specDir), `units-${String(n).padStart(3, "0")}.json`), JSON.stringify({ units: batch }, null, 2) + "\n");
  return { ok: true, section: "units", errors: [], stored_units: batch.length, total_units: prior.length + batch.length };
}

export interface FinalizeResult {
  ok: boolean;
  errors: SchemaError[];
  missing_coverage: string[];
  units: number;
  by_phase: Record<string, number>;
  spec_path?: string;
  design_path?: string;
}

/**
 * Requirement ids a spec must cover: every FR- and AC- id in requirements.md,
 * read by the same grammar a unit's `covers` field accepts (FR-1, FR-1.2,
 * AC-3, AC-1.2), so an id is compared exactly as written, whatever numbering
 * the requirements use. NFR ids are not required to be covered by a unit.
 */
export function requiredIds(requirementsText: string): string[] {
  return [...new Set(requirementsText.match(/\b(?:FR|AC)-\d+(?:\.\d+)?\b/g) ?? [])];
}

export function finalizeSpec(specDir: string, requirementsPath?: string): FinalizeResult {
  const errors: SchemaError[] = [];
  if (!existsSync(headerFile(specDir))) errors.push({ path: "/", message: "no header section was accepted" });
  const units = storedUnits(specDir);
  if (!units.length) errors.push({ path: "/units", message: "no unit batch was accepted" });
  const byPhase: Record<string, number> = {};
  for (const u of units) byPhase[u.phase] = (byPhase[u.phase] ?? 0) + 1;
  let missing: string[] = [];
  if (requirementsPath && !existsSync(requirementsPath)) errors.push({ path: "/", message: `the requirements file ${requirementsPath} does not exist, so coverage cannot be checked` });
  if (requirementsPath && existsSync(requirementsPath)) {
    const covered = new Set(units.flatMap((u) => u.covers));
    missing = requiredIds(readFileSync(requirementsPath, "utf8")).filter((id) => !covered.has(id));
  }
  if (errors.length || missing.length) return { ok: false, errors, missing_coverage: missing, units: units.length, by_phase: byPhase };

  const header = JSON.parse(readFileSync(headerFile(specDir), "utf8")) as SpecHeader;
  const spec: Spec = { spec_version: "1", ...header, units };
  const specPath = join(specDir, "spec.json");
  const designPath = join(specDir, "design.md");
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
  writeFileSync(designPath, renderDesign(spec));
  return { ok: true, errors: [], missing_coverage: [], units: units.length, by_phase: byPhase, spec_path: specPath, design_path: designPath };
}

export function loadSpec(specPath: string): Spec {
  return JSON.parse(readFileSync(specPath, "utf8")) as Spec;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** design.md, rendered from the spec by code: what Gate 2 and the reviewers read. */
export function renderDesign(spec: Spec): string {
  const lines: string[] = ["# Design (rendered from spec.json)", "", "## Stack", ...spec.stack.map((s) => `- ${s}`), "", "## Commands"];
  for (const c of spec.commands) lines.push(`- ${c.name}: \`${c.run}\` (in ${c.cwd})`);
  lines.push("", "## Decisions", "", "| Topic | Choice | Why | Rejected |", "|---|---|---|---|");
  for (const d of spec.decisions) lines.push(`| ${cell(d.topic)} | ${cell(d.choice)} | ${cell(d.reason)} | ${cell((d.rejected ?? []).join("; "))} |`);
  lines.push("", "## Conventions", ...spec.shared.conventions.map((c) => `- ${c}`), "", "## Data model");
  for (const t of spec.shared.data_model) lines.push(`- **${t.name}**: ${t.fields.map((f) => `${f.name} ${f.type}${f.constraints ? ` (${f.constraints})` : ""}`).join("; ")}`);
  lines.push("", "## API", "", "| Method | Path | Access | Request | Response | OK | Errors |", "|---|---|---|---|---|---|---|");
  for (const a of spec.shared.api) lines.push(`| ${a.method} | ${cell(a.path)} | ${cell(a.access)} | ${cell(a.request)} | ${cell(a.response)} | ${a.success_status} | ${a.error_statuses.join(", ")} |`);
  lines.push("", "## Files", "", "| Id | Path | Phase | Kind | What it does | Uses |", "|---|---|---|---|---|---|");
  for (const u of spec.units) lines.push(`| ${u.id} | ${cell(u.path)} | ${u.phase} | ${u.kind} | ${cell(u.behaviour)} | ${u.depends_on.join(", ")} |`);
  return lines.join("\n") + "\n";
}
