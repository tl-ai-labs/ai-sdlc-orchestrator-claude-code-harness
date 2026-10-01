/**
 * Zero-touch hand-off mode, the hook around a hand-off tool call.
 *
 * The hand-off tools live in the mmo plugin's server, which never sees a chat. Two hook moments connect the two:
 *
 *   before the call (PreToolUse)  in a hand-off chat the hook adds a stamp to the call (`_mmo`): the chat's id, the
 *                                 project folder and who pays for a Claude typist. The server takes nothing else
 *                                 from the call about the chat: the chat's policy and models are read from the
 *                                 chat's own records, which the hook makes sure are resolved before it stamps.
 *                                 Anywhere else the call is refused: a chat in workflow mode, and a chat that is
 *                                 running a workflow (a workflow has its own steps and its own bill).
 *   after the call (PostToolUse)  the person sees one line, written by code from the tool's receipt: what was
 *                                 written, by which model, what it cost; or that the hand-off failed and the chat's
 *                                 model writes the file itself. The model reads the receipt; the line is never
 *                                 given to it.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const TOOL = "mcp__plugin_mmo_model-dispatch__write_document";

/**
 * A person who chose Hand-off ("b", Flash 3.8 typing every kind, the chat on Opus 5) or Workflows ("a") in the
 * settings box.
 */
function sandbox({ mode = "b", handoff = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-tools-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeZtSettings(home, { mode: mode === "a" ? "workflows" : "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash", ...handoff } });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The chat's stamp names a policy that no longer exists (a damaged install): nothing can be handed off. */
function breakPolicy(s, sid) {
  const file = join(s.home, "sessions", sid, "handoff.json");
  const st = JSON.parse(readFileSync(file, "utf8"));
  for (const k of Object.keys(st.typists)) st.typists[k].policy = "no-such-policy";
  writeFileSync(file, JSON.stringify(st));
  rmSync(join(s.home, "sessions", sid, "handoff_models.json"), { force: true });
}

function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
const startOn = (s, sid, model = "claude-opus-5") => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", model }, s);
const FORM = { kind: "docs", file: "docs/setup.md", purpose: "p", readers: "r", sections: [{ heading: "Install", must_say: "how" }], facts: [{ statement: "Install with `npm ci`.", source: "chat" }] };
const before = (s, sid, input = FORM, extra = {}, tool = TOOL) => run("pre-handoff", { session_id: sid, cwd: s.repo, tool_name: tool, tool_input: input, ...extra }, s);
const after = (s, sid, receipt, shape = (r) => [{ type: "text", text: JSON.stringify(r) }]) => run("post-handoff", { session_id: sid, cwd: s.repo, tool_name: TOOL, tool_input: FORM, tool_response: shape(receipt) }, s);
const denied = (r) => (r.json?.hookSpecificOutput?.permissionDecision === "deny" ? r.json.hookSpecificOutput.permissionDecisionReason : null);
const line = (r) => r.json?.systemMessage ?? null;

test("in a hand-off chat the call is stamped with the chat, the project and who pays; the form is untouched", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "c1");
    const r = await before(s, "c1", { ...FORM, _mmo: { session_id: "someone-else", project_dir: "/", auth: "vendor" } });
    assert.equal(r.json.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined, "the hook decides nothing about permission: the person's own settings do");
    const sent = r.json.hookSpecificOutput.updatedInput;
    const { _mmo, ...form } = sent;
    assert.deepEqual(form, FORM, "every field of the form travels as the model wrote it");
    assert.deepEqual(_mmo, { session_id: "c1", project_dir: s.repo, auth: "estimated" }, "a stamp the model wrote is replaced, never kept");
    // The chat's models are resolved before the first hand-off, whether or not a message was recognised first.
    const kept = JSON.parse(readFileSync(join(s.home, "sessions", "c1", "handoff_models.json"), "utf8"));
    assert.equal(kept.routes.docs.model, "gemini-3.8-flash");
  } finally { s.cleanup(); }
});

