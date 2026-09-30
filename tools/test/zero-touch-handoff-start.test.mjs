/**
 * Zero-touch hand-off mode, the chat's start.
 *
 * One zero-touch plugin carries two modes, chosen in the person's mode file `<MMO_HOME>/mode`: `a` (workflows from
 * plain words, the default) and `b` (hand-off: the chat's own model does the development; new docs, specs, plans,
 * tests and repeated edits go to the hand-off policy's model). A hand-off chat has two settings, in the person's
 * `<MMO_HOME>/ambient.json`: `handoff.chat_model`, the model the chat is pinned to, and `handoff.policy`, the policy
 * whose models do the hand-offs.
 *
 * Everything is read ONCE, when the chat starts, and stamped on the chat (`sessions/<chat id>/chat_mode` and
 * `handoff.json`): a setting changed in the middle of a chat would leave the chat's start note, its no-switching
 * guard and its hand-offs disagreeing with each other, and would split one chat's costs across two sets of models.
 * A change reaches the next new chat (or /clear).
 *
 * At the start the person sees a message (the hook's `systemMessage`) and the chat's model gets a note with the
 * hand-off rules (the hook's `additionalContext`). A compaction drops that note from what the model reads, so both
 * are given again after a compaction and when a chat is reopened, from the stamp, never from the files.
 *
 * Every case runs the real start hook through its shell script with its own MMO_HOME and project folder. No network,
 * no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const START = join(ROOT, "zero-touch", "hooks", "start-chat.sh");
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function sandbox({ mode = "b" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-start-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  if (mode) writeFileSync(join(home, "mode"), `${mode}\n`);
  // No organisation settings file unless a test writes one.
  return { dir, home, repo, managed: join(dir, "managed-settings.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function start(s, sid, { source = "startup", model, env = {} } = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PROJECT_DIR: s.repo, MMO_MANAGED_SETTINGS: s.managed, ...env };
    const p = spawn("sh", [START], { cwd: s.repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "" });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify({ session_id: sid, cwd: s.repo, source, ...(model ? { model } : {}) }));
  });
}
const stamp = (s, sid) => readJson(join(s.home, "sessions", sid, "handoff.json"));
const settings = (s, value) => writeFileSync(join(s.home, "ambient.json"), JSON.stringify(value));

test("mode b: the chat is marked for hand-off, its settings are stamped on it, the person sees the start message and the model gets the rules note", async () => {
  const s = sandbox();
  try {
    for (const source of ["startup", "clear"]) {
      const sid = `b-${source}`;
      const r = await start(s, sid, { source });
      assert.equal(r.code, 0);
      assert.equal(chatMode(sid, { MMO_HOME: s.home }), "b", source);
      const st = stamp(s, sid);
      assert.equal(st.chat_model, "claude-opus-5", "the shipped default");
      assert.equal(st.policy, "opus-plus-flash-v38", "the shipped default");
      assert.equal(st.policy_file, null);
      assert.equal(st.pin, "default");

      assert.match(r.message, /^Zero-touch hand-off mode is on for this chat\./, source);
      assert.match(r.message, /This chat's model does the development itself\./);
      assert.match(r.message, /docs, specs, plans, tests and the same change repeated across files/i, "what is handed off, in the person's words");
      assert.match(r.message, /Chat model: claude-opus-5\./);
      assert.match(r.message, /Hand-off policy: opus-plus-flash-v38 \(the default: Flash 3\.8 does the typing\)\./);
      assert.match(r.message, /handoff\.chat_model and handoff\.policy in \S+ambient\.json; a change applies from the next new chat/, "where the two settings live, and when a change applies");
      assert.match(r.message, /A workflow starts only when you type its command/);
      assert.match(r.message, /put a \(workflows from plain words\) or off in \S+mode and start a new chat/, "how to leave this mode");
      assert.match(r.message, /until \/clear or a new chat/);

      assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(r.note, /hand-off mode/);
      for (const tool of ["write_document", "write_tests_from_cases", "repeat_edit_across_files"]) assert.match(r.note, new RegExp(tool), `the note names ${tool}`);
      assert.match(r.note, /only when the person types its command/, "no workflow from plain words");
    }
  } finally { s.cleanup(); }
});

test("the two settings are read once: a change, or a new mode, reaches the next new chat, never a chat that is open", async () => {
  const s = sandbox();
  try {
    settings(s, { handoff: { chat_model: "claude-sonnet-5", policy: "opus-plus-sonnet" } });
    const first = await start(s, "c1");
    assert.deepEqual([stamp(s, "c1").chat_model, stamp(s, "c1").policy, stamp(s, "c1").pin], ["claude-sonnet-5", "opus-plus-sonnet", "setting"]);
    assert.match(first.message, /Chat model: claude-sonnet-5\./);
    assert.match(first.message, /Hand-off policy: opus-plus-sonnet\./);

    settings(s, { handoff: { chat_model: "claude-opus-5", policy: "opus-only-v5" } });
    writeFileSync(join(s.home, "mode"), "a\n");
    for (const source of ["compact", "resume"]) {
      const again = await start(s, "c1", { source });
      assert.equal(chatMode("c1", { MMO_HOME: s.home }), "b", `${source}: the mode the chat started with`);
      assert.match(again.message, /^Zero-touch hand-off mode is on/, source);
      assert.match(again.message, /Chat model: claude-sonnet-5\./, "the stamped model, not the file's new value");
      assert.match(again.message, /Hand-off policy: opus-plus-sonnet\./, "the stamped policy");
      assert.match(again.note, /hand-off mode/, `${source}: the rules note is given again, since a compaction drops it`);
      assert.equal(stamp(s, "c1").policy, "opus-plus-sonnet");
    }
    await start(s, "c2");
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), "on", "a new chat takes the new mode");
    writeFileSync(join(s.home, "mode"), "b\n");
    await start(s, "c1", { source: "clear" });
    assert.deepEqual([stamp(s, "c1").chat_model, stamp(s, "c1").policy], ["claude-opus-5", "opus-only-v5"], "/clear begins a fresh conversation: the settings are read again");
  } finally { s.cleanup(); }
});

test("a workflow-mode chat gets no rules note, at its start or after a compaction, and no hand-off stamp", async () => {
  const s = sandbox({ mode: "a" });
  try {
    for (const source of ["startup", "compact", "resume"]) {
      const r = await start(s, "a1", { source });
      assert.match(r.message, /^Zero-touch workflow mode is on/, source);
      assert.equal(r.json.hookSpecificOutput, undefined, `${source}: the model is given nothing`);
    }
    assert.throws(() => stamp(s, "a1"), "no hand-off stamp in a workflow-mode chat");
  } finally { s.cleanup(); }
});

test("the start message says whether the chat is on its pinned model, as far as the start moment tells", async () => {
  const s = sandbox();
  try {
    const on = await start(s, "m1", { model: "claude-opus-5[1m]" });
    assert.match(on.message, /Chat model: claude-opus-5\. This chat is on it; switching to another model is refused in this mode\./, "the 1M-context tag is the same model");
    const other = await start(s, "m2", { model: "claude-sonnet-5" });
    assert.match(other.message, /Chat model: claude-opus-5\. This chat is on claude-sonnet-5: type \/model claude-opus-5\./);
    const unknown = await start(s, "m3");
    assert.match(unknown.message, /Chat model: claude-opus-5\. If this chat is on another model, type \/model claude-opus-5\./, "Claude Code does not always say which model a chat starts on");
    assert.equal(readFileSync(join(s.home, "sessions", "m2", "model_now"), "utf8"), "claude-sonnet-5", "the chat's model is kept for the lines that follow");
    // After a compaction the chat's current model is what counts, not the one it started on.
    const later = await start(s, "m2", { source: "compact", model: "claude-opus-5" });
    assert.match(later.message, /This chat is on it;/);
  } finally { s.cleanup(); }
});

test("a project's own policy file wins over handoff.policy, as it does for workflows", async () => {
  const s = sandbox();
  try {
    settings(s, { handoff: { policy: "opus-plus-sonnet" } });
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n");
    const r = await start(s, "p1");
    assert.equal(stamp(s, "p1").policy_file, join(s.repo, "routing-policy.yaml"));
    assert.match(r.message, /Hand-off policy: this project's routing-policy\.yaml \(it wins over handoff\.policy\)\./);
  } finally { s.cleanup(); }
});

test("a setting that is not a model id or a policy name falls back to the default, and the message says so", async () => {
  const s = sandbox();
  try {
    settings(s, { handoff: { chat_model: "opus", policy: "../../etc/passwd" } });
    const r = await start(s, "bad");
    assert.deepEqual([stamp(s, "bad").chat_model, stamp(s, "bad").policy, stamp(s, "bad").pin], ["claude-opus-5", "opus-plus-flash-v38", "default"]);
    assert.match(r.message, /handoff\.chat_model there is not an exact model id \(for example claude-opus-5\), so the default is used\./, "an alias would follow whichever model is newest");
    assert.match(r.message, /handoff\.policy there is not a policy name, so the default is used\./);
    settings(s, "not an object");
    assert.equal(stamp(s, (await start(s, "bad2"), "bad2")).policy, "opus-plus-flash-v38", "an unreadable file is the defaults");
  } finally { s.cleanup(); }
});

test("an organisation's pinned model wins over the person's setting, and the chat is not asked to switch", async () => {
  const s = sandbox();
  try {
    settings(s, { handoff: { chat_model: "claude-sonnet-5" } });
    writeFileSync(s.managed, JSON.stringify({ model: "claude-opus-5" }));
    const exact = await start(s, "o1", { model: "claude-sonnet-5" });
    assert.deepEqual([stamp(s, "o1").chat_model, stamp(s, "o1").pin], ["claude-opus-5", "admin"]);
    assert.match(exact.message, /Chat model: claude-opus-5, set by your organisation\./);
    assert.doesNotMatch(exact.message, /\/model/, "the organisation's setting decides; nothing to type");
    // An alias cannot be compared with a model id, so nothing is pinned by this plugin: the organisation's own
    // setting is what holds the chat.
    writeFileSync(s.managed, JSON.stringify({ model: "opus" }));
    const alias = await start(s, "o2");
    assert.deepEqual([stamp(s, "o2").chat_model, stamp(s, "o2").pin], [null, "admin"]);
    assert.match(alias.message, /Chat model: opus, set by your organisation\./);
  } finally { s.cleanup(); }
});

test("the mode file is read whatever its case or spacing; a one-run override still wins over it", async () => {
  const s = sandbox({ mode: null });
  try {
    writeFileSync(join(s.home, "mode"), "  B \n");
    assert.match((await start(s, "u1")).message, /^Zero-touch hand-off mode is on/);
    const forced = await start(s, "u2", { env: { MMO_AMBIENT: "on" } });
    assert.equal(chatMode("u2", { MMO_HOME: s.home }), "on", "MMO_AMBIENT=on is workflow mode for one run, whatever the file says");
    assert.match(forced.message, /^Zero-touch workflow mode is on/);
    assert.equal((await start(s, "u3", { env: { MMO_AMBIENT: "observe" } })).stdout, "", "a measuring run that only records shows nothing");
    assert.equal(chatMode("u3", { MMO_HOME: s.home }), "observe");
    assert.equal((await start(s, "u4", { env: { MMO_AMBIENT: "off" } })).stdout, "");
    assert.equal(chatMode("u4", { MMO_HOME: s.home }), null);
  } finally { s.cleanup(); }
});

test("workflow mode and off say how to reach the other modes", async () => {
  const s = sandbox({ mode: "a" });
  try {
    assert.match((await start(s, "w1")).message, /To change the mode, put b \(hand-off\) or off in \S+mode and start a new chat\./);
    writeFileSync(join(s.home, "mode"), "off\n");
    assert.match((await start(s, "w2")).message, /^Zero-touch is off for this chat\. To turn it on, put a \(workflows from plain words\) or b \(hand-off\) in \S+mode and start a new chat\.$/);
  } finally { s.cleanup(); }
});

test("the start hook's defaults are the shipped ones: it carries no code of mmo's, so the two are proved equal here", () => {
  const shipped = readJson(join(ROOT, "plugin", "config", "ambient.default.json")).handoff;
  assert.deepEqual(shipped, { chat_model: "claude-opus-5", policy: "opus-plus-flash-v38" });
  const source = readFileSync(join(ROOT, "zero-touch", "scripts", "start-chat.mjs"), "utf8");
  assert.match(source, new RegExp(`DEFAULT_CHAT_MODEL = "${shipped.chat_model}"`));
  assert.match(source, new RegExp(`DEFAULT_POLICY = "${shipped.policy}"`));
});
