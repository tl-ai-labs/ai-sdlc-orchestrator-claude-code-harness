/**
 * Zero-touch routing, hand-off half (ask 2, step 4), end to end through the real shell shim: a chat message the
 * rules recognise starts that job's /mmo: workflow; an unclear one is started only after the person agrees (or at
 * once in "auto"); everything else stays ordinary chat. Every case pipes the hook input Claude Code sends and reads
 * the decision back. Facts the design rests on were probed live on Claude Code 2.1.282: a command start, typed or
 * model-started, is a PreToolUse on the Skill tool ({skill, args}); only a typed one fires UserPromptExpansion; a
 * PreToolUse deny stops it and the model reads the reason.
 *
 * Each test has its own MMO_HOME and project folder. No network, no model call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
// The workflows' model check needs the built server; see tools/test/lib/server-built.mjs.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

/** A project folder: "existing" has a manifest (greenfield.md's signal), "new" is empty. */
function sandbox(kind = "existing", settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-route-hooks-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (kind === "existing") writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on", ...settings }));
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = {
      PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, MMO_AMBIENT_ARM: "on",
      // The workflows check this before a run starts (plugin/scripts/driver-model-check.mjs); the default policy's driver is Opus 5.
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5",
      ...env,
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
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

const prompt = (s, sid, text, env) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `p-${Math.random()}` }, s, env);
const skill = (s, sid, name, args, env) => run("pre-skill", { session_id: sid, cwd: s.repo, tool_name: "Skill", tool_input: { skill: name, ...(args ? { args } : {}) } }, s, env);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === "deny";
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
const pipeline = (s, sid) => existsSync(join(s.home, "sessions", sid, "pipeline"));
const projectPolicy = (s) => { try { return JSON.parse(readFileSync(join(s.repo, ".sdlc", "project.json"), "utf8")).default_policy; } catch { return null; } };

test("a clear job starts its workflow: Opus is told which one, in plain words for the person, and nothing else may run first", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const r = await prompt(s, "c1", "fix the /login endpoint returning 500 on missing password");
    assert.equal(r.json?.hookSpecificOutput?.hookEventName, "UserPromptSubmit", r.stdout);
    const c = context(r);
    assert.match(c, /Skill tool/);
    assert.match(c, /"mmo:bugfix"/);
    assert.match(c, /fix the \/login endpoint returning 500 on missing password/, "the message goes to the workflow as its description");
    assert.match(c, /Running this as a full bug-fix workflow\./, "the one plain line the person sees");
    assert.match(c, /estimated/, "the cost-recording mode is chosen, so the person is not asked");
    assert.match(c, /Keep the plugin, command names and model names out of what you say to the person/);
    assert.doesNotMatch(c, /ToolSearch/, "a chat that becomes a workflow gets no chat-savings note");
    // Guard A: until the workflow starts, nothing that changes files or starts a helper may run.
    const write = await run("pre-write", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s);
    assert.ok(denied(write) && /Start the workflow first/.test(reason(write)), write.stdout);
    const bash = await run("pre-bash", { session_id: "c1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" } }, s);
    assert.ok(denied(bash), bash.stdout);
    const agent = await run("pre-agent", { session_id: "c1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "x" } }, s);
    assert.ok(denied(agent), agent.stdout);
    // Guard B: only the routed workflow may start.
    assert.ok(denied(await skill(s, "c1", "mmo:refactor", "x")), "another workflow is refused");
    const start = await skill(s, "c1", "mmo:bugfix", "fix the /login endpoint returning 500 on missing password");
    assert.equal(start.stdout, "", "the routed workflow starts");
    assert.ok(pipeline(s, "c1"), "from here the chat is a workflow run: zero-touch stands down");
    assert.equal(projectPolicy(s), "opus-plus-flash-v38", "a folder with no saved policy gets the default, so the workflow does not stop to ask");
    assert.equal((await run("pre-write", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "b.js"), content: "x" } }, s)).stdout, "", "Guard A ends when the workflow starts");
  } finally { s.cleanup(); }
});

