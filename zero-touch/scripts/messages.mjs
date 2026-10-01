/**
 * Everything the zero-touch plugin says: the start message a person sees at the top of a chat, the lines after a
 * settings box, and the notes Claude reads (the person never sees those).
 *
 * The wording is the final proposal of 1 Oct 2026 (task folder, MESSAGES-REVIEW.md v2), written for a person with no
 * context and no technical knowledge. Its rules: true every time it is shown; what happened, why, and what to do now;
 * one word per thing (Workflows / Hand-off / Off, workflow, approval step, hand off, chat model, checked
 * automatically, zero-touch settings); no file to edit and no command to learn, except the few a person must type,
 * given in full; money said when money is spent; "this chat" and "new chats" never mixed up. The one way to change
 * anything, in every mode, is to type "change zero-touch settings" (any wording works: it only opens the box).
 */
import { CHAT_MODELS, KINDS, TYPISTS, WORKFLOW_MODELS, clean, describe } from "./settings.mjs";

export const CHANGE = "change zero-touch settings";
/** The eight jobs that get a full workflow, as the person reads them (one list, used wherever they are named). */
const JOBS = "build a new app, fix a bug, add to a feature, build a new feature, clean up code, write tests, write documentation, upgrade a library";

// ─── Start messages ──────────────────────────────────────────────────────

/** The first chat after install, nothing chosen yet. */
export function welcomeMessage() {
  return [
    "Welcome to zero-touch. It lets Claude give parts of the work to AI models that cost less than Opus 5, with no special commands to learn.",
    "Before Claude answers your first message, it will ask you a few quick questions: how zero-touch should work, and which AI models to use. Your answers apply straight away, starting with this chat.",
    `You can change them at any time: type "${CHANGE}".`,
  ].join("\n");
}

/** A chat with no screen (a script's `claude -p` run) and nothing chosen yet: zero-touch waits for a normal chat. */
export function noSettingsMessage() {
  return `Zero-touch has no settings yet, so it is doing nothing in this run. Open Claude in a normal chat and type "${CHANGE}" to choose them.`;
}

/** The settings file cannot be read: the standard settings are used for this chat. */
export function unreadableLine() {
  return `• Zero-touch couldn't read your settings, so it's using the standard ones this time (${describe({})}). To set them again, type "${CHANGE}".`;
}

/** The project has its own model rules file, which zero-touch does not follow. */
export function folderPolicyLine() {
  return "• This project has its own AI-model rules file (routing-policy.yaml), probably added by your team. Zero-touch doesn't follow it; it uses your settings above. (Workflows you start by typing a command do use it.)";
}

/**
 * Google cannot be used and the settings use Flash 3.8. `g` is google.mjs's answer: { state, detail } offline, plus
 * `online: "refused"` when the one real check at save time was refused.
 */
export function googleLine(settings, g = {}) {
  const s = clean(settings);
  // Hand-off: a Flash hand-off fails at once without Google, and the ladder's last attempt is the chat's own model,
  // or, if that fails too, the chat does the piece itself. "This chat's model" is true in both cases, and also when an
  // organisation keeps the chat on a model other than the one chosen in the box (1 Oct 2026).
  // Workflows: with no Google login a workflow does not start (route-flow.mjs startProblem, checked offline). A login
  // that exists but that Google refused passes that offline check, so the workflow starts and its Flash steps fail
  // (the start-up check builds the model's connection, it does not call it): said as such (1 Oct 2026, found in review).
  const until = s.mode !== "workflows"
    ? "work set to Flash 3.8 is done by this chat's model instead"
    : g.online === "refused" ? "workflows can't use Flash 3.8: they may stop, or use a more expensive model for those steps" : "workflows won't start";
  const fix = `To fix it, run "gcloud auth application-default login" in a terminal and sign in, or ask Claude: "help me connect Google for zero-touch". Or type "${CHANGE}" and choose models without Flash.`;
  if (g.online === "refused") return `• Google refused this computer's login just now${g.detail ? ` (${g.detail})` : ""}, so Google's Flash 3.8 can't be used yet. Until it's fixed, ${until}. ${fix}`;
  if (g.state === "broken") return `• A Google login is set up on this computer but can't be used${g.detail ? ` (${g.detail})` : ""}, so Google's Flash 3.8 can't be used yet. Until it's fixed, ${until}. ${fix}`;
  return `• Google's Flash 3.8 can't be used yet, because this computer isn't connected to Google. Until it is, ${until}. To fix it, ask Claude: "help me connect Google for zero-touch". Or type "${CHANGE}" and choose models without Flash.`;
}

