#!/usr/bin/env node
/**
 * The zero-touch plugin's start hook: at the start of a chat it marks the chat with the person's zero-touch mode and
 * models, and tells the person what is in force.
 *
 * Claude Code runs it at SessionStart while the zero-touch plugin is enabled, and never while it is disabled (then
 * nothing of zero-touch runs, and nothing can be shown). The mmo plugin, which holds all of zero-touch's code, acts
 * only in a chat this hook marked (plugin/scripts/ambient/lib/chat-mode.mjs); what a mark holds is scripts/mark.mjs.
 *
 * Where the settings come from (1 Oct 2026): the person's choices in the zero-touch settings box, kept in this
 * plugin's own data folder (scripts/settings.mjs, scripts/boxes.mjs). No file to edit and no command: the person
 * types "change zero-touch settings" in any chat, in any mode, and Claude opens the box. The old mode file
 * (`<MMO_HOME>/mode`) and the hand-off settings in `<MMO_HOME>/ambient.json` are no longer read.
 *
 * At a fresh start (a new chat, /clear, which Claude Code gives a new chat id, or a fork, which is a new chat id too):
 *   nothing saved yet, and the run can show a box   the first chat after install: no mark yet; Claude opens the box
 *                                                    first (the settings hook holds other tools until it is shown)
 *   nothing saved yet, and no screen (claude -p)    no mark; the person is told to choose in a normal chat
 *   settings cannot be read                          the standard settings, and the person is told
 *   Off / Workflows / Hand-off                        the chat is marked accordingly (mark.mjs)
 * A compaction or a reopened chat keeps its marks and shows its start message again (the top of the chat may be out
 * of view), and gives Claude its notes again (a compaction drops them from what Claude reads).
 *
 * Every chat, every mode, Off included, gets the settings note: how to open the box. So the one way to change
 * anything always works. MMO_AMBIENT (off / observe / on) is a one-run override for a developer or a measuring setup.
 *
 * Self-contained on purpose: Claude Code gives each plugin its own copy of any file it links to at install, so this
 * plugin carries no code of mmo's. Always exits 0: a failure leaves the chat without zero-touch, never blocks it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modeBox } from "./boxes.mjs";
import { FILES, chatDir, drop, readJson, readText, writeJson, writeText } from "./chat-files.mjs";
import { googleState } from "./google.mjs";
import { canAsk, canonicalModel, hasFolderPolicy, markChat, mmoMissing, unmarkChat } from "./mark.mjs";
import * as M from "./messages.mjs";
import { DEFAULTS, boxCurrent, clean, needsGoogle, readSettings } from "./settings.mjs";

const FRESH_STARTS = ["startup", "clear", "fork"];

function reply(message, note) {
  const out = {};
  if (message) out.systemMessage = message;
  if (note) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: note };
  if (message || note) process.stdout.write(JSON.stringify(out));
}

/** The extra lines of a start message: the settings could not be read, the folder's own rules file, Google. */
function extras(settings, { unreadable, projectDir, env }) {
  const lines = [];
  if (unreadable) lines.push(M.unreadableLine());
  if (hasFolderPolicy(projectDir)) lines.push(M.folderPolicyLine());
  if (needsGoogle(settings)) {
    const g = googleState(env);
    if (!g.connected) lines.push(M.googleLine(settings, g));
  }
  return lines;
}

/** What a marked chat says and gives Claude: its start message and its notes. */
function sayMarked(marked, settings, { model, unreadable, projectDir, env }) {
  // The box the note gives is the one the settings hook expects: from the saved file, never from the chat's marks.
  const note = M.settingsNote(modeBox(boxCurrent(env)));
  const extra = extras(settings, { unreadable, projectDir, env });
  if (marked.mode === "off") return reply(unreadable ? `${M.offMessage()}\n${M.unreadableLine()}` : M.offMessage(), note);
  if (marked.mode === "on") return reply(M.workflowMessage({ policy: marked.policy, extra }), note);
  if (marked.mode === "observe") return undefined; // a measuring run: it only records
  return reply(M.handoffMessage(marked.stamp, model, { extra }), `${M.rulesNote(marked.stamp)}\n\n${note}`);
}

/**
 * The settings a marked chat was started with, read back from its own marks (never from the settings file: the chat
 * keeps what it started with). A record an older zero-touch wrote, without its models, reads as the standard ones.
 */
