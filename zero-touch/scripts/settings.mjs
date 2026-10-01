/**
 * The person's zero-touch settings: what they chose in the settings box, kept by the zero-touch plugin itself.
 *
 * Why here, and why this shape (decided 1 Oct 2026):
 *   - A person never edits a file or types a command to set zero-touch up. They choose in Claude's own question box
 *     in the chat (scripts/boxes.mjs), which is the one picker the desktop app shows for a plugin; Claude Code's plugin
 *     settings form exists only in the terminal, and an MCP server's pop-up form is declined by the desktop app.
 *   - The choices live in this plugin's own data folder (${CLAUDE_PLUGIN_DATA}, `~/.claude/plugins/data/<id>/`),
 *     which Claude Code keeps across updates and deletes when the plugin is removed. So removing zero-touch forgets
 *     them, and installing it again asks again. Without that variable (a developer running the script by hand) the
 *     folder is `<MMO_HOME>/zero-touch/`.
 *   - Only the fixed choices of the box are ever stored. Anything else in the file is ignored, value by value, so one
 *     bad value never loses the others; a file that cannot be read at all is reported, and the standard choices are
 *     used for that chat (never a guess).
 *   - Written atomically (a temporary file, then a rename), so two chats saving at the same moment leave one whole
 *     file: the later save wins, and each chat's saved line says exactly what that chat saved.
 *
 * The file: { version: 1, mode, workflows: { models }, handoff: { chat_model, documents, tests, repeats }, saved_at }
 *   mode                 "workflows" | "handoff" | "off"
 *   workflows.models     the shipped policy the workflows run on (three of them are offered)
 *   handoff.chat_model   the model a hand-off chat is kept on
 *   handoff.<kind>       who types that kind of hand-off work: "flash" | "sonnet" | "chat" (kept in the chat)
 *
 * Self-contained on purpose: Claude Code copies each plugin on its own at install, so this plugin carries no code
 * of mmo's (see start-chat.mjs).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The three modes, as stored, and as the box names them. */
export const MODES = {
  workflows: { label: "Workflows", name: "Workflows mode" },
  handoff: { label: "Hand-off", name: "Hand-off mode" },
  off: { label: "Off", name: "Off" },
};

/**
 * The models a workflow can run on: three shipped policies. Each one passes the workflows' run-start check and routes
 * every step of all eight jobs to a current model (checked 1 Oct 2026 with the real router): planning and review on
 * Opus 5, and the writing on Flash 3.8, Sonnet 5 or Opus 5.
 */
export const WORKFLOW_MODELS = {
  "opus-plus-flash-v38": { label: "Opus 5 + Flash 3.8", says: "Opus 5 plans and reviews; Google's Flash 3.8 writes the code", usesFlash: true },
  "opus-plus-sonnet": { label: "Opus 5 + Sonnet 5", says: "Opus 5 plans and reviews; Sonnet 5 writes the code", usesFlash: false },
  "opus-only-v5": { label: "Opus 5 only", says: "Opus 5 does everything", usesFlash: false },
};

/** The models a hand-off chat can be kept on. */
export const CHAT_MODELS = {
  "claude-opus-5": { label: "Opus 5 (Recommended)", name: "Opus 5" },
  "claude-sonnet-5": { label: "Sonnet 5", name: "Sonnet 5" },
};

/**
 * Who types a kind of hand-off work. `policy` is the shipped policy whose stage for that kind routes to this typist
 * (the hand-off tools read the model from there, through the same router the workflows use); "chat" hands nothing off.
 */
export const TYPISTS = {
  flash: { label: "Flash 3.8", name: "Flash 3.8", policy: "opus-plus-flash-v38", usesFlash: true },
  sonnet: { label: "Sonnet 5", name: "Sonnet 5", policy: "opus-plus-sonnet", usesFlash: false },
  chat: { label: "Keep in chat", name: "kept in the chat", policy: null, usesFlash: false },
};

/** The three kinds of hand-off work a person chooses a typist for, in the box's order. */
export const KINDS = ["documents", "tests", "repeats"];

