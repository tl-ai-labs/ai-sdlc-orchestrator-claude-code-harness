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
const { startingChats } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const TOOL = "mcp__plugin_mmo_model-dispatch__write_document";

function sandbox({ mode = "b", handoff } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-tools-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(home, "mode"), `${mode}\n`);
  if (handoff) writeFileSync(join(home, "ambient.json"), JSON.stringify({ handoff }));
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
  const s = sandbox({ handoff: { policy: "no-such-policy" } });
  try {
    await startOn(s, "x1");
    const why = denied(await before(s, "x1")) ?? "";
    assert.match(why, /Hand-off cannot run in this chat: the hand-off policy no-such-policy cannot be read/);
    assert.match(why, /Do this work yourself/);
  } finally { s.cleanup(); }
});

test("after the call the person sees one line from the receipt: what was written, by which model, what it cost", async () => {
  const s = sandbox();
  try {
    await startOn(s, "r1");
    const written = { status: "written", file: "docs/setup.md", kind: "docs", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004123 };
    const r = await after(s, "r1", written);
    assert.equal(line(r), "Zero-touch: docs/setup.md written by Flash, checked ($0.0041).");
    assert.equal(r.json.hookSpecificOutput, undefined, "the model reads the receipt itself; the line is the person's");
    // Claude Code hands a hook the reply as a content list, as a string or as the object: each reads the same.
    assert.equal(line(await after(s, "r1", written, (x) => JSON.stringify(x))), "Zero-touch: docs/setup.md written by Flash, checked ($0.0041).");
    assert.equal(line(await after(s, "r1", written, (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }))), "Zero-touch: docs/setup.md written by Flash, checked ($0.0041).");
    assert.equal(line(await after(s, "r1", { ...written, cost_usd: 1.5 })), "Zero-touch: docs/setup.md written by Flash, checked ($1.50).");
  } finally { s.cleanup(); }
});

test("the line says when the routed model failed and another wrote it, when the hand-off failed, and when the form was refused", async () => {
  const s = sandbox();
  try {
    await startOn(s, "f1");
    const byOpus = { status: "written", file: "docs/setup.md", written_by: "claude-opus-5", routed_model: "gemini-3.8-flash", attempts: 3, cost_usd: 0.098, note: "gemini-3.8-flash failed twice (…); done by claude-opus-5" };
    assert.equal(line(await after(s, "f1", byOpus)), "Zero-touch: Flash failed, done by Opus: docs/setup.md written, checked ($0.10).");
    const failed = { status: "failed", file: "docs/setup.md", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the document is empty", cost_usd: 0.012 };
    assert.equal(line(await after(s, "f1", failed)), "Zero-touch: hand-off failed for docs/setup.md ($0.01 spent); Opus writes it in the chat.");
    const form = { status: "refused", problems: ["purpose is empty", "facts needs at least one fact"] };
    assert.equal(line(await after(s, "f1", form)), "Zero-touch: hand-off form not complete (2 to fix); nothing was sent.");
    assert.equal(line(await after(s, "f1", { status: "refused", reason: "this chat's hand-off models are not resolved" })), "Zero-touch: hand-off refused (this chat's hand-off models are not resolved); nothing was sent.");
    assert.equal((await after(s, "f1", "not a receipt", (x) => x)).stdout, "", "a reply that is no receipt shows nothing");
  } finally { s.cleanup(); }
});

test("the line for tests, for a repeated change and for an undo", async () => {
  const s = sandbox();
  try {
    await startOn(s, "t1");
    const tests = { status: "written", id: "h1", file: "tests/cart.test.js", kind: "tests", written_by: "gemini-3.8-flash", routed_model: "gemini-3.8-flash", attempts: 1, cost_usd: 0.004 };
    assert.equal(line(await after(s, "t1", tests)), "Zero-touch: tests/cart.test.js written by Flash, checked ($0.0040).");
    const red = { status: "failed", file: "tests/cart.test.js", kind: "tests", routed_model: "gemini-3.8-flash", attempts: 3, reason: "the test command failed in a scratch copy of the project (exit 1). Its output:", output: "5 !== 6", cost_usd: 0.098 };
    assert.equal(line(await after(s, "t1", red)), "Zero-touch: the tests in tests/cart.test.js did not pass in a scratch copy ($0.10 spent); nothing was written. Opus looks at the output.");

    const landed = { status: "landed", id: "h2", changed: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], routed_model: "gemini-3.8-flash", check: "`npm test` passed in a scratch copy (3.2 s)", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", landed)), "Zero-touch: the change repeated in 3 files by Flash, checked ($0.01).");
    assert.equal(line(await after(s, "t1", { ...landed, changed: ["a.js"], failed: [{ file: "b.js", reason: "x" }, { file: "c.js", reason: "y" }], check: "not run (no check_command was given)" })), "Zero-touch: the change repeated in 1 file by Flash, no check command run ($0.01). 2 left for Opus to change.");
    assert.equal(line(await after(s, "t1", { ...landed, by_fallback: 1, fallback_model: "claude-opus-5" })), "Zero-touch: the change repeated in 3 files by Flash (1 by Opus after Flash failed), checked ($0.01).");
    assert.equal(line(await after(s, "t1", { ...landed, id: undefined, changed: [], unchanged: ["a.js"] })), "Zero-touch: no file needed the change ($0.01).");
    const broke = { status: "failed", reason: "the check command failed in a scratch copy with the 3 changed files (exit 1)", routed_model: "gemini-3.8-flash", would_change: ["a.js", "b.js", "c.js"], unchanged: [], failed: [], output: "boom", cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", broke)), "Zero-touch: the repeated change failed its check in a scratch copy ($0.01 spent); nothing was changed. Opus makes the change in the chat.");
    const none = { status: "failed", reason: "no target's edits passed the checks", routed_model: "gemini-3.8-flash", changed: [], unchanged: [], failed: [{ file: "a.js", reason: "x" }], cost_usd: 0.012 };
    assert.equal(line(await after(s, "t1", none)), "Zero-touch: the repeated change could not be handed off ($0.01 spent); nothing was changed. Opus makes the change in the chat.");

    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js", "b.js"], left_alone: [] })), "Zero-touch: hand-off h2 undone (2 files restored).");
    assert.equal(line(await after(s, "t1", { status: "undone", id: "h2", restored: ["a.js"], left_alone: ["b.js"] })), "Zero-touch: hand-off h2 undone (1 file restored, 1 changed since and left alone).");
  } finally { s.cleanup(); }
});

test("an undo needs no model: it is stamped even when the chat's hand-off policy cannot be read", { skip: SKIP ?? false }, async () => {
  const s = sandbox({ handoff: { policy: "no-such-policy" } });
  try {
    await startOn(s, "u1");
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
  const note = readFileSync(join(ROOT, "zero-touch", "scripts", "start-chat.mjs"), "utf8");
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
