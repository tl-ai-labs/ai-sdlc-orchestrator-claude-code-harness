/**
 * export-run-times.mjs: the one command a teammate runs to send back the time split of every study run on their Mac.
 *
 * Checked end to end, the way a teammate runs it (`node export-run-times.mjs [--root <dir>]... [--out <file>]`), on
 * temp trees:
 *   - which runs it finds: every folder in `<project>/.sdlc/runs/` under ~/Documents/GitHub and each --root, projects
 *     down to 4 folders below a root, no symbolic link followed; a run folder with a manifest.json is timed, every
 *     other one is listed as skipped with why;
 *   - that each run goes to the cost tool's --time-only mode, one at a time, with the run folder and the folder that
 *     holds .sdlc, and that exactly the run_id, project_root and time_split of each answer are kept;
 *   - that a run the cost tool cannot time is listed with the reason, and the file is still written;
 *   - that the file holds nothing else (no chat text, no environment value), and that no searched folder changes;
 *   - what it prints, where the file goes, and its exit codes.
 *
 * Offline, $0. The cost tool is stood in for by fixtures/export-run-times/cost-tool-stub.mjs, which holds to the
 * --time-only contract. HOME and CLAUDE_CONFIG_DIR point into each test's temp tree, so nothing outside it is read.
 * The last test runs the real cost tool on a recorded-shape run, once that tool has --time-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TIMED, unknownSplit } from "./fixtures/export-run-times/cost-tool-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");
const SCRIPT = join(SCRIPTS, "export-run-times.mjs");
const REAL_COST_TOOL = join(SCRIPTS, "collect-orchestrator-usage.mjs");
const STUB = join(HERE, "fixtures", "export-run-times", "cost-tool-stub.mjs");
const STUB_NAME = basename(STUB);
const PLUGIN_VERSION = JSON.parse(readFileSync(join(SCRIPTS, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
const SEND = "Send this file to the person who asked.";

/** A temp tree: a home with ~/Documents/GitHub, a folder to run from, a Claude Code config folder, the stub's call log. */
function tree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mmo-export-times-")));
  const t = {
    base,
    home: join(base, "home"),
    gh: join(base, "home", "Documents", "GitHub"),
    out: join(base, "out"),
    claudeConfig: join(base, "claude-config"),
    log: join(base, "stub-calls.jsonl"),
  };
  for (const d of [t.gh, t.out, t.claudeConfig]) mkdirSync(d, { recursive: true });
  t.rm = () => rmSync(base, { recursive: true, force: true });
  return t;
}

/** A run folder as a brownfield run leaves it; `plan` tells the stub what to answer for it. */
function addRun(projectRoot, runId, plan) {
  const dir = join(projectRoot, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ run_id: runId, policy: "argon-plus-flash" }, null, 2) + "\n");
  writeFileSync(join(dir, "orchestrator.log"), `MMO: 2026-11-06T08:57:12.345Z INFO   run.start run_id=${runId}\n`);
  if (plan) writeFileSync(join(dir, "stub.json"), JSON.stringify(plan));
  return dir;
}

/** The stub's calls, in order. */
function calls(t) {
  if (!existsSync(t.log)) return [];
  return readFileSync(t.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const DEFAULT_NAME = /^run-times-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Runs the command as a teammate would, against the stub. `path` is the file it wrote (`outFile`, else the one
 * run-times-<date>.json in `cwd`), and `file` that file parsed.
 */
function exportTimes(t, args = [], { env = {}, cwd = t.out, outFile } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env, HOME: t.home, CLAUDE_CONFIG_DIR: t.claudeConfig, TZ: "UTC",
      MMO_COST_TOOL_FOR_TESTS: STUB, STUB_LOG: t.log, ...env,
    },
  });
  const named = readdirSync(cwd).filter((n) => DEFAULT_NAME.test(n));
  assert.ok(named.length <= 1, `at most one run-times file in ${cwd}: ${named}`);
  const path = outFile ? (existsSync(outFile) ? outFile : null) : named.length ? join(cwd, named[0]) : null;
  const text = path ? readFileSync(path, "utf8") : null;
  return { ...r, path, text, file: text ? JSON.parse(text) : null, calls: calls(t) };
}

const runEntry = (runId, projectRoot, timeSplit = TIMED) => ({ run_id: runId, project_root: projectRoot, time_split: timeSplit });