/** The standard settings: what a chat uses when the file cannot be read, and what the box marks before any choice. */
export const DEFAULTS = Object.freeze({
  mode: "workflows",
  workflows: Object.freeze({ models: "opus-plus-flash-v38" }),
  handoff: Object.freeze({ chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" }),
});

const FILE = "settings.json";
const MAX_BYTES = 16 * 1024;

/** The zero-touch home folder (the same rule as mmo's lib/paths.mjs). */
export function mmoHome(env = process.env) {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/** This plugin's own data folder, where the settings live. */
export function dataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.trim() ? env.CLAUDE_PLUGIN_DATA : join(mmoHome(env), "zero-touch");
}

export function settingsFile(env = process.env) {
  return join(dataDir(env), FILE);
}

const pick = (value, allowed, fallback) => (typeof value === "string" && Object.hasOwn(allowed, value) ? value : fallback);

/** A settings object with every value one of the fixed choices; anything else takes the standard value. */
export function clean(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const w = r.workflows && typeof r.workflows === "object" ? r.workflows : {};
  const h = r.handoff && typeof r.handoff === "object" ? r.handoff : {};
  return {
    mode: pick(r.mode, MODES, DEFAULTS.mode),
    workflows: { models: pick(w.models, WORKFLOW_MODELS, DEFAULTS.workflows.models) },
    handoff: {
      chat_model: pick(h.chat_model, CHAT_MODELS, DEFAULTS.handoff.chat_model),
      documents: pick(h.documents, TYPISTS, DEFAULTS.handoff.documents),
      tests: pick(h.tests, TYPISTS, DEFAULTS.handoff.tests),
      repeats: pick(h.repeats, TYPISTS, DEFAULTS.handoff.repeats),
    },
  };
}

/**
 * The person's settings: { state, settings }.
 *   state "none"        nothing saved yet: the first chat after install asks (settings are the standard ones)
 *   state "ok"          saved and read
 *   state "unreadable"  a file is there but cannot be read: the standard settings are used, and the person is told
 */
export function readSettings(env = process.env) {
  let text;
  try { text = readFileSync(settingsFile(env), "utf8"); } catch (err) {
    return err?.code === "ENOENT" ? { state: "none", settings: clean(DEFAULTS) } : { state: "unreadable", settings: clean(DEFAULTS) };
  }
  if (text.length > MAX_BYTES) return { state: "unreadable", settings: clean(DEFAULTS) };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unreadable", settings: clean(DEFAULTS) };
    return { state: "ok", settings: clean(parsed) };
  } catch {
    return { state: "unreadable", settings: clean(DEFAULTS) };
  }
}

/** Saves the settings whole, atomically. Returns what was saved. */
export function writeSettings(settings, env = process.env) {
  const saved = { version: 1, ...clean(settings), saved_at: new Date().toISOString() };
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${FILE}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, join(dir, FILE));
  return saved;
}

/** Whether these settings need Google (Flash 3.8) anywhere. */
export function needsGoogle(settings) {
  const s = clean(settings);
  if (s.mode === "workflows") return WORKFLOW_MODELS[s.workflows.models].usesFlash;
  if (s.mode === "handoff") return KINDS.some((k) => TYPISTS[s.handoff[k]].usesFlash);
  return false;
}

/**
 * The settings in one plain sentence, for the saved line and the start message:
 * "Workflows mode, Opus 5 + Flash 3.8" / "Hand-off mode on Opus 5; documents go to Flash 3.8, tests to Sonnet 5,
 * repeated changes stay in the chat" / "Off".
 */
/** An organisation's model as a person reads it: a known id by its name, anything else as written. */
function orgModelName(id) {
  const known = CHAT_MODELS[String(id).replace(/\[[^\]]*\]$/, "").trim()];
  return known ? known.name : String(id);
}

/**
 * The settings a settings box marks as the current choice: the saved file's, or null when nothing is saved or the file
 * cannot be read (nothing is marked then). Every box and every note that gives a box uses this one rule, so the box a
 * note gives Claude is the box the hook then expects (1 Oct 2026, found in review: notes built from the chat's marks or
 * from the standard settings made Claude's first try refused).
 */
export function boxCurrent(env = process.env) {
  const r = readSettings(env);
  return r.state === "ok" ? r.settings : null;
}

export function describe(settings, { orgModel = null } = {}) {
  const s = clean(settings);
  if (s.mode === "off") return "Off";
  if (s.mode === "workflows") return `Workflows mode, ${WORKFLOW_MODELS[s.workflows.models].label}`;
  const word = { documents: "documents", tests: "tests", repeats: "repeated changes" };
  // "documents go to Flash 3.8, tests to Sonnet 5, repeated changes stay in the chat": the verb once, as a person says it.
  const parts = KINDS.map((k, i) => {
    const t = s.handoff[k];
    return t === "chat" ? `${word[k]} stay in the chat` : `${word[k]} ${i === 0 ? "go " : ""}to ${TYPISTS[t].name}`;
  });
  // An organisation's pinned model holds a Hand-off chat whatever the person chose (mark.mjs handoffStamp), so a line
  // that says which model a chat runs on names that one (1 Oct 2026, found in review).
  const chat = orgModel ? `${orgModelName(orgModel)} (the model your organisation set)` : CHAT_MODELS[s.handoff.chat_model].name;
  return `Hand-off mode on ${chat}; ${parts.join(", ")}`;
}
