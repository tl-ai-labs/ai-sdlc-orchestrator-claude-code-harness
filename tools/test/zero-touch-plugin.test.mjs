/**
 * Zero-touch is its own plugin, and its settings are the person's clicks in the settings box (1 Oct 2026).
 *
 * The history this test guards: until 29 Sep zero-touch lived inside mmo and was switched by a settings file nobody
 * knew about; from 29 Sep the zero-touch plugin was the switch and a mode file in the home folder chose the mode; from
 * 1 Oct a person never edits a file or types a command: they type "change zero-touch settings" (any wording) and pick
 * in Claude's question box (zero-touch/scripts/boxes.mjs, settings-hook.mjs), and the plugin keeps the choices in its
 * own data folder (settings.mjs). The mode file and the hand-off settings in ambient.json are not read any more.
 *
 * What stays: the zero-touch plugin marks a chat at its start (a new chat, /clear, a fork), mmo acts only in a chat so
 * marked (plugin/scripts/ambient/lib/chat-mode.mjs), a chat keeps its marks for its whole life, and the plugin holds
 * none of mmo's code.
 *
 * No network, no model. Each case has its own home, plugin data folder and project folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
const { writeGoogleLogin, writeZtSettings, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const M = await import(join(ZT, "scripts", "messages.mjs"));
const B = await import(join(ZT, "scripts", "boxes.mjs"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function sandbox({ settings = { mode: "workflows" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-plugin-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n'); // an existing project, so a bug-fix message is a job
  if (settings) writeZtSettings(home, settings);
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A complete gcloud login file in the test home, so the Google check says "connected". */
function googleLogin(s, body = { type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "z" }) {
  mkdirSync(join(s.home, ".config", "gcloud"), { recursive: true });
  writeFileSync(join(s.home, ".config", "gcloud", "application_default_credentials.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function sh(script, event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PLUGIN_DATA: ztData(home), CLAUDE_PROJECT_DIR: repo, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const p = spawn("sh", event ? [script, event] : [script], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "" });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}
const ztStart = (s, sid, source = "startup", env) => sh(START, null, { session_id: sid, cwd: s.repo, source }, s, env);
const mmo = (s, event, payload, env) => sh(SHIM, event, payload, s, env);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
// What "zero-touch acts" shows (routing): a message the rules recognise as a job gets the instruction to start its
// workflow. Routing asks the workflows' own model check, which needs the built server.
const ROUTED = /"mmo:bugfix"/;
const JOB = "fix the /login endpoint returning 500 on missing password";
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();

test("the marketplace offers zero-touch as its own plugin: it needs mmo, and its hooks are the chat's start and the settings box", () => {
  const market = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
  const entries = Object.fromEntries(market.plugins.map((p) => [p.name, p]));
  assert.equal(entries.mmo?.source, "./plugin");
  assert.equal(entries["zero-touch"]?.source, "./zero-touch");
  const manifest = readJson(join(ZT, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "zero-touch");
  assert.ok((manifest.dependencies ?? []).includes("mmo"), "installing zero-touch brings mmo; mmo cannot be disabled under it");
  assert.equal(manifest.version, readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).version, "the two plugins ship together");
  assert.equal(entries["zero-touch"].version, manifest.version);
  assert.equal(manifest.userConfig, undefined, "no plugin settings form: the desktop app cannot show one; the box is the one place");
  assert.doesNotMatch(manifest.description, /~\/\.mmo-ambient|ambient\.json|\/mmo:/, "the description names no file and no command");
  const hooks = readJson(join(ZT, "hooks", "hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "UserPromptSubmit"]);
  assert.match(JSON.stringify(hooks.SessionStart), /start-chat\.sh/);
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) assert.match(JSON.stringify(hooks[ev]), /settings\.sh/);
  assert.deepEqual(hooks.PreToolUse.map((h) => h.matcher).sort(), ["*", "AskUserQuestion"]);
  assert.deepEqual(hooks.PostToolUse.map((h) => h.matcher), ["AskUserQuestion"]);
  assert.equal(readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).dependencies, undefined, "mmo never needs zero-touch");
});

test("its start hook marks a chat at a fresh start only (a new chat, /clear, a fork), and mmo reads exactly that record", async () => {
  const s = sandbox();
  try {
    const env = { MMO_HOME: s.home };
    const r = await ztStart(s, "c1");
    assert.equal(r.code, 0);
    assert.ok(r.message, "the person sees the start message");
    assert.equal(chatMode("c1", env), "on");
    await ztStart(s, "c2", "resume");
    assert.equal(chatMode("c2", env), null, "a reopened chat that never started with zero-touch stays off");
    await ztStart(s, "c3", "compact");
    assert.equal(chatMode("c3", env), null);
    for (const source of ["clear", "fork"]) {
      await ztStart(s, `c-${source}`, source);
      assert.equal(chatMode(`c-${source}`, env), "on", `${source} is a new chat id: it is marked afresh`);
    }
    await ztStart(s, "c4", "startup", { MMO_AMBIENT: "observe" });
    assert.equal(chatMode("c4", env), "observe", "a measuring setup can still ask for observe");
    await ztStart(s, "c1", "clear", { MMO_AMBIENT: "off" });
    assert.equal(chatMode("c1", env), null, "an explicit off wins");
    await ztStart(s, "a/../../x y", "startup");
    assert.equal(chatMode("a/../../x y", env), "on", "an unusual chat id lands where mmo looks for it, never outside the records");
    assert.ok(!existsSync(join(s.dir, "x y")));
    assert.equal((await sh(START, null, "not json", s)).code, 0, "never fails the chat's start");
  } finally { s.cleanup(); }
});

test("the settings decide the chat: Workflows marks it with its models, Hand-off with its typists, Off marks nothing and says so", async () => {
  const s = sandbox();
  try {
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    await ztStart(s, "w");
    assert.equal(chatMode("w", { MMO_HOME: s.home }), "on");
    assert.equal(readJson(join(s.home, "sessions", "w", "workflow.json")).policy, "opus-plus-sonnet");
    writeZtSettings(s.home, { mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat" } });
    await ztStart(s, "h");
    assert.equal(chatMode("h", { MMO_HOME: s.home }), "b");
    const stamp = readJson(join(s.home, "sessions", "h", "handoff.json"));
    assert.deepEqual(stamp.typists, { documents: { typist: "flash", policy: "opus-plus-flash-v38" }, tests: { typist: "sonnet", policy: "opus-plus-sonnet" }, repeats: { typist: "chat", policy: null } });
    writeZtSettings(s.home, { mode: "off" });
    const off = await ztStart(s, "o");
    assert.equal(chatMode("o", { MMO_HOME: s.home }), null, "an Off chat is not marked: nothing of zero-touch's work acts in it");
    assert.equal(off.message, M.offMessage());
    assert.match(off.note, /Zero-touch settings: if the person asks to change how zero-touch works/, "Off still listens for the settings");
    // The files the old designs read switch nothing now.
    writeFileSync(join(s.home, "mode"), "b\n");
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ handoff: { policy: "opus-only-v5" }, routing_defaults: { policy: "opus-only-v5" } }));
    await ztStart(s, "o2");
    assert.equal(chatMode("o2", { MMO_HOME: s.home }), null, "the old mode file is not read");
  } finally { s.cleanup(); }
});

test("the Workflows start message: the jobs, the approval steps, the cost, the models, how to change; nothing to edit, no command", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    for (const source of ["startup", "clear"]) {
      const r = await ztStart(s, `i-${source}`, source);
      assert.equal(r.message, M.workflowMessage({ policy: "opus-plus-flash-v38" }), source);
      assert.match(r.message, /^Zero-touch is on in this chat: Workflows mode\./);
      assert.match(r.message, /waits for your approval/);
      assert.match(r.message, /costs more than a normal chat/);
      assert.match(r.message, /Opus 5 plans and reviews; Google's Flash 3\.8 writes the code/);
      assert.match(r.message, /type "change zero-touch settings"/);
      assert.doesNotMatch(r.message, /\/mmo:|~\/\.mmo-ambient|ambient\.json|policy file|opus-plus/, "no command, no file, no policy code");
      // Claude gets the settings note, with the mode box as it stands (the choice in force marked).
      assert.equal(r.note, M.settingsNote(B.modeBox({ mode: "workflows" })));
      assert.match(r.note, /\(your current choice\)/);
    }
    assert.equal((await ztStart(s, "i-off", "startup", { MMO_AMBIENT: "off" })).stdout, "", "switched off for one run: nothing is shown");
    assert.equal((await ztStart(s, "i-obs", "startup", { MMO_AMBIENT: "observe" })).stdout, "", "a measuring run that only records: nothing is shown");
  } finally { s.cleanup(); }
});

test("a project's own routing-policy.yaml and saved choice are not used by zero-touch; the start message says the file is there", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-only-v5" } });
    mkdirSync(join(s.repo, ".sdlc"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "project.json"), JSON.stringify({ default_policy: "opus-plus-flash-v37" }));
    const saved = await ztStart(s, "p-saved");
    assert.match(saved.message, /Your models: Opus 5 does everything\./, "the person's pick, not the folder's saved choice");
    assert.equal(readJson(join(s.home, "sessions", "p-saved", "workflow.json")).policy, "opus-only-v5");
    assert.doesNotMatch(saved.message, /routing-policy\.yaml/);
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n");
    const file = await ztStart(s, "p-file");
    assert.match(file.message, /Your models: Opus 5 does everything\./, "still the person's pick");
    assert.ok(file.message.includes(M.folderPolicyLine()), "one line says the folder's file is not followed");
  } finally { s.cleanup(); }
});