/** Workflows mode. `policy` is the chat's stamped policy name. */
export function workflowMessage({ policy, extra = [] }) {
  const m = WORKFLOW_MODELS[policy] ?? WORKFLOW_MODELS["opus-plus-flash-v38"];
  return [
    "Zero-touch is on in this chat: Workflows mode.",
    `• When you ask for one of these jobs in your own words, Claude starts a full workflow for it: ${JOBS}.`,
    "• A workflow works in steps and waits for your approval at the main ones (for a new app: requirements, design, security review, final check). It uses several AI models and costs more than a normal chat. The report at the end shows what it cost.",
    `• Your models: ${m.says}.`,
    "• Anything else you type gets a normal answer from Claude.",
    ...extra,
    `• To change how zero-touch works, type "${CHANGE}". Changes apply from your next new chat.`,
  ].join("\n");
}

/** The kinds of hand-off work, as the start message and the rules note name them. */
const KIND_WORDS = {
  documents: "new documents, specs and plans",
  tests: "new tests",
  repeats: "the same change repeated in many files",
};

/** The kinds of work a Hand-off stamp hands off (not kept in the chat). */
function handedKinds(stamp) {
  return KINDS.filter((k) => (stamp.typists?.[k]?.typist ?? "chat") !== "chat");
}

/**
 * Whether every kind handed off goes to a model that costs less per token than the chat's model: Flash 3.8 < Sonnet 5
 * < Opus 5 on the dated price list. Only then may a message call the typists cheaper. Unknown chat model (an
 * organisation's pin): no claim (1 Oct 2026: "Sonnet 5 chat, Sonnet 5 typist" made "a cheaper model" false).
 */
const PRICE_RANK = { flash: 1, sonnet: 2, "claude-sonnet-5": 2, "claude-opus-5": 3 };
function typistsCheaper(stamp) {
  const chat = PRICE_RANK[stamp.chat_model];
  const handed = handedKinds(stamp);
  return Boolean(chat) && handed.length > 0 && handed.every((k) => PRICE_RANK[stamp.typists[k].typist] < chat);
}

/** The chat-model line of a Hand-off chat. `model` is the model the chat is on now, when known. */
export function chatModelLine(stamp, model) {
  const want = stamp.chat_model;
  const name = modelName(want);
  if (stamp.pin === "admin") return `• This chat stays on ${stamp.chat_model ? name : stamp.admin_model}, the model your organisation set.`;
  if (model && model !== want) {
    return `• Hand-off mode needs this chat on ${name}, but it's on ${modelName(model)} right now. Switch it using the model menu next to the message box (in the terminal, type /model ${want}). After that, switching away is blocked.`;
  }
  if (!model) return `• Hand-off mode needs this chat on ${name}. If it's on a different model, switch it using the model menu next to the message box (in the terminal, type /model ${want}).`;
  // Savings and hand-off decisions are named only when something is handed off (all kept in the chat: neither exists).
  const handsOff = handedKinds(stamp).length > 0;
  if (want === "claude-opus-5") {
    return handsOff
      ? "• This chat stays on Opus 5, because good development and good hand-off decisions need its judgment; the savings come from the cheaper models doing the writing. Switching this chat to another model is blocked."
      : "• This chat stays on Opus 5, because good development needs its judgment. Switching this chat to another model is blocked.";
  }
  return `• This chat stays on ${name}, as you chose. The quality of ${handsOff ? "the development and the hand-offs" : "the work"} depends on this model; Opus 5 gives the best results. Switching this chat to another model is blocked.`;
}

