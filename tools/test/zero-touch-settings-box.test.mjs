/**
 * The zero-touch settings box, end to end through the plugin's real hooks (zero-touch/hooks/settings.sh →
 * scripts/settings-hook.mjs), as Claude Code calls them around its question tool.
 *
 * Why this test exists: from 1 Oct 2026 the settings box is the only way a person sets zero-touch up, in the desktop
 * app and the terminal alike. So every path must be right the first time: the first chat after install (and its
 * hold), the order of the boxes, a box Claude rewords, Claude's own boxes left alone, a helper refused, an answer typed
 * in "Other", a closed box (which no hook is ever told about: probe of 1 Oct 2026), all-or-nothing saving, the settings
 * reaching new chats while an open chat keeps its own, and the Google check at the moment Flash is chosen.
 *
 * Offline: temporary folders, no model, no network. PATH holds only node's folder and the system's, so the real
 * gcloud is never run; the Google cases put a fake one first on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ZT = join(ROOT, "zero-touch");
const START = join(ZT, "hooks", "start-chat.sh");
const HOOK = join(ZT, "hooks", "settings.sh");
const B = await import(join(ZT, "scripts", "boxes.mjs"));
const M = await import(join(ZT, "scripts", "messages.mjs"));
const S = await import(join(ZT, "scripts", "settings.mjs"));
const { writeGoogleLogin, writeZtSettings, ztData } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { chatMode } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "chat-mode.mjs"));
const BASE_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

function sandbox({ settings = null, google = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zt-box-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  if (settings) writeZtSettings(home, settings, { google });
  else if (google) writeGoogleLogin(home);
  return { dir, home, repo, bin: null, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake gcloud first on PATH: "works" prints a token, "refused" fails the way an expired login does. */
function fakeGcloud(s, behaviour) {
  s.bin = join(s.dir, "bin");
  mkdirSync(s.bin, { recursive: true });
  const script = behaviour === "works"
    ? "#!/bin/sh\necho ya29.fake-token\n"
    : "#!/bin/sh\necho 'ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed.' >&2\nexit 1\n";
  writeFileSync(join(s.bin, "gcloud"), script);
  chmodSync(join(s.bin, "gcloud"), 0o755);
}