test("the matching tool name is read with or without the plugin prefix; another tool is not touched", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "n1");
    assert.ok((await before(s, "n1", FORM, {}, "mcp__model-dispatch__write_document")).json.hookSpecificOutput.updatedInput._mmo);
    assert.equal((await before(s, "n1", FORM, {}, "mcp__plugin_mmo_model-dispatch__execute_stage")).stdout, "", "not a hand-off tool");
    assert.equal((await before(s, "n1", FORM, {}, "Write")).stdout, "");
  } finally { s.cleanup(); }
});

test("outside a hand-off chat, and while a workflow runs, a hand-off tool is refused with the reason", { skip: SKIP ?? false }, async () => {
  const a = sandbox({ mode: "a" });
  try {
    await startOn(a, "w1");
    assert.match(denied(await before(a, "w1")) ?? "", /work only in a chat that started in zero-touch hand-off mode/);
  } finally { a.cleanup(); }
  const s = sandbox();
  try {
    await startOn(s, "p1");
    await run("prompt", { session_id: "p1", cwd: s.repo, prompt: "/mmo:bugfix the login 500", prompt_id: "p1-1" }, s);
    assert.ok(existsSync(join(s.home, "sessions", "p1", "pipeline")));
    assert.match(denied(await before(s, "p1")) ?? "", /not available inside a workflow run/);
  } finally { s.cleanup(); }
});

test("when the chat's hand-off policy cannot be read, the call is refused and the model is told to do the work itself", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "x1");
    breakPolicy(s, "x1");
    const why = denied(await before(s, "x1")) ?? "";
    assert.match(why, /Hand-off cannot run in this chat: the models for this work can't be read/);
    assert.match(why, /Do this work yourself/);
  } finally { s.cleanup(); }
});