/** Hand-off mode. */
export function handoffMessage(stamp, model, { extra = [] } = {}) {
  const chat = modelName(stamp.chat_model ?? stamp.admin_model);
  const rows = KINDS.map((k) => {
    const t = stamp.typists?.[k]?.typist ?? "chat";
    if (t === "chat") return `  – ${KIND_WORDS[k]}: kept in this chat (${chat} does it)`;
    const who = t === "flash" ? "Google's Flash 3.8" : TYPISTS[t].name;
    return `  – ${KIND_WORDS[k]}: ${who}${k === "tests" ? " (tests are only added if they pass in a test copy of your project)" : ""}`;
  });
  // What is handed off, said only as far as it is true (1 Oct 2026): "cheaper" only when every typist costs less
  // than the chat's model; nothing about hand-offs when the person keeps all three kinds in the chat.
  const work = handedKinds(stamp).length === 0
    ? [`• Nothing is handed off, because you chose to keep all of it in this chat: new documents, specs and plans, new tests, and the same change repeated in many files are all done by ${chat} here.`]
    : [
        `• Simple writing work is handed off to the AI model you chose for it${typistsCheaper(stamp) ? `, which costs less than ${chat}` : ""}, and checked automatically before it's added to your project:`,
        ...rows,
        // The last attempt is the chat's own model; when an organisation keeps the chat on a model that is not one
        // named id (an alias), the server uses the policy's Claude model instead, so no model is named for it.
        `• ${chat} decides what to hand off and gives that model clear instructions. If a hand-off fails twice, ${stamp.chat_model ? `${chat} tries once more itself` : "Claude tries once more"}; if that fails too, ${chat} does the work directly in this chat. Anything a hand-off adds to your project can be undone: just ask Claude.`,
      ];
  return [
    "Zero-touch is on in this chat: Hand-off mode.",
    `• ${chat}, this chat's model, does the real development work itself: understanding your project, deciding what to do, writing and fixing code, and reviewing.`,
    ...work,
    chatModelLine(stamp, model),
    "• In this mode, asking for a job in your own words doesn't start a full workflow; Claude simply does the work in this chat.",
    ...extra,
    `• To change how zero-touch works, type "${CHANGE}". Changes apply from your next new chat.`,
  ].join("\n");
}

/** Off mode. */
export function offMessage() {
  return [
    "Zero-touch is off in this chat, as you chose. Claude works as normal: nothing is started or handed off automatically.",
    `To turn zero-touch back on, type "${CHANGE}". It applies from your next new chat.`,
    "To remove zero-touch completely, remove it from your plugins list.",
  ].join("\n");
}

/** zero-touch starts in a chat whose mmo plugin is switched off or missing (a backstop; see start-chat.mjs). */
export function mmoMissingMessage() {
  return "Zero-touch can't work right now, because a plugin it needs, mmo, is switched off or missing. Switch mmo back on in your plugins list, or remove zero-touch as well.";
}

/** Node.js is not installed (said once per computer, by the hook's shell script, which cannot run this file). */
export const NODE_MISSING = "Zero-touch can't run on this computer, because a program it needs, Node.js, isn't installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat.";

// ─── After the settings box ──────────────────────────────────────────────

/**
 * Saved. `first` is the first chat after install, where the settings apply to this chat too. `google` is set when
 * the settings use Flash and Google cannot be used (google.mjs: the offline state, or the real check refused), so the
 * person hears it the moment they choose, not when a workflow later fails.
 */
export function savedLine(settings, { first = false, google = null, orgModel = null } = {}) {
  const s = clean(settings);
  const warn = google ? `\n${googleLine(s, google).replace(/^• /, "")}` : "";
  const what = describe(s, { orgModel });
  if (!first) return `Zero-touch: your settings are saved. From your next new chat: ${what}. This chat carries on as it started.${warn}`;
  // The first message arrived before there were settings, so zero-touch never judged it; only a message sent now is
  // judged, and only a job gets a workflow (1 Oct 2026, found in review: this once promised a workflow for any message).
  const tail = s.mode === "workflows"
    ? ` Send your request again: if it asks for one of these jobs, zero-touch starts a full workflow for it: ${JOBS}. Anything else gets a normal answer.`
    : " Claude now answers your message.";
  return `Zero-touch: your settings are saved and apply from now on, in this chat too: ${what}.${tail}${warn}`;
}

