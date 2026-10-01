/**
 * The zero-touch settings box: its exact wording, which box comes next, and reading what the person clicked.
 *
 * The box is Claude Code's own multiple-choice question (the AskUserQuestion tool), opened by Claude when a chat's note
 * tells it to: in the first chat after install, and whenever the person asks to change zero-touch's settings. It is the
 * one picker a plugin can put in front of a person in the desktop app and the terminal alike (checked 30 Sep - 1 Oct
 * 2026: the desktop app has no plugin settings form and declines an MCP server's pop-up form).
 *
 * Always the same order: the mode first (MODE box), then, from its answer, the models for workflows (MODELS box) or
 * the four hand-off questions (HANDOFF box); Off needs nothing more. Every question names zero-touch, because the hook
 * checks only boxes that are about zero-touch: Claude asks its own questions with the same tool, and so do the
 * workflows at their approval steps, and those are never touched (a probe on 1 Oct 2026 caught an over-broad check
 * refusing Claude's own "which editor?" box).
 *
 * The limits of the tool: a header of at most 12 characters, 1 to 4 questions, 2 to 4 choices each. Claude Code adds
 * a free-text "Other" line of its own; an answer typed there is not one of the choices, so nothing is saved.
 *
 * The choice in force is marked "(your current choice)" at the end of its line, so a person who wants to change one
 * thing sees what to keep. The first chat after install marks nothing.
 */
import { CHAT_MODELS, KINDS, MODES, TYPISTS, WORKFLOW_MODELS, clean } from "./settings.mjs";

export const CURRENT = " (your current choice)";

const MODE_QUESTION = "How should zero-touch work in your new chats?";
const MODE_QUESTION_FIRST = "How should zero-touch work, starting with this chat?";
const MODE_LINES = {
  workflows: "Ask for a job in your own words (build an app, fix a bug, write tests…) and Claude runs a full workflow for it, waiting for your approval at each main step.",
  // No cost claim (1 Oct 2026): the next box can keep work in the chat, or pick Sonnet 5 for a Sonnet 5 chat.
  handoff: "Claude does the development itself. Simple writing work (new documents, tests, repeated changes) can go to another AI model you pick next, and is checked automatically.",
  off: "Claude works as normal. Nothing is started or handed off automatically.",
};
const MODELS_QUESTION = "Which AI models should zero-touch use for your workflows?";
const MODELS_LINES = {
  "opus-plus-flash-v38": "Opus 5 plans and reviews; Google's Flash 3.8 writes the code. The cheapest. Needs this computer connected to Google.",
  "opus-plus-sonnet": "Opus 5 plans and reviews; Sonnet 5 writes the code.",
  "opus-only-v5": "Opus 5 does everything. The most expensive.",
};
const HANDOFF_QUESTIONS = {
  chat_model: { header: "Chat model", question: "In your new zero-touch Hand-off chats, which model should do the development and decide what to hand off?" },
  documents: { header: "Documents", question: "In your new zero-touch Hand-off chats, who should write new documents, specs and plans (READMEs, guides, requirements, designs, plans, release notes)?" },
  tests: { header: "Tests", question: "In your new zero-touch Hand-off chats, who should write new tests?" },
  repeats: { header: "Repeats", question: "In your new zero-touch Hand-off chats, who should repeat a change across many files, after the chat model makes it in one file?" },
};
const CHAT_MODEL_LINES = {
  "claude-opus-5": "The best judgment, so the best development and the clearest instructions for the cheaper models.",
  "claude-sonnet-5": "Cheaper than Opus 5, with weaker judgment.",
};
const TYPIST_LINES = {
  flash: "Google's model, the cheapest. Checked automatically before anything is added to your project. Needs this computer connected to Google.",
  sonnet: "Costs more than Flash 3.8 and less than Opus 5. Checked the same way.",
  chat: "Nothing is handed off: the chat model does this work itself.",
};

/** One choice, marked when it is the one in force. */
const option = (label, line, isCurrent) => ({ label, description: isCurrent ? line + CURRENT : line });

/** The mode question. `current` is the saved settings (null in the first chat after install: nothing is marked). */
export function modeBox(current, { first = false } = {}) {
  const now = current ? clean(current).mode : null;
  return {
    questions: [{
      question: first ? MODE_QUESTION_FIRST : MODE_QUESTION,
      header: "Zero-touch",
      multiSelect: false,
      options: Object.keys(MODES).map((m) => option(MODES[m].label, MODE_LINES[m], m === now)),
    }],
  };
}

/** After "Workflows": which models run the workflows. */
export function modelsBox(current) {
  const now = current ? clean(current).workflows.models : null;
  return {
    questions: [{
      question: MODELS_QUESTION,
      header: "Models",
      multiSelect: false,
      options: Object.keys(WORKFLOW_MODELS).map((p) => option(WORKFLOW_MODELS[p].label, MODELS_LINES[p], p === now)),
    }],
  };
}