test("a new app in an empty folder starts the new-app workflow with no arguments; a saved policy is never overwritten", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    mkdirSync(join(s.repo, ".sdlc"));
    writeFileSync(join(s.repo, ".sdlc", "project.json"), JSON.stringify({ schema_version: 2, default_policy: "opus-plus-sonnet" }));
    const c = context(await prompt(s, "g1", "build me a todo app with a React frontend and a Node backend"));
    assert.match(c, /"mmo:greenfield"/);
    assert.match(c, /Running this as a full new-app build\./);
    assert.doesNotMatch(c, /args/, "the new-app command takes no arguments");
    assert.equal((await skill(s, "g1", "mmo:greenfield")).stdout, "");
    assert.equal(projectPolicy(s), "opus-plus-sonnet", "the person's own choice stays");
  } finally { s.cleanup(); }
});

test("a typed command is never touched: it starts as on 0.7.7, and nothing is routed around it", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.equal((await run("prompt-expansion", { session_id: "t1", cwd: s.repo, command_name: "mmo:refactor", expansion_type: "slash_command" }, s)).stdout, "");
    assert.equal(context(await prompt(s, "t1", "/mmo:refactor extract the date helpers")), "", "no route, no note");
    assert.equal((await skill(s, "t1", "mmo:refactor", "extract the date helpers")).stdout, "", "a typed command runs as a Skill call on 2.1.282, and it is allowed");
    assert.equal((await run("pre-write", { session_id: "t1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

test("ask (the default): an unclear request is started only after the person agrees in plain words", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const first = context(await prompt(s, "a1", "teh logn page 500s sort it out"));
    assert.doesNotMatch(first, /"mmo:bugfix"/, "the rules are not sure, so nothing is routed");
    assert.match(first, /Skill tool/, "the chat note tells Opus how full workflows start");
    const workflows = first.slice(first.indexOf("Full workflows:"));
    assert.ok(first.includes("Full workflows:") && workflows.length < 600, `the workflows paragraph stays short: ${workflows.length} chars`);
    assert.ok(!/\b(must|always|never|you should|immediately)\b/i.test(workflows), "it informs, it does not order, like the note it joins");
    const tried = await skill(s, "a1", "mmo:bugfix", "the login page returns 500");
    assert.ok(denied(tried), "Opus may not start it on its own");
    assert.match(reason(tried), /must agree/);
    assert.match(reason(tried), /bug-fix workflow/);
    assert.match(reason(tried), /Keep the plugin, command names and model names out of what you say to the person/);
    const yes = context(await prompt(s, "a1", "yes"));
    assert.match(yes, /agreed/);
    assert.match(yes, /"mmo:bugfix"/);
    assert.match(yes, /the login page returns 500/, "the description Opus offered goes with it");
    assert.equal((await skill(s, "a1", "mmo:bugfix", "the login page returns 500")).stdout, "");
    assert.ok(pipeline(s, "a1"));
  } finally { s.cleanup(); }
});

test("ask: anything but a plain yes is a no, and the offer lasts one reply", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "a2", "teh logn page 500s sort it out");
    assert.ok(denied(await skill(s, "a2", "mmo:bugfix", "the login page returns 500")));
    assert.doesNotMatch(context(await prompt(s, "a2", "yes but only look at the controller")), /"mmo:bugfix"/);
    assert.doesNotMatch(context(await prompt(s, "a2", "yes")), /"mmo:bugfix"/, "the offer expired with the reply that did not accept it");
    assert.ok(!pipeline(s, "a2"));
  } finally { s.cleanup(); }
});

test("auto: an unclear request Opus recognises starts at once", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing_unsure: "auto" });
  try {
    await prompt(s, "u1", "teh logn page 500s sort it out");
    assert.equal((await skill(s, "u1", "mmo:bugfix", "the login page returns 500")).stdout, "");
    assert.ok(pipeline(s, "u1"));
    assert.equal(projectPolicy(s), "opus-plus-flash-v38");
  } finally { s.cleanup(); }
});

