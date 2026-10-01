/**
 * Zero-touch's settings and its settings box (zero-touch/scripts/settings.mjs, boxes.mjs).
 *
 * Why this test exists: from 1 Oct 2026 a person sets zero-touch up only by clicking in Claude's question box in the
 * chat, never by editing a file or typing a command. So the box must always be the same words, in the same order,
 * within the limits of Claude Code's question tool; only the fixed choices may ever be saved; one bad value must never
 * lose the others; and a box that is not about zero-touch (Claude's own questions, a workflow's approval step) must
 * never be taken for one. A probe run on 1 Oct caught exactly that last mistake in the first design.
 *
 * All offline: temporary folders only, no model, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const S = await import(join(ROOT, "zero-touch", "scripts", "settings.mjs"));
const B = await import(join(ROOT, "zero-touch", "scripts", "boxes.mjs"));
const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));

function home() {
  const dir = mkdtempSync(join(tmpdir(), "zt-settings-"));
  const data = join(dir, "data");
  return { dir, data, env: { HOME: dir, MMO_HOME: join(dir, "mmo"), CLAUDE_PLUGIN_DATA: data }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("nothing saved yet reads as 'none' with the standard settings; the standard settings are Workflows on Opus 5 + Flash 3.8", () => {
  const h = home();
  try {
    const r = S.readSettings(h.env);
    assert.equal(r.state, "none");
    assert.deepEqual(r.settings, { mode: "workflows", workflows: { models: "opus-plus-flash-v38" }, handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" } });
  } finally { h.cleanup(); }
});

test("a file that cannot be read gives the standard settings and says so; one bad value never loses the others", () => {
  const h = home();
  try {
    mkdirSync(h.data, { recursive: true });
    const file = join(h.data, "settings.json");
    for (const text of ["{ not json", "[1,2]", "null", "x".repeat(20000)]) {
      writeFileSync(file, text);
      const r = S.readSettings(h.env);
      assert.equal(r.state, "unreadable", `unreadable for ${text.slice(0, 12)}`);
      assert.equal(r.settings.mode, "workflows");
    }
    writeFileSync(file, JSON.stringify({ mode: "handoff", workflows: { models: "gpt-9" }, handoff: { chat_model: "claude-haiku-4-5", documents: "sonnet", tests: "../../x", repeats: "chat" } }));
    const r = S.readSettings(h.env);
    assert.equal(r.state, "ok");
    assert.equal(r.settings.mode, "handoff", "a good value is kept");
    assert.equal(r.settings.workflows.models, "opus-plus-flash-v38", "a policy that is not one of the three is not used");
    assert.equal(r.settings.handoff.chat_model, "claude-opus-5", "a chat model that is not offered is not used");
    assert.equal(r.settings.handoff.documents, "sonnet");
    assert.equal(r.settings.handoff.tests, "flash", "an odd value takes the standard one");
    assert.equal(r.settings.handoff.repeats, "chat");
  } finally { h.cleanup(); }
});

test("saving writes the whole file at once, in the plugin's own data folder, and leaves no temporary file behind", () => {
  const h = home();
  try {
    const saved = S.writeSettings({ mode: "off", extra: "dropped" }, h.env);
    assert.equal(saved.mode, "off");
    assert.equal(saved.version, 1);
    assert.ok(!("extra" in saved), "only the fixed settings are stored");
    assert.deepEqual(readdirSync(h.data), ["settings.json"]);
    assert.equal(S.readSettings(h.env).state, "ok");
    assert.equal(S.readSettings(h.env).settings.mode, "off");
    // Without the plugin's data folder (a developer running the script by hand): <MMO_HOME>/zero-touch.
    const env = { HOME: h.dir, MMO_HOME: join(h.dir, "mmo") };
    S.writeSettings({ mode: "workflows" }, env);
    assert.ok(existsSync(join(h.dir, "mmo", "zero-touch", "settings.json")));
  } finally { h.cleanup(); }
});

test("every model choice is a shipped policy, and the settings sentence reads as a person says it", () => {
  for (const p of Object.keys(S.WORKFLOW_MODELS)) assert.ok(existsSync(join(ROOT, "plugin", "config", "policies", `${p}.yaml`)), `${p} is shipped`);
  for (const t of Object.values(S.TYPISTS)) if (t.policy) assert.ok(existsSync(join(ROOT, "plugin", "config", "policies", `${t.policy}.yaml`)), `${t.policy} is shipped`);
  assert.equal(S.describe({ mode: "workflows", workflows: { models: "opus-plus-sonnet" } }), "Workflows mode, Opus 5 + Sonnet 5");
  assert.equal(S.describe({ mode: "off" }), "Off");
  assert.equal(S.describe({ mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat" } }),
    "Hand-off mode on Opus 5; documents go to Flash 3.8, tests to Sonnet 5, repeated changes stay in the chat");
  assert.equal(S.needsGoogle({ mode: "workflows", workflows: { models: "opus-plus-flash-v38" } }), true);
  assert.equal(S.needsGoogle({ mode: "workflows", workflows: { models: "opus-only-v5" } }), false);
  assert.equal(S.needsGoogle({ mode: "handoff", handoff: { documents: "chat", tests: "sonnet", repeats: "flash" } }), true);
  assert.equal(S.needsGoogle({ mode: "handoff", handoff: { documents: "chat", tests: "sonnet", repeats: "chat" } }), false);
  assert.equal(S.needsGoogle({ mode: "off" }), false);
});

test("the boxes fit Claude Code's question tool, and every question names zero-touch", () => {
  const current = S.clean({ mode: "handoff" });
  for (const box of [B.modeBox(null, { first: true }), B.modeBox(current), B.modelsBox(current), B.handoffBox(current)]) {
    assert.ok(box.questions.length >= 1 && box.questions.length <= 4);
    for (const q of box.questions) {
      assert.ok(q.header.length <= 12, `header "${q.header}" fits`);
      assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.header} has 2-4 choices`);
      assert.equal(q.multiSelect, false);
      assert.ok(q.header === "Zero-touch" || /zero-touch/i.test(q.question), `"${q.question}" names zero-touch`);
      for (const o of q.options) assert.ok(o.label && o.description, "every choice has a label and a line under it");
    }
    assert.equal(B.isZeroTouchBox(box.questions), true);
  }
});

test("the choice in force is marked, and the first chat after install marks nothing", () => {
  const marked = (box) => box.questions.flatMap((q) => q.options.filter((o) => o.description.endsWith(B.CURRENT)).map((o) => `${q.header}:${o.label}`));
  assert.deepEqual(marked(B.modeBox(null, { first: true })), []);
  const s = S.clean({ mode: "handoff", workflows: { models: "opus-only-v5" }, handoff: { chat_model: "claude-sonnet-5", documents: "chat", tests: "sonnet", repeats: "flash" } });
  assert.deepEqual(marked(B.modeBox(s)), ["Zero-touch:Hand-off"]);
  assert.deepEqual(marked(B.modelsBox(s)), ["Models:Opus 5 only"]);
  assert.deepEqual(marked(B.handoffBox(s)), ["Chat model:Sonnet 5", "Documents:Keep in chat", "Tests:Sonnet 5", "Repeats:Flash 3.8"]);
  assert.equal(B.modeBox(null, { first: true }).questions[0].question, "How should zero-touch work, starting with this chat?");
  assert.equal(B.modeBox(s).questions[0].question, "How should zero-touch work in your new chats?");
});

test("only a box about zero-touch is ours: Claude's own questions and a workflow's approval step are never taken for one", () => {
  assert.equal(B.isZeroTouchBox([{ question: "Which editor do you use?", header: "Editor", options: [{ label: "VS Code" }, { label: "Vim" }] }]), false);
  assert.equal(B.isZeroTouchBox([{ question: "Requirements ready. Approve?", header: "Gate 1", options: [{ label: "Approve" }, { label: "Change" }] }]), false);
  // Claude's own rewording of a zero-touch box is still ours (so it can be sent back with the exact one).
  assert.equal(B.isZeroTouchBox([{ question: "Which zero-touch mode?", header: "Mode", options: [{ label: "Workflows" }, { label: "Hand-off" }] }]), true);
  assert.equal(B.isZeroTouchBox([{ question: "Mode?", header: "Zero-touch", options: [{ label: "On" }, { label: "Off" }] }]), true);
  assert.equal(B.isZeroTouchBox([{ question: "Pick the models", header: "Setup", options: [{ label: "Opus and Flash" }, { label: "Sonnet" }] }, { question: "Anything for zero-touch?", header: "More", options: [{ label: "No" }, { label: "Yes" }] }]), true, "the name in one question, a model in another");
  assert.equal(B.isZeroTouchBox("nonsense"), false);
  // 1 Oct 2026, found in review: a question that only mentions zero-touch is Claude's own (likely while working on
  // this very plugin), never taken for the settings.
  assert.equal(B.isZeroTouchBox([{ question: "Should the README section on zero-touch go before or after Setup?", header: "README", options: [{ label: "Before Setup" }, { label: "After Setup" }] }]), false);
  assert.equal(B.isZeroTouchBox([{ question: "Which zero-touch test file should I fix first?", header: "Tests", options: [{ label: "settings.test.mjs" }, { label: "docs.test.mjs" }] }]), false);
  // A settings word without zero-touch named is not ours either: a model question in someone's own project.
  assert.equal(B.isZeroTouchBox([{ question: "Which model should the benchmark use?", header: "Model", options: [{ label: "Opus 5" }, { label: "Sonnet 5" }] }]), false);
});

test("a box caught by mistake is told how to ask again, so nothing is stuck", () => {
  assert.match(M.wrongBoxReason(B.modeBox(null)), /If your question is about something else, ask it again without the word "zero-touch" in it\./);
});

test("a box is the expected one only word for word; which box it is follows its question text", () => {
  const s = S.clean({});
  const box = B.modeBox(s);
  assert.equal(B.sameBox(structuredClone(box.questions), box), true);
  const noMulti = structuredClone(box.questions); delete noMulti[0].multiSelect;
  assert.equal(B.sameBox(noMulti, box), true, "multiSelect left out means one choice, as the tool reads it");
  const reworded = structuredClone(box.questions); reworded[0].options[0].description = "Workflows start by themselves.";
  assert.equal(B.sameBox(reworded, box), false);
  const withoutMark = B.modeBox(null);
  assert.equal(B.sameBox(withoutMark.questions, box), false, "the marker is part of the words");
  assert.equal(B.boxKind(box.questions), "mode");
  assert.equal(B.boxKind(B.modeBox(null, { first: true }).questions), "mode");
  assert.equal(B.boxKind(B.modelsBox(s).questions), "models");
  assert.equal(B.boxKind(B.handoffBox(s).questions), "handoff");
  assert.equal(B.boxKind(reworded.slice(0, 0)), null);
  assert.equal(B.boxKind([{ question: "Which zero-touch mode?" }]), null);
});

test("the clicks are read exactly; an answer typed in Other, or a missing one, saves nothing, and one bad answer saves none", () => {
  const s = S.clean({});
  const q = (box, i = 0) => box.questions[i].question;
  assert.deepEqual(B.readAnswers("mode", { answers: { [q(B.modeBox(s))]: "Hand-off" } }), { values: { mode: "handoff" } });
  assert.deepEqual(B.readAnswers("mode", { answers: { [q(B.modeBox(null, { first: true }))]: "Off" } }), { values: { mode: "off" } });
  assert.ok(B.readAnswers("mode", { answers: { [q(B.modeBox(s))]: "switch it off please" } }).invalid);
  assert.ok(B.readAnswers("mode", {}).invalid);
  assert.deepEqual(B.readAnswers("models", { answers: { [q(B.modelsBox(s))]: "Opus 5 + Sonnet 5" } }), { values: { models: "opus-plus-sonnet" } });
  const hb = B.handoffBox(s);
  const all = { [q(hb, 0)]: "Opus 5 (Recommended)", [q(hb, 1)]: "Flash 3.8", [q(hb, 2)]: "Sonnet 5", [q(hb, 3)]: "Keep in chat" };
  assert.deepEqual(B.readAnswers("handoff", { answers: all }), { values: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat" } });
  const one = B.readAnswers("handoff", { answers: { ...all, [q(hb, 2)]: "GPT" } });
  assert.equal(one.invalid.length, 1, "the one bad row is named");
  assert.equal(one.values, undefined, "and nothing is saved");
  assert.ok(B.readAnswers("nothing", { answers: all }).invalid);
});
