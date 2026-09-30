/**
 * A second job while a workflow runs (0.8.4, zero-touch chats only): the one question the model asks, the
 * person's answer, and the chat's queue.
 *
 * Why: on 29 Sep a chat typed /mmo:bugfix, then /mmo:docs while the bug fix ran; docs started and the bug fix was
 * dropped without a word. In a zero-touch chat such a job is held and the person chooses "Queue it" or
 * "Replace it". The question is asked with Claude Code's multiple-choice tool, whose answer reaches the hook as
 * `tool_response.answers[<question text>] = <label>` (read from real transcripts, 29 Sep), so the hook reads the
 * exact label, never a guess at free text. A person who types the answer instead is understood only when the
 * message is one of the two labels, written out.
 *
 * Records, each a small file in the chat's folder (`sessions/<chat id>/`), all ending with the chat or /clear:
 *   choice.json  the question waiting for its answer: { job, args, via, question, running }; via is "words" (plain
 *                words recognised as a job), "typed" (a typed /mmo: workflow command) or "skill" (the model
 *                starting one); it belongs to the message that raised it
 *   queue.json   the queued jobs, first in first out: [{ job, args, at }]
 *   hold         after "Queue it" for a typed command, whose text the model still holds: nothing that changes
 *                anything runs until the turn ends
 *   typed.json   the plugin command typed in the current message: { name, prompt_id }, so the expansion and prompt
 *                hooks of one typed command (they share its prompt_id) decide once
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSessionDir, sessionDir } from "./paths.mjs";
import { KEEP_OUT, plainName } from "./route-flow.mjs";

export const QUEUE_LABEL = "Queue it";
export const REPLACE_LABEL = "Replace it";
const HEADER = "Next job";

function readJson(sid, name) {
  try { return JSON.parse(readFileSync(join(sessionDir(sid), name), "utf8")); } catch { return null; }
}
function writeJson(sid, name, value) {
  ensureSessionDir(sid);
  writeFileSync(join(sessionDir(sid), name), JSON.stringify(value), { mode: 0o600 });
}
function drop(sid, name) {
  try { rmSync(join(sessionDir(sid), name), { force: true }); } catch { /* already gone */ }
}

export { plainName };

/** The question, exactly as asked and as read back: it names the running workflow and the new one in plain words. */
export function questionFor(runningJob, newJob) {
  return `A ${plainName(runningJob)} is still running in this chat. What should happen to the ${plainName(newJob)} you asked for?`;
}

/** What the model is told to do: ask that one question, nothing else first. */
export function askInstruction(choice) {
  return (
    `The person asked for a full ${plainName(choice.job)} while a ${plainName(choice.running)} is still running in this chat. ` +
    "Do not start it and do not do it yourself. Ask the person with the AskUserQuestion tool, one question, exactly: " +
    `question ${JSON.stringify(choice.question)}, header ${JSON.stringify(HEADER)}, multiSelect false, options ` +
    `${JSON.stringify(QUEUE_LABEL)} (description "It starts by itself when the running one ends.") and ` +
    `${JSON.stringify(REPLACE_LABEL)} (description "The running one stops now and this one starts."). ` +
    "If the running workflow is also waiting for an answer, you may ask its question in the same call. " +
    `Other tools that change anything are blocked until the person answers. ${KEEP_OUT}`
  );
}

export const readChoice = (sid) => readJson(sid, "choice.json");
export const writeChoice = (sid, choice) => writeJson(sid, "choice.json", { ...choice, at: new Date().toISOString() });
export const dropChoice = (sid) => drop(sid, "choice.json");

/** The person's answer to the waiting question from a multiple-choice result: "queue", "replace", "other", or null (not answered here). */
export function answerFrom(toolResponse, question) {
  const answers = toolResponse?.answers;
  if (!answers || typeof answers !== "object" || !question || !(question in answers)) return null;
  return labelKind(answers[question]) ?? "other";
}

/** A label written out as a message ("Queue it", "replace it."): "queue", "replace", or null. */
export function labelKind(text) {
  const t = String(text ?? "").trim().replace(/[.!\s]+$/, "").toLowerCase();
  if (t === QUEUE_LABEL.toLowerCase()) return "queue";
  if (t === REPLACE_LABEL.toLowerCase()) return "replace";
  return null;
}

/** Same job: the same command and the same description, whitespace and case aside. */
export function sameJob(a, b) {
  const norm = (x) => String(x ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return Boolean(a && b) && a.job === b.job && norm(a.args) === norm(b.args);
}

export const readQueue = (sid) => { const q = readJson(sid, "queue.json"); return Array.isArray(q) ? q : []; };
/** Adds a job at the end unless the same job is already queued. Returns "added" or "duplicate". */
export function enqueue(sid, item) {
  const q = readQueue(sid);
  if (q.some((x) => sameJob(x, item))) return "duplicate";
  q.push({ job: item.job, args: item.args ?? "", at: new Date().toISOString() });
  writeJson(sid, "queue.json", q);
  return "added";
}
/** Removes the first queued job when it is this one (it has started). */
export function removeStarted(sid, item) {
  const q = readQueue(sid);
  if (q.length && sameJob(q[0], item)) { q.shift(); if (q.length) writeJson(sid, "queue.json", q); else drop(sid, "queue.json"); }
}
export const dropQueue = (sid) => drop(sid, "queue.json");

export const setHold = (sid) => writeJson(sid, "hold", { at: new Date().toISOString() });
export const hasHold = (sid) => readJson(sid, "hold") !== null;
export const dropHold = (sid) => drop(sid, "hold");

export const readTyped = (sid) => readJson(sid, "typed.json");
export const writeTyped = (sid, typed) => writeJson(sid, "typed.json", typed);
export const dropTyped = (sid) => drop(sid, "typed.json");

/** The line the model is given when a queued job is next (the Stop hook's reason: the turn continues with it). */
export function queuedStartInstruction({ job, args }) {
  const call = args ? `skill "mmo:${job}", args ${JSON.stringify(args)}` : `skill "mmo:${job}" (no arguments)`;
  return (
    `The ${plainName(job)} the person queued is next: the running workflow has ended. Start it now with the Skill tool: ${call}. ` +
    `Before the call, tell the person this one plain line: "Starting the queued ${plainName(job)}." ` +
    `Do nothing else before the workflow starts: other tools are blocked until it does. ${KEEP_OUT}`
  );
}
