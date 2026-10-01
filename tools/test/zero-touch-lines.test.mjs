/**
 * The one line a person sees after each message in a workflow-mode chat.
 *
 * The prompt hook already decides, for every message a person types, whether it starts a workflow. It says so in one
 * line shown to the person (the hook's `systemMessage`, which Claude Code shows in the chat and never gives the
 * model), so anyone watching the chat can tell what zero-touch did with the message, and that it was zero-touch and
 * not the model that said it: every line starts with "Zero-touch:". What the model reads is unchanged: the start
 * instruction for a recognised job, nothing for an ordinary message.
 *
 * Nothing is shown for what nobody typed (a machine notice), for a typed /mmo: command (the person named the
 * workflow themselves), for a message sent while Claude is still working (it joins the running task), in a chat
 * without zero-touch, or in a measuring run that only records.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { formatLine } = await import(join(ROOT, "plugin", "scripts", "lib", "log.mjs"));
// Starting a workflow asks the workflows' own model check, which needs the built server.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

function sandbox(kind = "existing") {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-lines-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
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
const plain = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {}, zeroTouch: false });

let seq = 0;
const say = (s, sid, text, extra = {}, env) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${++seq}`, ...extra }, s, env);
const skill = (s, sid, name, args) => run("pre-skill", { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } }, s);
const turnEnd = (s, sid) => run("turn-end", { session_id: sid, cwd: s.repo, stop_hook_active: false }, s);
const line = (r) => r.json?.systemMessage ?? null;
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

function workflowLog(s, runId, ...lines) {
  const dir = join(s.repo, ".sdlc", "runs", runId);
  mkdirSync(dir, { recursive: true });
  for (const [event, fields] of lines) appendFileSync(join(dir, "orchestrator.log"), formatLine("info", event, { run_id: runId, ...fields }) + "\n");
}

const BUGFIX = "fix the /login endpoint returning 500 on missing password";
const DOCS = "add jsdoc to every function in src/cart.js";
const NEW_APP = "build me a todo app with a React frontend and a Node backend";
const QUESTION = "what does the cart module do?";

/** A routed bug-fix workflow, started: past its first gate, or with that gate still open. */
async function runningBugfix(s, sid, { gateOpen = false } = {}) {
  await say(s, sid, BUGFIX);
  assert.equal((await skill(s, sid, "mmo:bugfix", BUGFIX)).stdout, "", "the bug fix starts");
  workflowLog(s, `bf-${sid}`, ["run.start", { mode: "brownfield" }], ["gate.open", { gate: "gate-0", title: "scope" }]);
  if (!gateOpen) workflowLog(s, `bf-${sid}`, ["gate.resolved", { gate: "gate-0", response: "approved" }]);
}
const endBugfix = (s, sid) => workflowLog(s, `bf-${sid}`, ["run.end", { outcome: "completed" }], ["gate.open", { gate: "gate-4" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]);

test("a recognised job: the person sees which workflow starts, and the model still gets its start instruction", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    const r = await say(s, "l1", BUGFIX);
    assert.equal(line(r), "Zero-touch: you asked for a bug fix, so Claude is starting the bug-fix workflow. It will wait for your approval at each main step.");
    assert.match(context(r), /Start it now with the Skill tool/, "the model's instruction is unchanged");
    const d = await say(s, "l1b", DOCS);
    assert.equal(line(d), "Zero-touch: you asked for documentation, so Claude is starting the documentation workflow. It will wait for your approval at each main step.");
  } finally { s.cleanup(); }
});

test("a new app in an empty folder: the line names the new-app workflow", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    assert.equal(line(await say(s, "l2", NEW_APP)), "Zero-touch: you asked for a new app, so Claude is starting the new-app workflow. It will wait for your approval at each main step.");
  } finally { s.cleanup(); }
});

test("an ordinary message: the person sees it is handled as a normal chat, and the model gets nothing", async () => {
  const s = sandbox();
  try {
    const r = await say(s, "l3", QUESTION);
    assert.equal(line(r), "Zero-touch: this isn't one of the jobs that get a full workflow, so Claude answers it normally.");
    assert.equal(r.json.hookSpecificOutput, undefined, "nothing is added to what the model reads");
  } finally { s.cleanup(); }
});

test("a message while the workflow's gate is open is shown as that gate's answer; the model gets nothing", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "l4", { gateOpen: true });
    const r = await say(s, "l4", DOCS);
    assert.equal(line(r), "Zero-touch: the workflow is waiting for your approval, so this message is taken as your answer to it, not as a new request.");
    assert.equal(r.json.hookSpecificOutput, undefined);
  } finally { s.cleanup(); }
});

test("a second job while a workflow runs: the person is told to choose, and the model is told to ask", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "l5");
    const r = await say(s, "l5", DOCS);
    assert.equal(line(r), "Zero-touch: a bug-fix workflow is still running in this chat. In the box, choose whether the documentation workflow you asked for should wait its turn or replace the running one.");
    assert.match(context(r), /AskUserQuestion/);
  } finally { s.cleanup(); }
});

test("a message during a running workflow that is no new job: the person sees the workflow carries on", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "l6");
    const r = await say(s, "l6", QUESTION);
    assert.equal(line(r), "Zero-touch: this isn't a new job, so the running bug-fix workflow carries on, taking your message into account.");
    assert.equal(r.json.hookSpecificOutput, undefined);
  } finally { s.cleanup(); }
});

test("a job while another chat runs a workflow in this folder: the person sees it was not started", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "l7a");
    const r = await say(s, "l7b", DOCS);
    assert.equal(line(r), "Zero-touch: the documentation workflow didn't start, because another chat in this project folder is already running a bug-fix workflow, and two at once would get in each other's way. When that one has finished, or after you type /clear in that chat, ask again here. Until then, Claude can help in this chat as usual.");
    assert.match(context(r), /cannot start in this chat/, "the model still explains it");
  } finally { s.cleanup(); }
});

test("a queued job, when its turn comes: the person sees the queued workflow start", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await runningBugfix(s, "l8");
    await say(s, "l8", DOCS);
    await say(s, "l8", "Queue it");
    endBugfix(s, "l8");
    const r = await turnEnd(s, "l8");
    assert.equal(line(r), "Zero-touch: the bug-fix workflow has finished, so the documentation workflow you queued is starting now.");
    assert.equal(r.json.decision, "block", "the turn continues with the queued start, as before");
  } finally { s.cleanup(); }
});

test("nothing is shown for a machine notice, a typed command, a chat without zero-touch, or a run that only records", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    assert.equal((await say(s, "n1", "<task-notification>done</task-notification>")).stdout, "", "a machine notice");
    assert.equal(line(await say(s, "n2", "/mmo:bugfix the login 500")), null, "a typed command: the person named the workflow");
    assert.equal((await plain("prompt", { session_id: "n3", cwd: s.repo, prompt: BUGFIX, prompt_id: "n3p" }, s)).stdout, "", "a chat without zero-touch");
    assert.equal(line(await say(s, "n4", QUESTION, {}, { MMO_AMBIENT: "observe" })), null, "a measuring run only records");
  } finally { s.cleanup(); }
});