test("Google: not connected, a broken login, and a working one, read exactly as mmo's own setup check reads them", async () => {
  const s = sandbox();
  try {
    rmSync(join(s.home, ".config"), { recursive: true, force: true }); // this person has not connected Google
    const none = await ztStart(s, "g-none");
    assert.match(none.message, /Google's Flash 3\.8 can't be used yet, because this computer isn't connected to Google\. Until it is, workflows won't start\./);
    googleLogin(s, { type: "authorized_user", client_id: "x" }); // missing the secret and the refresh token
    const broken = await ztStart(s, "g-broken");
    assert.match(broken.message, /A Google login is set up on this computer but can't be used/);
    assert.match(broken.message, /gcloud auth application-default login/);
    googleLogin(s);
    const WARN = /can't be used|isn't connected to Google/;
    assert.doesNotMatch((await ztStart(s, "g-ok")).message, WARN, "a complete login: nothing to say");
    // A project name alone is not a login (mmo's rule); an API key is one.
    rmSync(join(s.home, ".config"), { recursive: true, force: true });
    assert.match((await ztStart(s, "g-project", "startup", { GOOGLE_CLOUD_PROJECT: "p1" })).message, /isn't connected to Google/);
    assert.doesNotMatch((await ztStart(s, "g-key", "startup", { GEMINI_API_KEY: "k" })).message, WARN);
    // Models without Flash need no Google.
    writeZtSettings(s.home, { mode: "workflows", workflows: { models: "opus-plus-sonnet" } });
    assert.doesNotMatch((await ztStart(s, "g-sonnet")).message, WARN);
  } finally { s.cleanup(); }
});

test("the first chat after install asks first; a run with no screen does nothing until settings exist; an unreadable file uses the standard ones", async () => {
  const s = sandbox({ settings: null });
  try {
    writeGoogleLogin(s.home);
    const first = await ztStart(s, "f1");
    assert.equal(first.message, M.welcomeMessage());
    assert.equal(first.note, M.firstRunNote(B.modeBox(null, { first: true })));
    assert.equal(chatMode("f1", { MMO_HOME: s.home }), null, "nothing acts until the settings are chosen");
    assert.ok(existsSync(join(s.home, "sessions", "f1", "zt_setup.json")), "the chat waits for its settings box");
    const script = await ztStart(s, "f2", "startup", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    assert.equal(script.message, M.noSettingsMessage(), "claude -p cannot show a box: it does nothing and says where to choose");
    assert.ok(!existsSync(join(s.home, "sessions", "f2", "zt_setup.json")), "no hold in a run with no screen");
    assert.equal(chatMode("f2", { MMO_HOME: s.home }), null);
    mkdirSync(ztData(s.home), { recursive: true });
    writeFileSync(join(ztData(s.home), "settings.json"), "{ not json");
    const bad = await ztStart(s, "f3");
    assert.equal(chatMode("f3", { MMO_HOME: s.home }), "on", "the standard settings: Workflows");
    assert.ok(bad.message.includes(M.unreadableLine()));
  } finally { s.cleanup(); }
});

test("after a compaction or when a chat is reopened, the same start message shows again and the chat keeps its mode, whatever was saved since", async () => {
  const s = sandbox();
  try {
    googleLogin(s);
    const started = await ztStart(s, "c-on", "startup");
    writeZtSettings(s.home, { mode: "off" });
    for (const source of ["compact", "resume"]) {
      const r = await ztStart(s, "c-on", source);
      assert.equal(r.message, started.message, `${source}: the mode the chat started with, not the new settings`);
      assert.equal(chatMode("c-on", { MMO_HOME: s.home }), "on");
      assert.ok(r.note.includes("Zero-touch settings:"), "Claude gets the settings note again (a compaction drops it)");
    }
    const off = await ztStart(s, "c-off", "startup");
    assert.equal((await ztStart(s, "c-off", "compact")).message, off.message, "an Off chat shows its message again too");
    const never = await ztStart(s, "c-never", "compact");
    assert.equal(never.message, "", "a chat that started without zero-touch shows nothing");
  } finally { s.cleanup(); }
});

test("a backstop, never an alarm: mmo switched off or its folder gone says so; anything unreadable, or a setup without mmo listed, is fine", async () => {
  const s = sandbox();
  try {
    const claudeDir = join(s.home, ".claude");
    mkdirSync(join(claudeDir, "plugins"), { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@tilicho-ai-labs": false, "zero-touch@tilicho-ai-labs": true } }));
    const off = await ztStart(s, "b1");
    assert.equal(off.message, M.mmoMissingMessage());
    assert.equal(chatMode("b1", { MMO_HOME: s.home }), null);
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ enabledPlugins: { "mmo@old-market": false, "mmo@tilicho-ai-labs": true } }));
    assert.equal(chatMode("b1", { MMO_HOME: s.home }), null);
    await ztStart(s, "b2");
    assert.equal(chatMode("b2", { MMO_HOME: s.home }), "on", "one mmo on is enough: an old entry switched off is not an alarm");
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "mmo@m": [{ installPath: join(s.dir, "gone") }] } }));
    assert.equal((await ztStart(s, "b3")).message, M.mmoMissingMessage(), "installed at a folder that no longer exists");
    writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "zero-touch@m": [{ installPath: s.dir }] } }));
    await ztStart(s, "b4");
    assert.equal(chatMode("b4", { MMO_HOME: s.home }), "on", "mmo not listed at all (a developer's --plugin-dir): fine");
  } finally { s.cleanup(); }
});

