#!/usr/bin/env node
/**
 * The zero-touch settings box, in the chat: the hooks around Claude Code's question tool (AskUserQuestion).
 *
 * argv[2] is the moment:
 *   pre-ask     before a box is shown (PreToolUse, AskUserQuestion)
 *   post-ask    after the person answered it (PostToolUse, AskUserQuestion)
 *   prompt      a message the person sent (UserPromptSubmit)
 *   pre-any     any other tool, in the first chat after install only (PreToolUse, every tool; the shell script skips
 *               node entirely unless that chat is waiting for its first settings)
 *
 * What it guarantees (the rules of 1 Oct 2026, and what the probes of that day showed):
 *   - Only a box about zero-touch is checked (scripts/boxes.mjs isZeroTouchBox). Claude's own questions and the
 *     workflows' approval steps pass untouched.
 *   - A zero-touch box must be exactly the one expected now, word for word: the mode box first; after "Workflows" the
 *     models box; after "Hand-off" the four hand-off questions. Anything else is refused before the person sees it,
 *     with the exact box in the refusal (the probes: every model then opens the exact one).
 *   - Only the fixed choices are saved, all or nothing, and only when the sequence is complete (Off completes it at the
 *     first box). The saved settings reach new chats; in the first chat after install they apply at once.
 *   - A helper agent never opens the settings: they belong to the main chat.
 *   - A closed box reaches no hook (probe of 1 Oct 2026), so it is noticed at the person's next message; the first
 *     chat's hold ends as soon as the box has been SHOWN, whatever the person then does, so nobody is ever stuck.
 *
 * Records (scripts/chat-files.mjs): zt_setup.json (first chat), zt_flow.json (a sequence in progress). The settings
 * themselves: scripts/settings.mjs. Always exits 0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boxKind, handoffBox, isZeroTouchBox, modeBox, modelsBox, readAnswers, sameBox } from "./boxes.mjs";
import { FILES, chatDir, drop, readJson, writeJson } from "./chat-files.mjs";
import { googleState, onlineCheck } from "./google.mjs";
import { canonicalModel, markChat, organisationModel } from "./mark.mjs";
import * as M from "./messages.mjs";
import { promptKind } from "./prompt-kind.mjs";
import { boxCurrent, clean, needsGoogle, readSettings, writeSettings } from "./settings.mjs";

/** The first chat's wait for its box ends at the latest at this many messages the transcript cannot place. */
const GIVE_UP_AFTER = 3;

/** Tools that change nothing: they may run while the first chat waits for its settings box. */
const CHANGES_NOTHING = new Set(["AskUserQuestion", "Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch", "TodoWrite", "TodoRead", "TaskList", "TaskGet", "WebFetch", "WebSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

const emit = (out) => process.stdout.write(JSON.stringify(out));
const deny = (reason) => emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

function state(sid, env) {
  const dir = chatDir(sid, env);
  return { setup: readJson(join(dir, FILES.setup)), flow: readJson(join(dir, FILES.flow)) };
}

/** The settings the boxes mark as current (settings.mjs boxCurrent): none in the first chat after install. */
function current(env, first) {
  return first ? null : boxCurrent(env);
}
/** The mode box for a later change in this chat, as things stand now. */
const laterBox = (env) => modeBox(current(env, false));
/** Whether any settings are saved (in this chat or another): the first chat's questions are over once there are. */
const anySaved = (env) => readSettings(env).state !== "none";

/** The boxes that may be shown now, in order of preference (the first is the one a refusal names). */
function expected(env, { setup, flow }) {
  const first = Boolean(setup);
  const now = current(env, first);
  const mode = modeBox(now, { first });
  if (flow?.pending === "workflows") return [modelsBox(now), mode];
  if (flow?.pending === "handoff") return [handoffBox(now), mode];
  return [mode];
}

function preAsk(input, env) {
  const questions = input.tool_input?.questions;
  if (!isZeroTouchBox(questions)) return;
  if (typeof input.agent_id === "string" && input.agent_id) return deny(M.HELPER_BOX_REASON);
  const sid = input.session_id;
  const st = state(sid, env);
  const allowed = expected(env, st);
  const match = allowed.find((box) => sameBox(questions, box));
  if (!match) return deny(M.wrongBoxReason(allowed[0]));
  // Shown: the first chat's hold ends here, whatever the person does next.
  if (st.setup && !st.setup.asked) writeJson(sid, FILES.setup, { asked: true }, env);
  writeJson(sid, FILES.flow, { pending: st.flow?.pending ?? null, shown: boxKind(questions), first: Boolean(st.setup) }, env);
}

function postAsk(input, env) {
  const questions = input.tool_input?.questions;
  if (!isZeroTouchBox(questions) || (typeof input.agent_id === "string" && input.agent_id)) return;
  const kind = boxKind(questions);
  if (!kind) return;
  const sid = input.session_id;
  const st = state(sid, env);
  const first = Boolean(st.setup);
  const before = readSettings(env);
  const base = before.state === "ok" ? before.settings : clean({});
  const got = readAnswers(kind, input.tool_response);
  const endFlow = () => drop(sid, FILES.flow, env);
  if (got.invalid) {
    endFlow();
    if (first) drop(sid, FILES.setup, env);
    return emit({ systemMessage: M.notAChoiceLine(got.invalid[0]?.answer, base, { first }), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.notSavedNote(laterBox(env)) } });
  }
  if (kind === "mode" && got.values.mode !== "off") {
    const mode = got.values.mode;
    // The same rule the check before a box uses (expected): the box named here is the one it will let through.
    const next = mode === "workflows" ? modelsBox(current(env, first)) : handoffBox(current(env, first));
    writeJson(sid, FILES.flow, { pending: mode, shown: null, first }, env);
    return emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: M.nextBoxNote(mode, next) } });
  }
  // A complete answer: Off from the first box, or the second box after the mode.
  let settings;
  if (kind === "mode") settings = { ...base, mode: "off" };
  else if (kind === "models") {
    if (st.flow?.pending !== "workflows") return; // not in a sequence: the pre-ask check never shows it
    settings = { ...base, mode: "workflows", workflows: { models: got.values.models } };
  } else {
    if (st.flow?.pending !== "handoff") return;
    const { chat_model, documents, tests, repeats } = got.values;
    settings = { ...base, mode: "handoff", handoff: { chat_model, documents, tests, repeats } };
  }
  const saved = writeSettings(settings, env);
  endFlow();
  let note = M.savedNote(saved, { first, box: laterBox(env) });
  if (first) {
    // The first chat after install: the settings apply to this chat now.
    drop(sid, FILES.setup, env);
    const marked = markChat(sid, saved, { model: canonicalModel(input.model) || null, env });
    if (marked.mode === "b") note = `${note}\n\n${M.rulesNote(marked.stamp)}`;
  }
  let google = null;
  if (needsGoogle(saved)) {
    const g = googleState(env);
    if (!g.connected) google = g;
    else {
      const live = onlineCheck(env);
      if (live.result === "refused") google = { ...g, online: "refused", detail: live.detail };
    }
  }
  // An organisation's pinned model holds a Hand-off chat whatever was chosen: the line names the model that will run.
  const orgModel = saved.mode === "handoff" ? organisationModel(env) : null;
  emit({ systemMessage: M.savedLine(saved, { first, google, orgModel }), hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } });
}