/** An answer typed in "Other" (or no answer): nothing saved. */
export function notAChoiceLine(answer, settings, { first = false } = {}) {
  const said = typeof answer === "string" && answer ? `"${answer}" isn't one of the choices, so nothing was changed.` : "No choice was made, so nothing was changed.";
  if (first) return `Zero-touch: ${said} Zero-touch won't do anything in this chat; it will ask again in your next new chat, or type "${CHANGE}" at any time.`;
  return `Zero-touch: ${said} Your settings are still: ${describe(settings)}. To try again, type "${CHANGE}".`;
}

/** The box was closed (seen at the next message: Claude Code tells no hook about a closed box). */
export function closedLine(settings, { first = false } = {}) {
  if (first) return `Zero-touch: nothing was saved, so zero-touch won't do anything in this chat. It will ask again in your next new chat, or type "${CHANGE}" at any time.`;
  return `Zero-touch: nothing was changed. Your settings are still: ${describe(settings)}.`;
}

// ─── Notes Claude reads ──────────────────────────────────────────────────

const exactly = (box) => `the AskUserQuestion tool, passing exactly this input, word for word: ${JSON.stringify(box)}`;

/** Every chat, every mode (Off included): how the settings are opened. `box` is the mode box as it stands now. */
export function settingsNote(box) {
  return [
    "Zero-touch settings: if the person asks to change how zero-touch works (its mode, its models, which model does the writing, turning it on or off), open the zero-touch settings box with " + exactly(box) + ".",
    "Do not change any setting another way (no files, no commands), and do not describe the choices yourself: the box does. If the request is not about zero-touch, do not open this box.",
    "After the person answers, follow the note that comes back.",
  ].join(" ");
}

/** The first chat after install: the box comes before anything else. */
export function firstRunNote(box) {
  return [
    "Zero-touch was just installed and has no settings yet. Before you answer the person's first message or use any other tool, open the zero-touch settings box with " + exactly(box) + ".",
    "Tools that change anything are blocked until the box has been shown. Do not describe the choices yourself: the box does. After the person answers, follow the note that comes back.",
  ].join(" ");
}

/** After the mode answer: the next box. */
export function nextBoxNote(mode, box) {
  return `The person chose ${mode === "handoff" ? "Hand-off" : "Workflows"} in the zero-touch settings. Nothing is saved yet. Now open the next zero-touch settings box with ${exactly(box)}. Do nothing else first.`;
}

/**
 * The box for a later change in this chat, as it stands after what just happened (a save, a closed box, a refused
 * answer): the box Claude was given at the chat's start may no longer be the expected one (1 Oct 2026).
 */
const laterChange = (box) => (box ? ` If the person later asks to change how zero-touch works, open the zero-touch settings box with ${exactly(box)}.` : "");

export function savedNote(settings, { first = false, box = null } = {}) {
  const s = clean(settings);
  if (!first) return `The zero-touch settings are saved: ${describe(s)}. They apply from the person's next new chat; this chat carries on as it started. The person has already been shown a line saying so; confirm in one short sentence at most.${laterChange(box)}`;
  if (s.mode === "workflows") {
    return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now. The person's first message arrived before zero-touch had any settings, so zero-touch could not judge whether it is a workflow job. The person has been asked to send it again, so zero-touch can judge it: do not do that request yourself now, and say nothing more than one short sentence.${laterChange(box)}`;
  }
  return `The zero-touch settings are saved (${describe(s)}) and apply to this chat now. Now answer the person's first message.${laterChange(box)}`;
}

export function notSavedNote(box = null) {
  return `Nothing was saved in the zero-touch settings: the answer was not one of the choices. The person has been shown a line saying so. Do not change any setting another way.${laterChange(box)}`;
}

export function closedNote({ first = false, box = null } = {}) {
  return (first
    ? "The person closed the zero-touch settings box, so nothing was saved and zero-touch does nothing in this chat. Answer their message normally."
    : "The zero-touch settings box was closed without an answer, so nothing was changed. Answer the person's message normally.") + laterChange(box);
}

/** The first chat after install, while another chat saved the settings: this chat's questions are over (1 Oct 2026). */
export function savedElsewhereLine() {
  return "Zero-touch: your settings were just saved in another chat. They apply from your next new chat; this chat carries on without zero-touch.";
}
export function savedElsewhereNote(box) {
  return `The zero-touch settings were saved in another chat, so this chat's first questions are over: do not open the settings box now. This chat has no zero-touch; answer the person normally.${laterChange(box)}`;
}