test("with the zero-touch plugin disabled, nothing acts in a chat, whatever the old settings files say", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ mode: "on" })); // the old switch: no longer one
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" });
    assert.equal(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" })), "", "nothing is routed");
    const skill = await mmo(s, "pre-skill", { session_id: "c1", cwd: s.repo, tool_name: "Skill", tool_input: { skill: "mmo:bugfix" } });
    assert.equal(skill.stdout, "", "nothing is refused: the chat may start a workflow as on 0.7.7");
  } finally { s.cleanup(); }
});

test("with it enabled the chat acts even when mmo's start hook ran first (both start hooks run at once): mmo's start work runs at the first prompt", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" }); // mmo first: no record yet
    await ztStart(s, "c1");                                                                // then zero-touch marks the chat
    assert.match(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" })), ROUTED);
    const events = readFileSync(join(s.home, "sessions", "c1", "events.jsonl"), "utf8");
    assert.match(events, /"type":"session\.start"/, "the chat's start is logged once, late");
  } finally { s.cleanup(); }
});

test("a developer or measuring setup can still switch it for one run with MMO_AMBIENT, without the zero-touch plugin", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await mmo(s, "session-start", { session_id: "c1", cwd: s.repo, source: "startup" }, { MMO_AMBIENT: "on" });
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on");
    assert.match(context(await mmo(s, "prompt", { session_id: "c1", cwd: s.repo, prompt: JOB, prompt_id: "p1" }, { MMO_AMBIENT: "on" })), ROUTED);
    // Both plugins' hooks run in the chat's one environment, so an explicit off reaches the zero-touch hook too.
    await ztStart(s, "c2", "startup", { MMO_AMBIENT: "off" });
    await mmo(s, "session-start", { session_id: "c2", cwd: s.repo, source: "startup" }, { MMO_AMBIENT: "off" });
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), null, "an explicit off wins over the plugin");
    assert.equal(context(await mmo(s, "prompt", { session_id: "c2", cwd: s.repo, prompt: JOB, prompt_id: "p2" }, { MMO_AMBIENT: "off" })), "");
  } finally { s.cleanup(); }
});