function prompt(input, env) {
  // Only a message the person typed while the chat was idle says anything about the box (prompt-kind.mjs): a notice
  // Claude Code queues, or a message typed while Claude works (delivered into the running turn, where a sequence may
  // be half done), is left alone (1 Oct 2026, found in review: either one ended a sequence the person was still in).
  // A message the transcript does not show yet ("unknown") ends nothing either; the first chat's wait counts it,
  // with a limit.
  const kind = promptKind(input);
  if (kind === "notice" || kind === "working") return;
  const sid = input.session_id;
  const st = state(sid, env);
  const out = (line, note) => emit({ ...(line ? { systemMessage: line } : {}), hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note } });
  const endAll = () => { drop(sid, FILES.setup, env); drop(sid, FILES.flow, env); };
  if (st.setup && anySaved(env)) {
    // The first chat after install, and the settings were saved in another chat meanwhile: this chat's questions are
    // over. It started without settings, so it stays without zero-touch, like any chat that is already open.
    endAll();
    return out(M.savedElsewhereLine(), M.savedElsewhereNote(laterBox(env)));
  }
  if (st.setup && !st.setup.asked) {
    const prompts = (st.setup.prompts ?? 0) + 1;
    if ((prompts >= 2 && kind === "idle") || prompts >= GIVE_UP_AFTER) {
      // A whole turn went by and the box was never shown (Claude did not open it, or the question tool is not
      // available here): zero-touch gives up in this chat, so nothing is held for ever (1 Oct 2026, found in review).
      // A new turn is known from a message the transcript shows as typed while idle; without that evidence, the
      // limit decides.
      endAll();
      return out(M.notShownLine(), M.notShownNote(laterBox(env)));
    }
    // The first chat after install: the box comes before anything else.
    writeJson(sid, FILES.setup, { ...st.setup, prompts }, env);
    return out(null, M.firstRunNote(modeBox(null, { first: true })));
  }
  // A choice left half done is said to be closed only on positive evidence of a new message ("idle").
  if (kind !== "idle") return;
  if (st.setup && st.setup.asked) {
    // The box was shown in the first chat and nothing was saved: it was closed. Zero-touch does nothing here.
    endAll();
    return out(M.closedLine(null, { first: true }), M.closedNote({ first: true, box: laterBox(env) }));
  }
  if (st.flow) {
    // A sequence that never completed: a box was closed, or the second one never opened. Nothing was saved.
    drop(sid, FILES.flow, env);
    const r = readSettings(env);
    return out(M.closedLine(r.settings), M.closedNote({ box: laterBox(env) }));
  }
}

function preAny(input, env) {
  const sid = input.session_id;
  const st = state(sid, env);
  if (!st.setup || st.setup.asked) return;
  const tool = String(input.tool_name ?? "");
  if (CHANGES_NOTHING.has(tool)) return;
  // Settings saved in another chat end this chat's hold at once (1 Oct 2026, found in review).
  if (anySaved(env)) return;
  deny(M.holdReason(modeBox(null, { first: true })));
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const moment = process.argv[2];
  if (moment === "pre-ask") return preAsk(input, env);
  if (moment === "post-ask") return postAsk(input, env);
  if (moment === "prompt") return prompt(input, env);
  if (moment === "pre-any") return preAny(input, env);
}

try { main(); } catch { /* a failure never blocks the chat */ }