/** After "Hand-off": the chat model, then who types each kind of work. */
export function handoffBox(current) {
  const h = current ? clean(current).handoff : null;
  const chatModel = {
    ...HANDOFF_QUESTIONS.chat_model,
    multiSelect: false,
    options: Object.keys(CHAT_MODELS).map((m) => option(CHAT_MODELS[m].label, CHAT_MODEL_LINES[m], h?.chat_model === m)),
  };
  const kinds = KINDS.map((k) => ({
    ...HANDOFF_QUESTIONS[k],
    multiSelect: false,
    options: Object.keys(TYPISTS).map((t) => option(TYPISTS[t].label, TYPIST_LINES[t], h?.[k] === t)),
  }));
  return { questions: [chatModel, ...kinds] };
}

/** Which of the three boxes a box's questions are, by their question text: "mode", "models", "handoff" or null. */
export function boxKind(questions) {
  const texts = (Array.isArray(questions) ? questions : []).map((q) => q?.question);
  if (texts.length === 1 && (texts[0] === MODE_QUESTION || texts[0] === MODE_QUESTION_FIRST)) return "mode";
  if (texts.length === 1 && texts[0] === MODELS_QUESTION) return "models";
  const handoff = ["chat_model", ...KINDS].map((k) => HANDOFF_QUESTIONS[k].question);
  if (texts.length === handoff.length && texts.every((t, i) => t === handoff[i])) return "handoff";
  return null;
}

/** A choice that is a zero-touch setting: a mode, a model, or keeping work in the chat. */
const SETTINGS_CHOICE = /\b(workflows?|hand[\s-]?off|off|opus|sonnet|flash|haiku|keep in (the )?chat)\b/i;

/**
 * Whether a box is an attempt at the zero-touch settings: it names zero-touch (in a question or its title) AND offers
 * a settings choice. Only such a box is checked; every other box Claude opens (its own questions, a workflow's
 * approval step, a question that merely mentions zero-touch, such as "Should the README section on zero-touch go
 * before Setup?") passes untouched. Narrowed on 1 Oct 2026 after review: "names zero-touch" alone refused such
 * questions in every chat. A box that is caught but was not meant as the settings is told how to ask again
 * (messages.mjs wrongBoxReason), so nothing is ever stuck.
 */
export function isZeroTouchBox(questions) {
  const qs = (Array.isArray(questions) ? questions : []).filter((q) => q && typeof q === "object");
  const names = qs.some((q) => String(q.header ?? "").trim().toLowerCase() === "zero-touch" || /zero[\s-]?touch/i.test(String(q.question ?? "")));
  const offersSetting = qs.some((q) => (Array.isArray(q.options) ? q.options : []).some((o) => SETTINGS_CHOICE.test(String(o?.label ?? ""))));
  return names && offersSetting;
}

/** A box's questions as the person sees them: question, header, one choice or many, and each choice's words. */
function shape(questions) {
  return JSON.stringify((Array.isArray(questions) ? questions : []).map((q) => ({
    question: String(q?.question ?? ""),
    header: String(q?.header ?? ""),
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: String(o?.label ?? ""), description: String(o?.description ?? "") })),
  })));
}

/** Whether a box Claude opened is exactly the expected one, word for word (fields the person does not see aside). */
export function sameBox(questions, expected) {
  return shape(questions) === shape(expected.questions);
}

/**
 * What the person clicked, from the box's result (`tool_response.answers`: question text → the chosen label; read
 * from real runs on 1 Oct 2026). Returns { values } keyed by setting, or { invalid } naming the questions whose answer
 * is not one of the choices (typed in "Other", or missing). All or nothing: one bad answer saves nothing.
 */
export function readAnswers(kind, toolResponse) {
  const answers = toolResponse && typeof toolResponse === "object" ? toolResponse.answers : null;
  const got = (question) => (answers && typeof answers === "object" && typeof answers[question] === "string" ? answers[question].trim() : null);
  const find = (table, label) => Object.keys(table).find((key) => table[key].label === label) ?? null;
  const values = {};
  const invalid = [];
  const take = (setting, question, table) => {
    const label = got(question);
    const key = label === null ? null : find(table, label);
    if (key === null) invalid.push({ question, answer: label });
    else values[setting] = key;
  };
  if (kind === "mode") {
    const label = got(MODE_QUESTION) ?? got(MODE_QUESTION_FIRST);
    const key = label === null ? null : find(MODES, label);
    if (key === null) invalid.push({ question: MODE_QUESTION, answer: label });
    else values.mode = key;
  } else if (kind === "models") {
    take("models", MODELS_QUESTION, WORKFLOW_MODELS);
  } else if (kind === "handoff") {
    take("chat_model", HANDOFF_QUESTIONS.chat_model.question, CHAT_MODELS);
    for (const k of KINDS) take(k, HANDOFF_QUESTIONS[k].question, TYPISTS);
  } else {
    invalid.push({ question: null, answer: null });
  }
  return invalid.length ? { invalid } : { values };
}