test("Node.js missing: both plugins' shell scripts say it once per computer, in the same words, exactly as printed", () => {
  // Run, not read (1 Oct 2026): the text once sat inside single quotes in the scripts, and its apostrophes ("can't")
  // ended the quoting, so the person saw "cantrunonthiscomputer". A source-text check passed; the printed text did not.
  const dir = mkdtempSync(join(tmpdir(), "zt-no-node-"));
  try {
    // A PATH with the shell's tools and no node: a folder holding links to only what the scripts use.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["sh", "mkdir", "dirname", "printf", "cat", "head", "sed"]) {
      const found = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find((f) => existsSync(f));
      if (found) symlinkSync(found, join(bin, tool));
    }
    for (const [name, script, arg] of [["zero-touch's start script", START, []], ["mmo's hook script", SHIM, ["session-start"]]]) {
      const home = join(dir, name.replace(/\W+/g, "-"));
      mkdirSync(home);
      const run = () => spawnSync("/bin/sh", [script, ...arg], { input: "{}", env: { PATH: bin, HOME: home, MMO_HOME: home }, encoding: "utf8" });
      const first = run();
      assert.equal(first.status, 0, `${name}: exits 0`);
      assert.deepEqual(JSON.parse(first.stdout), { systemMessage: M.NODE_MISSING }, `${name}: the words, exactly`);
      assert.equal(run().stdout, "", `${name}: said once per computer`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(readFileSync(START, "utf8") + readFileSync(SHIM, "utf8"), /Cost-saving mode|Starting workflows from plain requests is on/, "the old names are gone");
});