test("after the call the person sees one line from the receipt: what was written, by which model, what it cost", async () => {
  const s = sandbox();
  try {
    await startOn(s, "r1");
    const written = { status: "written", file: "docs/setup.md", kind: "docs", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004123 };
    const r = await after(s, "r1", written);
    assert.equal(line(r), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Cost: $0.0041.");
    assert.equal(r.json.hookSpecificOutput, undefined, "the model reads the receipt itself; the line is the person's");
    // Claude Code hands a hook the reply as a content list, as a string or as the object: each reads the same.
    assert.equal(line(await after(s, "r1", written, (x) => JSON.stringify(x))), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Cost: $0.0041.");
    assert.equal(line(await after(s, "r1", written, (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }))), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Cost: $0.0041.");
    assert.equal(line(await after(s, "r1", { ...written, cost_usd: 1.5 })), "Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Cost: $1.50.");
  } finally { s.cleanup(); }
});

test("the line says when the routed model failed and another wrote it, when the hand-off failed, and when the form was refused", async () => {
  const s = sandbox();
  try {
    await startOn(s, "f1");
    const byOpus = { status: "written", file: "docs/setup.md", written_by: "claude-opus-5", routed_model: "gemini-3.8-flash", attempts: 3, cost_usd: 0.098, note: "gemini-3.8-flash failed twice (…); done by claude-opus-5" };
    assert.equal(line(await after(s, "f1", byOpus)), "Zero-touch: Flash 3.8 couldn't write docs/setup.md, so Opus 5 wrote it. It was checked automatically. Cost: $0.10.");
    const failed = { status: "failed", file: "docs/setup.md", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the document is empty", cost_usd: 0.012 };
    assert.equal(line(await after(s, "f1", failed)), "Zero-touch: the hand-off of docs/setup.md didn't work (cost so far: $0.01), and nothing was added to your project. Opus 5 will write it directly now.");
    const form = { status: "refused", problems: ["purpose is empty", "facts needs at least one fact"] };
    assert.equal(line(await after(s, "f1", form)), "Zero-touch: Opus 5's instructions for the hand-off were missing 2 things, so nothing was sent and nothing was charged. Opus 5 is fixing them and will try again.");
    assert.equal(line(await after(s, "f1", { status: "refused", reason: "this chat's hand-off models are not resolved" })), "Zero-touch: the hand-off was refused (this chat's hand-off models are not resolved), so nothing was sent and nothing was charged.");
    assert.equal((await after(s, "f1", "not a receipt", (x) => x)).stdout, "", "a reply that is no receipt shows nothing");
  } finally { s.cleanup(); }
});

test("the line for tests, for a repeated change and for an undo", async () => {
  const s = sandbox();
  try {
    await startOn(s, "t1");
    const tests = { status: "written", id: "h1", file: "tests/cart.test.js", kind: "tests", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004 };
    assert.equal(line(await after(s, "t1", tests)), "Zero-touch: tests/cart.test.js was written by Flash 3.8 and checked automatically. Cost: $0.0040. To undo it, ask Claude to undo hand-off h1.");
    const red = { status: "failed", file: "tests/cart.test.js", kind: "tests", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the test command failed in a scratch copy of the project (exit 1). Its output:", output: "5 !== 6", cost_usd: 0.098 };
    assert.equal(line(await after(s, "t1", red)), "Zero-touch: the new tests in tests/cart.test.js didn't pass in the test copy (cost: $0.10), so nothing was added. Opus 5 will look at why: if a test was wrong, it fixes the test; if the code has a real bug, it tells you.");

    const landed = { status: "landed", id: "h2", changed: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], routed_model: "gemini-3.8-flash", check: "`npm test` passed in a scratch copy (3.2 s)", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", landed)), "Zero-touch: Flash 3.8 made the change in 3 files, and your project's check passed on a test copy. Cost: $0.01. To undo it, ask Claude to undo hand-off h2.");
    assert.equal(line(await after(s, "t1", { ...landed, changed: ["a.js"], failed: [{ file: "b.js", reason: "x" }, { file: "c.js", reason: "y" }], check: "not run (no check_command was given)" })), "Zero-touch: Flash 3.8 made the change in 1 file, and no automatic check was available. Cost: $0.01. To undo it, ask Claude to undo hand-off h2. 2 files still need the change, and Opus 5 will do them.");
    assert.equal(line(await after(s, "t1", { ...landed, by_fallback: 1, fallback_model: "claude-opus-5" })), "Zero-touch: Flash 3.8 made the change in 3 files (1 file by Opus 5 after Flash 3.8 failed), and your project's check passed on a test copy. Cost: $0.01. To undo it, ask Claude to undo hand-off h2.");
    assert.equal(line(await after(s, "t1", { ...landed, id: undefined, changed: [], unchanged: ["a.js"] })), "Zero-touch: no file needed the change. Cost: $0.01.");
    const broke = { status: "failed", reason: "the check command failed in a scratch copy with the 3 changed files (exit 1)", routed_model: "gemini-3.8-flash", would_change: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], output: "boom", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", broke)), "Zero-touch: the change couldn't be repeated safely (your project's check failed on the test copy; cost: $0.01), so nothing was changed. Opus 5 will make the change directly.");
    const none = { status: "failed", reason: "no target's edits passed the checks", routed_model: "gemini-3.8-flash", changed: [], unchanged: [], failed: [{ file: "a.js", reason: "x" }], cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", none)), "Zero-touch: the change couldn't be repeated safely (it couldn't be handed off; cost: $0.01), so nothing was changed. Opus 5 will make the change directly.");

    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js", "b.js"], left_alone: [] })), "Zero-touch: hand-off h2 was undone: 2 files are back as they were.");
    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js"], left_alone: ["b.js"] })), "Zero-touch: hand-off h2 was undone: 1 file is back as it was. (1 file had been changed again since, so it was left as it is.)");
  } finally { s.cleanup(); }
});

test("an undo needs no model: it is stamped even when the chat's hand-off policy cannot be read", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "u1");
    breakPolicy(s, "u1");
    const undo = await before(s, "u1", { id: "h1" }, {}, "mcp__plugin_mmo_model-dispatch__undo_hand_off");
    assert.deepEqual(undo.json.hookSpecificOutput.updatedInput, { id: "h1", _mmo: { session_id: "u1", project_dir: s.repo, auth: "estimated" } });
  } finally { s.cleanup(); }
});

