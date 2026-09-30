#!/usr/bin/env node
/**
 * The zero-touch plugin's start hook: at the start of a chat it decides once which zero-touch mode the chat has, and
 * tells the person.
 *
 * Claude Code runs it at SessionStart while the zero-touch plugin is enabled, and never while it is disabled (then
 * nothing of zero-touch runs, and nothing can be shown). The chat's mode is its record
 * `<MMO_HOME>/sessions/<chat id>/chat_mode` (MMO_HOME defaults to ~/.mmo-ambient); the mmo plugin, which holds all of
 * zero-touch's code, acts only in a chat whose record exists (plugin/scripts/ambient/lib/chat-mode.mjs), and a chat
 * keeps its record for its whole life, so it is never half in one mode and half in another.
 *
 * At a fresh start (a new chat, or /clear) the person's mode file `<MMO_HOME>/mode` is read:
 *   a (or no file, or any other value)   workflow mode: plain words start the matching workflow; record "on"
 *   b                                    hand-off mode: the chat's own model does the development, and new docs,
 *                                        specs, plans, tests and repeated edits go to a cheaper model; record "b"
 *   off                                  no zero-touch in the chat; no record
 * A compaction or a reopened chat keeps the mode it has. MMO_AMBIENT, a one-run override for a developer or a
 * measuring setup, wins over the file: "off" removes the record, "observe" writes "observe", "on" is workflow mode.
 *
 * Hand-off mode has two settings, in the person's `<MMO_HOME>/ambient.json`: `handoff.chat_model` (the model the chat
 * is pinned to) and `handoff.policy` (the policy whose models do the hand-offs). They are read here, once, and
 * stamped on the chat as `sessions/<chat id>/handoff.json`; everything later reads the stamp, never the file, so a
 * change reaches the next new chat only. Two things outrank the person's settings: an organisation's pinned model
 * (managed settings `model`), and a policy file in the project (`routing-policy.yaml`), which a project uses to say
 * which models may see its code.
 *
 * The person sees one message (the hook's `systemMessage`, which Claude Code shows in the chat and does not give the
 * model): at a fresh start, and again after a compaction or when the chat is reopened, since the chat's first lines
 * may be out of view. In hand-off mode the chat's model also gets a note with the hand-off rules (the hook's
 * `additionalContext`), and gets it again after a compaction, which drops it from what the model reads. A run
 * switched off by MMO_AMBIENT and a measuring run that only records show nothing.
 *
 * Self-contained on purpose: Claude Code gives each plugin its own copy of any file it links to at install, so this
 * plugin carries no code of mmo's. The path rules below are the same as mmo's lib/paths.mjs, the policy it names
 * follows the workflow's own resolution, and its two hand-off defaults are the shipped ones;
 * tools/test/zero-touch-plugin.test.mjs and tools/test/zero-touch-handoff-start.test.mjs prove all three. Always
 * exits 0.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FRESH_STARTS = ["startup", "clear"];
/** The shipped policy a workflow, and a hand-off, uses when neither the project nor the person chose one. */
const DEFAULT_POLICY = "opus-plus-flash-v38";
/** The shipped model a hand-off chat is pinned to. */
const DEFAULT_CHAT_MODEL = "claude-opus-5";
const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * An exact model id, as a chat's pin must be: it carries a version ("claude-opus-5"). An alias ("opus") follows
 * whichever model is newest, so a chat pinned to one could not be compared with the model it is on.
 */
const MODEL_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._:@/-]{2,100}$/;

