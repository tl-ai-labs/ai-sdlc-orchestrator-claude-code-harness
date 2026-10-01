/**
 * Which messages the settings box's hooks may act on: only a message the person typed while the chat was idle.
 *
 * Why (1 Oct 2026, found in review): the prompt hook fires for more than that. Claude Code queues its own notices
 * (a background command finished, …) as messages, and a message the person types while Claude is working is
 * delivered into the running turn, where a settings sequence may be half done (the mode answered, the next box not yet
 * shown). Taking either for "the person moved on" dropped the sequence and said "nothing was saved" while the person
 * was still choosing. So those messages are left alone here, exactly as the mmo plugin's routing leaves them alone.
 *
 * Both rules are COPIES of the mmo plugin's own (plugin/scripts/ambient/hook.mjs NOTICE_TAG, lib/transcript.mjs
 * sentWhileWorking): Claude Code gives each plugin its own files, so zero-touch carries no mmo code.
 * tools/test/zero-touch-prompt-kind.test.mjs keeps the copies identical in behaviour.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The tags Claude Code wraps its own queued notices in (the mmo plugin's list, read from the program). */
export const NOTICE_TAG = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

const TAIL_BYTES = 256 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

/**
 * Was this message typed while Claude was still working? true (sent while working: a "queued_command" attachment),
 * false (sent when idle: an ordinary user entry), or null (not found, or no transcript). The latest entry carrying
 * exactly this text decides.
 */
export function sentWhileWorking(transcriptPath, text) {
  if (typeof transcriptPath !== "string" || !transcriptPath || typeof text !== "string" || !text.trim()) return null;
  const want = text.trim();
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain === true) continue;
    if (rec.type === "attachment" && rec.attachment?.type === "queued_command" && typeof rec.attachment.prompt === "string" && rec.attachment.prompt.trim() === want) return true;
    if (rec.type === "user" && contentText(rec.message?.content).trim() === want) return false;
  }
  return null;
}

/**
 * What a message the prompt hook sees is, for the settings box (1 Oct 2026):
 *   "notice"   a notice Claude Code queued (never the person);
 *   "working"  typed while Claude was working: it joins the running turn;
 *   "idle"     typed while the chat was idle: the transcript shows it as an ordinary entry, or there is no transcript
 *              to tell (as the mmo plugin's routing assumes);
 *   "unknown"  a transcript exists but does not show this message yet (it may be one typed mid-turn, not yet written).
 * The settings box ends a half-done choice, or gives up waiting in the first chat, only on positive evidence
 * ("idle"); "unknown" is waited out, with a limit (settings-hook.mjs), so nothing is held for ever (found in the
 * review's second pass: counting every such message gave up too early).
 */
export function promptKind(input) {
  const text = typeof input?.prompt === "string" ? input.prompt : "";
  if (NOTICE_TAG.test(text)) return "notice";
  const path = input?.transcript_path;
  if (typeof path !== "string" || !path) return "idle";
  const w = sentWhileWorking(path, text);
  return w === true ? "working" : w === false ? "idle" : "unknown";
}
