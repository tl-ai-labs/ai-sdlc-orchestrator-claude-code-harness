/**
 * Zero-touch is its own plugin, and that plugin is the switch (29 Sep 2026). Until then zero-touch lived inside the
 * mmo plugin and was switched by a settings file in the home folder that nobody knew about; disabling the mmo plugin
 * would have switched off the /mmo: workflows with it. Now the marketplace offers two plugins: `mmo` (the workflows,
 * and all of zero-touch's code, hooks and tools) and `zero-touch`, which needs mmo and does one thing: at the start
 * of each chat it writes the chat's record, "this chat has zero-touch on". mmo acts only in a chat with that record
 * (lib/chat-mode.mjs). Enable zero-touch in Claude Code's plugin list and new chats are on; disable it and new chats
 * are off; the settings file no longer switches anything.
 *
 * Why the switch plugin holds no code of its own: Claude Code gives each plugin its own copy of any file it links to
 * at install, so a zero-touch plugin carrying the server would need a second build of it on every machine.
 *
 * No network, no model. Each case has its own MMO_HOME and project folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-plugin-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n'); // an existing project, so a bug-fix message is a job
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sh(script, event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const p = spawn("sh", event ? [script, event] : [script], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}
const ztStart = (s, sid, source = "startup", env) => sh(START, null, { session_id: sid, cwd: s.repo, source }, s, env);
const mmo = (s, event, payload, env) => sh(SHIM, event, payload, s, env);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
// What "zero-touch acts" shows (0.8.4, routing only): a message the rules recognise as a job gets the instruction to
// start its workflow. Routing asks the workflows' own model check, which needs the built server.
const ROUTED = /"mmo:bugfix"/;
const JOB = "fix the /login endpoint returning 500 on missing password";
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const SKIP = serverBuilt();

test("the marketplace offers zero-touch as its own plugin: it needs mmo, and its only hook is the chat's start", () => {
  const market = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
  const entries = Object.fromEntries(market.plugins.map((p) => [p.name, p]));
  assert.equal(entries.mmo?.source, "./plugin");
  assert.equal(entries["zero-touch"]?.source, "./zero-touch");
  const manifest = readJson(join(ZT, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "zero-touch");
  assert.ok((manifest.dependencies ?? []).includes("mmo"), "installing zero-touch brings mmo; mmo cannot be disabled under it");
  assert.equal(manifest.version, readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).version, "the two plugins ship together");
  assert.equal(entries["zero-touch"].version, manifest.version);
  const hooks = readJson(join(ZT, "hooks", "hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart"], "the switch plugin does nothing but mark the chat at its start");
  assert.match(JSON.stringify(hooks.SessionStart), /start-chat\.sh/);
  assert.equal(readJson(join(ROOT, "plugin", ".claude-plugin", "plugin.json")).dependencies, undefined, "mmo never needs zero-touch");
});

test("its start hook marks a chat at a fresh start only, and mmo reads exactly that record", async () => {
  const s = sandbox();
  try {
    const env = { MMO_HOME: s.home };
    const r = await ztStart(s, "c1");
    assert.equal(r.code, 0);
    assert.ok(r.json?.systemMessage, "the person sees one line (0.8.4); see the indicator test");
    assert.equal(r.json?.hookSpecificOutput, undefined, "the model is told nothing");
    assert.equal(chatMode("c1", env), "on");
    await ztStart(s, "c2", "resume");
    assert.equal(chatMode("c2", env), null, "a reopened chat that never started with zero-touch stays off");
    await ztStart(s, "c3", "compact");
    assert.equal(chatMode("c3", env), null);
    await ztStart(s, "c3", "clear");
    assert.equal(chatMode("c3", env), "on", "/clear begins a fresh conversation");
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

test("with the zero-touch plugin disabled, nothing acts in a chat, whatever the old settings file says", { skip: SKIP ?? false }, async () => {
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

test("the person sees the start message at a fresh start: workflow mode, what it does, the policy in use and how to turn it off; the model sees nothing", async () => {
  const s = sandbox();
  try {
    for (const source of ["startup", "clear"]) {
      const r = await ztStart(s, `i-${source}`, source);
      const msg = r.json?.systemMessage ?? "";
      assert.match(msg, /^Zero-touch workflow mode is on for this chat\./, source);
      assert.match(msg, /new app.*bug fix.*docs/i, "what it does, in the person's words");
      assert.match(msg, /Anything else is a normal Claude chat\./);
      assert.match(msg, /Policy: opus-plus-flash-v38 \(the default: Opus 5 plans and reviews, Flash 3\.8 types\)\. To use your own, put a policy file named routing-policy\.yaml in this folder; it applies to the next workflow\./);
      assert.doesNotMatch(msg, /\/mmo:/, "no plugin command to learn");
      assert.match(msg, /put off in \S+mode and start a new chat/, "how to turn it off");
      assert.match(msg, /until \/clear or a new chat/);
      assert.equal(r.json?.hookSpecificOutput, undefined, "the model is given nothing");
    }
    assert.equal((await ztStart(s, "i-off", "startup", { MMO_AMBIENT: "off" })).stdout, "", "switched off for one run: nothing is shown");
    assert.equal((await ztStart(s, "i-obs", "startup", { MMO_AMBIENT: "observe" })).stdout, "", "a measuring run that only records: nothing is shown");
  } finally { s.cleanup(); }
});

test("the start message names the policy the chat's workflows will use: the project's own, else the person's default", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.home, "ambient.json"), JSON.stringify({ routing_defaults: { policy: "opus-plus-flash-v37" } }));
    assert.match((await ztStart(s, "p-home")).json.systemMessage, /Policy: opus-plus-flash-v37\. To use your own/, "the person's default");
    mkdirSync(join(s.repo, ".sdlc"), { recursive: true });
    writeFileSync(join(s.repo, ".sdlc", "project.json"), JSON.stringify({ default_policy: "opus-only-v5" }));
    assert.match((await ztStart(s, "p-project")).json.systemMessage, /Policy: opus-only-v5\. To use your own/, "the project's saved choice wins");
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n");
    assert.match((await ztStart(s, "p-file")).json.systemMessage, /Policy: this project's routing-policy\.yaml\. To change it, edit that file; it applies to the next workflow\./, "a policy file in the project wins over names");
  } finally { s.cleanup(); }
});

test("the mode file: off gives no zero-touch and says so; a missing or unknown value is workflow mode", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.home, "mode"), "off\n");
    const off = await ztStart(s, "m-off");
    assert.match(off.json?.systemMessage ?? "", /^Zero-touch is off for this chat\. To turn it on, put a in \S+mode and start a new chat\.$/);
    assert.equal(chatMode("m-off", { MMO_HOME: s.home }), null, "the chat is not marked: nothing of zero-touch acts in it");
    writeFileSync(join(s.home, "mode"), "a\n");
    assert.match((await ztStart(s, "m-a")).json.systemMessage, /^Zero-touch workflow mode is on/);
    writeFileSync(join(s.home, "mode"), "something\n");
    assert.match((await ztStart(s, "m-x")).json.systemMessage, /^Zero-touch workflow mode is on/, "an unknown value never switches zero-touch off");
  } finally { s.cleanup(); }
});

test("after a compaction or when a chat is reopened, the same start message shows again and the chat keeps its mode", async () => {
  const s = sandbox();
  try {
    await ztStart(s, "c-on", "startup");
    writeFileSync(join(s.home, "mode"), "off\n");
    for (const source of ["compact", "resume"]) {
      const r = await ztStart(s, "c-on", source);
      assert.match(r.json?.systemMessage ?? "", /^Zero-touch workflow mode is on/, `${source}: the mode the chat started with, not the file's new value`);
      assert.equal(chatMode("c-on", { MMO_HOME: s.home }), "on");
    }
    assert.equal((await ztStart(s, "c-never", "compact")).stdout, "", "a chat that started without zero-touch shows nothing");
  } finally { s.cleanup(); }
});