test("every tool the hooks match, the start note names and the reminders name is a tool the server lists", { skip: SKIP ?? false }, async () => {
  const { HANDOFF_TOOLS } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "handoff", "tools.js"));
  const listed = HANDOFF_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(listed, ["repeat_edit_across_files", "undo_hand_off", "write_document", "write_tests_from_cases"]);
  const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
  for (const tool of listed) assert.equal(H.handoffToolName(`mcp__plugin_mmo_model-dispatch__${tool}`), tool, `the hook knows ${tool}`);
  for (const tool of new Set(Object.values(H.HANDOFF_TOOL))) assert.ok(listed.includes(tool), `the reminders name ${tool}, which the server lists`);
  const note = readFileSync(join(ROOT, "zero-touch", "scripts", "messages.mjs"), "utf8"); // the rules note lives there (1 Oct 2026)
  for (const tool of listed) assert.match(note, new RegExp(`\\b${tool}\\b`), `the start note names ${tool}`);
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["PreToolUse", "PostToolUse"]) {
    const entry = hooks[event].find((e) => e.hooks.some((h) => /(pre|post)-handoff$/.test(h.command)));
    for (const tool of listed) assert.ok(new RegExp(`^(?:${entry.matcher})$`).test(`mcp__plugin_mmo_model-dispatch__${tool}`), `${event} matches ${tool}`);
  }
});

test("mmo registers both moments for the hand-off tools, through the same shim as its other hooks", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
  for (const [event, moment] of [["PreToolUse", "pre-handoff"], ["PostToolUse", "post-handoff"]]) {
    const entry = (hooks[event] ?? []).find((e) => e.hooks.some((h) => h.command.endsWith(` ${moment}`)));
    assert.ok(entry, `${event} has the ${moment} hook`);
    assert.equal(entry.hooks[0].command, `sh "\${CLAUDE_PLUGIN_ROOT}/hooks/ambient.sh" ${moment}`);
    const matcher = new RegExp(`^(?:${entry.matcher})$`);
    for (const tool of ["write_document", "write_tests_from_cases", "repeat_edit_across_files", "undo_hand_off"]) {
      assert.ok(matcher.test(`mcp__plugin_mmo_model-dispatch__${tool}`), `${tool}, installed as a plugin`);
      assert.ok(matcher.test(`mcp__model-dispatch__${tool}`), `${tool}, from a clone`);
    }
    assert.ok(!matcher.test("mcp__plugin_mmo_model-dispatch__execute_stage"), "the workflow's own tools are not touched");
  }
});

test("a project not set up with git: the person reads the plain line, not the server's reason", async () => {
  // 1 Oct 2026: the line was "the hand-off was refused (the project is not a git repository, so a scratch copy cannot
  // tell its own files from installed dependencies …)": technical, and it did not say who does the work now. The
  // approved words (MESSAGES-REVIEW.md 6.4) are shown instead; the documents sentence only when documents hand off.
  const reason = "the project is not a git repository, so a scratch copy cannot tell its own files from installed dependencies and the hand-off cannot be checked";
  const refused = { status: "refused", reason, cause: "no-git", next: "Nothing was sent. Write tests/cart.test.js yourself." };
  const s = sandbox();
  try {
    await startOn(s, "g1");
    assert.equal(line(await after(s, "g1", refused)), "Zero-touch: this can't be handed off here, because the test copy it needs only works in a project set up with git. So Opus 5 does it directly. (New documents can still be handed off.)");
    // Any other refusal keeps its own line.
    assert.match(line(await after(s, "g1", { status: "refused", reason: "something else" })), /the hand-off was refused \(something else\)/);
  } finally { s.cleanup(); }
  const k = sandbox({ handoff: { documents: "chat" } });
  try {
    await startOn(k, "g2");
    assert.equal(line(await after(k, "g2", refused)), "Zero-touch: this can't be handed off here, because the test copy it needs only works in a project set up with git. So Opus 5 does it directly.", "documents are kept in the chat: no promise about them");
  } finally { k.cleanup(); }
});

test("a repeated change that found a file changed while it ran: the person reads that nothing was written over", async () => {
  // 1 Oct 2026: the server lands nothing then (handoffTestsAndEdits.test.mjs); the line says why, in plain words.
  const s = sandbox();
  try {
    await startOn(s, "m1");
    const r = await after(s, "m1", { status: "failed", reason: "src/reports.js changed while the hand-off ran", changed_meanwhile: ["src/reports.js"], would_change: ["src/invoices.js", "src/reports.js"], cost_usd: 0.008 });
    assert.equal(line(r), "Zero-touch: the change couldn't be repeated safely (1 file changed while it was running; cost: $0.0080), so nothing was changed. Opus 5 will make the change directly.");
  } finally { s.cleanup(); }
});
