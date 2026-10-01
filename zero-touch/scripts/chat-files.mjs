/**
 * A chat's zero-touch records, as the zero-touch plugin writes them (shared by start-chat.mjs and settings-hook.mjs).
 *
 * Every record lives in the chat's own folder, `<MMO_HOME>/sessions/<chat id>/`, beside the records the mmo plugin
 * keeps there; the path rules are the same as mmo's lib/paths.mjs (tools/test/zero-touch-plugin.test.mjs proves it).
 * Claude Code gives a conversation a new chat id at /clear (checked in Claude Code's own code, 1 Oct 2026), so a
 * record belongs to exactly one conversation.
 *
 *   chat_mode       "on" (Workflows) or "b" (Hand-off): the mmo plugin acts only in a chat that has it
 *   workflow.json   a Workflows chat's models: { policy, at }
 *   handoff.json    a Hand-off chat's settings: chat model, and who types each kind of work
 *   zt_off          an Off chat (so a compaction can show its message again)
 *   zt_setup.json   the first chat after install, until its settings are saved: { asked, at }
 *   zt_flow.json    a settings box sequence in progress: { pending, shown, first, at }
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mmoHome } from "./settings.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Same as mmo's lib/paths.mjs safeId(): a chat id that is not a plain token becomes a hash, never a path. */
export function safeId(id) {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

export function chatDir(sid, env = process.env) {
  return join(mmoHome(env), "sessions", safeId(sid));
}

export function ensureChatDir(sid, env = process.env) {
  const dir = chatDir(sid, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  return dir;
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readText(file) {
  try { return readFileSync(file, "utf8").trim(); } catch { return null; }
}

export function writeJson(sid, name, value, env = process.env) {
  writeFileSync(join(ensureChatDir(sid, env), name), JSON.stringify({ ...value, at: new Date().toISOString() }), { mode: 0o600 });
}

export function writeText(sid, name, text, env = process.env) {
  writeFileSync(join(ensureChatDir(sid, env), name), text, { mode: 0o600 });
}

export function drop(sid, name, env = process.env) {
  rmSync(join(chatDir(sid, env), name), { force: true });
}

export const FILES = {
  mode: "chat_mode",
  workflow: "workflow.json",
  handoff: "handoff.json",
  models: "handoff_models.json",
  modelNow: "model_now",
  off: "zt_off",
  setup: "zt_setup.json",
  flow: "zt_flow.json",
};
