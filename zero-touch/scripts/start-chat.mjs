#!/usr/bin/env node
/**
 * The zero-touch plugin's start hook: at the start of a chat it decides once whether the chat has zero-touch, and
 * tells the person.
 *
 * Claude Code runs it at SessionStart while the zero-touch plugin is enabled, and never while it is disabled (then
 * nothing of zero-touch runs, and nothing can be shown). The chat's mode is its record
 * `<MMO_HOME>/sessions/<chat id>/chat_mode` (MMO_HOME defaults to ~/.mmo-ambient); the mmo plugin, which holds all of
 * zero-touch's code, acts only in a chat whose record exists (plugin/scripts/ambient/lib/chat-mode.mjs), and a chat
 * keeps its record for its whole life, so it is never half on and half off.
 *
 * At a fresh start (a new chat, or /clear) the person's mode file `<MMO_HOME>/mode` is read: "off" leaves the chat
 * without zero-touch; anything else, or no file, gives workflow mode. A compaction or a reopened chat keeps the mode
 * it has. MMO_AMBIENT, a one-run override for a developer or a measuring setup, still applies: "off" removes the
 * record, "observe" writes "observe".
 *
 * The person sees one message (the hook's `systemMessage`, which Claude Code shows in the chat and does not give the
 * model): at a fresh start, and again after a compaction or when the chat is reopened, since the chat's first lines
 * may be out of view. It names the policy the chat's workflows will use and how to change it or turn zero-touch off.
 * A run switched off by MMO_AMBIENT and a measuring run that only records show nothing.
 *
 * Self-contained on purpose: Claude Code gives each plugin its own copy of any file it links to at install, so this
 * plugin carries no code of mmo's. The path rules below are the same as mmo's lib/paths.mjs, and the policy it names
 * follows the workflow's own resolution; tools/test/zero-touch-plugin.test.mjs proves both. Always exits 0.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FRESH_STARTS = ["startup", "clear"];
/** The shipped policy a workflow uses when neither the project nor the person chose one. */
const DEFAULT_POLICY = "opus-plus-flash-v38";
const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

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

/** The mode the person chose in <MMO_HOME>/mode: "off", or workflow mode for a missing or any other value. */
function chosenMode(env) {
  try { return readFileSync(join(mmoHome(env), "mode"), "utf8").trim().toLowerCase() === "off" ? "off" : "a"; } catch { return "a"; }
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
    `• To turn zero-touch off, put off in ${modeFile} and start a new chat.`,
    "• This mode lasts until /clear or a new chat.",
  ].join("\n");
}

function offMessage(env) {
  return `Zero-touch is off for this chat. To turn it on, put a in ${shown(join(mmoHome(env), "mode"))} and start a new chat.`;
}

function main(env = process.env) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  if (!input || typeof input.session_id !== "string" || !input.session_id) return;
  const dir = join(mmoHome(env), "sessions", safeId(input.session_id));
  const file = join(dir, "chat_mode");
  const projectDir = (env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim()) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const say = (text) => process.stdout.write(JSON.stringify({ systemMessage: text }));
  // A compaction or a reopened chat keeps the mode it started with, and shows its start message again.
  if (!FRESH_STARTS.includes(input.source ?? "startup")) {
    let kept = null;
    try { kept = readFileSync(file, "utf8").trim(); } catch { /* the chat started without zero-touch */ }
    if (kept === "on") say(workflowMessage(projectDir, env));
    return;
  }
  if (env.MMO_AMBIENT === "off") { rmSync(file, { force: true }); return; }
  if (env.MMO_AMBIENT !== "observe" && chosenMode(env) === "off") { rmSync(file, { force: true }); say(offMessage(env)); return; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const mode = env.MMO_AMBIENT === "observe" ? "observe" : "on";
  writeFileSync(file, mode, { mode: 0o600 });
  if (mode === "on") say(workflowMessage(projectDir, env));
}

try { main(); } catch { /* a failure leaves the chat without zero-touch, never blocks it */ }
