/**
 * Zero-touch hand-off mode, the chat's start.
 *
 * Since 1 Oct 2026 a person chooses hand-off mode, and its settings, in the zero-touch settings box in the chat: the
 * model the chat is kept on (Opus 5, recommended, or Sonnet 5), and who types each kind of hand-off work (new
 * documents, specs and plans; new tests; the same change repeated in many files): Flash 3.8, Sonnet 5, or kept in the
 * chat. The zero-touch plugin keeps the choices (zero-touch/scripts/settings.mjs). The old mode file and the hand-off
 * settings in ambient.json are not read any more, and a project's routing-policy.yaml is not used by zero-touch.
 *
 * Everything is read ONCE, when the chat starts, and stamped on the chat (`sessions/<chat id>/chat_mode` and
 * `handoff.json`): a setting changed in the middle of a chat would leave the chat's start message, its no-switching
 * guard and its hand-offs disagreeing with each other, and would split one chat's costs across two sets of models.
 * A change reaches the next new chat (/clear is one: Claude Code gives it a new chat id).
 *
 * At the start the person sees a message (the hook's `systemMessage`) and the chat's model gets the hand-off rules and
 * the settings note (the hook's `additionalContext`). A compaction drops those from what the model reads, so both are
 * given again after a compaction and when a chat is reopened, from the stamp, never from the settings.
 *
 * Every case runs the real start hook through its shell script with its own home, plugin data folder and project
 * folder. No network, no model.
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
const { writeZtSettings, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
const { DEFAULTS } = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** A person who chose Hand-off (the standard hand-off choices unless `handoff` says otherwise). */
function sandbox({ handoff = {}, mode = "handoff" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-start-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeZtSettings(home, { mode, handoff: { ...DEFAULTS.handoff, ...handoff } });
  // No organisation settings file unless a test writes one.
  return { dir, home, repo, managed: join(dir, "managed-settings.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const choose = (s, value) => writeZtSettings(s.home, value);

function start(s, sid, { source = "startup", model, env = {} } = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home), CLAUDE_PROJECT_DIR: s.repo, MMO_MANAGED_SETTINGS: s.managed, ...env };
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

test("Hand-off: the chat is marked, its settings are stamped on it, the person sees the start message and the model gets the rules", async () => {
  const s = sandbox();
  try {
    for (const source of ["startup", "clear"]) {
      const sid = `b-${source}`;
      const r = await start(s, sid, { source, model: "claude-opus-5" });
      assert.equal(r.code, 0);
      assert.equal(chatMode(sid, { MMO_HOME: s.home }), "b", source);
      const st = stamp(s, sid);
      assert.equal(st.chat_model, "claude-opus-5", "the standard chat model");
      assert.equal(st.pin, "setting");
      assert.deepEqual(st.typists, { documents: { typist: "flash", policy: "opus-plus-flash-v38" }, tests: { typist: "flash", policy: "opus-plus-flash-v38" }, repeats: { typist: "flash", policy: "opus-plus-flash-v38" } });
      assert.equal(r.message, M.handoffMessage(st, "claude-opus-5"), "the approved words, exactly");
      assert.match(r.message, /^Zero-touch is on in this chat: Hand-off mode\./);
      assert.match(r.message, /Opus 5, this chat's model, does the real development work itself/);
      assert.match(r.message, /new documents, specs and plans: Google's Flash 3\.8/);
      assert.match(r.message, /This chat stays on Opus 5, because good development and good hand-off decisions need its judgment/);
      assert.match(r.message, /type "change zero-touch settings"/);
      assert.doesNotMatch(r.message, /~\/\.mmo-ambient|ambient\.json|\/mmo:|handoff\.(policy|chat_model)|opus-plus/, "no file, no command, no policy code");
      assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
      for (const tool of ["write_document", "write_tests_from_cases", "repeat_edit_across_files"]) assert.match(r.note, new RegExp(tool), `the rules name ${tool}`);
      assert.match(r.note, /No full workflow starts from the person's plain words in this chat/);
      assert.match(r.note, /Zero-touch settings: if the person asks to change how zero-touch works/, "and the settings note");
    }
  } finally { s.cleanup(); }
});

test("work kept in the chat is not handed off: the message says who does it, and the rules neither name its tool nor ask for a hand-off", async () => {
  const s = sandbox({ handoff: { documents: "sonnet", tests: "chat", repeats: "chat" } });
  try {
    const r = await start(s, "k1", { model: "claude-opus-5" });
    assert.deepEqual(stamp(s, "k1").typists.tests, { typist: "chat", policy: null });
    assert.match(r.message, /new documents, specs and plans: Sonnet 5/);
    assert.match(r.message, /new tests: kept in this chat \(Opus 5 does it\)/);
    assert.match(r.message, /the same change repeated in many files: kept in this chat \(Opus 5 does it\)/);
    assert.match(r.note, /write_document/);
    assert.doesNotMatch(r.note, /write_tests_from_cases|repeat_edit_across_files/, "no tool for work the person keeps in the chat");
    assert.match(r.note, /keep this work in the chat, so you do it yourself.*new tests; the same change repeated in many files/);
  } finally { s.cleanup(); }
});

test("the start message says only what is true of the chosen models: 'cheaper' only when it is, nothing about hand-offs when all is kept", async () => {
  // 1 Oct 2026: the message once said "handed off to a cheaper AI model" for every setup; with a Sonnet 5 chat and a
  // Sonnet 5 typist that is false, and with all three kinds kept in the chat nothing is handed off at all.
  const cases = [
    { name: "standard", handoff: {}, model: "claude-opus-5", cheaper: /which costs less than Opus 5/, savings: true, handed: true },
    { name: "Sonnet chat, Sonnet typists", handoff: { chat_model: "claude-sonnet-5", documents: "sonnet", tests: "sonnet", repeats: "sonnet" }, model: "claude-sonnet-5", cheaper: null, savings: false, handed: true },
    { name: "Sonnet chat, Flash typists", handoff: { chat_model: "claude-sonnet-5" }, model: "claude-sonnet-5", cheaper: /which costs less than Sonnet 5/, savings: false, handed: true },
    { name: "Sonnet chat, one Sonnet typist", handoff: { chat_model: "claude-sonnet-5", documents: "flash", tests: "sonnet", repeats: "chat" }, model: "claude-sonnet-5", cheaper: null, savings: false, handed: true },
    { name: "all kept, Opus", handoff: { documents: "chat", tests: "chat", repeats: "chat" }, model: "claude-opus-5", cheaper: null, savings: false, handed: false },
    { name: "all kept, Sonnet", handoff: { chat_model: "claude-sonnet-5", documents: "chat", tests: "chat", repeats: "chat" }, model: "claude-sonnet-5", cheaper: null, savings: false, handed: false },
  ];
  for (const c of cases) {
    const s = sandbox({ handoff: c.handoff });
    try {
      const r = await start(s, "t1", { model: c.model });
      if (c.cheaper) assert.match(r.message, c.cheaper, c.name);
      else assert.doesNotMatch(r.message, /costs less|cheaper/, `${c.name}: no cheaper claim`);
      assert.equal(/savings/.test(r.message), c.savings, `${c.name}: savings named only for an Opus chat that hands off`);
      if (c.handed) {
        assert.match(r.message, /If a hand-off fails twice, (Opus|Sonnet) 5 tries once more itself/, c.name);
      } else {
        assert.match(r.message, /Nothing is handed off, because you chose to keep all of it in this chat/, c.name);
        assert.doesNotMatch(r.message, /hand-off fails|hand-off decisions|the hand-offs|handed off to/, `${c.name}: no hand-off promises`);
        assert.doesNotMatch(r.note, /write_document|write_tests_from_cases|repeat_edit_across_files/, `${c.name}: no tool in the rules`);
      }
    } finally { s.cleanup(); }
  }
});

test("the settings are read once: a change reaches the next new chat (or /clear, a new chat id), never a chat that is open", async () => {
  const s = sandbox({ handoff: { chat_model: "claude-sonnet-5", documents: "sonnet", tests: "sonnet", repeats: "sonnet" } });
  try {
    const first = await start(s, "c1", { model: "claude-sonnet-5" });
    assert.deepEqual([stamp(s, "c1").chat_model, stamp(s, "c1").typists.documents.typist], ["claude-sonnet-5", "sonnet"]);
    assert.match(first.message, /This chat stays on Sonnet 5, as you chose\. The quality of the development and the hand-offs depends on this model; Opus 5 gives the best results\./);
    choose(s, { mode: "workflows" });
    for (const source of ["compact", "resume"]) {
      const again = await start(s, "c1", { source, model: "claude-sonnet-5" });
      assert.equal(chatMode("c1", { MMO_HOME: s.home }), "b", `${source}: the mode the chat started with`);
      assert.equal(again.message, first.message, `${source}: the stamped settings, not the new ones`);
      assert.match(again.note, /hand-off mode/, `${source}: the rules are given again, since a compaction drops them`);
    }
    await start(s, "c2");
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), "on", "a new chat takes the new mode");
  } finally { s.cleanup(); }
});

test("a Workflows chat gets no hand-off rules, at its start or after a compaction, and no hand-off stamp", async () => {
  const s = sandbox({ mode: "workflows" });
  try {
    for (const source of ["startup", "compact", "resume"]) {
      const r = await start(s, "a1", { source });
      assert.match(r.message, /^Zero-touch is on in this chat: Workflows mode\./, source);
      assert.doesNotMatch(r.note, /hand-off mode|write_document/, `${source}: no hand-off rules`);
      assert.match(r.note, /Zero-touch settings:/, `${source}: only the settings note`);
    }
    assert.throws(() => stamp(s, "a1"), "no hand-off stamp in a Workflows chat");
  } finally { s.cleanup(); }
});

test("the start message says whether the chat is on its chosen model, as far as the start moment tells", async () => {
  const s = sandbox();
  try {
    const on = await start(s, "m1", { model: "claude-opus-5[1m]" });
    assert.match(on.message, /This chat stays on Opus 5, because/, "the 1M-context tag is the same model");
    const other = await start(s, "m2", { model: "claude-sonnet-5" });
    assert.match(other.message, /Hand-off mode needs this chat on Opus 5, but it's on Sonnet 5 right now\. Switch it using the model menu next to the message box \(in the terminal, type \/model claude-opus-5\)\. After that, switching away is blocked\./);
    const unknown = await start(s, "m3");
    assert.match(unknown.message, /Hand-off mode needs this chat on Opus 5\. If it's on a different model, switch it using the model menu next to the message box/, "Claude Code does not always say which model a chat starts on");
    assert.equal(readFileSync(join(s.home, "sessions", "m2", "model_now"), "utf8"), "claude-sonnet-5", "the chat's model is kept for the lines that follow");
    // After a compaction the chat's current model is what counts, not the one it started on.
    const later = await start(s, "m2", { source: "compact", model: "claude-opus-5" });
    assert.match(later.message, /This chat stays on Opus 5, because/);
  } finally { s.cleanup(); }
});

test("a project's own routing-policy.yaml is not used by zero-touch: the chosen typists stand, and one line says the file is there", async () => {
  const s = sandbox({ handoff: { documents: "sonnet" } });
  try {
    writeFileSync(join(s.repo, "routing-policy.yaml"), "version: 1\n");
    const r = await start(s, "p1", { model: "claude-opus-5" });
    assert.equal(stamp(s, "p1").policy_file, null, "no project file is stamped");
    assert.deepEqual(stamp(s, "p1").typists.documents, { typist: "sonnet", policy: "opus-plus-sonnet" });
    assert.ok(r.message.includes(M.folderPolicyLine()));
  } finally { s.cleanup(); }
});

test("an organisation's pinned model wins over the person's chat model, and the chat is not asked to switch", async () => {
  const s = sandbox({ handoff: { chat_model: "claude-sonnet-5" } });
  try {
    writeFileSync(s.managed, JSON.stringify({ model: "claude-opus-5" }));
    const exact = await start(s, "o1", { model: "claude-sonnet-5" });
    assert.deepEqual([stamp(s, "o1").chat_model, stamp(s, "o1").pin], ["claude-opus-5", "admin"]);
    assert.match(exact.message, /This chat stays on Opus 5, the model your organisation set\./);
    assert.doesNotMatch(exact.message, /\/model/, "the organisation's setting decides; nothing to type");
    // An alias cannot be compared with a model id, so nothing is pinned by this plugin: the organisation's own
    // setting is what holds the chat.
    writeFileSync(s.managed, JSON.stringify({ model: "opus" }));
    const alias = await start(s, "o2");
    assert.deepEqual([stamp(s, "o2").chat_model, stamp(s, "o2").pin], [null, "admin"]);
    assert.match(alias.message, /This chat stays on opus, the model your organisation set\./);
  } finally { s.cleanup(); }
});

test("a one-run override still wins over the settings, for a developer or a measuring setup", async () => {
  const s = sandbox();
  try {
    const forced = await start(s, "u2", { env: { MMO_AMBIENT: "on" } });
    assert.equal(chatMode("u2", { MMO_HOME: s.home }), "on", "MMO_AMBIENT=on is Workflows for one run, whatever the settings say");
    assert.match(forced.message, /^Zero-touch is on in this chat: Workflows mode\./);
    assert.equal((await start(s, "u3", { env: { MMO_AMBIENT: "observe" } })).stdout, "", "a measuring run that only records shows nothing");
    assert.equal(chatMode("u3", { MMO_HOME: s.home }), "observe");
    assert.equal((await start(s, "u4", { env: { MMO_AMBIENT: "off" } })).stdout, "");
    assert.equal(chatMode("u4", { MMO_HOME: s.home }), null);
  } finally { s.cleanup(); }
});

test("a Hand-off chat marked before 1 Oct 2026 (one policy for every kind) still reads: its message and rules are shown again after a compaction", async () => {
  const s = sandbox();
  try {
    const dir = join(s.home, "sessions", "old1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chat_mode"), "b");
    writeFileSync(join(dir, "handoff.json"), JSON.stringify({ chat_model: "claude-opus-5", pin: "default", policy: "opus-plus-sonnet", policy_file: null }));
    const r = await start(s, "old1", { source: "compact", model: "claude-opus-5" });
    assert.match(r.message, /^Zero-touch is on in this chat: Hand-off mode\./);
    assert.match(r.message, /new tests: Sonnet 5/, "the old single policy, read as the typist for every kind");
    assert.match(r.note, /write_tests_from_cases/);
  } finally { s.cleanup(); }
});