function sh(script, args, payload, s, env = {}) {
  return new Promise((done) => {
    const childEnv = {
      PATH: s.bin ? `${s.bin}:${BASE_PATH}` : BASE_PATH, HOME: s.home, MMO_HOME: s.home, CLAUDE_PLUGIN_DATA: ztData(s.home),
      CLAUDE_PROJECT_DIR: s.repo, CLAUDE_CODE_ENTRYPOINT: "claude-desktop", MMO_MANAGED_SETTINGS: join(s.dir, "managed.json"), ...env,
    };
    const p = spawn("sh", [script, ...args], { cwd: s.repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json, message: json?.systemMessage ?? "", note: json?.hookSpecificOutput?.additionalContext ?? "", deny: json?.hookSpecificOutput?.permissionDecision === "deny" ? json.hookSpecificOutput.permissionDecisionReason : null });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const start = (s, sid, env) => sh(START, [], { session_id: sid, cwd: s.repo, source: "startup", model: "claude-opus-5" }, s, env);
const prompt = (s, sid, text = "hi") => sh(HOOK, ["prompt"], { session_id: sid, prompt: text }, s);
const tool = (s, sid, name, input = {}) => sh(HOOK, ["pre-any"], { session_id: sid, tool_name: name, tool_input: input }, s);
const show = (s, sid, box, extra = {}) => sh(HOOK, ["pre-ask"], { session_id: sid, tool_name: "AskUserQuestion", tool_input: box, ...extra }, s);
/** The person clicks: `labels` in the box's question order. */
const click = (s, sid, box, labels, extra = {}) => {
  const answers = Object.fromEntries(box.questions.map((q, i) => [q.question, labels[i]]));
  return sh(HOOK, ["post-ask"], { session_id: sid, tool_name: "AskUserQuestion", tool_input: box, tool_response: { answers }, model: "claude-opus-5", ...extra }, s);
};
const saved = (s) => JSON.parse(readFileSync(join(ztData(s.home), "settings.json"), "utf8"));

test("the first chat after install: the box comes first, other tools wait until it is shown, and Workflows applies to this chat at once", async () => {
  const s = sandbox();
  try {
    const st = await start(s, "f1");
    assert.equal(st.message, M.welcomeMessage());
    const first = B.modeBox(null, { first: true });
    assert.equal((await prompt(s, "f1", "build me a todo app")).note, M.firstRunNote(first), "the reminder comes with the first message");
    assert.equal((await tool(s, "f1", "Write", { file_path: "a.js" })).deny, M.holdReason(first), "a tool that changes something waits");
    assert.equal((await tool(s, "f1", "Read", { file_path: "a.js" })).stdout, "", "a tool that changes nothing runs");
    assert.equal((await show(s, "f1", first)).stdout, "", "the exact box is shown");
    assert.equal((await tool(s, "f1", "Write", { file_path: "a.js" })).stdout, "", "once shown, nothing is held any more, whatever the person does");
    const next = await click(s, "f1", first, ["Workflows"]);
    assert.equal(next.note, M.nextBoxNote("workflows", B.modelsBox(null)), "Claude is told to open the models box, word for word");
    assert.equal(next.message, "", "nothing is saved yet, so nothing is said");
    assert.ok(!existsSync(join(ztData(s.home), "settings.json")));
    assert.equal((await show(s, "f1", B.modelsBox(null))).stdout, "");
    const done = await click(s, "f1", B.modelsBox(null), ["Opus 5 + Sonnet 5"]);
    assert.equal(done.message, M.savedLine({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } }, { first: true }));
    assert.match(done.message, /Send your request again/, "the first message came before the mode existed");
    assert.equal(saved(s).mode, "workflows");
    assert.equal(saved(s).workflows.models, "opus-plus-sonnet");
    assert.equal(chatMode("f1", { MMO_HOME: s.home }), "on", "this chat is marked now");
    assert.equal(JSON.parse(readFileSync(join(s.home, "sessions", "f1", "workflow.json"), "utf8")).policy, "opus-plus-sonnet");
    assert.ok(!existsSync(join(s.home, "sessions", "f1", "zt_setup.json")) && !existsSync(join(s.home, "sessions", "f1", "zt_flow.json")));
  } finally { s.cleanup(); }
});

test("the first chat after install, Hand-off: the chat is marked with the typists chosen, and Claude gets the rules at once", async () => {
  const s = sandbox();
  try {
    await start(s, "f2");
    const first = B.modeBox(null, { first: true });
    await show(s, "f2", first);
    await click(s, "f2", first, ["Hand-off"]);
    const box = B.handoffBox(null);
    assert.equal((await show(s, "f2", box)).stdout, "");
    const done = await click(s, "f2", box, ["Opus 5 (Recommended)", "Flash 3.8", "Keep in chat", "Sonnet 5"]);
    assert.match(done.message, /^Zero-touch: your settings are saved and apply from now on, in this chat too: Hand-off mode on Opus 5; documents go to Flash 3.8, tests stay in the chat, repeated changes to Sonnet 5\. Claude now answers your message\.$/);
    assert.equal(chatMode("f2", { MMO_HOME: s.home }), "b");
    const stamp = JSON.parse(readFileSync(join(s.home, "sessions", "f2", "handoff.json"), "utf8"));
    assert.deepEqual(stamp.typists, { documents: { typist: "flash", policy: "opus-plus-flash-v38" }, tests: { typist: "chat", policy: null }, repeats: { typist: "sonnet", policy: "opus-plus-sonnet" } });
    assert.match(done.note, /write_document/);
    assert.doesNotMatch(done.note, /write_tests_from_cases/, "tests are kept in the chat");
  } finally { s.cleanup(); }
});

test("the first chat after install, Off: saved at the first box; nothing is marked; closing the box instead saves nothing and releases the hold", async () => {
  const s = sandbox();
  try {
    await start(s, "f3");
    const first = B.modeBox(null, { first: true });
    await show(s, "f3", first);
    const off = await click(s, "f3", first, ["Off"]);
    assert.equal(off.message, M.savedLine({ mode: "off" }, { first: true }));
    assert.equal(saved(s).mode, "off");
    assert.equal(chatMode("f3", { MMO_HOME: s.home }), null);
  } finally { s.cleanup(); }
  const c = sandbox();
  try {
    await start(c, "f4");
    const first = B.modeBox(null, { first: true });
    await show(c, "f4", first); // shown, then closed: no hook hears of it
    const next = await prompt(c, "f4", "never mind, just help me with this");
    assert.equal(next.message, M.closedLine(null, { first: true }));
    assert.ok(!existsSync(join(ztData(c.home), "settings.json")), "nothing saved");
    assert.equal(chatMode("f4", { MMO_HOME: c.home }), null, "zero-touch does nothing in this chat");
    assert.equal((await tool(c, "f4", "Write", { file_path: "a.js" })).stdout, "", "and nothing is held");
    assert.equal((await prompt(c, "f4", "and again")).stdout, "", "said once");
    const later = await start(c, "f5");
    assert.equal(later.message, M.welcomeMessage(), "the next new chat asks again");
  } finally { c.cleanup(); }
});

test("changing the settings in a normal chat: the current choices are marked, the second box must match the first answer, and the open chat keeps its own", async () => {
  const s = sandbox({ settings: { mode: "workflows", workflows: { models: "opus-plus-flash-v38" } } });
  try {
    await start(s, "c1");
    const current = S.clean(saved(s));
    const mode = B.modeBox(current);
    assert.match(JSON.stringify(mode), /Workflows[^}]*your current choice/, "the choice in force is marked");
    assert.equal((await show(s, "c1", mode)).stdout, "");
    await click(s, "c1", mode, ["Hand-off"]);
    const wrong = await show(s, "c1", B.modelsBox(current));
    assert.equal(wrong.deny, M.wrongBoxReason(B.handoffBox(current)), "after Hand-off, only the hand-off box: the refusal gives it word for word");
    assert.equal((await show(s, "c1", B.handoffBox(current))).stdout, "");
    const done = await click(s, "c1", B.handoffBox(current), ["Sonnet 5", "Sonnet 5", "Flash 3.8", "Keep in chat"]);
    assert.equal(done.message, M.savedLine({ mode: "handoff", handoff: { chat_model: "claude-sonnet-5", documents: "sonnet", tests: "flash", repeats: "chat" } }));
    assert.match(done.message, /From your next new chat: .*This chat carries on as it started\.$/);
    assert.equal(chatMode("c1", { MMO_HOME: s.home }), "on", "the open chat keeps its mode");
    assert.equal(saved(s).workflows.models, "opus-plus-flash-v38", "the Workflows choice is kept for when the person switches back");
    await start(s, "c2");
    assert.equal(chatMode("c2", { MMO_HOME: s.home }), "b", "the next new chat has the new settings");
  } finally { s.cleanup(); }
});

test("only a box about zero-touch is checked: Claude's own boxes pass untouched, a reworded one is sent back, a helper's is refused", async () => {
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "b1");
    const editor = { questions: [{ question: "Which editor do you use?", header: "Editor", multiSelect: false, options: [{ label: "VS Code", description: "x" }, { label: "Vim", description: "y" }] }] };
    assert.equal((await show(s, "b1", editor)).stdout, "", "Claude's own question");
    const gate = { questions: [{ question: "Requirements ready. Approve?", header: "Gate 1", multiSelect: false, options: [{ label: "Approve", description: "a" }, { label: "Change", description: "b" }] }] };
    assert.equal((await show(s, "b1", gate)).stdout, "", "a workflow's approval step");
    assert.equal((await click(s, "b1", editor, ["Vim"])).stdout, "", "and their answers are not read as settings");
    const reworded = { questions: [{ question: "Which zero-touch mode do you want?", header: "Mode", multiSelect: false, options: [{ label: "Workflows", description: "x" }, { label: "Hand-off", description: "y" }] }] };
    assert.equal((await show(s, "b1", reworded)).deny, M.wrongBoxReason(B.modeBox(S.clean(saved(s)))));
    assert.equal((await show(s, "b1", B.modeBox(S.clean(saved(s))), { agent_id: "helper-1" })).deny, M.HELPER_BOX_REASON);
  } finally { s.cleanup(); }
});