function marksOf(sid, env) {
  const dir = chatDir(sid, env);
  const mode = readText(join(dir, FILES.mode));
  if (mode === "on") {
    const policy = readJson(join(dir, FILES.workflow))?.policy;
    const s = clean({ mode: "workflows", workflows: { models: policy } });
    return { marked: { mode: "on", policy: s.workflows.models }, settings: s };
  }
  if (mode === "b") {
    const stamp = readJson(join(dir, FILES.handoff));
    const full = stamp?.typists ? stamp : { ...(stamp ?? {}), ...markedStampFallback(clean({ mode: "handoff", handoff: { chat_model: stamp?.chat_model } }), stamp?.policy), ...(stamp?.pin ? { pin: stamp.pin, admin_model: stamp.admin_model ?? null, chat_model: stamp.chat_model ?? null } : {}) };
    const h = full.typists;
    const s = clean({ mode: "handoff", handoff: { chat_model: full.chat_model, documents: h.documents?.typist, tests: h.tests?.typist, repeats: h.repeats?.typist } });
    return { marked: { mode: "b", stamp: full }, settings: s };
  }
  if (mode === "observe") return { marked: { mode: "observe" }, settings: clean(DEFAULTS) };
  if (readText(join(dir, FILES.off)) !== null) return { marked: { mode: "off" }, settings: clean({ mode: "off" }) };
  return null;
}

/**
 * A Hand-off stamp's typists for a record written before 1 Oct 2026, which named one policy for every kind of work:
 * Sonnet types when that policy was the Sonnet one, Flash otherwise (the shipped hand-off default).
 */
function markedStampFallback(s, oldPolicy) {
  const typist = oldPolicy === "opus-plus-sonnet" ? "sonnet" : "flash";
  const typists = {};
  for (const k of ["documents", "tests", "repeats"]) typists[k] = { typist, policy: typist === "sonnet" ? "opus-plus-sonnet" : "opus-plus-flash-v38" };
  return { chat_model: s.handoff.chat_model, pin: "setting", admin_model: null, typists };
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const sid = input.session_id;
  const projectDir = (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim()) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  // The model the chat is on, when Claude Code says so at this moment (it does not always).
  const model = canonicalModel(input.model) || null;
  const source = input.source ?? "startup";

  // A compaction or a reopened chat keeps its marks, and shows its start message again from them.
  if (!FRESH_STARTS.includes(source)) {
    const setup = readJson(join(chatDir(sid, env), FILES.setup));
    if (setup && !setup.asked) {
      if (readSettings(env).state === "none") return reply(M.welcomeMessage(), M.firstRunNote(modeBox(null, { first: true })));
      // Saved in another chat meanwhile: this chat's first questions are over, and it stays without zero-touch
      // (1 Oct 2026, found in review: a compaction days later showed the welcome again).
      drop(sid, FILES.setup, env);
      drop(sid, FILES.flow, env);
    }
    const kept = marksOf(sid, env);
    if (!kept) return reply(null, M.settingsNote(modeBox(boxCurrent(env))));
    let now = model;
    if (kept.marked.mode === "b") {
      if (now) writeText(sid, FILES.modelNow, now, env);
      else now = readText(join(chatDir(sid, env), FILES.modelNow)) || null;
    }
    return sayMarked(kept.marked, kept.settings, { model: now, unreadable: false, projectDir, env });
  }

  // A fresh start: a new chat id. Anything a settings box left here belongs to no one now.
  drop(sid, FILES.setup, env);
  drop(sid, FILES.flow, env);
  if (env.MMO_AMBIENT === "off") { unmarkChat(sid, env); return; }
  const r = readSettings(env);
  if (env.MMO_AMBIENT === "observe") { unmarkChat(sid, env); writeText(sid, FILES.mode, "observe", env); return; }
  if (env.MMO_AMBIENT === "on") {
    // A developer's override: workflows on, with the person's workflow models (or the standard ones).
    const marked = markChat(sid, { ...r.settings, mode: "workflows" }, { model, env });
    return sayMarked(marked, clean({ ...r.settings, mode: "workflows" }), { model, unreadable: r.state === "unreadable", projectDir, env });
  }
  if (mmoMissing(env)) {
    unmarkChat(sid, env);
    return reply(M.mmoMissingMessage(), M.settingsNote(modeBox(boxCurrent(env))));
  }
  if (r.state === "none") {
    unmarkChat(sid, env);
    if (canAsk(env)) {
      writeJson(sid, FILES.setup, { asked: false }, env);
      return reply(M.welcomeMessage(), M.firstRunNote(modeBox(null, { first: true })));
    }
    return reply(M.noSettingsMessage(), M.settingsNote(modeBox(null)));
  }
  const marked = markChat(sid, r.settings, { model, env });
  return sayMarked(marked, r.settings, { model, unreadable: r.state === "unreadable", projectDir, env });
}

try { main(); } catch { /* a failure leaves the chat without zero-touch, never blocks it */ }
