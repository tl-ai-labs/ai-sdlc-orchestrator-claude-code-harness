/**
 * The executor's checks on a typist's answer, run by code before a file is
 * written. The same checks for every typist, so no door is held to a
 * different bar:
 *  1. the answer names the job's own path, and that path is safe;
 *  2. the content parses, by the parser of the tool that reads it (Python
 *     with the checker's interpreter; TypeScript / JavaScript with the
 *     TypeScript parser; tsconfig/jsconfig files with TypeScript's config
 *     parser, which allows comments; any other JSON with JSON.parse); any
 *     other file must be non-empty;
 *  3. every export the spec declares (except test functions) is defined — at
 *     top level, or, for a dotted name such as `NoteStore.add`, as a member of
 *     that class (or of that exported object);
 *  4. every import of the project's own code resolves to a file some unit of
 *     the spec writes, and every name imported from it is one that unit
 *     declares. Imports of anything else (the standard library, third-party
 *     packages, stylesheets and other assets) are not the spec's to judge.
 * Behaviour is not judged here — that is what the run's own tests and the
 * senior review are for.
 *
 * Checks 3 and 4 catch, for $0 and before any review, the cross-file mistakes
 * a file written from its spec entry alone can make: in step 2 a lean Opus
 * file imported `app.logging`, which nothing writes, and in the executor smoke
 * a correct `NoteStore.add` was refused because only top-level names counted.
 *
 * The checker's tools must be present: a stage refuses to start when it has
 * Python files and no interpreter can parse them, or TypeScript/JavaScript
 * files and the TypeScript parser cannot load — never "pass unchecked".
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { isSafeRelativePath, type Spec, type SpecUnit } from "../spec/store.js";

export interface CheckResult { ok: boolean; reason?: string; checked: "parsed" | "non-empty" | "not-parsed" }
/** What the checks need to know about the job: its path, and its declared exports (none for a file the spec does not list). */
export type CheckTarget = Pick<SpecUnit, "path" | "exports">;

interface PyImport { module: string; names: string[] | null; level: number }
interface TsImport { specifier: string; names: string[] }
interface Analysis { ok: boolean; error?: string; names?: string[]; imports?: (PyImport | TsImport)[] }

const PY_ANALYSE = `
import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"ok": False, "error": f"{e.msg} (line {e.lineno})"})); sys.exit(0)
names = set()
def members(cls):
    for m in cls.body:
        if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): names.add(f"{cls.name}.{m.name}")
        elif isinstance(m, ast.Assign):
            for t in m.targets:
                if isinstance(t, ast.Name): names.add(f"{cls.name}.{t.id}")
        elif isinstance(m, ast.AnnAssign) and isinstance(m.target, ast.Name): names.add(f"{cls.name}.{m.target.id}")
for n in tree.body:
    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)): names.add(n.name)
    elif isinstance(n, ast.ClassDef):
        names.add(n.name); members(n)
    elif isinstance(n, ast.Assign):
        for t in n.targets:
            for x in ast.walk(t):
                if isinstance(x, ast.Name): names.add(x.id)
    elif isinstance(n, (ast.AnnAssign, ast.AugAssign)) and isinstance(n.target, ast.Name): names.add(n.target.id)
    elif isinstance(n, (ast.Import, ast.ImportFrom)):
        for a in n.names: names.add((a.asname or a.name).split(".")[0])
imports = []
for n in ast.walk(tree):
    if isinstance(n, ast.ImportFrom): imports.append({"module": n.module or "", "names": [a.name for a in n.names], "level": n.level})
    elif isinstance(n, ast.Import):
        for a in n.names: imports.append({"module": a.name, "names": None, "level": 0})
print(json.dumps({"ok": True, "names": sorted(names), "imports": imports}))
`;

/**
 * The Python that parses the project's Python files: MMO_CHECK_PYTHON when set
 * (for a project that needs a newer interpreter than the machine's python3),
 * else python3.
 */
export function checkPython(env: Record<string, string | undefined> = process.env): string {
  return env.MMO_CHECK_PYTHON || "python3";
}

let ts: any;
function typescript(): any {
  if (ts === undefined) {
    try { ts = createRequire(import.meta.url)("typescript"); } catch { ts = null; }
  }
  return ts;
}

