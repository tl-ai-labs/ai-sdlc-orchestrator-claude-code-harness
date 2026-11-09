#!/usr/bin/env node
/**
 * export-run-times: finds every run of this plugin on this computer and writes one small file with each run's time
 * split, for the person who runs it to send to whoever asked.
 *
 * The split is read from Claude Code's history files, which exist only on the computer that ran the run and which
 * Claude Code deletes 30 days after last use, so each person runs this once on their own computer. All timing is the
 * cost tool's (`collect-orchestrator-usage.mjs --time-only`, beside this script): this script finds the runs, hands
 * them over one at a time and keeps the answers. It opens no history file and no run file (it only checks that a run's
 * manifest.json exists), and writes nothing but its own file, never inside a `.sdlc` folder.
 *
 * Usage:
 *   node export-run-times.mjs [--root <dir>]... [--out <file>]
 *
 *   --root   a folder to search as well as ~/Documents/GitHub (repeatable). Projects are found down to four folders
 *            below a root; no symbolic link is followed.
 *   --out    the file to write. Default: ./run-times-<YYYY-MM-DD>.json (today, local time).
 *
 * The file: { made_by: "export-run-times", made_at, plugin_version, runs: [{ run_id, project_root, time_split }],
 * skipped: [{ run_dir, reason }] }. Every folder in a project's `.sdlc/runs/` is in one of the two lists.
 *
 * Exit codes: 0 = the file is written, whatever was skipped. 1 = nothing written: no folder could be searched, the
 * file cannot be written there, or the cost tool is missing. 2 = bad arguments.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COST_TOOL = join(HERE, "collect-orchestrator-usage.mjs");
const PLUGIN_JSON = join(HERE, "..", ".claude-plugin", "plugin.json");
const MADE_BY = "export-run-times";
const MAX_LEVEL = 4;
const TIMEOUT_MS = 600_000;
const MAX_STDOUT = 64 * 1024 * 1024;
const REASON_MAX = 2000;
const LINK = "a symbolic link, not followed";
const SEND = "Send this file to the person who asked.";

const USAGE = `Usage: node export-run-times.mjs [--root <dir>]... [--out <file>]

Finds every run of the plugin under ~/Documents/GitHub (and each --root), times each one from this computer's
Claude Code history, and writes one file to send back. Nothing in the runs is changed.

  --root <dir>   another folder to search as well; repeat it for more
  --out <file>   the file to write (default: ./run-times-<today>.json)
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { roots: [], out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (flag) => {
      const v = a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i];
      if (v === undefined || v === "" || (v.startsWith("--") && !a.startsWith(`${flag}=`))) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--root" || a.startsWith("--root=")) args.roots.push(value("--root"));
    else if (a === "--out" || a.startsWith("--out=")) {
      if (args.out !== undefined) throw new UsageError("--out is given twice");
      args.out = value("--out");
    } else if (a.startsWith("-")) throw new UsageError(`unknown option '${a}'`);
    else throw new UsageError(`unexpected argument '${a}'`);
  }
  return args;
}

const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const byCodeUnit = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const codeOf = (err) => err?.code ?? err?.message ?? String(err);

/** A folder's entries in code-unit order, so every computer lists the same runs in the same order whatever its locale. */
const entriesOf = (dir) => readdirSync(dir, { withFileTypes: true }).sort(byCodeUnit);

