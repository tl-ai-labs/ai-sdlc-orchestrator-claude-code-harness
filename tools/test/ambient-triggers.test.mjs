/**
 * Triggers, offers and the tool-call stamp. A trigger is a fact about what the
 * thinker is doing (a plan naming many files, todo items of one shape, a
 * failing test it wrote), never a reading of the prompt. The hook cases run
 * through the real shim with a private MMO_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LIB = join(ROOT, "plugin", "scripts", "ambient", "lib");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const T = await import(join(LIB, "triggers.mjs"));
const { stampInput, ambientToolName, isStartTool } = await import(join(LIB, "stamp.mjs"));
const { cellFor, drawOffer, pickWorker } = await import(join(LIB, "offers.mjs"));
const { loadConfig } = await import(join(LIB, "config.mjs"));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-triggers-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, "src"), { recursive: true });
  // share 1 so "shown" is deterministic; the coin flip itself is tested apart.
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ offers: { share: 1 } }));
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(event, payload, s, env = {}) {
  return new Promise((done) => {
    const p = spawn("sh", [SHIM, event], {
      cwd: s.repo, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PROJECT_DIR: s.repo, MMO_AMBIENT: "on", MMO_AMBIENT_ARM: "on", ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => done({ code, out, json: out ? JSON.parse(out) : null }));
    p.stdin.end(JSON.stringify(payload));
  });
}

/** A transcript whose last reply ran at `contextTokens`: what the hook reads the chat's size from. */
function transcriptAt(s, contextTokens) {
  const file = join(s.dir, "transcript-" + contextTokens + ".jsonl");
  writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5", usage: { input_tokens: 1000, cache_read_input_tokens: contextTokens - 1000, cache_creation_input_tokens: 0, output_tokens: 10 } } }) + "\n");
  return file;
}

