/**
 * Reads the END of a chat's transcript to learn one thing the hook input does not carry: whether a message was typed
 * while Claude was still working (sentWhileWorking). Only a bounded tail is read, so the cost is the same for a 2 MB
 * transcript and a 200 MB one. (Until 0.8.4 it also read the context size and the answering model for the generic
 * orchestrator's prices; that went with it.)
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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

/** The text a transcript entry's content carries: a string, or the text parts of a list. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

/**
 * Was this message typed while Claude was still working on the previous one? Claude Code writes every message to
 * the transcript before the prompt hook runs: one sent when the chat is idle is an ordinary user entry; one sent
 * while Claude is working is delivered into the running task and recorded as a "queued_command" attachment carrying
 * the text (seen live on Claude Code 2.1.284). Reads the tail, newest entry first; the latest entry carrying exactly
 * this text decides. Returns true (sent while working), false (sent when idle), or null (not found, or no transcript).
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