function clip(text) {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)} … (${text.length - REASON_MAX} more characters)` : text;
}

/**
 * The folders to search, each by its real path, so a project's path holds no symbolic link, as `process.cwd()` reports
 * a folder. A missing or unreadable ~/Documents/GitHub is a note; a --root that is not a folder is an error.
 */
function searchRoots(given, home) {
  const defaultRoot = join(home, "Documents", "GitHub");
  const roots = [];
  const notes = [];
  const add = (path, explicit) => {
    let real;
    try {
      real = realpathSync(path);
      if (!statSync(real).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "not a folder" });
    } catch (err) {
      const why = err.code === "ENOENT" ? "no such folder" : codeOf(err);
      if (explicit) throw new UsageError(`--root ${path}: ${why}`);
      notes.push({ path, why });
      return;
    }
    if (!roots.includes(real)) roots.push(real);
  };
  add(defaultRoot, false);
  for (const r of given) add(resolve(r), true);
  return { roots, notes };
}

/** What a run folder is: a run to time, or a skipped entry with why. */
function runFolder(runDir, projectRoot) {
  try {
    const st = lstatSync(join(runDir, "manifest.json"));
    if (st.isFile()) return { runDir, projectRoot };
    return { skip: { run_dir: runDir, reason: st.isSymbolicLink() ? `manifest.json is ${LINK}` : "manifest.json is not a file" } };
  } catch (err) {
    return { skip: { run_dir: runDir, reason: err.code === "ENOENT" ? "no manifest.json in this run folder" : `could not be read: ${codeOf(err)}` } };
  }
}

/**
 * Every folder in a project's `.sdlc/runs/`, each named as the table shows it, plus a linked `.sdlc` and a linked or
 * unreadable `.sdlc/runs` as skipped entries. Files there (`.DS_Store`) are not runs.
 */
function projectRuns(projectRoot, sdlc) {
  const sdlcDir = join(projectRoot, ".sdlc");
  if (sdlc.isSymbolicLink()) return [{ name: ".sdlc", skip: { run_dir: sdlcDir, reason: LINK } }];
  if (!sdlc.isDirectory()) return [];
  const runsDir = join(sdlcDir, "runs");
  const runsSkip = (reason) => [{ name: ".sdlc/runs", skip: { run_dir: runsDir, reason } }];
  let entries;
  try {
    const st = lstatSync(runsDir);
    if (st.isSymbolicLink()) return runsSkip(LINK);
    if (!st.isDirectory()) return [];
    entries = entriesOf(runsDir);
  } catch (err) {
    return err.code === "ENOENT" ? [] : runsSkip(`could not be read: ${codeOf(err)}`);
  }
  const out = [];
  for (const e of entries) {
    const runDir = join(runsDir, e.name);
    if (e.isSymbolicLink()) out.push({ name: e.name, skip: { run_dir: runDir, reason: LINK } });
    else if (e.isDirectory()) out.push({ name: e.name, ...runFolder(runDir, projectRoot) });
  }
  return out;
}

/**
 * Every run folder under each root, roots in order, projects down to MAX_LEVEL folders below a root (the root is level
 * 0). `.sdlc` is not searched further and no symbolic link is followed, so a run reached from two roots (one inside
 * the other) is the same path and is kept once.
 */
export function findRuns(roots) {
  const items = [];
  const seen = new Set();
  const withRuns = new Set();
  const unsearched = [];
  const searched = [];
  for (const root of roots) {
    let rootRead = true;
    const walk = (dir, level) => {
      let entries;
      try {
        entries = entriesOf(dir);
      } catch (err) {
        if (dir === root) rootRead = false;
        unsearched.push({ path: dir, why: codeOf(err) });
        return;
      }
      for (const e of entries) {
        if (e.name === ".sdlc") {
          if (seen.has(dir)) continue;
          seen.add(dir);
          const project = relative(root, dir) || basename(dir);
          for (const item of projectRuns(dir, e)) {
            items.push({ ...item, project });
            withRuns.add(dir);
          }
        } else if (level < MAX_LEVEL && e.isDirectory()) walk(join(dir, e.name), level + 1);
      }
    };
    walk(root, 0);
    if (rootRead) searched.push(root);
  }
  return { items, projects: withRuns.size, searched, unsearched };
}

/**
 * Times one run with the cost tool's --time-only mode: exit 0 and one JSON object on its last line of stdout, or a
 * non-zero exit and the reason on stderr. Only run_id, project_root and time_split are kept from the answer; any
 * other line or key is left where it is, so nothing else the tool prints can reach the file.
 */
export function timeRun({ costTool, runDir, projectRoot, timeoutMs = TIMEOUT_MS, env = process.env }) {
  const tool = `${basename(costTool)} --time-only`;
  const r = spawnSync(process.execPath, [costTool, runDir, "--project-root", projectRoot, "--time-only"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_STDOUT,
  });
  if (r.error?.code === "ETIMEDOUT") return { ok: false, reason: `${tool} did not finish within ${timeoutMs / 1000} seconds, so it was stopped` };
  if (r.error?.code === "ENOBUFS") return { ok: false, reason: `${tool} printed more than ${MAX_STDOUT / 1024 / 1024} MB, so it was stopped` };
  if (r.error) return { ok: false, reason: `${tool} could not be run: ${r.error.message}` };
  const why = clip((r.stderr ?? "").trim());
  if (r.status === null) return { ok: false, reason: `${tool} was stopped by ${r.signal}${why ? `: ${why}` : ""}` };
  if (r.status !== 0) {
    return { ok: false, reason: why ? `${tool} stopped with exit code ${r.status}: ${why}` : `${tool} stopped with exit code ${r.status} and gave no reason` };
  }
  const last = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (last === undefined) return { ok: false, reason: `${tool} exited 0, but printed nothing` };
  let answer;
  try {
    answer = JSON.parse(last);
  } catch {
    answer = null;
  }
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const fault = !isObject(answer) ? "its last line is not one JSON object"
    : typeof answer.run_id !== "string" || !answer.run_id ? "its answer has no run_id string"
    : typeof answer.project_root !== "string" || !answer.project_root ? "its answer has no project_root string"
    : !isObject(answer.time_split) ? "its answer has no time_split object"
    : null;
  if (fault) return { ok: false, reason: `${tool} exited 0, but ${fault}` };
  return { ok: true, result: { run_id: answer.run_id, project_root: answer.project_root, time_split: answer.time_split } };
}

/** Why the file cannot be written at `path` (null when it can): never inside `.sdlc`, never over a file it did not make. */
function outputProblem(path) {
  let parent;
  try {
    parent = realpathSync(dirname(path));
    if (!statSync(parent).isDirectory()) return `${dirname(path)} is not a folder`;
  } catch (err) {
    return `the folder ${dirname(path)} ${err.code === "ENOENT" ? "does not exist" : `cannot be used (${codeOf(err)})`}`;
  }
  const real = join(parent, basename(path));
  if (real.split(sep).includes(".sdlc")) return `${real} is inside a .sdlc folder, where runs keep their records; run this from another folder, or pass --out <file>`;
  try {
    accessSync(parent, constants.W_OK);
  } catch (err) {
    return `cannot write in ${parent} (${codeOf(err)}); pass --out <file> in a folder you can write to`;
  }
  let st;
  try {
    st = lstatSync(real);
  } catch (err) {
    return err.code === "ENOENT" ? null : `cannot check ${real} (${codeOf(err)})`;
  }
  let madeBy;
  try {
    madeBy = st.isFile() ? JSON.parse(readFileSync(real, "utf8"))?.made_by : undefined;
  } catch {
    madeBy = undefined;
  }
  return madeBy === MADE_BY ? null : `${real} already exists and was not made by export-run-times; pass --out <another file>`;
}

function writeWhole(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function pluginVersion() {
  try {
    const v = JSON.parse(readFileSync(PLUGIN_JSON, "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const minutes = (sec) => `${(sec / 60).toFixed(1)} min`;

/** A timed run's window in local time (the end's day only when it differs), its length and the time taken. */
function timedColumns(split) {
  const start = new Date(split?.window?.start ?? NaN);
  const end = new Date(split?.window?.end ?? NaN);
  const sec = split?.window?.sec;
  const taken = split?.time_taken_sec;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !Number.isFinite(sec) || !Number.isFinite(taken)) {
    return "the answer has no window or time taken";
  }
  const clock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const window = `${localDay(start)} ${clock(start)} → ${localDay(end) === localDay(start) ? "" : `${localDay(end)} `}${clock(end)}`;
  return `${window.padEnd(35)}  ${minutes(sec).padStart(9)}  ${minutes(taken).padStart(10)}`;
}

const firstLine = (text) => {
  const line = text.split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)} …` : line;
};