const isPy = (p: string) => p.endsWith(".py");
/** TypeScript's own config files, which it parses as JSON with comments. */
const TS_CONFIG_JSON = /^(ts|js)config(\.[^/]+)?\.json$/;
const isTsJs = (p: string) => /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(p);

/**
 * Why the checks cannot run for these paths, or null when they can. A stage
 * calls this before any typist is paid: a missing checker fails the stage,
 * never waves files through unchecked.
 */
export function toolchainProblem(paths: string[], python: string): string | null {
  if (paths.some(isPy)) {
    const r = spawnSync(python, ["-c", "import ast, json"], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return `the checks need a Python interpreter to parse the project's Python files, and '${python}' did not run (set MMO_CHECK_PYTHON to one that does)`;
  }
  if (paths.some((p) => isTsJs(p) || TS_CONFIG_JSON.test(posix.basename(p))) && !typescript()) return "the checks need the TypeScript parser (the 'typescript' package of the MCP server) and it did not load; run the setup check with --fix";
  return null;
}

function pyAnalyse(content: string, python: string): Analysis | null {
  const r = spawnSync(python, ["-c", PY_ANALYSE], { input: content, encoding: "utf8", timeout: 30_000 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function tsAnalyse(path: string, content: string): Analysis | null {
  const t = typescript();
  if (!t) return null;
  const kind = path.endsWith(".tsx") ? t.ScriptKind.TSX : path.endsWith(".jsx") ? t.ScriptKind.JSX : /\.(m?js|cjs)$/.test(path) ? t.ScriptKind.JS : t.ScriptKind.TS;
  const sf = t.createSourceFile(path, content, t.ScriptTarget.Latest, true, kind);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) return { ok: false, error: t.flattenDiagnosticMessageText(diags[0].messageText, " ") };
  const names = new Set<string>();
  const imports: TsImport[] = [];
  const has = (n: any, k: any) => n.modifiers?.some((m: any) => m.kind === k);
  const exported = (n: any) => has(n, t.SyntaxKind.ExportKeyword);
  const memberName = (m: any) => (m.name && (t.isIdentifier(m.name) || t.isStringLiteral(m.name) || t.isPrivateIdentifier?.(m.name)) ? m.name.text : undefined);
  for (const st of sf.statements) {
    if ((t.isFunctionDeclaration(st) || t.isClassDeclaration(st) || t.isInterfaceDeclaration(st) || t.isTypeAliasDeclaration(st) || t.isEnumDeclaration(st)) && exported(st)) {
      if (st.name) names.add(st.name.text);
      if (has(st, t.SyntaxKind.DefaultKeyword)) names.add("default");
      if ((t.isClassDeclaration(st) || t.isInterfaceDeclaration(st)) && st.name) {
        for (const m of st.members) { const n = memberName(m); if (n) names.add(`${st.name.text}.${n}`); }
      }
    } else if (t.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!t.isIdentifier(d.name)) continue;
        names.add(d.name.text);
        if (d.initializer && t.isObjectLiteralExpression(d.initializer)) {
          for (const p of d.initializer.properties) { const n = memberName(p); if (n) names.add(`${d.name.text}.${n}`); }
        }
      }
    } else if (t.isExportAssignment(st)) {
      names.add("default");
      if (t.isIdentifier(st.expression)) names.add(st.expression.text);
    } else if (t.isExportDeclaration(st)) {
      const named = st.exportClause && t.isNamedExports(st.exportClause) ? st.exportClause.elements : [];
      for (const e of named) names.add(e.name.text);
      if (st.moduleSpecifier && t.isStringLiteral(st.moduleSpecifier)) {
        imports.push({ specifier: st.moduleSpecifier.text, names: named.map((e: any) => (e.propertyName ?? e.name).text).filter((n: string) => n !== "default") });
      }
    } else if (t.isImportDeclaration(st) && t.isStringLiteral(st.moduleSpecifier)) {
      const nb = st.importClause?.namedBindings;
      const named = nb && t.isNamedImports(nb) ? nb.elements.map((e: any) => (e.propertyName ?? e.name).text).filter((n: string) => n !== "default") : [];
      imports.push({ specifier: st.moduleSpecifier.text, names: named });
    }
  }
  return { ok: true, names: [...names], imports };
}

/** A declared name as the analysis reports it: `Name`, or `Class.member` for a dotted name (deeper paths are checked at their first member). */
const exportKey = (name: string) => name.split(".").slice(0, 2).join(".");
/** The top-level names a unit declares, for checking what others import from it. */
const declaredTop = (u: SpecUnit) => new Set(u.exports.map((e) => e.name.split(".")[0]));

const dirOf = (p: string) => { const d = posix.dirname(p); return d === "." ? "" : d; };
const normDir = (d: string) => posix.normalize(d).replace(/^\.\/+/, "").replace(/\/+$/, "");

/** Python module names of the spec's files, under each import root: the code directory, `src`, and each command's working directory (and its `src`). */
function pyModules(spec: Spec): Map<string, SpecUnit> {
  const roots = new Set<string>(["", "src"]);
  for (const c of spec.commands) {
    if (!c.cwd || c.cwd.startsWith("/")) continue;
    const d = normDir(c.cwd);
    roots.add(d === "." ? "" : d);
    roots.add(posix.join(d === "." ? "" : d, "src"));
  }
  const mods = new Map<string, SpecUnit>();
  for (const u of spec.units) {
    if (!isPy(u.path)) continue;
    for (const r of roots) {
      if (r && !u.path.startsWith(`${r}/`)) continue;
      const parts = (r ? u.path.slice(r.length + 1) : u.path).replace(/\.py$/, "").split("/");
      if (parts[parts.length - 1] === "__init__") parts.pop();
      if (parts.length && !mods.has(parts.join("."))) mods.set(parts.join("."), u);
    }
  }
  return mods;
}

function checkPyImports(spec: Spec, path: string, imports: PyImport[]): string | null {
  const mods = pyModules(spec);
  const tops = new Set([...mods.keys()].map((k) => k.split(".")[0]));
  const isPackage = (m: string) => [...mods.keys()].some((k) => k.startsWith(`${m}.`));
  const byPath = new Map(spec.units.map((u) => [u.path, u]));
  const namesOk = (target: SpecUnit | undefined, names: string[] | null, isSub: (n: string) => boolean, shown: string): string | null => {
    if (!names) return null;
    const declared = target ? declaredTop(target) : new Set<string>();
    for (const n of names) {
      if (n === "*" || isSub(n)) continue;
      if (target && (declared.size === 0 || declared.has(n))) continue;
      return target
        ? `imports ${n} from ${shown}, which its spec entry does not export (it exports: ${[...declared].join(", ")})`
        : `imports ${n} from package ${shown}, but no unit writes ${shown}.${n} or declares ${n} in the package's __init__.py`;
    }
    return null;
  };
  for (const imp of imports) {
    if (imp.level > 0) {
      // Relative: resolved from this file's own directory, by path.
      const base = dirOf(path).split("/").filter(Boolean);
      const up = base.slice(0, Math.max(0, base.length - (imp.level - 1)));
      const parts = [...up, ...(imp.module ? imp.module.split(".") : [])];
      const stem = parts.join("/");
      const file = byPath.get(`${stem}.py`) ?? byPath.get(stem ? `${stem}/__init__.py` : "__init__.py");
      const pkg = spec.units.some((u) => u.path.startsWith(stem ? `${stem}/` : ""));
      const shown = `${".".repeat(imp.level)}${imp.module}`;
      if (!file && !pkg) return `imports ${shown}, which no unit of the spec writes`;
      const isSub = (n: string) => byPath.has(`${stem ? `${stem}/` : ""}${n}.py`) || byPath.has(`${stem ? `${stem}/` : ""}${n}/__init__.py`);
      const bad = namesOk(file, imp.names, isSub, shown);
      if (bad) return bad;
      continue;
    }
    if (!tops.has(imp.module.split(".")[0])) continue; // not the project's own code
    const target = mods.get(imp.module);
    if (!target && !isPackage(imp.module)) return `imports ${imp.module}, which no unit of the spec writes`;
    const bad = namesOk(target, imp.names, (n) => mods.has(`${imp.module}.${n}`), imp.module);
    if (bad) return bad;
  }
  return null;
}

const TS_EXT = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function checkTsImports(spec: Spec, path: string, imports: TsImport[]): string | null {
  const byPath = new Map(spec.units.map((u) => [u.path, u]));
  for (const imp of imports) {
    const s = imp.specifier;
    if (!s.startsWith("./") && !s.startsWith("../")) continue; // a package or a path alias: not the spec's to judge
    const ext = posix.extname(s);
    if (ext && !TS_EXT.includes(ext)) continue; // a stylesheet, an image, JSON: assets, not code units
    const base = posix.normalize(posix.join(dirOf(path), s));
    const swapped = base.replace(/\.(m|c)?jsx?$/, (m) => m.replace("js", "ts"));
    const candidates = [base, swapped, ...TS_EXT.map((e) => base + e), ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((f) => `${base}/${f}`)];
    const target = candidates.map((c) => byPath.get(c)).find(Boolean);
    if (!target) return `imports '${s}', which no unit of the spec writes`;
    const declared = declaredTop(target);
    if (declared.size === 0) continue;
    const missing = imp.names.filter((n) => !declared.has(n));
    if (missing.length) return `imports ${missing.join(", ")} from '${s}', which its spec entry does not export (it exports: ${[...declared].join(", ")})`;
  }
  return null;
}

/**
 * Checks one answer. `spec` enables the import check; without it (a unit test
 * of the other checks) imports are not judged.
 */
export function checkAnswer(target: CheckTarget, answer: { path: string; content: string }, python: string, spec?: Spec): CheckResult {
  if (answer.path !== target.path) return { ok: false, reason: `the answer names ${answer.path}, not ${target.path}`, checked: "not-parsed" };
  if (!isSafeRelativePath(answer.path)) return { ok: false, reason: `unsafe path ${answer.path}`, checked: "not-parsed" };
  const c = answer.content;
  if (!c.trim()) return { ok: false, reason: "the file is empty", checked: "not-parsed" };
  let a: Analysis | null = null;
  if (isPy(target.path)) {
    a = pyAnalyse(c, python);
    if (!a) return { ok: false, reason: `the Python checker '${python}' did not run`, checked: "not-parsed" };
    if (!a.ok) return { ok: false, reason: `the Python does not parse: ${a.error}`, checked: "parsed" };
  } else if (isTsJs(target.path)) {
    a = tsAnalyse(target.path, c);
    if (!a) return { ok: false, reason: "the TypeScript parser did not load", checked: "not-parsed" };
    if (!a.ok) return { ok: false, reason: `the code does not parse: ${a.error}`, checked: "parsed" };
  } else if (TS_CONFIG_JSON.test(posix.basename(target.path))) {
    // TypeScript reads its config files (tsconfig*.json, jsconfig*.json) as
    // JSON with comments and trailing commas — Vite's own template has
    // /* ... */ section comments — so they are judged by TypeScript's config
    // parser, the one the project's build uses. Found in step 8: a strict
    // JSON.parse refused a correct tsconfig.json.
    const t = typescript();
    if (!t) return { ok: false, reason: "the TypeScript parser did not load", checked: "not-parsed" };
    const r = t.parseConfigFileTextToJson(target.path, c);
    if (r.error) return { ok: false, reason: `the TypeScript config does not parse: ${t.flattenDiagnosticMessageText(r.error.messageText, " ")}`, checked: "parsed" };
    return { ok: true, checked: "parsed" };
  } else if (target.path.endsWith(".json")) {
    // Every other JSON file is read by a strict parser (npm reads package.json with JSON.parse).
    try { JSON.parse(c); } catch (e: any) { return { ok: false, reason: `the JSON does not parse: ${e.message}`, checked: "parsed" }; }
    return { ok: true, checked: "parsed" };
  } else {
    return { ok: true, checked: "non-empty" };
  }
  const names = new Set(a.names ?? []);
  const missing = target.exports.filter((e) => e.kind !== "test").map((e) => e.name).filter((n) => !names.has(exportKey(n)));
  if (missing.length) return { ok: false, reason: `these declared exports are not defined: ${missing.join(", ")}`, checked: "parsed" };
  if (spec && a.imports) {
    const bad = isPy(target.path) ? checkPyImports(spec, target.path, a.imports as PyImport[]) : checkTsImports(spec, target.path, a.imports as TsImport[]);
    if (bad) return { ok: false, reason: bad, checked: "parsed" };
  }
  return { ok: true, checked: "parsed" };
}