/** Every entry under `dir`, with what would show a change: type, mode, size, mtime, content hash, link target. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = `dir ${st.mode} ${st.mtimeMs}`;
        walk(p);
      } else out[rel] = `file ${st.mode} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

// ── Finding the runs ─────────────────────────────────────────────────────────

test("finds every run under ~/Documents/GitHub with no options, and writes them to ./run-times-<date>.json", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const docs = join(t.gh, "docs-site");
    addRun(shop, "20261106-085700-bugfix-login");
    addRun(shop, "20261107-101500-docs-readme");
    addRun(docs, "20261108-120000-feature-extend-search");
    const startMs = Date.now();
    const days = [utcDay()];
    const r = exportTimes(t);
    days.push(utcDay());
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.path, `a run-times-<date>.json in the folder it was run from; stdout:\n${r.stdout}`);
    assert.ok(days.map((d) => `run-times-${d}.json`).includes(basename(r.path)), `named for today (local time, UTC here): ${r.path}`);
    assert.deepEqual(Object.keys(r.file), ["made_by", "made_at", "plugin_version", "runs", "skipped"]);
    assert.equal(r.file.made_by, "export-run-times");
    assert.equal(r.file.plugin_version, PLUGIN_VERSION);
    const madeMs = Date.parse(r.file.made_at);
    assert.ok(madeMs >= startMs - 1000 && madeMs <= Date.now() + 1000, `made_at ${r.file.made_at} is when the file was made`);
    assert.equal(r.file.made_at, new Date(madeMs).toISOString(), "made_at is an ISO time");
    assert.deepEqual(r.file.runs, [
      runEntry("20261108-120000-feature-extend-search", docs),
      runEntry("20261106-085700-bugfix-login", shop),
      runEntry("20261107-101500-docs-readme", shop),
    ]);
    assert.deepEqual(r.file.skipped, []);
  } finally {
    t.rm();
  }
});

test("hands each run to the cost tool's --time-only mode, one at a time, with the run folder and the folder that holds .sdlc", () => {
  const t = tree();
  try {
    const spaced = join(t.gh, "My Projects", "shop");
    const runA = addRun(spaced, "20261106-085700-bugfix-login", { hold_ms: 250 });
    const runB = addRun(spaced, "20261107-101500-docs-readme", { hold_ms: 250 });
    const runC = addRun(join(t.gh, "api"), "20261108-120000-refactor-dates", { hold_ms: 250 });
    const r = exportTimes(t);
    assert.equal(r.status, 0, r.stderr);
    // Folders are taken in code-unit order ("My Projects" before "api"), the same on every Mac whatever its locale.
    assert.deepEqual(r.calls.map((call) => call.argv), [
      [runA, "--project-root", spaced, "--time-only"],
      [runB, "--project-root", spaced, "--time-only"],
      [runC, "--project-root", join(t.gh, "api"), "--time-only"],
    ]);
    assert.deepEqual(r.calls.map((call) => call.overlapped), [false, false, false], "no call starts while another is going");
  } finally {
    t.rm();
  }
});

test("searches each --root as well as ~/Documents/GitHub, and lists a run reached from two roots once", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const tools = join(t.base, "elsewhere", "tools");
    addRun(shop, "20261106-085700-bugfix-login");
    addRun(tools, "20261109-090000-test-coverage");
    const r = exportTimes(t, ["--root", join(t.base, "elsewhere"), "--root", shop, `--root=${t.gh}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2, `each run timed once: ${JSON.stringify(r.calls)}`);
    assert.deepEqual(r.file.runs, [runEntry("20261106-085700-bugfix-login", shop), runEntry("20261109-090000-test-coverage", tools)]);
    assert.deepEqual(r.file.skipped, []);
  } finally {
    t.rm();
  }
});

test("finds projects down to four folders below a root and no deeper; a root that is itself a project counts", () => {
  const t = tree();
  try {
    const top = join(t.base, "work");
    addRun(top, "r-level-0");
    addRun(join(top, "a", "b", "c", "d"), "r-level-4");
    addRun(join(top, "a", "b", "c", "d", "e"), "r-level-5");
    const r = exportTimes(t, ["--root", top]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.file.runs.map((x) => x.run_id), ["r-level-0", "r-level-4"]);
    assert.ok(!r.text.includes("r-level-5") && !r.stdout.includes("r-level-5"), "a project five folders down is not searched");
  } finally {
    t.rm();
  }
});

test("follows no symbolic link: a link out of the root is not searched, and a linked .sdlc or run folder is listed as skipped", () => {
  const t = tree();
  try {
    const outside = join(t.base, "outside", "proj");
    addRun(outside, "r-outside");
    const shop = join(t.gh, "shop");
    addRun(shop, "r-real");
    symlinkSync(outside, join(t.gh, "linked"));
    symlinkSync(join(outside, ".sdlc", "runs", "r-outside"), join(shop, ".sdlc", "runs", "r-link"));
    mkdirSync(join(t.gh, "shop2"));
    symlinkSync(join(outside, ".sdlc"), join(t.gh, "shop2", ".sdlc"));
    const r = exportTimes(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.argv[0]), [join(shop, ".sdlc", "runs", "r-real")]);
    assert.deepEqual(r.file.runs.map((x) => x.run_id), ["r-real"]);
    assert.deepEqual(r.file.skipped.map((s) => s.run_dir), [join(shop, ".sdlc", "runs", "r-link"), join(t.gh, "shop2", ".sdlc")]);
    for (const s of r.file.skipped) assert.match(s.reason, /symbolic link, not followed/);
    assert.ok(!r.text.includes("r-outside"), "nothing behind a link is read");
  } finally {
    t.rm();
  }
});

test("lists every other folder in a runs folder as skipped, with why; files there are not runs", () => {
  const t = tree();
  const shop = join(t.gh, "shop");
  const locked = join(shop, ".sdlc", "runs", "r-locked");
  try {
    addRun(shop, "r-done");
    const gate0 = join(shop, ".sdlc", "runs", "r-gate0");
    mkdirSync(gate0, { recursive: true });
    writeFileSync(join(gate0, "orchestrator.log"), "MMO: 2026-11-06T08:57:12.345Z INFO   run.start run_id=r-gate0\n");
    writeFileSync(join(shop, ".sdlc", "runs", ".DS_Store"), "");
    addRun(shop, "r-locked");
    chmodSync(locked, 0o000);
    const asRoot = process.getuid?.() === 0; // root reads a folder whatever its mode
    const r = exportTimes(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.file.runs.map((x) => x.run_id), asRoot ? ["r-done", "r-locked"] : ["r-done"]);
    assert.deepEqual(r.file.skipped, [
      { run_dir: gate0, reason: "no manifest.json in this run folder" },
      ...(asRoot ? [] : [{ run_dir: locked, reason: "could not be read: EACCES" }]),
    ]);
    assert.ok(!r.text.includes(".DS_Store"));
  } finally {
    chmodSync(locked, 0o755);
    t.rm();
  }
});

// ── What the cost tool answers ───────────────────────────────────────────────

test("keeps a run the cost tool answered with unknown_reason in runs, as it answered", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    addRun(shop, "r-no-history", { kind: "unknown", reason: "no history files found for the run" });
    const r = exportTimes(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.file.runs, [runEntry("r-no-history", shop, unknownSplit("no history files found for the run"))]);
    assert.deepEqual(r.file.skipped, []);
  } finally {
    t.rm();
  }
});

test("lists a run the cost tool failed on as skipped with the reason, and still writes the file with the rest", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const dir = (id) => join(shop, ".sdlc", "runs", id);
    addRun(shop, "r1-fail", { kind: "fail", code: 1, stderr: "collect-orchestrator-usage FAILED: orchestrator.log has no run.start for this run\n" });
    addRun(shop, "r2-crash", { kind: "crash", message: "time split broke" });
    addRun(shop, "r3-line-after-json", { kind: "line-after-json", line: "TRAILING-LINE-4b1e" });
    addRun(shop, "r4-no-time-split", { kind: "no-time-split" });
    addRun(shop, "r5-silent", { kind: "silent" });
    addRun(shop, "r6-fail-quiet", { kind: "fail", code: 3, stderr: "" });
    addRun(shop, "r7-ok");
    const r = exportTimes(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.file.runs, [runEntry("r7-ok", shop)]);
    const why = Object.fromEntries(r.file.skipped.map((s) => [basename(s.run_dir), s.reason]));
    assert.deepEqual(r.file.skipped.map((s) => s.run_dir), ["r1-fail", "r2-crash", "r3-line-after-json", "r4-no-time-split", "r5-silent", "r6-fail-quiet"].map(dir));
    assert.equal(why["r1-fail"], `${STUB_NAME} --time-only stopped with exit code 1: collect-orchestrator-usage FAILED: orchestrator.log has no run.start for this run`);
    assert.match(why["r2-crash"], new RegExp(`^${STUB_NAME} --time-only stopped with exit code 1: [^]*Error: time split broke`));
    assert.equal(why["r3-line-after-json"], `${STUB_NAME} --time-only exited 0, but its last line is not one JSON object`);
    assert.equal(why["r4-no-time-split"], `${STUB_NAME} --time-only exited 0, but its answer has no time_split object`);
    assert.equal(why["r5-silent"], `${STUB_NAME} --time-only exited 0, but printed nothing`);
    assert.equal(why["r6-fail-quiet"], `${STUB_NAME} --time-only stopped with exit code 3 and gave no reason`);
    assert.ok(!r.text.includes("TRAILING-LINE-4b1e"), "a line that is not the answer is described, never copied");
  } finally {
    t.rm();
  }
});

test("writes the five fields, each run's three keys and the reasons, and nothing else: no chat text, no environment value", () => {
  const t = tree();
  try {
    const CHAT = "CHAT-TEXT-0f9c please rename the login handler";
    const ENV_VALUE = "ENV-VALUE-77ab";
    const shop = join(t.gh, "shop");
    const history = join(t.claudeConfig, "projects", shop.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(history, { recursive: true });
    writeFileSync(join(history, "sess-1.jsonl"), JSON.stringify({ type: "user", timestamp: "2026-11-06T08:57:00.000Z", message: { role: "user", content: CHAT } }) + "\n");
    addRun(shop, "r-noisy", { stdout_before: [`user said: ${CHAT}`, "window opens at the command turn"], extra: { debug: CHAT, env: ENV_VALUE } });
    mkdirSync(join(shop, ".sdlc", "runs", "r-empty"));
    const r = exportTimes(t, [], { env: { EXPORT_RUN_TIMES_TEST_VALUE: ENV_VALUE } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.text.includes("CHAT-TEXT-0f9c"), "no chat text in the file");
    assert.ok(!r.text.includes(ENV_VALUE), "no environment value in the file");
    assert.deepEqual(Object.keys(r.file), ["made_by", "made_at", "plugin_version", "runs", "skipped"]);
    assert.deepEqual(r.file.runs.map((x) => Object.keys(x)), [["run_id", "project_root", "time_split"]]);
    assert.deepEqual(r.file.skipped.map((x) => Object.keys(x)), [["run_dir", "reason"]]);
  } finally {
    t.rm();
  }
});

test("changes nothing in the folders it searches, run after run", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    addRun(shop, "r-timed");
    addRun(shop, "r-unknown", { kind: "unknown", reason: "no run.start in orchestrator.log" });
    addRun(shop, "r-fail", { kind: "fail", code: 1, stderr: "collect-orchestrator-usage FAILED: unreadable manifest\n" });
    mkdirSync(join(shop, ".sdlc", "runs", "r-empty"));
    addRun(join(t.base, "elsewhere", "api"), "r-other");
    const before = { home: snapshot(t.home), elsewhere: snapshot(join(t.base, "elsewhere")) };
    for (let i = 0; i < 2; i++) {
      const r = exportTimes(t, ["--root", join(t.base, "elsewhere")]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.path?.startsWith(t.out + "/"), "the file goes in the folder it was run from");
    }
    assert.deepEqual({ home: snapshot(t.home), elsewhere: snapshot(join(t.base, "elsewhere")) }, before);
  } finally {
    t.rm();
  }
});

// ── What a teammate sees, and where the file goes ────────────────────────────

test("prints one row per run as it is done (window in local time, its length, time taken; or unknown or skipped, with why), then the file and what to do with it", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    addRun(shop, "20261106-085700-bugfix-login");
    addRun(shop, "20261107-101500-docs-readme", { kind: "unknown", reason: "no history files found for the run" });
    addRun(shop, "20261108-120000-refactor-dates", { kind: "fail", code: 1, stderr: "collect-orchestrator-usage FAILED: orchestrator.log has no run.start for this run\n" });
    mkdirSync(join(shop, ".sdlc", "runs", "20261109-090000-test-gate0"));
    const r = exportTimes(t, [], { env: { TZ: "Asia/Kolkata" } });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n");
    const row = (id) => {
      const found = lines.filter((l) => l.includes(id));
      assert.equal(found.length, 1, `one row for ${id}:\n${r.stdout}`);
      return found[0];
    };
    const timed = row("20261106-085700-bugfix-login");
    assert.match(timed, /^\s*shop\s+20261106-085700-bugfix-login\s/);
    assert.match(timed, /2026-11-06 14:27 → 16:25\s+118\.7 min\s+61\.0 min\s*$/, "window in local time (IST here), its length, time taken");
    assert.match(row("20261107-101500-docs-readme"), /unknown: no history files found for the run\s*$/);
    assert.match(row("20261108-120000-refactor-dates"), new RegExp(`skipped: ${STUB_NAME} --time-only stopped with exit code 1: collect-orchestrator-usage FAILED: orchestrator\\.log has no run\\.start for this run\\s*$`));
    assert.match(row("20261109-090000-test-gate0"), /skipped: no manifest\.json in this run folder\s*$/);
    const tail = lines.filter((l) => l.trim()).slice(-2);
    assert.deepEqual(tail, [`Wrote ${r.path}: 1 timed, 1 unknown, 2 skipped.`, SEND]);
  } finally {
    t.rm();
  }
});

test("replaces a file it made earlier, never a file it did not make", () => {
  const t = tree();
  try {
    addRun(join(t.gh, "shop"), "r1");
    const first = exportTimes(t);
    assert.equal(first.status, 0, first.stderr);
    const again = exportTimes(t);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.path, first.path);
    assert.deepEqual(again.file.runs, first.file.runs);
    assert.ok(readdirSync(t.out).every((n) => n.startsWith("run-times-") && n.endsWith(".json")), `no temp file left: ${readdirSync(t.out)}`);

    const theirs = join(t.out, "notes.json");
    writeFileSync(theirs, '{"mine": true}\n');
    rmSync(t.log, { force: true });
    const r = exportTimes(t, ["--out", theirs], { outFile: theirs });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.json/);
    assert.match(r.stderr, /not made by export-run-times/);
    assert.equal(readFileSync(theirs, "utf8"), '{"mine": true}\n');
    assert.deepEqual(r.calls, [], "it stops before timing anything");
  } finally {
    t.rm();
  }
});

test("--out names the file; the file is never written inside a .sdlc folder, so a run folder never gains one", () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const run = addRun(shop, "r1");
    const named = join(t.base, "send-me.json");
    const ok = exportTimes(t, ["--out", named], { outFile: named });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.file.runs.map((x) => x.run_id), ["r1"]);

    rmSync(t.log, { force: true });
    const before = snapshot(join(shop, ".sdlc"));
    const inRun = exportTimes(t, [], { cwd: run });
    assert.equal(inRun.status, 1);
    assert.match(inRun.stderr, /\.sdlc/);
    const inSdlc = exportTimes(t, ["--out", join(shop, ".sdlc", "times.json")]);
    assert.equal(inSdlc.status, 1);
    assert.deepEqual(snapshot(join(shop, ".sdlc")), before);
    assert.deepEqual(calls(t), [], "it stops before timing anything");
  } finally {
    t.rm();
  }
});

test("says what to do when there is no folder to search, and stops on bad arguments with exit 2", () => {
  const t = tree();
  try {
    rmSync(join(t.home, "Documents"), { recursive: true });
    const none = exportTimes(t);
    assert.equal(none.status, 1);
    assert.ok(none.stderr.includes(join(t.home, "Documents", "GitHub")), none.stderr);
    assert.match(none.stderr, /--root/);
    assert.equal(none.path, null);
    assert.deepEqual(readdirSync(t.out), []);

    for (const args of [["--bogus"], ["--root"], ["--out"], ["stray"], ["--root", join(t.base, "no-such-folder")]]) {
      const r = exportTimes(t, args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.ok(r.stderr.trim(), `${args.join(" ")} says why`);
      assert.deepEqual(readdirSync(t.out), []);
    }
    const help = exportTimes(t, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--root/);
    assert.match(help.stdout, /--out/);
  } finally {
    t.rm();
  }
});

test("stops before timing anything when the cost tool is not there", () => {
  const t = tree();
  try {
    addRun(join(t.gh, "shop"), "r1");
    const missing = join(t.base, "no-such-cost-tool.mjs");
    const r = exportTimes(t, [], { env: { MMO_COST_TOOL_FOR_TESTS: missing } });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(missing), r.stderr);
    assert.equal(r.path, null);
  } finally {
    t.rm();
  }
});

test("uses the cost tool beside it unless a test names another", async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.equal(mod.DEFAULT_COST_TOOL, REAL_COST_TOOL);
  assert.ok(existsSync(mod.DEFAULT_COST_TOOL));
});

test("a cost tool call that does not finish in time is stopped, and the run is skipped with that reason", async () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const runDir = addRun(shop, "r-slow", { hold_ms: 10_000 });
    const { timeRun } = await import(pathToFileURL(SCRIPT).href);
    const started = Date.now();
    const out = timeRun({ costTool: STUB, runDir, projectRoot: shop, timeoutMs: 300 });
    assert.ok(Date.now() - started < 5_000, "stopped well before the call would have ended");
    assert.deepEqual(out, { ok: false, reason: `${STUB_NAME} --time-only did not finish within 0.3 seconds, so it was stopped` });
  } finally {
    t.rm();
  }
});

// ── The real cost tool ───────────────────────────────────────────────────────

const probe = spawnSync(process.execPath, [REAL_COST_TOOL, "--time-only"], { encoding: "utf8", env: { ...process.env, HOME: tmpdir(), CLAUDE_CONFIG_DIR: join(tmpdir(), "no-claude-config") } });
const NO_TIME_ONLY = probe.stderr.includes("unknown argument '--time-only'") ? "the cost tool has no --time-only mode in this checkout yet" : false;

test("the real cost tool's --time-only answer is kept whole, for a run with its log, telemetry and history files", { skip: NO_TIME_ONLY }, () => {
  const t = tree();
  try {
    const shop = join(t.gh, "shop");
    const id = "20261106-085700-bugfix-login";
    const runDir = join(shop, ".sdlc", "runs", id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ run_id: id, policy: "opus-plus-flash", started_at: "2026-11-06T09:05:00.000Z", ended_at: "2026-11-06T09:05:30.000Z" }));
    writeFileSync(join(runDir, "telemetry.jsonl"), JSON.stringify({ ts: "2026-11-06T09:05:30.000Z", latency_ms: 30000, pass: id, phase: "codegen", task_id: "t-1", provenance: "vendor", model: "gemini-3.8-flash", model_id: "worker", cost_usd: 0.01 }) + "\n");
    const log = (iso, event, fields) => `MMO: ${iso} INFO   ${event} ${fields}`;
    writeFileSync(join(runDir, "orchestrator.log"), [
      log("2026-11-06T09:00:00.000Z", "run.start", `run_id=${id} mode=brownfield`),
      log("2026-11-06T09:06:00.000Z", "gate.open", `run_id=${id} gate=gate-4 title="Accept"`),
      log("2026-11-06T09:08:00.000Z", "gate.resolved", `run_id=${id} gate=gate-4 response=approved`),
      log("2026-11-06T09:08:30.000Z", "run.end", `run_id=${id} outcome=completed`),
    ].join("\n") + "\n");
    const history = join(t.claudeConfig, "projects", shop.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(history, { recursive: true });
    const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 };
    const assistant = (uuid, parentUuid, id2, ts, content) => ({ type: "assistant", uuid, parentUuid, timestamp: ts, message: { id: id2, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content, usage } });
    writeFileSync(join(history, "sess-1.jsonl"), [
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-11-06T08:58:00.000Z", origin: { kind: "human" }, message: { role: "user", content: "<command-message>mmo:bugfix is running…</command-message>\n<command-name>/mmo:bugfix</command-name>\n<command-args>fix the login</command-args>" } },
      assistant("a1", "u1", "m1", "2026-11-06T08:58:10.000Z", [{ type: "text", text: "Starting." }]),
      assistant("a2", "a1", "m2", "2026-11-06T09:00:05.000Z", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
      { type: "user", uuid: "u2", parentUuid: "a2", timestamp: "2026-11-06T09:00:07.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
      assistant("a3", "u2", "m3", "2026-11-06T09:06:00.000Z", [{ type: "text", text: "Gate 4: accept?" }]),
      { type: "user", uuid: "u3", parentUuid: "a3", timestamp: "2026-11-06T09:08:00.000Z", origin: { kind: "human" }, message: { role: "user", content: "approved" } },
      assistant("a4", "u3", "m4", "2026-11-06T09:08:20.000Z", [{ type: "text", text: "Done." }]),
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = exportTimes(t, [], { env: { MMO_COST_TOOL_FOR_TESTS: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.file.skipped, [], r.stdout);
    assert.equal(r.file.runs.length, 1);
    assert.deepEqual(Object.keys(r.file.runs[0]), ["run_id", "project_root", "time_split"]);
    assert.equal(r.file.runs[0].run_id, id);
    assert.equal(r.file.runs[0].project_root, shop);
    assert.equal(r.file.runs[0].time_split.version, 1);
  } finally {
    t.rm();
  }
});