test("an answer typed in Other saves nothing; a box closed in the middle of the sequence is said at the next message; Off chats can change settings too", async () => {
  const s = sandbox({ settings: { mode: "off" } });
  try {
    const st = await start(s, "o1");
    assert.equal(st.message, M.offMessage());
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "o1", mode);
    const other = await click(s, "o1", mode, ["switch it to workflows please"]);
    assert.equal(other.message, M.notAChoiceLine("switch it to workflows please", S.clean(saved(s))));
    assert.equal(saved(s).mode, "off", "nothing changed");
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Workflows"]); // then the models box is never answered (closed)
    const next = await prompt(s, "o1", "ok thanks");
    assert.equal(next.message, M.closedLine(S.clean(saved(s))));
    assert.equal(saved(s).mode, "off", "all or nothing: the mode alone is not saved");
    // An Off chat can switch zero-touch back on (zero-touch's own hooks run in every chat).
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Workflows"]);
    await show(s, "o1", B.modelsBox(S.clean(saved(s))));
    const on = await click(s, "o1", B.modelsBox(S.clean(saved(s))), ["Opus 5 only"]);
    assert.match(on.message, /From your next new chat: Workflows mode, Opus 5 only\./);
  } finally { s.cleanup(); }
});

test("choosing Flash says at once when Google cannot be used: no login, a login Google refuses, and a working one", async () => {
  const pick = async (s) => {
    await start(s, "g");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "g", mode);
    await click(s, "g", mode, ["Workflows"]);
    await show(s, "g", B.modelsBox(S.clean(saved(s))));
    return (await click(s, "g", B.modelsBox(S.clean(saved(s))), ["Opus 5 + Flash 3.8"])).message;
  };
  const none = sandbox({ settings: { mode: "off" }, google: false });
  try {
    const said = await pick(none);
    assert.match(said, /Google's Flash 3\.8 can't be used yet, because this computer isn't connected to Google/);
    assert.match(said, /Until it is, workflows won't start\./, "no login: the workflow start refuses, so this is true");
  } finally { none.cleanup(); }
  const refused = sandbox({ settings: { mode: "off" } });
  try {
    fakeGcloud(refused, "refused");
    const said = await pick(refused);
    assert.match(said, /Google refused this computer's login just now \(ERROR: \(gcloud\.auth\.application-default\.print-access-token\) Reauthentication failed\.\)/);
    // 1 Oct 2026, found in review: a login that exists passes the workflow start's offline check, so "workflows won't
    // start" was false here; they start, and their Flash steps fail.
    assert.match(said, /Until it's fixed, workflows can't use Flash 3\.8: they may stop, or use a more expensive model for those steps\./);
    assert.doesNotMatch(said, /won't start/);
  } finally { refused.cleanup(); }
  const works = sandbox({ settings: { mode: "off" } });
  try {
    fakeGcloud(works, "works");
    assert.doesNotMatch(await pick(works), /Google/, "a working login: nothing to say");
  } finally { works.cleanup(); }
  const sonnet = sandbox({ settings: { mode: "off" }, google: false });
  try {
    await start(sonnet, "g");
    const mode = B.modeBox(S.clean(saved(sonnet)));
    await show(sonnet, "g", mode);
    await click(sonnet, "g", mode, ["Workflows"]);
    await show(sonnet, "g", B.modelsBox(S.clean(saved(sonnet))));
    assert.doesNotMatch((await click(sonnet, "g", B.modelsBox(S.clean(saved(sonnet))), ["Opus 5 + Sonnet 5"])).message, /Google/, "no Flash, no Google needed");
  } finally { sonnet.cleanup(); }
});

test("a run with no screen never holds, and its settings note still points at a normal chat", async () => {
  const s = sandbox();
  try {
    const r = await start(s, "p1", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    assert.equal(r.message, M.noSettingsMessage());
    assert.equal((await tool(s, "p1", "Write", { file_path: "a.js" })).stdout, "", "nothing is held");
    assert.equal((await prompt(s, "p1")).stdout, "", "no first-chat reminder");
  } finally { s.cleanup(); }
});

/** The box a note gives Claude (the last "word for word:" in it), parsed back from the note's own text. */
function boxFrom(note) {
  const at = note.lastIndexOf("word for word: ");
  assert.ok(at >= 0, "the note gives a box");
  const text = note.slice(at + "word for word: ".length);
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error("no whole box in the note");
}

test("every box a note gives Claude is the one the check lets through: unreadable settings, a second change, after a compaction", async () => {
  // 1 Oct 2026, found in review: notes built their box from other data than the check (the chat's marks, the standard
  // settings), so Claude's first try was refused in these cases; it recovered only because the refusal names the box.
  const bad = sandbox();
  try {
    mkdirSync(ztData(bad.home), { recursive: true });
    writeFileSync(join(ztData(bad.home), "settings.json"), "{ not json");
    const st = await start(bad, "u1");
    assert.equal((await show(bad, "u1", boxFrom(st.note))).stdout, "", "unreadable settings: the start note's box is shown");
    const next = await click(bad, "u1", boxFrom(st.note), ["Hand-off"]);
    assert.equal((await show(bad, "u1", boxFrom(next.note))).stdout, "", "unreadable settings: the next-box note's box is shown");
  } finally { bad.cleanup(); }
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    const st = await start(s, "c1");
    const mode = boxFrom(st.note);
    await show(s, "c1", mode);
    const done = await click(s, "c1", mode, ["Off"]);
    assert.equal(saved(s).mode, "off");
    assert.equal((await show(s, "c1", boxFrom(done.note))).stdout, "", "a second change in the same chat: the saved note's box is shown");
    await click(s, "c1", boxFrom(done.note), ["Hand-off"]);
    await prompt(s, "c1", "never mind");
    const compacted = await sh(START, [], { session_id: "c1", cwd: s.repo, source: "compact", model: "claude-opus-5" }, s);
    assert.equal((await show(s, "c1", boxFrom(compacted.note))).stdout, "", "after a compaction: the start note's box is shown");
  } finally { s.cleanup(); }
});

test("while a sequence is half done, a notice or a message typed while Claude works does not end it; an idle message still does", async () => {
  // 1 Oct 2026, found in review: any prompt event ended the sequence and said "nothing was saved".
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    await start(s, "n1");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "n1", mode);
    await click(s, "n1", mode, ["Hand-off"]);
    assert.equal((await prompt(s, "n1", "<task-notification>\n<task-id>b1</task-id> completed\n</task-notification>")).stdout, "", "a notice: nothing");
    const transcript = join(s.dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "also check the README" } }) + "\n");
    assert.equal((await sh(HOOK, ["prompt"], { session_id: "n1", prompt: "also check the README", transcript_path: transcript }, s)).stdout, "", "typed while working: nothing");
    const handoff = B.handoffBox(S.clean(saved(s)));
    assert.equal((await show(s, "n1", handoff)).stdout, "", "the sequence goes on: the hand-off box is shown");
    await click(s, "n1", handoff, ["Sonnet 5", "Keep in chat", "Sonnet 5", "Flash 3.8"]);
    assert.deepEqual(saved(s).handoff, { chat_model: "claude-sonnet-5", documents: "chat", tests: "sonnet", repeats: "flash" }, "and is saved, click for click");
    // A sequence left open, then a message typed while the chat is idle: said, as before.
    await show(s, "n1", B.modeBox(S.clean(saved(s))));
    await click(s, "n1", B.modeBox(S.clean(saved(s))), ["Workflows"]);
    assert.match((await prompt(s, "n1", "what next?")).message, /nothing was changed/);
  } finally { s.cleanup(); }
});

