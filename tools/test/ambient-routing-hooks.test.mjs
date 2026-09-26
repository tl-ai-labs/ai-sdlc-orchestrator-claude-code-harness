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
import { execFileSync, spawn } from "node:child_process";
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
      // No CLAUDE_CODE_SUBAGENT_MODEL (v0.8.3, 25 Sep): the workflows' helpers name their model in the plugin's
      // agent files, so every scenario here runs as a person with nothing set would.
      PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, MMO_AMBIENT_ARM: "on",
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
    // Guard A (the catch-all pre-any hook): until the workflow starts, nothing that changes files or starts a helper may run.
    const write = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s);
    assert.ok(denied(write) && /Start the workflow first/.test(reason(write)), write.stdout);
    const bash = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" } }, s);
    assert.ok(denied(bash), bash.stdout);
    const agent = await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "x" } }, s);
    assert.ok(denied(agent), agent.stdout);
    // Guard B: only the routed workflow may start.
    assert.ok(denied(await skill(s, "c1", "mmo:refactor", "x")), "another workflow is refused");
    const start = await skill(s, "c1", "mmo:bugfix", "fix the /login endpoint returning 500 on missing password");
    assert.equal(start.stdout, "", "the routed workflow starts");
    assert.ok(pipeline(s, "c1"), "from here the chat is a workflow run: zero-touch stands down");
    assert.equal(projectPolicy(s), "opus-plus-flash-v38", "a folder with no saved policy gets the default, so the workflow does not stop to ask");
    assert.equal((await run("pre-any", { session_id: "c1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "b.js"), content: "x" } }, s)).stdout, "", "Guard A ends when the workflow starts");
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
    assert.equal((await run("pre-any", { session_id: "t1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

// ─── Rules only (26 Sep 2026) ───
// Until 26 Sep an unclear request the chat's own model recognised was offered ("Shall I run the full bug-fix
// workflow?") or, with routing_unsure: auto, started at once. Both rested on the chat model's guess, so the result
// changed with the model the person picked. Now a workflow starts only when the rules recognise the request or the
// person types the command; anything else is an ordinary chat with the generic orchestrator.

test("an unclear request is never started or offered: no question, no workflow, the chat carries on", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    assert.doesNotMatch(context(await prompt(s, "a1", "teh logn page 500s sort it out")), /"mmo:bugfix"/, "the rules are not sure, so nothing is routed");
    const tried = await skill(s, "a1", "mmo:bugfix", "the login page returns 500");
    assert.ok(denied(tried), "the chat may not start a workflow on its own guess");
    assert.doesNotMatch(reason(tried), /agree|Shall I|ask them/i, "and is not told to ask the person");
    assert.match(reason(tried), /Carry on/);
    assert.doesNotMatch(context(await prompt(s, "a1", "yes")), /"mmo:bugfix"/, "a later yes starts nothing: there was no offer");
    assert.ok(!pipeline(s, "a1"));
    assert.ok(!existsSync(join(s.home, "sessions", "a1", "route-offer.json")), "no offer is ever kept");
  } finally { s.cleanup(); }
});

test("the chat note says full workflows are started by the plugin itself, names no command and invites no start", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    const note = context(await prompt(s, "a3", "hello there"));
    const i = note.indexOf("Full workflows");
    assert.ok(i >= 0, "the note mentions full workflows");
    const workflows = note.slice(i);
    assert.ok(workflows.length < 400, `the workflows paragraph stays short: ${workflows.length} chars`);
    assert.doesNotMatch(workflows, /mmo:|Skill tool/, "no command names and no invitation to call one");
    assert.ok(!/\b(must|always|never|you should|immediately)\b/i.test(workflows), "it informs, it does not order, like the note it joins");
  } finally { s.cleanup(); }
});

test("an old routing_unsure setting is ignored: auto no longer starts anything", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { routing_unsure: "auto" });
  try {
    await prompt(s, "u1", "teh logn page 500s sort it out");
    assert.ok(denied(await skill(s, "u1", "mmo:bugfix", "the login page returns 500")));
    assert.ok(!pipeline(s, "u1"));
    assert.equal(projectPolicy(s), null, "nothing was written");
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

test("a project folder can switch workflows off, never on", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    mkdirSync(join(s.repo, ".sdlc"));
    writeFileSync(join(s.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "off" }));
    assert.doesNotMatch(context(await prompt(s, "p2", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
  const t = sandbox("existing", { routing: "off" });
  try {
    mkdirSync(join(t.repo, ".sdlc"));
    writeFileSync(join(t.repo, ".sdlc", "ambient.json"), JSON.stringify({ routing: "on" }));
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
    assert.equal((await run("pre-any", { session_id: "s1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } }, s)).stdout, "");
    assert.ok(denied(await skill(s, "s1", "mmo:bugfix", "x")), "the old route is gone");
  } finally { s.cleanup(); }
});

test("with no helper setting at all, a clear job starts: the workflows' helpers name their model in the plugin's agent files", { skip: SKIP ?? false }, async () => {
  // Until v0.8.3's pin (25 Sep) this was "cannot start: it needs a one-time setting, then a new chat". The live
  // desktop test hit exactly that on the first try; the pin removes the step for everyone.
  const s = sandbox("existing");
  try {
    const c = context(await prompt(s, "m1", "fix the /login endpoint returning 500 on missing password"));
    assert.match(c, /"mmo:bugfix"/, "the workflow's own check passes with nothing set, so it starts");
    assert.doesNotMatch(c, /one-time setting|--apply=routing|new chat/);
  } finally { s.cleanup(); }
});

test("setup, policy, revert, pass and the generic brownfield command are never started by the model", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "n1", "hello");
    for (const name of ["mmo:setup", "mmo:policy", "mmo:revert", "mmo:pass", "mmo:brownfield"]) {
      assert.ok(denied(await skill(s, "n1", name)), name);
    }
    assert.equal((await skill(s, "n1", "some-other-plugin:thing")).stdout, "", "other plugins' skills are not ours to judge");
  } finally { s.cleanup(); }
});

test("inside a workflow run, typed or started by routing, every zero-touch tool is refused (the batch write would get around the write contract)", { skip: SKIP ?? false }, async () => {
  // Independent review, 25 Sep: in a typed brownfield run with zero-touch on, write_files was stamped and allowed
  // and overwrote a file the run's write contract keeps off limits. 0.7.7 has no such tool; a run must not either.
  const s = sandbox("existing");
  try {
    const tool = (sid, name, input) => run("pre-mmo-tool", { session_id: sid, cwd: s.repo, tool_name: `mcp__plugin_mmo_model-dispatch__${name}`, tool_input: input }, s);
    await run("prompt-expansion", { session_id: "r1", cwd: s.repo, command_name: "mmo:bugfix", expansion_type: "slash_command" }, s);
    for (const [name, input] of [["write_files", { files: [{ path: "src/billing.js", content: "x" }] }], ["lookup", { terms: ["x"] }], ["write_files_from_specs", { files: [] }], ["job_result", { job_ids: [] }]]) {
      const r = await tool("r1", name, input);
      assert.ok(denied(r), `${name} in a typed run: ${r.stdout}`);
      assert.equal(r.json?.hookSpecificOutput?.updatedInput, undefined, "never stamped");
    }
    await prompt(s, "r2", "fix the /login endpoint returning 500 on missing password");
    assert.equal((await skill(s, "r2", "mmo:bugfix", "x")).stdout, "");
    assert.ok(denied(await tool("r2", "write_files", { files: [{ path: "src/a.js", content: "x" }] })), "and in a routed run");
  } finally { s.cleanup(); }
});

// ─── Independent review, 25 Sep: the causes a workflow cannot start, the start hook's timing, guard gaps ───

test("a workflow that cannot start says the real cause and the fix that works for it", { skip: SKIP ?? false }, async () => {
  const other = sandbox("existing");
  try {
    mkdirSync(join(other.repo, ".sdlc"));
    writeFileSync(join(other.repo, ".sdlc", "project.json"), JSON.stringify({ schema_version: 2, default_policy: "opus-plus-flash" }));
    const c = context(await prompt(other, "k2", "fix the /login endpoint returning 500 on missing password"));
    assert.doesNotMatch(c, /"mmo:bugfix"/, "this project's saved choice (an Opus 4.7 policy) wants helpers on another model than the plugin's agent files name");
    assert.match(c, /saved/);
    assert.doesNotMatch(c, /one-time setting|--apply=routing|the setting|new chat/, "no setting can fix it: the choice is the project's policy");
  } finally { other.cleanup(); }
  const broken = sandbox("existing");
  try {
    mkdirSync(join(broken.repo, ".sdlc"));
    writeFileSync(join(broken.repo, ".sdlc", "project.json"), "{not json");
    const c = context(await prompt(broken, "k3", "fix the /login endpoint returning 500 on missing password"));
    assert.doesNotMatch(c, /"mmo:bugfix"|--apply=routing/);
    assert.match(c, /\.sdlc\/project\.json/);
  } finally { broken.cleanup(); }
  // CLAUDE_CODE_SUBAGENT_MODEL_FORCE on makes Claude Code ignore the agent files' model; with nothing set the helpers
  // would follow the chat, so the workflow's own check refuses, and zero-touch passes on the check's own reason
  // rather than calling it an old saved choice.
  const forced = sandbox("existing");
  try {
    const c = context(await prompt(forced, "k5", "fix the /login endpoint returning 500 on missing password", { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" }));
    assert.doesNotMatch(c, /"mmo:bugfix"/);
    assert.match(c, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
    assert.doesNotMatch(c, /saved workflow choice is an older one/);
  } finally { forced.cleanup(); }
  const vendor = sandbox("existing", { routing_defaults: { policy: "opus-plus-flash-v38", auth: "vendor" } });
  try {
    const c = context(await prompt(vendor, "k4", "fix the /login endpoint returning 500 on missing password"));
    assert.match(c, /"mmo:bugfix"/, "under vendor the workflow skips its helpers'-model check, so routing does too");
    assert.match(c, /cost recording "vendor"/);
  } finally { vendor.cleanup(); }
});

test("a folder inside another project with no saved choice never gets one written into the outer project", { skip: SKIP ?? false }, async () => {
  const s = sandbox("new");
  try {
    execFileSync("git", ["init", "-q"], { cwd: s.repo });
    writeFileSync(join(s.repo, "notes.txt"), "x");
    execFileSync("git", ["add", "notes.txt"], { cwd: s.repo });
    const app = join(s.repo, "app");
    mkdirSync(app);
    const inner = { home: s.home, repo: app };
    const c = context(await run("prompt", { session_id: "e1", cwd: app, prompt: "build me a todo app with a React frontend" }, inner));
    assert.doesNotMatch(c, /"mmo:greenfield"/);
    assert.match(c, /inside another project/);
    assert.ok(!existsSync(join(s.repo, ".sdlc")) && !existsSync(join(app, ".sdlc")), "nothing written anywhere");
  } finally { s.cleanup(); }
});

test("a start is confirmed after the command ran even if the start hook never finished: the workflow is never left blocked", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "q1", "fix the /login endpoint returning 500 on missing password");
    // pre-skill timed out (Claude Code lets the call run); only the after-hook sees the command start.
    await run("post-skill", { session_id: "q1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix", args: "x" }, tool_response: { success: true } }, s);
    assert.ok(pipeline(s, "q1"));
    assert.equal((await run("pre-agent", { session_id: "q1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "mmo:orchestrator", prompt: "x" } }, s)).stdout, "", "the workflow's own agent runs");
    assert.equal((await run("pre-any", { session_id: "q1", cwd: s.repo, tool_name: "Bash", tool_input: { command: "npm test" } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

test("Guard A covers every tool that can change something, helpers included; tools that change nothing still run", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "h1", "fix the /login endpoint returning 500 on missing password");
    const any = (payload) => run("pre-any", { session_id: "h1", cwd: s.repo, ...payload }, s);
    for (const tool_name of ["Write", "Edit", "Bash", "NotebookEdit", "Agent", "mcp__github__create_or_update_file", "mcp__plugin_mmo_model-dispatch__execute_stage"]) {
      assert.ok(denied(await any({ tool_name, tool_input: {} })), `${tool_name} while the workflow waits to start`);
    }
    assert.ok(denied(await any({ tool_name: "Write", agent_id: "helper-1", tool_input: { file_path: join(s.repo, "a.js"), content: "x" } })), "a helper that was already running too");
    for (const tool_name of ["Read", "Glob", "Grep", "ToolSearch", "TodoWrite", "Skill"]) {
      assert.equal((await any({ tool_name, tool_input: {} })).stdout, "", `${tool_name} changes nothing`);
    }
    // Guard B: a helper cannot start the workflow for the chat, and a leading slash is the same command.
    assert.ok(denied(await run("pre-skill", { session_id: "h1", cwd: s.repo, agent_id: "helper-1", tool_name: "Skill", tool_input: { skill: "mmo:bugfix" } }, s)));
    assert.ok(!pipeline(s, "h1"));
    assert.ok(denied(await skill(s, "h1", "/mmo:refactor", "x")), "/mmo:refactor is mmo:refactor");
    assert.equal((await skill(s, "h1", "/mmo:bugfix", "x")).stdout, "", "and /mmo:bugfix starts the routed workflow");
    assert.ok(pipeline(s, "h1"));
  } finally { s.cleanup(); }
});

test("the chat's own starts are refused in any folder, even where the job would fit", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await prompt(s, "f1", "hello");
    assert.ok(denied(await skill(s, "f1", "mmo:bugfix", "x")), "a project job in a project: still not the chat's call");
    assert.ok(denied(await skill(s, "f1", "mmo:greenfield")), "a new-app build in a project");
    assert.ok(!pipeline(s, "f1"));
  } finally { s.cleanup(); }
  const n = sandbox("new");
  try {
    await prompt(n, "f2", "hello");
    assert.ok(denied(await skill(n, "f2", "mmo:greenfield")), "a new-app build in an empty folder: still not the chat's call");
    assert.ok(!pipeline(n, "f2"));
  } finally { n.cleanup(); }
});

test("the offer machinery is gone: nothing asks, keeps or accepts an offer", async () => {
  const flow = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));
  for (const name of ["isPlainYes", "askReason", "declinedInstruction", "readOffer", "writeOffer", "dropOffer"]) {
    assert.equal(flow[name], undefined, name);
  }
  const { ROUTING_UNSURE } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "config.mjs"));
  assert.equal(ROUTING_UNSURE, undefined, "no routing_unsure switch");
});

test("a typed command without the plugin's prefix is still a typed run: zero-touch stands down, nothing is routed or noted", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await run("prompt-expansion", { session_id: "sf1", cwd: s.repo, command_name: "bugfix", expansion_type: "slash_command" }, s);
    assert.equal(context(await prompt(s, "sf1", "/bugfix the login page returns 500")), "");
    assert.ok(pipeline(s, "sf1"));
    assert.equal(context(await prompt(s, "sf2", "/refactor extract the date helpers")), "", "the typed line alone is enough");
    assert.ok(pipeline(s, "sf2"));
  } finally { s.cleanup(); }
});

test("/clear starts a fresh conversation: an earlier run, route or started work no longer counts", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    await run("prompt-expansion", { session_id: "cl1", cwd: s.repo, command_name: "mmo:refactor", expansion_type: "slash_command" }, s);
    await run("post-write", { session_id: "cl1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.repo, "a.js"), content: "x" }, tool_response: { type: "create" } }, s);
    await run("session-start", { session_id: "cl1", cwd: s.repo, source: "clear" }, s);
    assert.ok(!pipeline(s, "cl1"));
    assert.match(context(await prompt(s, "cl1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
});

test("the control arm of a measurement changes nothing: no agent refusal, no model lock", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { lock_model: true });
  try {
    const env = { MMO_AMBIENT_ARM: "control" };
    assert.equal((await run("pre-agent", { session_id: "ca1", cwd: s.repo, tool_name: "Agent", tool_input: { subagent_type: "mmo:architect", prompt: "x" } }, s, env)).stdout, "");
    assert.equal((await run("pre-model-switch", { session_id: "ca1", cwd: s.repo, to_model: "claude-sonnet-5", requested_model: "sonnet" }, s, env)).stdout, "");
  } finally { s.cleanup(); }
});

test("what the person can see never names the plugin, a command, a settings path or a model the chat is not already on", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing", { lock_model: true });
  try {
    const lock = await run("pre-model-switch", { session_id: "pn1", cwd: s.repo, to_model: "claude-sonnet-5", requested_model: "sonnet" }, s);
    const text = lock.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.ok(text.length > 0, "the lock still refuses");
    assert.doesNotMatch(text, /mmo|ambient|\.json|lock_model|claude-/i);
    const shim = readFileSync(SHIM, "utf8");
    assert.doesNotMatch(shim.match(/systemMessage[^}]*/)?.[0] ?? "", /mmo|ambient/i, "the start-up line when Node.js is missing");
    const note = context(await prompt(s, "pn2", "hello there"));
    assert.match(note, /Keep the plugin, command names and model names out of what you say to the person/, "the chat note carries the wording rule too");
  } finally { s.cleanup(); }
});

test("started work means files inside the project changed since the chat began, however they changed; a write elsewhere is not work here", { skip: SKIP ?? false }, async () => {
  const s = sandbox("existing");
  try {
    execFileSync("git", ["init", "-q"], { cwd: s.repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "package.json"], { cwd: s.repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: s.repo });
    writeFileSync(join(s.repo, "old.js"), "x");
    execFileSync("git", ["add", "old.js"], { cwd: s.repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"], { cwd: s.repo });
    await run("session-start", { session_id: "ws1", cwd: s.repo, source: "startup" }, s);
    // A write outside the project is not work on it.
    await run("post-bash", { session_id: "ws1", cwd: s.repo, tool_name: "Bash", tool_input: { command: `git log > ${join(s.dir, "log.txt")}` }, tool_response: { stdout: "", stderr: "" } }, s);
    assert.match(context(await prompt(s, "ws1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    // A delete through Bash (no path the Bash parser counts as written) is still work: the project changed.
    await run("session-start", { session_id: "ws2", cwd: s.repo, source: "startup" }, s);
    rmSync(join(s.repo, "old.js"));
    assert.doesNotMatch(context(await prompt(s, "ws2", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
  } finally { s.cleanup(); }
});

test("a Write or Edit outside the project is not work on the project; inside it is", { skip: SKIP ?? false }, async () => {
  // Step 5 design, 25 Sep: the Bash rule counted only in-project paths (independent review), but Write and Edit
  // counted any path, so a note written elsewhere stopped a later job from routing.
  const s = sandbox("existing");
  try {
    await prompt(s, "wo1", "hi");
    await run("post-write", { session_id: "wo1", cwd: s.repo, tool_name: "Write", tool_input: { file_path: join(s.dir, "notes-elsewhere.md"), content: "x" }, tool_response: { type: "create" } }, s);
    await run("post-edit", { session_id: "wo1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.dir, "other.md"), old_string: "a", new_string: "b" }, tool_response: {} }, s);
    assert.match(context(await prompt(s, "wo1", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    const t = sandbox("existing");
    try {
      await prompt(t, "wo2", "hi");
      await run("post-edit", { session_id: "wo2", cwd: t.repo, tool_name: "Edit", tool_input: { file_path: join(t.repo, "package.json"), old_string: "shop", new_string: "shop2" }, tool_response: {} }, t);
      assert.doesNotMatch(context(await prompt(t, "wo2", "fix the /login endpoint returning 500 on missing password")), /"mmo:bugfix"/);
    } finally { t.cleanup(); }
  } finally { s.cleanup(); }
});