/** Same as mmo's lib/paths.mjs mmoHome(). */
function mmoHome(env) {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/** Same as mmo's lib/paths.mjs safeId(): a chat id that is not a plain token becomes a hash, never a path. */
function safeId(id) {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

/** A path under the person's home folder written with "~", as they would type it. */
function shown(path) {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/** The mode the person chose in <MMO_HOME>/mode: "off", "b" (hand-off), or workflow mode for a missing or any other value. */
function chosenMode(env) {
  let value = "";
  try { value = readFileSync(join(mmoHome(env), "mode"), "utf8").trim().toLowerCase(); } catch { /* no file: workflow mode */ }
  return value === "off" || value === "b" ? value : "a";
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * The policy this chat's workflows will use, as the workflow resolves it: a policy file in the project, else the
 * project's saved choice (in the folder or its git top folder), else the person's default, else the shipped default.
 */
function policyShown(projectDir, env) {
  if (existsSync(join(projectDir, "routing-policy.yaml"))) return "this project's routing-policy.yaml";
  const folders = [projectDir];
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    if (top && top !== projectDir) folders.push(top);
  } catch { /* not in a git repository */ }
  for (const dir of folders) {
    const saved = readJson(join(dir, ".sdlc", "project.json"))?.default_policy;
    if (typeof saved === "string" && POLICY_NAME.test(saved)) return saved;
  }
  const own = readJson(join(mmoHome(env), "ambient.json"))?.routing_defaults?.policy;
  if (typeof own === "string" && POLICY_NAME.test(own) && own !== DEFAULT_POLICY) return own;
  return `${DEFAULT_POLICY} (the default: Opus 5 plans and reviews, Flash 3.8 types)`;
}

/** What the person sees when a chat has workflow mode. */
function workflowMessage(projectDir, env) {
  const modeFile = shown(join(mmoHome(env), "mode"));
  const policy = policyShown(projectDir, env);
  return [
    "Zero-touch workflow mode is on for this chat.",
    "• Ask in plain words for a new app, a bug fix, a feature, a refactor, tests, docs or a dependency upgrade, and that workflow starts. Anything else is a normal Claude chat.",
    `• Policy: ${policy}. ${policy.startsWith("this project's") ? "To change it, edit that file" : "To use your own, put a policy file named routing-policy.yaml in this folder"}; it applies to the next workflow.`,
    `• To change the mode, put b (hand-off) or off in ${modeFile} and start a new chat.`,
    "• This mode lasts until /clear or a new chat.",
  ].join("\n");
}

function offMessage(env) {
  return `Zero-touch is off for this chat. To turn it on, put a (workflows from plain words) or b (hand-off) in ${shown(join(mmoHome(env), "mode"))} and start a new chat.`;
}

// ─── Hand-off mode ──────────────────────────────────────────────────────

/** Where an organisation's settings live on this machine (Claude Code's managed settings); MMO_MANAGED_SETTINGS names another file for tests. */
function managedSettingsFile(env) {
  if (env.MMO_MANAGED_SETTINGS && env.MMO_MANAGED_SETTINGS.trim()) return env.MMO_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/**
 * A hand-off chat's settings, read once: the model the chat is pinned to, and the policy whose models do the
 * hand-offs. `pin` says where the model came from ("admin", "setting" or "default"); `problems` names each setting
 * that was set aside, so the person is told and a typing mistake is never silent.
 *
 * An organisation's pinned model wins over the person's setting. Written as an alias it cannot be compared with the
 * model a chat is on, so `chat_model` is then null and this plugin pins nothing: the organisation's setting is what
 * holds the chat.
 */
function readHandoffSettings(projectDir, env) {
  const own = readJson(join(mmoHome(env), "ambient.json"))?.handoff;
  const set = own && typeof own === "object" && !Array.isArray(own) ? own : {};
  const problems = [];

  let chat_model = DEFAULT_CHAT_MODEL;
  let pin = "default";
  let admin_model = null;
  const admin = readJson(managedSettingsFile(env))?.model;
  if (typeof admin === "string" && admin.trim()) {
    pin = "admin";
    admin_model = admin.trim();
    chat_model = MODEL_ID.test(canonicalModel(admin_model)) ? canonicalModel(admin_model) : null;
  } else if (set.chat_model !== undefined) {
    if (typeof set.chat_model === "string" && MODEL_ID.test(canonicalModel(set.chat_model))) { chat_model = canonicalModel(set.chat_model); pin = "setting"; }
    else problems.push("chat_model");
  }

  let policy = DEFAULT_POLICY;
  if (set.policy !== undefined) {
    if (typeof set.policy === "string" && POLICY_NAME.test(set.policy)) policy = set.policy;
    else problems.push("policy");
  }
  // A policy file in the project wins over a name, as it does for a workflow: a project uses it to say which models
  // may see its code.
  const file = join(projectDir, "routing-policy.yaml");
  return { chat_model, pin, admin_model, policy, policy_file: existsSync(file) ? file : null, problems };
}

/** What the person sees when a chat has hand-off mode. `model` is the model the chat is on now, when known. */
function handoffMessage(h, model, env) {
  const home = mmoHome(env);
  const settingsFile = shown(join(home, "ambient.json"));
  let chat;
  if (h.pin === "admin") chat = `${h.chat_model ?? h.admin_model}, set by your organisation.`;
  else if (!model) chat = `${h.chat_model}. If this chat is on another model, type /model ${h.chat_model}.`;
  else if (model === h.chat_model) chat = `${h.chat_model}. This chat is on it; switching to another model is refused in this mode.`;
  else chat = `${h.chat_model}. This chat is on ${model}: type /model ${h.chat_model}.`;
  const policy = h.policy_file
    ? "this project's routing-policy.yaml (it wins over handoff.policy)"
    : h.policy === DEFAULT_POLICY ? `${DEFAULT_POLICY} (the default: Flash 3.8 does the typing)` : h.policy;
  const problems = (h.problems ?? []).map((key) => key === "chat_model"
    ? " handoff.chat_model there is not an exact model id (for example claude-opus-5), so the default is used."
    : " handoff.policy there is not a policy name, so the default is used.").join("");
  return [
    "Zero-touch hand-off mode is on for this chat.",
    "• This chat's model does the development itself. New docs, specs, plans, tests and the same change repeated across files are handed to the hand-off policy's model, and checked before they reach your project.",
    `• Chat model: ${chat}`,
    `• Hand-off policy: ${policy}.`,
    `• Settings: handoff.chat_model and handoff.policy in ${settingsFile}; a change applies from the next new chat.${problems}`,
    "• A workflow starts only when you type its command, for example /mmo:greenfield or /mmo:bugfix.",
    `• To change the mode, put a (workflows from plain words) or off in ${shown(join(home, "mode"))} and start a new chat.`,
    "• This mode lasts until /clear or a new chat.",
  ].join("\n");
}

/**
 * The hand-off rules the chat's model reads, at the chat's start and again after a compaction. The tools are the mmo
 * plugin's (its server registers them); tools/test/zero-touch-handoff-tools.test.mjs proves every tool named here
 * exists there.
 */
function rulesNote() {
  return [
    "This chat is in zero-touch hand-off mode. You do the development yourself: reading, deciding, new code, bug fixes, refactors, reviews and answers.",
    "Three kinds of work are handed to another model through this plugin's hand-off tools, which check the result before anything reaches the project:",
    "- A NEW document (a README, a guide, an API reference, a changelog), a NEW spec (requirements, a design document, an API spec, a data-model write-up) or NEW planning text (a plan, a task breakdown or tickets, a status report, release notes): the write_document tool.",
    "- NEW tests for code that exists: decide the cases yourself, then the write_tests_from_cases tool.",
    "- The same change in several files: make it yourself in ONE file, then the repeat_edit_across_files tool for the others.",
    "How to hand off: read what the tool's form needs, fill in every field with exact facts from the project (real paths, commands, names and values), and make one call. The form is a brief, never the finished text. The tool refuses a form with an empty field or a fact that is not in the project, and says what to fix. When it returns, read what it wrote before you tell the person it is done.",
    "Creating such a file yourself, with the Write tool or a shell command, is refused; a change to a file that exists is yours to make.",
    "When a tool reports that the hand-off failed or cannot run, do that piece yourself and say so in one line. When tests handed off do not pass, read the output the tool returns: correct a wrong case and hand off again; a real bug in the code under test you tell the person, and you never change a test to hide it.",
    "Every hand-off that changed the project has an id on its receipt; the undo_hand_off tool takes one back.",
    "Start no workflow (an mmo: command) from the person's plain words in this chat: a workflow starts only when the person types its command.",
  ].join("\n");
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const dir = join(mmoHome(env), "sessions", safeId(input.session_id));
  const file = join(dir, "chat_mode");
  const stampFile = join(dir, "handoff.json");
  const modelFile = join(dir, "model_now");
  const projectDir = (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim()) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const say = (text) => process.stdout.write(JSON.stringify({ systemMessage: text }));
  /** Hand-off mode: the message for the person and the rules note for the model, in one reply. */
  const sayHandoff = (h, model) => process.stdout.write(JSON.stringify({
    systemMessage: handoffMessage(h, model, env),
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rulesNote() },
  }));
  // The model the chat is on, when Claude Code says so at this moment (it does not always).
  const model = canonicalModel(input.model) || null;

  // A compaction or a reopened chat keeps the mode it started with, and shows its start message again.
  if (!FRESH_STARTS.includes(input.source ?? "startup")) {
    let kept = null;
    try { kept = readFileSync(file, "utf8").trim(); } catch { /* the chat started without zero-touch */ }
    if (kept === "on") say(workflowMessage(projectDir, env));
    if (kept === "b") {
      // From the stamp, never from the files: the chat keeps the settings it started with.
      const h = readJson(stampFile);
      if (!h) return;
      let now = model;
      if (now) writeFileSync(modelFile, now, { mode: 0o600 });
      else { try { now = readFileSync(modelFile, "utf8").trim() || null; } catch { /* not known */ } }
      sayHandoff(h, now);
    }
    return;
  }

  // A fresh start. What an earlier conversation in this chat left of hand-off mode goes; the record itself is
  // written over, never removed first, so the mmo plugin's start hook (run at the same moment) never finds a chat
  // that keeps zero-touch without its record.
  const dropHandoff = () => { for (const f of [stampFile, modelFile]) rmSync(f, { force: true }); };
  const dropAll = () => { rmSync(file, { force: true }); dropHandoff(); };
  if (env.MMO_AMBIENT === "off") { dropAll(); return; }
  const forced = env.MMO_AMBIENT === "observe" ? "observe" : env.MMO_AMBIENT === "on" ? "on" : null;
  const chosen = chosenMode(env);
  if (!forced && chosen === "off") { dropAll(); say(offMessage(env)); return; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const mode = forced ?? (chosen === "b" ? "b" : "on");
  dropHandoff();
  if (mode === "b") {
    const h = readHandoffSettings(projectDir, env);
    // The stamp is written before the record: whatever reads the record "b" then finds its settings.
    writeFileSync(stampFile, JSON.stringify({ ...h, at: new Date().toISOString() }), { mode: 0o600 });
    if (model) writeFileSync(modelFile, model, { mode: 0o600 });
    writeFileSync(file, mode, { mode: 0o600 });
    sayHandoff(h, model);
    return;
  }
  writeFileSync(file, mode, { mode: 0o600 });
  if (mode === "on") say(workflowMessage(projectDir, env));
}

try { main(); } catch { /* a failure leaves the chat without zero-touch, never blocks it */ }