export function main(argv = process.argv.slice(2), env = process.env) {
  let args, found;
  try {
    args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    found = searchRoots(args.roots, homedir());
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`export-run-times: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  const costTool = resolve(env.MMO_COST_TOOL_FOR_TESTS || DEFAULT_COST_TOOL);
  if (!existsSync(costTool)) {
    process.stderr.write(`export-run-times: the cost tool is missing: ${costTool}\nUpdate the plugin, then run this again.\n`);
    return 1;
  }
  const out = resolve(args.out ?? `run-times-${localDay(new Date())}.json`);
  const problem = outputProblem(out);
  if (problem) {
    process.stderr.write(`export-run-times: nothing written: ${problem}\n`);
    return 1;
  }
  const outPath = join(realpathSync(dirname(out)), basename(out));

  const said = (n) => (n.why === "no such folder" ? `${n.path} does not exist` : `${n.path} could not be read (${n.why})`);
  const scan = findRuns(found.roots);
  const blocked = [...found.notes, ...scan.unsearched].some((n) => n.why === "EPERM") && process.platform === "darwin"
    ? "If your terminal app is not allowed to read your Documents folder, allow it in System Settings > Privacy & Security > Files and Folders, then run this again."
    : null;
  if (scan.searched.length === 0) {
    const tried = [...found.notes, ...scan.unsearched].map(said).join("; ");
    process.stderr.write(`export-run-times: nothing to search: ${tried}.\nRun this again with --root <the folder that holds your projects>.\n${blocked ? `${blocked}\n` : ""}`);
    return 1;
  }

  const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
  const log = (line = "") => process.stdout.write(`${line}\n`);
  log(`Looking for runs in ${scan.searched.join(", ")} (projects up to ${MAX_LEVEL} folders down).`);
  for (const n of found.notes) log(`  ${said(n)}, so it was not searched.`);
  for (const n of scan.unsearched) log(`  could not search ${n.path} (${n.why}).`);
  if (blocked) log(`  ${blocked}`);
  if (scan.items.length === 0) {
    log("No run folders found. If your projects are in another folder, run this again with --root <that folder>.");
  } else {
    log(`Found ${plural(scan.items.length, "run folder")} in ${plural(scan.projects, "project")}. Timing them one at a time; nothing in them is changed.`);
    log();
  }

  const projectWidth = Math.max(7, ...scan.items.map((i) => i.project.length));
  const nameWidth = Math.max(3, ...scan.items.map((i) => i.name.length));
  if (scan.items.length) log(`  ${"Project".padEnd(projectWidth)}  ${"Run".padEnd(nameWidth)}  ${"Window (local time)".padEnd(35)}  ${"Length".padStart(9)}  ${"Time taken".padStart(10)}`);
  const runs = [];
  const skipped = [];
  let unknown = 0;
  for (const item of scan.items) {
    process.stdout.write(`  ${item.project.padEnd(projectWidth)}  ${item.name.padEnd(nameWidth)}  `);
    if (item.skip) {
      skipped.push(item.skip);
      log(`skipped: ${firstLine(item.skip.reason)}`);
      continue;
    }
    const timed = timeRun({ costTool, runDir: item.runDir, projectRoot: item.projectRoot, env });
    if (!timed.ok) {
      skipped.push({ run_dir: item.runDir, reason: timed.reason });
      log(`skipped: ${firstLine(timed.reason)}`);
      continue;
    }
    runs.push(timed.result);
    const why = timed.result.time_split.unknown_reason;
    if (typeof why === "string" && why) {
      unknown++;
      log(`unknown: ${firstLine(why)}`);
    } else log(timedColumns(timed.result.time_split));
  }

  const file = { made_by: MADE_BY, made_at: new Date().toISOString(), plugin_version: pluginVersion(), runs, skipped };
  try {
    writeWhole(outPath, `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`export-run-times: could not write ${outPath}: ${codeOf(err)}\n`);
    return 1;
  }
  log();
  log(`Wrote ${outPath}: ${runs.length - unknown} timed, ${unknown} unknown, ${skipped.length} skipped.`);
  log(SEND);
  return 0;
}

// import.meta.url is the module's real path; argv[1] keeps the caller's spelling, so the entry is compared by its real path.
const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`export-run-times: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  }
}