/**
 * The first chat after install, where a whole turn went by and the box was never shown (Claude did not open it, or the
 * question tool is not available here): zero-touch gives up in this chat, so nothing is held for ever (1 Oct 2026).
 */
export function notShownLine() {
  return `Zero-touch: its questions weren't shown in this chat, so zero-touch won't do anything here. It will ask again in your next new chat, or type "${CHANGE}" at any time.`;
}
export function notShownNote(box) {
  return `The zero-touch settings box was not shown, so zero-touch does nothing in this chat and nothing is blocked any more. Answer the person normally.${laterChange(box)}`;
}

/** The refusal a box gets when it is a zero-touch box but not the one expected now. */
export function wrongBoxReason(box) {
  return `This is not the zero-touch settings box as given, so nothing was shown to the person. If you meant to open the zero-touch settings, open them with ${exactly(box)}. If your question is about something else, ask it again without the word "zero-touch" in it.`;
}

export const HELPER_BOX_REASON = "The zero-touch settings belong to the main chat, so a helper does not open them. Carry on with your task.";

export function holdReason(box) {
  return `Zero-touch has no settings yet: open the zero-touch settings box first, with ${exactly(box)}. Other tools that change anything are blocked until it has been shown.`;
}

/**
 * The hand-off rules, built from who types each kind of work: work kept in the chat is Claude's own; the rest goes to
 * the hand-off tools of the mmo plugin (tools/test/zero-touch-handoff-tools.test.mjs proves they exist).
 */
export function rulesNote(stamp) {
  const t = (k) => stamp.typists?.[k]?.typist ?? "chat";
  const handed = [];
  if (t("documents") !== "chat") handed.push("- A NEW document (a README, a guide, an API reference, a changelog), a NEW spec (requirements, a design document, an API spec, a data-model write-up) or NEW planning text (a plan, a task breakdown or tickets, a status report, release notes): the write_document tool.");
  if (t("tests") !== "chat") handed.push("- NEW tests for code that exists: decide the cases yourself, then the write_tests_from_cases tool.");
  if (t("repeats") !== "chat") handed.push("- The same change in several files: make it yourself in ONE file, then the repeat_edit_across_files tool for the others.");
  const kept = KINDS.filter((k) => t(k) === "chat").map((k) => KIND_WORDS[k]);
  const lines = [
    "This chat is in zero-touch hand-off mode. You do the development yourself: reading, deciding, new code, bug fixes, refactors, reviews and answers.",
  ];
  if (handed.length) {
    lines.push(
      "These kinds of work are handed to another model through this plugin's hand-off tools, which check the result before anything reaches the project:",
      ...handed,
      "How to hand off: read what the tool's form needs, fill in every field with exact facts from the project (real paths, commands, names and values), and make one call. The form is a brief, never the finished text. The tool refuses a form with an empty field or a fact that is not in the project, and says what to fix. When it returns, read what it wrote before you tell the person it is done.",
      "Creating such a file yourself, with the Write tool or a shell command, is refused; a change to a file that exists is yours to make.",
      "When a tool reports that the hand-off failed or cannot run, do that piece yourself and say so in one line. When tests handed off do not pass, read the output the tool returns: correct a wrong case and hand off again; a real bug in the code under test you tell the person, and you never change a test to hide it.",
      "Every hand-off that changed the project has an id on its receipt; the undo_hand_off tool takes one back.",
    );
  }
  if (kept.length) lines.push(`The person chose to keep this work in the chat, so you do it yourself, with your own tools: ${kept.join("; ")}.`);
  lines.push("No full workflow starts from the person's plain words in this chat: do the work yourself.");
  return lines.join("\n");
}

/** A model's name as a person reads it. */
export function modelName(id) {
  if (!id) return "the chat's model";
  if (CHAT_MODELS[id]) return CHAT_MODELS[id].name;
  const m = /^claude-([a-z]+)-(\d+(?:[.-]\d+)?)/.exec(String(id));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace("-", ".")}` : String(id);
}
