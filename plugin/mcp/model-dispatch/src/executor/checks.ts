/**
 * The executor's checks on a typist's answer, run by code before a file is
 * written. The same checks for every typist, so no door is held to a
 * different bar — and they refuse a file only when it is CERTAINLY wrong, in
 * any language:
 *  1. the answer names the job's own path, and that path is safe;
 *  2. the file is not empty;
 *  3. it parses, by the parser of the tool that reads it, where the executor
 *     has that parser: Python with the checker's interpreter; TypeScript and
 *     JavaScript with the TypeScript parser; JSON with a JSON reader that
 *     accepts comments and trailing commas (TypeScript's, as tsconfig,
 *     ESLint and VS Code files are read), except package.json, which npm
 *     reads strictly. A file in any other language passes on 1 and 2.
 *
 * Nothing else is judged: not which names a file exports, not what it
 * imports. A greenfield project can be in any language and framework, and
 * such checks need a rule for every idiom — the independent review found the
 * earlier export/import checks refusing correct `export *` barrels,
 * `export default memo(X)`, enum members, .d.ts files, module.exports and
 * NestJS `./x.service` imports. A refused correct file costs solo three Opus
 * calls but the orchestrator two Flash calls and one Opus call, so such
 * refusals were unfair as well as wasteful. Mistakes across files are caught
 * by the project's own tests, and fixed by the repair round, the same way for
 * both arms. Behaviour is not judged here either.
 *
 * The checker's tools must be present: a stage refuses to start when it has
 * files one of them must parse and it cannot run — never "pass unchecked".
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { isSafeRelativePath } from "../spec/store.js";

export interface CheckResult { ok: boolean; reason?: string; checked: "parsed" | "non-empty" | "not-parsed" }
/** What the checks need to know about the job: its path. */
export type CheckTarget = { path: string };

/** Parses stdin with Python's own parser; prints {"ok": true} or {"ok": false, "error": ...}. */
const PY_PARSE = `
import ast, json, sys
try:
    ast.parse(sys.stdin.read())
    print(json.dumps({"ok": True}))
except SyntaxError as e:
    print(json.dumps({"ok": False, "error": f"{e.msg} (line {e.lineno})"}))
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
const isTsJs = (p: string) => /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(p);
const isJson = (p: string) => p.endsWith(".json");
/** npm reads package.json with a strict JSON parser. */
const isStrictJson = (p: string) => posix.basename(p) === "package.json";
const BOM = "﻿";

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
  if (paths.some((p) => isTsJs(p) || (isJson(p) && !isStrictJson(p))) && !typescript()) return "the checks need the TypeScript parser (the 'typescript' package of the MCP server) and it did not load; run the setup check with --fix";
  return null;
}

/** The first parse error of a TypeScript / JavaScript file, or null when it parses. */
function tsParseError(path: string, content: string): string | null {
  const t = typescript();
  const kind = path.endsWith(".tsx") ? t.ScriptKind.TSX : path.endsWith(".jsx") ? t.ScriptKind.JSX : /\.(m?js|cjs)$/.test(path) ? t.ScriptKind.JS : t.ScriptKind.TS;
  const diags = t.createSourceFile(path, content, t.ScriptTarget.Latest, true, kind).parseDiagnostics ?? [];
  return diags.length ? t.flattenDiagnosticMessageText(diags[0].messageText, " ") : null;
}

export function checkAnswer(target: CheckTarget, answer: { path: string; content: string }, python: string): CheckResult {
  if (answer.path !== target.path) return { ok: false, reason: `the answer names ${answer.path}, not ${target.path}`, checked: "not-parsed" };
  if (!isSafeRelativePath(answer.path)) return { ok: false, reason: `unsafe path ${answer.path}`, checked: "not-parsed" };
  const c = answer.content;
  if (!c.trim()) return { ok: false, reason: "the file is empty", checked: "not-parsed" };
  if (isPy(target.path)) {
    const r = spawnSync(python, ["-c", PY_PARSE], { input: c, encoding: "utf8", timeout: 30_000 });
    let parsed: any = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* the interpreter did not run */ }
    if (!parsed) return { ok: false, reason: `the Python checker '${python}' did not run`, checked: "not-parsed" };
    return parsed.ok ? { ok: true, checked: "parsed" } : { ok: false, reason: `the Python does not parse: ${parsed.error}`, checked: "parsed" };
  }
  if (isTsJs(target.path)) {
    if (!typescript()) return { ok: false, reason: "the TypeScript parser did not load", checked: "not-parsed" };
    const err = tsParseError(target.path, c);
    return err ? { ok: false, reason: `the code does not parse: ${err}`, checked: "parsed" } : { ok: true, checked: "parsed" };
  }
  if (isJson(target.path)) {
    // A leading byte-order mark is an encoding marker, not content: npm and Node's JSON loader strip it.
    const text = c.startsWith(BOM) ? c.slice(1) : c;
    if (isStrictJson(target.path)) {
      try { JSON.parse(text); } catch (e: any) { return { ok: false, reason: `the JSON does not parse (package.json is read strictly): ${e.message}`, checked: "parsed" }; }
      return { ok: true, checked: "parsed" };
    }
    if (!typescript()) return { ok: false, reason: "the TypeScript parser did not load", checked: "not-parsed" };
    const diags = typescript().parseJsonText(target.path, text).parseDiagnostics ?? [];
    return diags.length
      ? { ok: false, reason: `the JSON does not parse: ${typescript().flattenDiagnosticMessageText(diags[0].messageText, " ")}`, checked: "parsed" }
      : { ok: true, checked: "parsed" };
  }
  return { ok: true, checked: "non-empty" };
}