const events = (s, sid) => {
  const f = join(s.home, "sessions", sid, "events.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("every offer line is one factual line that names its tool by its full name, says it needs loading, and gives no orders", () => {
  for (const kind of ["failing_repro_test", "reads_fan_out"]) {
    const line = T.offerLine({ kind, tool: "some_tool", count: 7 });
    assert.ok(line.startsWith("[mmo] ") && !line.includes("\n") && line.includes("`some_tool`"), kind);
    // In the desktop app the plugin's tools are hidden until loaded: a short name alone sends the model looking for a
    // tool it cannot see (seen live on 22 Sep: the line was read, no tool was ever called).
    assert.ok(line.includes("mcp__plugin_mmo_model-dispatch__some_tool"), `${kind}: the full name as Claude Code lists it`);
    assert.match(line, /load it with ToolSearch first/, kind);
    assert.ok(!/\b(must|always|never|you should|immediately)\b/i.test(line), `${kind}: an offer informs, it does not instruct`);
  }
  // The break-even, when the hook knows it, is stated in characters: the one number the model can act on.
  const withBreakEven = T.offerLine({ kind: "failing_repro_test", tool: "fix_from_analysis", count: 1, breakEvenChars: 31800 });
  assert.match(withBreakEven, /pays at this chat's size if the fix is more than about 31,800 characters/);
  const scout = T.offerLine({ kind: "reads_fan_out", tool: "scout_repo", count: 3, breakEvenReads: 3 });
  assert.match(scout, /read 3 files of this project by hand\. At this chat's size 3 reads cost as much as one scout job, so it pays now/);
});

test("the stamp carries session and arm, keeps the original input, and cannot be forged from inside the chat", () => {
  const out = stampInput({ files: ["a.ts"], _mmo: { arm: "on", session_id: "forged" } }, { sessionId: "real", promptId: "p1", arm: "control", mode: "on" });
  assert.deepEqual(out, { files: ["a.ts"], _mmo: { session_id: "real", prompt_id: "p1", arm: "control", mode: "on", agent: null, break_even_chars: null, context_tokens: null, cache_tier: null } });
  assert.equal(ambientToolName("mcp__plugin_mmo_model-dispatch__fix_from_analysis"), "fix_from_analysis");
  assert.equal(ambientToolName("mcp__model-dispatch__job_result"), "job_result");
  assert.equal(ambientToolName("mcp__model-dispatch__execute_with_model"), null, "the typed pipeline's tools are not ambient tools");
  assert.equal(isStartTool("job_result"), false);
});

test("the offer coin is flipped once per session and kind, and its probability is stored", () => {
  const s = sandbox();
  try {
    const env = { MMO_HOME: s.home };
    const a = drawOffer("s1", "many_files", 0.5, env, () => 0.9);
    const b = drawOffer("s1", "many_files", 0.5, env, () => 0.1);
    assert.deepEqual([a.shown, a.first, b.shown, b.first, b.propensity], [false, true, false, false, 0.5]);
    assert.equal(drawOffer("s1", "todos_one_shape", 0.5, env, () => 0.1).shown, true);
  } finally { s.cleanup(); }
});

test("a job kind whose cell is closed is never offered; bug-fix code on Go is closed for Flash and open for Sonnet", () => {
  const { config } = loadConfig({ env: { MMO_HOME: "/nonexistent" } });
  assert.equal(cellFor(config, "bugfix_code", "go").state, "closed");
  assert.equal(cellFor(config, "bugfix_code", "python").state, "open");
  assert.equal(cellFor(config, "boilerplate", "any").saving_basis, "assumed", "no measured saving for this job yet, and the record says so");
  assert.equal(cellFor({ ...config, closed_cells: ["bugfix_code|python|flash|completion"] }, "bugfix_code", "python").state, "closed");
  // An offer is withheld only when NO worker is open for the job: a Go bug fix is offered, for Sonnet.
  assert.deepEqual([pickWorker(config, "bugfix_code", "go").worker, pickWorker(config, "bugfix_code", "python").worker], ["sonnet", "flash"]);
});

test("hook: the bug-fix line appears only after the session wrote a test file AND a test run failed", async () => {
  const s = sandbox();
  try {
    const fail = (sid) => ({ session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" }, error: "1 failing" });
    assert.equal((await run("post-bash-failure", fail("cold"), s)).out, "", "a failing test the session did not write is not the bug-fix moment");
    await run("pre-write", { session_id: "s1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "src", "date.test.js"), content: "x" } }, s);
    const r = await run("post-bash-failure", fail("s1"), s);
    assert.equal(r.json.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.match(r.json.hookSpecificOutput.additionalContext, /fix_from_analysis.*you keep the diagnosis/);
    const lint = { session_id: "s2", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm run build" }, error: "tsc error" };
    await run("pre-write", { session_id: "s2", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.test.js"), content: "x" } }, s);
    assert.equal((await run("post-bash-failure", lint, s)).out, "", "a failed build is not a failing test");
  } finally { s.cleanup(); }
});

test("hook: the plugin's own job tools get stamped; start tools are refused where ambient mode stands down", async () => {
  const s = sandbox();
  try {
    const call = (sid, tool, input = { files: ["a.ts"] }) => ({ session_id: sid, cwd: s.repo, prompt_id: "p9", tool_name: "mcp__plugin_mmo_model-dispatch__" + tool, tool_input: input });
    const ok = await run("pre-mmo-tool", call("s1", "fix_from_analysis", { files: ["a.ts"], _mmo: { arm: "on", session_id: "forged" } }), s);
    const { break_even_chars, context_tokens, cache_tier, ...fixed } = ok.json.hookSpecificOutput.updatedInput._mmo;
    assert.ok(cache_tier === null || cache_tier === "5m" || cache_tier === "1h");
    assert.deepEqual({ ...ok.json.hookSpecificOutput.updatedInput, _mmo: fixed }, { files: ["a.ts"], _mmo: { session_id: "s1", prompt_id: "p9", arm: "on", mode: "on", agent: null } });
    assert.ok(break_even_chars === null || break_even_chars > 0, "the gate's numbers ride on the stamp; null only when the chat cannot be priced");
    assert.ok(context_tokens === null || context_tokens > 0);
    assert.equal(ok.json.hookSpecificOutput.permissionDecision, undefined, "stamping must not decide permission for the person");
    const control = await run("pre-mmo-tool", call("c", "fix_from_analysis"), s, { MMO_AMBIENT_ARM: "control" });
    assert.equal(control.json.hookSpecificOutput.permissionDecision, "deny");
    const follow = await run("pre-mmo-tool", call("c", "job_result", { job: "j1" }), s, { MMO_AMBIENT_ARM: "control" });
    assert.equal(follow.json.hookSpecificOutput.updatedInput._mmo.arm, "control", "a running job may always be collected or undone");
    await run("post-model-switch", { session_id: "off", cwd: s.repo, to_model: "claude-sonnet-5" }, s);
    assert.equal((await run("pre-mmo-tool", call("off", "write_files_from_specs"), s)).json.hookSpecificOutput.permissionDecision, "deny", "no NEW worker job while the chat is off the thinker");
    assert.equal((await run("pre-mmo-tool", { session_id: "s1", cwd: s.repo, tool_name: "mcp__model-dispatch__execute_with_model", tool_input: {} }, s)).out, "");
  } finally { s.cleanup(); }
});

test("a failing test is recognised from the OUTPUT too, because the thinker pipes test runs through tail and the exit code is lost", async () => {
  // Seen on the first live rehearsal: `npx vitest run ... 2>&1 | tail -8` exits 0 (tail's code), so no failure event
  // ever fires and the bug-fix moment was missed entirely.
  assert.equal(T.mentionsTestRunner("cd apps/api && npx vitest run --config vitest.config.ts validate-dates 2>&1 | tail -20"), true);
  assert.equal(T.mentionsTestRunner("cat vitest.config.ts | head -20; npx vitest run x 2>&1 | tail"), true);
  assert.equal(T.mentionsTestRunner("python -m pytest -q tests/ | tail -5"), true);
  assert.equal(T.mentionsTestRunner("go test ./... 2>&1 | head -40"), true);
  assert.equal(T.mentionsTestRunner("cat package.json | grep -n test"), false, "the word test alone is not a test run");
  assert.equal(T.mentionsTestRunner("git log --oneline | head"), false);
  for (const out of [" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 11 passed", "FAIL  tests/api/utils/validate-dates.test.ts", "AssertionError: expected 400", "=== 1 failed, 12 passed in 0.4s ===", "--- FAIL: TestParse (0.00s)", "  3 failing"]) {
    assert.equal(T.outputShowsFailingTests(out), true, out.slice(0, 30));
  }
  for (const out of [" Test Files  4 passed (4)\n      Tests  13 passed (13)", "0 failed, 12 passed", "ok  \tpkg/date\t0.01s", "failed to fetch optional dependency (warning)"]) {
    assert.equal(T.outputShowsFailingTests(out), false, out.slice(0, 30));
  }

  const s = sandbox();
  try {
    await run("pre-edit", { session_id: "s1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "tests", "api", "validate-dates.test.ts"), old_string: "a", new_string: "b" } }, s);
    const piped = { session_id: "s1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npx vitest run validate-dates 2>&1 | tail -20" }, tool_response: { stdout: " Test Files  1 failed (1)\n      Tests  2 failed | 5 passed (7)", stderr: "", interrupted: false } };
    const r = await run("post-bash", piped, s);
    assert.equal(r.json.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(r.json.hookSpecificOutput.additionalContext, /fix_from_analysis/);
    assert.equal(r.json.hookSpecificOutput.updatedToolOutput, undefined, "a failing run's output is never touched");
    const passing = { ...piped, session_id: "s2", tool_response: { stdout: " Tests  7 passed (7)", stderr: "", interrupted: false } };
    await run("pre-edit", { session_id: "s2", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "a.test.ts"), old_string: "a", new_string: "b" } }, s);
    assert.equal((await run("post-bash", passing, s)).out, "");
  } finally { s.cleanup(); }
});

test("a test file written through Bash counts as written (26% of test-file writes in past chats go through Bash)", async () => {
  // Measured on 847 past sessions: 142 test-file writes through Bash vs 410 through Edit/Write.
  // A session that writes its test with sed -i, a redirect, a heredoc or a python script
  // would otherwise never reach the bug-fix moment.
  const W = T.bashWrittenPaths;
  assert.deepEqual(W("sed -i '' 's/a/b/' tests/api/utils/x.test.ts"), ["tests/api/utils/x.test.ts"]);
  assert.deepEqual(W("cat > src/__tests__/date.test.js <<'EOF'\nimport x\nEOF"), ["src/__tests__/date.test.js"]);
  assert.deepEqual(W("python3 - <<'EOF'\np='tests/test_dates.py'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF"), ["tests/test_dates.py"]);
  assert.deepEqual(W("node -e \"require('fs').writeFileSync('pkg/date_test.go', s)\""), ["pkg/date_test.go"]);
  assert.deepEqual(W("echo hi | tee -a tests/log.test.ts"), ["tests/log.test.ts"]);
  assert.deepEqual(W("cp fixture.ts tests/new.spec.ts"), ["tests/new.spec.ts"]);
  assert.deepEqual(W("grep -rn foo tests/ | head; cat tests/a.test.ts"), [], "reading or searching a test file is not writing it");
  assert.deepEqual(W("npx vitest run tests/a.test.ts 2>&1 | tail -20"), [], "running tests is not writing them");
  assert.deepEqual(W("git diff > /tmp/out.txt"), ["/tmp/out.txt"]);

  const s = sandbox();
  try {
    const bash = (sid, command) => ({ session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command } });
    await run("pre-bash", bash("s1", "sed -i '' 's/old/new/' tests/api/x.test.ts"), s);
    const failing = { ...bash("s1", "npx vitest run x 2>&1 | tail -20"), tool_response: { stdout: " Tests  1 failed | 4 passed", stderr: "", interrupted: false } };
    const r = await run("post-bash", failing, s);
    assert.match(r.json.hookSpecificOutput.additionalContext, /fix_from_analysis/, "the bug-fix moment is reached with the test written through Bash");
    await run("pre-bash", bash("s2", "grep -rn x tests/api/x.test.ts"), s);
    assert.equal((await run("post-bash", { ...failing, session_id: "s2" }, s)).out, "", "only a WRITE to a test file counts");
  } finally { s.cleanup(); }
});

/**
 * One Bash call as Claude Code runs it: the before-hook sees the command, the
 * command runs (here: the listed files are created), then the after-hook runs.
 * `failed` sends the after-call down the failure path instead.
 */
async function bashStep(s, sid, id, command, create, { failed = false, stdout = "", size = 2 } = {}) {
  const input = { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_use_id: id, tool_input: { command } };
  const pre = await run("pre-bash", input, s);
  for (const f of create) {
    mkdirSync(dirname(join(s.repo, f)), { recursive: true });
    writeFileSync(join(s.repo, f), "x".repeat(size));
  }
  const post = failed
    ? await run("post-bash-failure", { ...input, error: "Exit code 1", is_interrupt: false }, s)
    : await run("post-bash", { ...input, tool_response: { stdout, stderr: "", interrupted: false } }, s);
  return { pre, post };
}
const heredocs = (files) => files.map((f) => `cat > ${f} <<'EOF'\nx\nEOF`).join("\n");

test("the stamp on a start tool carries the chat's break-even and size, so the server can refuse a job that would not pay", async () => {
  const s = sandbox();
  try {
    const out = await run("pre-mmo-tool", { session_id: "s1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_files_from_specs", transcript_path: transcriptAt(s, 20000), tool_input: { specs: [{ path: "src/a.ts", spec: "A helper that trims strings and nothing else." }] } }, s);
    const stamp = out.json?.hookSpecificOutput?.updatedInput?._mmo;
    assert.ok(stamp, JSON.stringify(out.json));
    assert.ok(Number.isInteger(stamp.break_even_chars) && stamp.break_even_chars > 0, JSON.stringify(stamp));
    assert.ok(Number.isFinite(stamp.context_tokens) && stamp.context_tokens > 0, JSON.stringify(stamp));
  } finally { s.cleanup(); }
});

// ---------- the enforced hand-over (23 Sep): typing is not asked about, it is refused above the break-even ----------

const bigWrite = (s, sid, name, chars, extra = {}) => ({ session_id: sid, cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "src", name), content: "x".repeat(chars) }, ...extra });

test("enforced: a by-hand Write of a new code file above the break-even is refused with the hand-over's full name; below it goes through; a second refusal is the last and the third try goes through, logged", async () => {
  const s = sandbox();
  try {
    const small = await run("pre-write", bigWrite(s, "s1", "tiny.ts", 500), s);
    assert.equal(small.json?.hookSpecificOutput?.permissionDecision, undefined, "500 characters: cheaper by hand, the spec would cost more");
    const first = await run("pre-write", bigWrite(s, "s1", "big.ts", 3000), s);
    assert.equal(first.json?.hookSpecificOutput?.permissionDecision, "deny");
    const why = first.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /Not typed by you: 3,000 characters of new files\. Above [\d,]+ characters a worker types this for about a third of the price/);
    assert.match(why, /the tool `write_files_from_specs` \(full name `mcp__plugin_mmo_model-dispatch__write_files_from_specs`; load it with ToolSearch first\) as one-paragraph specs, in one call/);
    assert.match(why, /A second refusal of the same file is the last; the third try goes through/);
    assert.equal((await run("pre-write", bigWrite(s, "s1", "big.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, "deny", "refused twice");
    const third = await run("pre-write", bigWrite(s, "s1", "big.ts", 3000), s);
    assert.equal(third.json?.hookSpecificOutput?.permissionDecision, undefined, "the third try goes through: never a trap");
    const ev = events(s, "s1");
    assert.equal(ev.filter((e) => e.type === "typing.refused").length, 2);
    assert.deepEqual(ev.filter((e) => e.type === "typing.refused").map((e) => [e.kind, e.tool, e.chars, e.files]), [["new_files_written", "write_files_from_specs", 3000, 1], ["new_files_written", "write_files_from_specs", 3000, 1]]);
    assert.ok(ev.filter((e) => e.type === "typing.refused").every((e) => e.break_even_chars > 600 && e.break_even_chars < 1000), "the break-even in the record is the sum's");
    assert.deepEqual(ev.filter((e) => e.type === "typing.allowed").map((e) => e.why), ["refused-twice"]);
    // A different new file is its own count: refused again, once.
    assert.equal((await run("pre-write", bigWrite(s, "s1", "other.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, "deny");
    // Overwriting an EXISTING file is an edit, not new typing: not enforced here.
    mkdirSync(join(s.repo, "src"), { recursive: true }); writeFileSync(join(s.repo, "src", "exists.ts"), "old");
    assert.equal((await run("pre-write", bigWrite(s, "s1", "exists.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined);
  } finally { s.cleanup(); }
});

test("enforced through Bash and the batch write: a heredoc command above the break-even is refused; a small one runs and its files are counted; a batch write of new files above the break-even is refused, below it runs", async () => {
  const s = sandbox();
  try {
    const big = await bashStep(s, "s1", "t1", heredocs(["src/a.ts"]).replace("x\nEOF", "x".repeat(3000) + "\nEOF"), []);
    assert.equal(big.pre.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(big.pre.json.hookSpecificOutput.permissionDecisionReason, /write_files_from_specs/);
    const small = await bashStep(s, "s1", "t2", heredocs(["src/b.ts"]), ["src/b.ts"]);
    assert.equal(small.pre.json?.hookSpecificOutput?.permissionDecision, undefined, "a tiny command is the thinker's own");
    assert.ok(existsSync(join(s.home, "sessions", "s1", "new-files")), "created files are still counted for the board");
    const batch = (files) => ({ session_id: "s1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_files", tool_input: { files } });
    const refused = await run("pre-mmo-tool", batch([{ path: "src/c.ts", content: "y".repeat(2000) }, { path: "src/d.ts", content: "y".repeat(2000) }]), s);
    assert.equal(refused.json?.hookSpecificOutput?.permissionDecision, "deny", "the batch write is the thinker's own typing: refused above the break-even like a Write");
    assert.match(refused.json.hookSpecificOutput.permissionDecisionReason, /4,000 characters of new files.*write_files_from_specs/s);
    const ok = await run("pre-mmo-tool", batch([{ path: "src/e.ts", content: "y".repeat(200) }]), s);
    assert.equal(ok.json?.hookSpecificOutput?.permissionDecision, undefined);
    assert.equal(ok.json?.hookSpecificOutput?.updatedInput?._mmo?.session_id, "s1", "a small batch runs, stamped");
  } finally { s.cleanup(); }
});

test("enforced: a test file names write_tests_from_cases; the same edit again in another file names repeat_edit_across_files, sized by the edit times the files git still finds", async () => {
  const s = sandbox();
  try {
    const t = await run("pre-write", { session_id: "s1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "tests", "a.test.ts"), content: "t".repeat(3000) } }, s);
    assert.equal(t.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(t.json.hookSpecificOutput.permissionDecisionReason, /3,000 characters of test files.*write_tests_from_cases.*as lists of cases/s);
    const { execFileSync } = await import("node:child_process");
    const git = (...args) => execFileSync("git", args, { cwd: s.repo, stdio: "pipe" });
    git("init", "-q"); git("config", "user.email", "dev@example.com"); git("config", "user.name", "dev");
    mkdirSync(join(s.repo, "src"), { recursive: true });
    for (const n of ["a", "b", "c", "d", "e", "f"]) writeFileSync(join(s.repo, "src", n + ".ts"), `export function ${n}() {\n  throw new HTTPException(404, { message: "${n} not found" });\n}\n`);
    git("add", "-A"); git("commit", "-q", "-m", "init");
    const edit = (n, id, replacement) => ({ session_id: "s1", cwd: s.repo, tool_name: "Edit", tool_use_id: id, tool_input: { file_path: join(s.repo, "src", n + ".ts"), old_string: `throw new HTTPException(404, { message: "${n} not found" });`, new_string: replacement }, tool_response: { filePath: join(s.repo, "src", n + ".ts") } });
    const small = `throw notFound("a not found");`;
    assert.equal((await run("pre-edit", edit("a", "e1", small), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "the first edit of a shape is always the thinker's");
    await run("post-edit", edit("a", "e1", small), s);
    assert.equal((await run("pre-edit", edit("b", "e2", small), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "a small edit times six files: 180 characters, cheaper by hand");
    const big = small + " // " + "z".repeat(400);
    await run("post-edit", edit("a", "e1b", big), s); // the big shape seen once, in a.ts
    const refused = await run("pre-edit", edit("b", "e3", big), s);
    assert.equal(refused.json?.hookSpecificOutput?.permissionDecision, "deny", "the same big edit in a second file: about 430 x 6 files pays");
    assert.match(refused.json.hookSpecificOutput.permissionDecisionReason, /repeat_edit_across_files.*with your edit and their list/s);
    assert.equal(events(s, "s1").find((e) => e.type === "typing.refused" && e.kind === "same_edit_in_files")?.tool, "repeat_edit_across_files");
  } finally { s.cleanup(); }
});

test("never refused: on the rules-only side, in the control arm, in observe mode, in a pipeline session, with the setting off, when every worker's cell is closed, and for a file the worker could not do (released)", async () => {
  const s = sandbox();
  try {
    const { releaseFile } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "released.mjs"));
    assert.equal((await run("pre-write", bigWrite(s, "c", "a.ts", 3000), s, { MMO_AMBIENT_ARM: "control" })).json?.hookSpecificOutput?.permissionDecision, undefined, "control arm");
    assert.equal((await run("pre-write", bigWrite(s, "o", "a.ts", 3000), s, { MMO_AMBIENT: "observe" })).json?.hookSpecificOutput?.permissionDecision, undefined, "observe");
    await run("prompt", { session_id: "p", cwd: s.repo, prompt: "/mmo:greenfield" }, s);
    assert.equal((await run("pre-write", bigWrite(s, "p", "a.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "pipeline session");
    mkdirSync(join(s.repo, ".sdlc"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "ambient.json"), JSON.stringify({ delegation: "off" }));
    assert.equal((await run("pre-write", bigWrite(s, "b", "a.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "rules only");
    rmSync(join(s.repo, ".sdlc"), { recursive: true, force: true });
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ offers: { enforce_handover: false } }));
    assert.equal((await run("pre-write", bigWrite(s, "x", "a.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "setting off");
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ closed_cells: ["boilerplate|js_ts|flash|completion", "boilerplate|js_ts|sonnet|completion"] }));
    assert.equal((await run("pre-write", bigWrite(s, "z", "a.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "no worker pays for this kind: the thinker types");
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({}));
    releaseFile("u", join(s.repo, "src", "a.ts"), { MMO_HOME: s.home, HOME: s.home });
    assert.equal((await run("pre-write", bigWrite(s, "u", "a.ts", 3000), s)).json?.hookSpecificOutput?.permissionDecision, undefined, "released: the worker could not do it");
    assert.equal(events(s, "u").find((e) => e.type === "typing.allowed")?.why, "released");
  } finally { s.cleanup(); }
});