test("two first chats: settings saved in one end the other's questions and hold at once, and its compaction shows no welcome", async () => {
  // 1 Oct 2026, found in review: the other chat kept holding tools, kept being told there were no settings, and a
  // compaction days later showed the welcome again.
  const s = sandbox();
  try {
    await start(s, "a");
    await start(s, "b");
    await prompt(s, "a", "hello");
    const first = B.modeBox(null, { first: true });
    await show(s, "b", first);
    await click(s, "b", first, ["Off"]);
    assert.equal(saved(s).mode, "off");
    assert.equal((await tool(s, "a", "Write", { file_path: "x.js" })).stdout, "", "chat a holds nothing any more");
    const said = await prompt(s, "a", "carry on");
    assert.equal(said.message, M.savedElsewhereLine());
    assert.doesNotMatch(said.note, /no settings yet/);
    assert.ok(!existsSync(join(s.home, "sessions", "a", "zt_setup.json")), "chat a's first questions are over");
    const compacted = await sh(START, [], { session_id: "a", cwd: s.repo, source: "compact", model: "claude-opus-5" }, s);
    assert.notEqual(compacted.message, M.welcomeMessage(), "no welcome again");
    assert.equal(chatMode("a", { MMO_HOME: s.home }), null, "chat a stays without zero-touch, as an open chat does");
  } finally { s.cleanup(); }
});

