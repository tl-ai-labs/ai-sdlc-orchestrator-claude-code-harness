/**
 * Marking a chat with its zero-touch mode and models, from the person's settings. Used at a chat's start
 * (start-chat.mjs) and in the first chat after install, the moment its settings are saved (settings-hook.mjs).
 *
 * A chat is marked once and keeps its marks for its whole life (a compaction or a reopened chat keeps them; /clear
 * starts a new chat id, so a cleared conversation is marked afresh). Settings saved later reach new chats only. So a
 * chat's start message, its model guard and its hand-offs can never disagree, and one chat's costs never split across
 * two sets of models.
 *
 * What the mmo plugin (which holds all of zero-touch's code) reads:
 *   chat_mode       "on" = Workflows, "b" = Hand-off; no file = zero-touch does nothing in the chat
 *   workflow.json   { policy }: the shipped policy every workflow zero-touch starts in this chat runs on. A project's
 *                   own routing-policy.yaml and its saved choice in .sdlc/project.json are NOT used by zero-touch
 *                   (decided 1 Oct 2026: "whatever he picks from the box or the default, that is it"); commands a
 *                   person types still follow them.
 *   handoff.json    { chat_model, pin, admin_model, typists: { documents|tests|repeats: { typist, policy } }, policy }
 *                   typist is "flash", "sonnet" or "chat" (kept in the chat, policy null). `policy` is the first
 *                   handed-off kind's policy, kept for an older mmo that reads one policy for every kind.
 * An organisation's pinned model (managed settings `model`) outranks the person's chat model, as before.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FILES, drop, readJson, writeJson, writeText } from "./chat-files.mjs";
import { DEFAULTS, KINDS, TYPISTS, clean } from "./settings.mjs";

/** An exact model id, as a chat's pin must be (an alias follows whichever model is newest). */
const MODEL_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._:@/-]{2,100}$/;

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
export function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/** Where an organisation's settings live on this machine; MMO_MANAGED_SETTINGS names another file for tests. */
export function managedSettingsFile(env = process.env) {
  if (env.MMO_MANAGED_SETTINGS && env.MMO_MANAGED_SETTINGS.trim()) return env.MMO_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** The model an organisation's managed settings pin every chat to, or null when there is none. */
export function organisationModel(env = process.env) {
  const admin = readJson(managedSettingsFile(env))?.model;
  return typeof admin === "string" && admin.trim() ? admin.trim() : null;
}

/** A Hand-off chat's stamp from the settings (and the organisation's pinned model, when there is one). */
export function handoffStamp(settings, env = process.env) {
  const h = clean(settings).handoff;
  let chat_model = h.chat_model;
  let pin = "setting";
  let admin_model = null;
  const admin = organisationModel(env);
  if (admin) {
    pin = "admin";
    admin_model = admin;
    // Written as an alias it cannot be compared with the model a chat is on, so nothing is pinned: the
    // organisation's own setting holds the chat.
    chat_model = MODEL_ID.test(canonicalModel(admin_model)) ? canonicalModel(admin_model) : null;
  }
  const typists = {};
  for (const k of KINDS) typists[k] = { typist: h[k], policy: TYPISTS[h[k]].policy };
  const first = KINDS.map((k) => typists[k].policy).find(Boolean) ?? DEFAULTS.workflows.models;
  return { chat_model, pin, admin_model, typists, policy: first, policy_file: null };
}

/**
 * Marks the chat from the settings. Returns what was written: { mode: "on"|"b"|"off", policy?, stamp? }.
 * The record is written last, so whatever reads the record finds the chat's models already there.
 */
export function markChat(sid, settings, { model = null, env = process.env } = {}) {
  const s = clean(settings);
  for (const f of [FILES.workflow, FILES.handoff, FILES.models, FILES.modelNow, FILES.off]) drop(sid, f, env);
  if (s.mode === "off") {
    drop(sid, FILES.mode, env);
    writeText(sid, FILES.off, "off", env);
    return { mode: "off" };
  }
  if (s.mode === "workflows") {
    writeJson(sid, FILES.workflow, { policy: s.workflows.models }, env);
    writeText(sid, FILES.mode, "on", env);
    return { mode: "on", policy: s.workflows.models };
  }
  const stamp = handoffStamp(s, env);
  writeJson(sid, FILES.handoff, stamp, env);
  if (model) writeText(sid, FILES.modelNow, canonicalModel(model), env);
  writeText(sid, FILES.mode, "b", env);
  return { mode: "b", stamp };
}

/** Removes every zero-touch mark from a chat (it has no zero-touch). */
export function unmarkChat(sid, env = process.env) {
  for (const f of [FILES.mode, FILES.workflow, FILES.handoff, FILES.models, FILES.modelNow, FILES.off]) drop(sid, f, env);
}

// ─── Facts the start message needs ───────────────────────────────────────

/** Whether the project folder has its own model rules file (zero-touch does not follow it; the start message says so). */
export function hasFolderPolicy(projectDir) {
  return typeof projectDir === "string" && projectDir !== "" && existsSync(join(projectDir, "routing-policy.yaml"));
}

/**
 * Whether Claude Code can show a question box in this run: false for a run with no screen (`claude -p` is labelled
 * "sdk-cli", the Agent SDK "sdk-ts" / "sdk-py"; read in Claude Code's own code, 1 Oct 2026). Such a run gets no
 * first-chat questions and no hold. A run started from inside another Claude chat inherits that chat's label.
 */
export function canAsk(env = process.env) {
  return !["sdk-cli", "sdk-ts", "sdk-py"].includes(String(env.CLAUDE_CODE_ENTRYPOINT ?? ""));
}

/**
 * A backstop, never an alarm: true only when Claude Code's own records say the mmo plugin (which holds all of
 * zero-touch's code) is switched off, or is installed at a folder that no longer exists. Claude Code refuses to switch
 * mmo off while zero-touch needs it in the terminal, and switches zero-touch off at the next load when it is off
 * anyway; this catches what gets past both (the desktop app's switch, a hand-edited settings file, a broken install).
 * Anything it cannot read, or a setup that does not list mmo at all (a developer's --plugin-dir), counts as fine.
 */
export function mmoMissing(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  // An mmo from any marketplace that is on and present means fine: an old entry from another marketplace, switched
  // off, is not an alarm.
  const enabled = readJson(join(configDir, "settings.json"))?.enabledPlugins;
  const states = enabled && typeof enabled === "object" ? Object.entries(enabled).filter(([key]) => /^mmo@/.test(key)).map(([, on]) => on) : [];
  if (states.includes(false) && !states.includes(true)) return true;
  const installed = readJson(join(configDir, "plugins", "installed_plugins.json"))?.plugins;
  if (installed && typeof installed === "object") {
    const paths = Object.entries(installed)
      .filter(([key, entries]) => /^mmo@/.test(key) && Array.isArray(entries))
      .flatMap(([, entries]) => entries.map((e) => e?.installPath).filter((p) => typeof p === "string" && p));
    if (paths.length && !paths.some((p) => existsSync(p))) return true;
  }
  return false;
}