test("workflows off: nothing is routed and Opus may not start one; the chat-savings rules still run", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing: "off" });
  try {
    const c = context(await prompt(s, "o1", "fix the /login endpoint returning 500 on missing password"));
    assert.doesNotMatch(c, /"mmo:bugfix"/);
    assert.match(c, /ToolSearch/, "the chat-savings note is sent as before");
    assert.doesNotMatch(c, /full workflow/i, "and says nothing about workflows");
    assert.ok(denied(await skill(s, "o1", "mmo:bugfix", "x")));
  } finally { s.cleanup(); }
});

test("a project folder can switch workflows off or back to asking, never on or to auto", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing_unsure: "auto" });
  try {
    mkdirSync(join(s.repo, ".sdlc"));
    writeFileSync(join(s.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing_unsure: "ask" }));
    await prompt(s, "p1", "teh logn page 500s sort it out");
    assert.ok(denied(await skill(s, "p1", "mmo:bugfix", "x")), "the folder tightened auto to ask");
    writeFileSync(join(s.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "off" }));
    assert.doesNotMatch(context(await prompt(s, "p2", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
  const t = sandbox("existing", { routing: "off" });
  try {
    mkdirSync(join(t.repo, ".sdlc"));
    writeFileSync(join(t.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "on", routing_unsure: "auto" }));
    assert.doesNotMatch(context(await prompt(t, "p3", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/, "a folder cannot switch workflows on");
  } finally { t.cleanup(); }
});

test("a chat that has started work never starts a workflow: the instruction is a follow-up", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "w1", "hi");
    assert.equal((await run("post-write", { session_id: "w1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "notes.md"), content: "x" }, tool_response: { type: "create" } }, s)).code, 0);
    assert.doesNotMatch(context(await prompt(s, "w1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    assert.ok(denied(await skill(s, "w1", "mmo:bugfix", "x")), "nor may Opus start one");
    const b = sandbox("existing");
    try {
      await prompt(b, "w2", "hi");
      await run("post-bash", { session_id: "w2", cwd: b.repo, tool_name: "Bash", tool_input: { command: "echo x > notes.txt" }, tool_response: { stdout: "", stderr: "" } }, b);
      assert.doesNotMatch(context(await prompt(b, "w2", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/, "a file written through Bash counts too");
    } finally { b.cleanup(); }
  } finally { s.cleanup(); }
});

test("a route not taken ends with its prompt: the next message is judged afresh and nothing stays blocked", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.match(context(await prompt(s, "s1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    await prompt(s, "s1", "actually, what does the login controller do?");
    assert.equal((await run("pre-write", { session_id: "s1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
    assert.ok(denied(await skill(s, "s1", "mmo:bugfix", "x")), "the old route is gone");
  } finally { s.cleanup(); }
});

test("a workflow that could not start is never routed: the person is told in plain words what is missing", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const c = context(await prompt(s, "m1", "fix the /login endpoint returning 500 on missing password", { CLAUDE_CODE_SUBAGENT_MODEL: undefined }));
    assert.doesNotMatch(c, /"mmo:bugfix"/, "the workflow's own check would stop it, so it is not started");
    assert.match(c, /one-time setting/);
    assert.match(c, /new chat/);
    assert.equal(projectPolicy(s), null, "nothing was written");
  } finally { s.cleanup(); }
});

test("setup, policy, revert, pass and the generic brownfield command are never started by the model", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing_unsure: "auto" });
  try {
    await prompt(s, "n1", "hello");
    for (const name of ["mmo:setup", "mmo:policy", "mmo:revert", "mmo:pass", "mmo:brownfield"]) {
      assert.ok(denied(await skill(s, "n1", name)), name);
    }
    assert.equal((await skill(s, "n1", "some-other-plugin:thing")).stdout, "", "other plugins' skills are not ours to judge");
  } finally { s.cleanup(); }
});