test("the first chat's hold lasts one turn at most: a box never shown ends it at the next message, and says so", async () => {
  // 1 Oct 2026, found in review: with the question tool unavailable the box could never be shown, and every tool
  // that changes anything was refused in every new chat, for ever.
  const s = sandbox();
  try {
    await start(s, "h1");
    assert.equal((await prompt(s, "h1", "fix the build")).note, M.firstRunNote(B.modeBox(null, { first: true })));
    assert.ok((await tool(s, "h1", "Bash", { command: "npm test" })).deny, "held during the first turn");
    const next = await prompt(s, "h1", "hello?");
    assert.equal(next.message, M.notShownLine());
    assert.equal((await tool(s, "h1", "Bash", { command: "npm test" })).stdout, "", "nothing is held any more");
    assert.ok(!existsSync(join(s.home, "sessions", "h1", "zt_setup.json")));
    assert.equal((await start(s, "h2")).message, M.welcomeMessage(), "the next new chat asks again");
  } finally { s.cleanup(); }
});

test("an organisation's pinned model: the saved line names the model that will run", async () => {
  // 1 Oct 2026, found in review: the line named the person's pick while the organisation's model held the chat.
  const s = sandbox({ settings: { mode: "workflows" } });
  try {
    writeFileSync(join(s.dir, "managed.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    await start(s, "o1");
    const mode = B.modeBox(S.clean(saved(s)));
    await show(s, "o1", mode);
    await click(s, "o1", mode, ["Hand-off"]);
    const handoff = B.handoffBox(S.clean(saved(s)));
    await show(s, "o1", handoff);
    const done = await click(s, "o1", handoff, ["Opus 5 (Recommended)", "Flash 3.8", "Flash 3.8", "Flash 3.8"]);
    assert.match(done.message, /Hand-off mode on Sonnet 5 \(the model your organisation set\)/);
    assert.doesNotMatch(done.message, /on Opus 5/);
  } finally { s.cleanup(); }
});

test("the first chat's wait counts a new turn only on evidence: a message the transcript cannot place yet does not end it early", async () => {
  // 1 Oct 2026, found in the review's second pass: a message typed during the first turn that the transcript did not
  // show yet was counted as a new turn, and the first-chat questions ended while Claude was about to open the box.
  const s = sandbox();
  try {
    await start(s, "w1");
    const transcript = join(s.dir, "w1.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "fix the build" } }) + "\n");
    const say = (text) => sh(HOOK, ["prompt"], { session_id: "w1", prompt: text, transcript_path: transcript }, s);
    assert.equal((await say("fix the build")).note, M.firstRunNote(B.modeBox(null, { first: true })), "the first message: the reminder");
    const early = await say("also the tests");
    assert.equal(early.message, "", "not in the transcript yet: no give-up");
    assert.ok((await tool(s, "w1", "Bash", { command: "npm test" })).deny, "still waiting for the box");
    assert.equal((await say("and the docs")).message, M.notShownLine(), "the limit: at most three such messages");
  } finally { s.cleanup(); }
  const t = sandbox();
  try {
    await start(t, "w2");
    const transcript = join(t.dir, "w2.jsonl");
    const lines = [];
    const say = (text) => { lines.push(JSON.stringify({ type: "user", message: { content: text } })); writeFileSync(transcript, lines.join("\n") + "\n"); return sh(HOOK, ["prompt"], { session_id: "w2", prompt: text, transcript_path: transcript }, t); };
    await say("fix the build");
    assert.equal((await say("hello?")).message, M.notShownLine(), "a second message typed while idle: the turn went by without the box");
  } finally { t.cleanup(); }
  const u = sandbox({ settings: { mode: "workflows" } });
  try {
    // A half-done choice is said to be closed only on an idle message, never on one the transcript cannot place.
    await start(u, "w3");
    const mode = B.modeBox(S.clean(saved(u)));
    await show(u, "w3", mode);
    await click(u, "w3", mode, ["Hand-off"]);
    const transcript = join(u.dir, "w3.jsonl");
    writeFileSync(transcript, "");
    assert.equal((await sh(HOOK, ["prompt"], { session_id: "w3", prompt: "hmm", transcript_path: transcript }, u)).stdout, "");
    assert.equal((await show(u, "w3", B.handoffBox(S.clean(saved(u))))).stdout, "", "the choice goes on");
  } finally { u.cleanup(); }
});
