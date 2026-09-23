/**
 * Reads the END of a session transcript to learn two things the hook input
 * does not carry: how large the context is right now, and which model produced
 * the last main-conversation reply. Only a bounded tail is read, so the cost
 * is the same for a 2 MB transcript and a 200 MB one.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 256 * 1024;

export function readTail(file, bytes = TAIL_BYTES) {
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

/** Returns { contextTokens, model } from the newest main-thread assistant entry, or nulls. */
export function lastTurnFacts(transcriptPath) {
  const none = { contextTokens: null, model: null };
  if (typeof transcriptPath !== "string" || !transcriptPath) return none;
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain === true) continue;
    const usage = rec?.message?.usage;
    if (rec.type !== "assistant" || !usage) continue;
    // Claude Code writes a placeholder reply (model "<synthetic>") when a turn
    // is interrupted or fails. It is not a model and says nothing about the
    // chat's context, so it is skipped.
    if (typeof rec.message.model === "string" && rec.message.model.startsWith("<")) continue;
    const contextTokens =
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const model = typeof rec.message.model === "string" ? rec.message.model.replace(/\[[^\]]*\]$/, "") : null;
    return { contextTokens, model };
  }
  return none;
}
