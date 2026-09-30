/**
 * Zero-touch hand-off mode, the chat's side: what a hand-off chat was started with, which models do its work, and
 * what the hook says to the person and to the chat's model (docs/ambient-mode.md, "Hand-off mode").
 *
 * In a hand-off chat the chat's own model does the development; new docs, specs, plans, tests and the same change
 * repeated across files go to the hand-off policy's models through the plugin's hand-off tools. Which work a message
 * asks for is lib/handoff-route.mjs; this file holds the rest of what the hook needs:
 *
 *   - the chat's stamp (`sessions/<chat id>/handoff.json`), written once at the chat's start by the zero-touch
 *     plugin (zero-touch/scripts/start-chat.mjs): the model the chat is pinned to and the hand-off policy. Settings
 *     are never read again during the chat, so its start note, its no-switching guard and its hand-offs cannot
 *     disagree;
 *   - the models the policy gives each kind of work, asked of the workflows' own router once per chat
 *     (plugin/scripts/handoff-models.mjs) and kept beside the stamp, so a line never names a model by guess;
 *   - the model the chat is on now: what Claude Code last reported (the start moment, a model switch) or, newer than
 *     that, what the chat's transcript shows it answered with;
 *   - the one line the person sees after each message, and the reminder the chat's model gets.
 *
 * Unlike workflow mode's lines, these name models ("this goes to Flash"): in hand-off mode which model does a piece
 * of work is the thing the person wants to see.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSessionDir, mmoHome, sessionDir } from "./paths.mjs";
import { lastAssistantModel } from "./transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF_MODELS = resolve(HERE, "..", "..", "handoff-models.mjs");

const STAMP = "handoff.json";
const MODELS = "handoff_models.json";
const MODEL_NOW = "model_now";

/** The hand-off tool each kind of work goes to (the mmo plugin's server registers them). */
export const HANDOFF_TOOL = { docs: "write_document", spec: "write_document", plan: "write_document", tests: "write_tests_from_cases", repeat: "repeat_edit_across_files" };
/** Which of the policy's routes each kind of work uses (handoff-models.mjs: docs, tests, repeat). */
const ROUTE_OF = { docs: "docs", spec: "docs", plan: "docs", tests: "tests", repeat: "repeat" };
/** A kind of written work, as the person's line names it. */
const WRITTEN = { docs: "docs", spec: "spec", plan: "plans and reports" };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
export function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/**
 * A model's short name for a line: its family, read from the id's own shape ("claude-opus-5" is Opus,
 * "gemini-3.8-flash" is Flash). An id of another shape is shown as it is, never guessed at.
 */
export function family(modelId) {
  const name = canonicalModel(modelId);
  const m = /^claude-([a-z]+)/.exec(name) ?? /^gemini-[\d.]+-([a-z]+(?:-[a-z]+)*)/.exec(name);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : name;
}

/** The chat's stamp, or null when it has none or it cannot be read: { chat_model, pin, policy, policy_file }. */
export function readStamp(sid, env = process.env) {
  const s = readJson(join(sessionDir(sid, env), STAMP));
  if (!s || typeof s !== "object" || typeof s.policy !== "string" || !s.policy) return null;
  return {
    chat_model: typeof s.chat_model === "string" && s.chat_model ? s.chat_model : null,
    pin: typeof s.pin === "string" ? s.pin : "default",
    policy: s.policy,
    policy_file: typeof s.policy_file === "string" && s.policy_file ? s.policy_file : null,
  };
}

/**
 * The models this chat's hand-offs use: `{ routes: { docs, tests, repeat } }`, each `{ id, model, adapter }`, or
 * `{ error, policy }` when they cannot be named: "not-built" (the plugin's server is not built on this machine),
 * "policy" (the hand-off policy cannot be read), "busy" (the router did not answer in time: a machine under heavy
 * load, never a fault of the policy) or "stamp" (the chat has no settings). Asked of the workflows' own router once
 * and kept for the chat; a failure is not kept, so a repaired setup, or a machine with time again, works at the
 * next message.
 */
export function handoffRoutes(sid, stamp, env = process.env, { timeoutMs = 3000 } = {}) {
  if (!stamp) return { error: "stamp" };
  const file = join(sessionDir(sid, env), MODELS);
  const kept = readJson(file);
  if (kept?.routes?.docs?.model && kept.routes.tests?.model && kept.routes.repeat?.model) return { routes: kept.routes };
  const named = stamp.policy_file ? "this project's routing-policy.yaml" : stamp.policy;
  try {
    const args = stamp.policy_file ? ["--policy-path", stamp.policy_file] : ["--policy", stamp.policy];
    const out = execFileSync(process.execPath, [HANDOFF_MODELS, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).toString();
    const routes = JSON.parse(out).routes;
    ensureSessionDir(sid, env);
    writeFileSync(file, JSON.stringify({ routes, at: new Date().toISOString() }), { mode: 0o600 });
    return { routes };
  } catch (err) {
    // A child stopped at the time limit has no exit status (it was killed): that is the machine, not the policy.
    if (err?.code === "ETIMEDOUT" || (err?.status == null && err?.signal)) return { error: "busy", policy: named };
    return { error: err?.status === 2 ? "not-built" : "policy", policy: named };
  }
}

/** Keeps the model Claude Code just said the chat is on (a model switch). */
export function recordModelNow(sid, model, env = process.env) {
  const name = canonicalModel(model);
  if (!name) return;
  writeFileSync(join(ensureSessionDir(sid, env), MODEL_NOW), name, { mode: 0o600 });
}

/**
 * The model the chat is on now, or null when nothing says. Two witnesses: what Claude Code last reported (kept at the
 * chat's start and at every model switch), and the model the chat's transcript shows it last answered with. The
 * newer one wins: an older Claude Code has no model-switch hook, and then only the transcript sees a switch.
 */
export function chatModelNow(sid, transcriptPath, env = process.env) {
  let kept = null;
  let keptAt = 0;
  try {
    const file = join(sessionDir(sid, env), MODEL_NOW);
    kept = readFileSync(file, "utf8").trim() || null;
    keptAt = statSync(file).mtimeMs;
  } catch { /* nothing reported */ }
  const seen = lastAssistantModel(transcriptPath);
  if (seen && (!kept || seen.at > keptAt)) return canonicalModel(seen.model) || kept;
  return kept;
}

/**
 * Who the chat is, for a line: `name` (its model's family, or null when its model is not known) and `reminder`, the
 * sentence added to every line while the chat is on another model than its pin.
 */
export function chatState(stamp, model) {
  const pin = stamp?.chat_model ?? null;
  const offPin = Boolean(pin && model && model !== pin);
  return {
    name: model ? family(model) : null,
    reminder: offPin ? ` This chat is on ${model}; hand-off mode expects ${pin}: type /model ${pin}.` : "",
  };
}

const LABEL = "Zero-touch:";
const capital = (s) => s[0].toUpperCase() + s.slice(1);
/** Why hand-off cannot run, in the person's words. */
function unavailableWhy(found) {
  if (found.error === "not-built") return "zero-touch is not fully installed on this machine";
  if (found.error === "policy") return `the hand-off policy ${found.policy} cannot be read`;
  if (found.error === "busy") return "this machine was too busy to check the hand-off policy; ask again";
  return "this chat's hand-off settings cannot be read";
}

/**
 * The one line the person sees after a message they typed in a hand-off chat. It is the hook's `systemMessage`, which
 * Claude Code shows in the chat and never gives the model, so it appears every time and cannot be reworded.
 */
export const HANDOFF_LINE = {
  /** Nothing is handed off: the chat's model does the work. */
  chatHandles: (chat) => `${LABEL} ${chat.name ? `${chat.name} handles this in the chat.` : "handled in the chat; nothing is handed off."}${chat.reminder}`,
  /** Hand-off work, one sentence per kind of work; `routes` names the model each goes to. */
  handoff({ kinds, rest }, routes, chat) {
    const worker = (kind) => family(routes[ROUTE_OF[kind]].model);
    const sentences = [];
    const written = kinds.filter((k) => WRITTEN[k]);
    if (written.length) sentences.push(`this goes to ${worker(written[0])} (${written.map((k) => WRITTEN[k]).join(", ")}).`);
    if (kinds.includes("tests")) sentences.push(`the tests go to ${worker("tests")}.`);
    if (kinds.includes("repeat")) sentences.push(`${chat.name ?? "the chat's model"} makes the change once; ${worker("repeat")} repeats it in the other files.`);
    if (rest) sentences.push(`${chat.name ?? "the chat's model"} handles the rest in the chat.`);
    return `${LABEL} ${sentences.map((s, i) => (i ? capital(s) : s)).join(" ")}${chat.reminder}`;
  },
  /** Hand-off work was asked for but cannot run here. */
  unavailable: (found, chat) => `${LABEL} hand-off cannot run (${unavailableWhy(found)}); ${chat.name ?? "the chat's model"} handles this in the chat.${chat.reminder}`,
};

/** What the chat's model reads with a message that asks for hand-off work: which tool takes which part. */
export function handoffInstruction({ kinds, rest }) {
  const parts = [];
  const written = kinds.filter((k) => WRITTEN[k]);
  if (written.length) parts.push(`the new ${written.map((k) => ({ docs: "document", spec: "spec", plan: "planning text" })[k]).join(" and ")}: gather its facts, then one ${HANDOFF_TOOL.docs} call for each file`);
  if (kinds.includes("tests")) parts.push(`the new tests: decide the cases yourself, then one ${HANDOFF_TOOL.tests} call`);
  if (kinds.includes("repeat")) parts.push(`the same change in several files: make it yourself in one file, then one ${HANDOFF_TOOL.repeat} call for the others`);
  return (
    `The person's message asks for hand-off work. Hand it off instead of typing it yourself: ${parts.join("; ")}. ` +
    "Fill in every field of the tool's form with exact facts from the project; the form is a brief, never the finished text. " +
    (rest ? "The rest of the message is yours to do. " : "") +
    "If the work turns out not to be of this kind, do it yourself and say so in one line."
  );
}

/** What the chat's model reads when hand-off work was asked for but cannot run here. */
export function unavailableInstruction(found) {
  return `Hand-off cannot run in this chat: ${unavailableWhy(found)}. Do this work yourself, and tell the person in one plain line that it was not handed off and why.`;
}

// ─── Around a hand-off tool call ────────────────────────────────────────

const TOOL_NAME = /^mcp__(?:plugin_mmo_)?model-dispatch__([a-z_]+)$/;
/** The undo sends nothing to a model: it needs the chat, not the chat's models. */
export const UNDO_TOOL = "undo_hand_off";
const HANDOFF_TOOLS = new Set([...Object.values(HANDOFF_TOOL), UNDO_TOOL]);

/** The hand-off tool a tool call names ("write_document"), installed as a plugin or run from a clone; null for any other tool. */
export function handoffToolName(toolName) {
  const m = TOOL_NAME.exec(String(toolName ?? ""));
  return m && HANDOFF_TOOLS.has(m[1]) ? m[1] : null;
}

/**
 * The tool call with the hook's stamp on it. The stamp names the chat, the project folder and who pays for a Claude
 * typist; the server reads everything else about the chat from the chat's own records, so nothing the model writes
 * in a call can choose a policy or a model. A `_mmo` the model wrote is always replaced: `updatedInput` replaces the
 * whole input, so every other field is carried over as it was.
 */
export function stampedInput(toolInput, { sessionId, projectDir, auth }) {
  const base = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? { ...toolInput } : {};
  base._mmo = { session_id: sessionId, project_dir: projectDir, auth: auth === "vendor" ? "vendor" : "estimated" };
  return base;
}

/** The JSON a plugin tool answered with, as Claude Code hands it to a hook: a string, a content list, or the object itself. */
export function toolReceipt(resp) {
  const parse = (t) => { try { const v = JSON.parse(t); return v && typeof v === "object" ? v : null; } catch { return null; } };
  const text = (list) => { const t = list.find((c) => c && c.type === "text" && typeof c.text === "string"); return t ? parse(t.text) : null; };
  if (typeof resp === "string") return parse(resp);
  if (Array.isArray(resp)) return text(resp);
  if (resp && typeof resp === "object") return Array.isArray(resp.content) ? text(resp.content) : resp;
  return null;
}

/** Dollars as a person reads them: cents, or four places for an amount under one cent's worth of rounding. */
function dollars(n) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The one line the person sees after a hand-off tool call, written from the tool's receipt: what was written or
 * changed, by which model and what it cost; that the routed model failed and another did the work; that the hand-off
 * failed and the chat's model does the work itself; that the form was not complete; or that a hand-off was undone.
 * Null for a reply that is no receipt.
 */
export function receiptLine(receipt, chat) {
  if (!receipt || typeof receipt.status !== "string") return null;
  const who = chat.name ?? "the chat's model";
  const Who = who[0].toUpperCase() + who.slice(1);
  const cost = dollars(receipt.cost_usd);
  const routed = family(receipt.routed_model);
  if (receipt.status === "written" && typeof receipt.file === "string") {
    const by = family(receipt.written_by);
    return receipt.routed_model && receipt.written_by !== receipt.routed_model
      ? `${LABEL} ${routed} failed, done by ${by}: ${receipt.file} written, checked (${cost}).`
      : `${LABEL} ${receipt.file} written by ${by}, checked (${cost}).`;
  }
  if (receipt.status === "landed" && Array.isArray(receipt.changed)) {
    // A repeated change: how many files it reached, whether a command checked them, and what is left for the chat.
    if (!receipt.changed.length && !(receipt.failed ?? []).length) return `${LABEL} no file needed the change (${cost}).`;
    const helped = receipt.by_fallback ? ` (${receipt.by_fallback} by ${family(receipt.fallback_model)} after ${routed} failed)` : "";
    const checked = String(receipt.check ?? "").startsWith("not run") ? "no check command run" : "checked";
    const left = (receipt.failed ?? []).length ? ` ${receipt.failed.length} left for ${who} to change.` : "";
    return `${LABEL} the change repeated in ${count(receipt.changed.length, "file")} by ${routed}${helped}, ${checked} (${cost}).${left}`;
  }
  if (receipt.status === "failed" && typeof receipt.file === "string") {
    // Tests that ran and did not pass are not a typing failure: the output may show a real bug.
    if (receipt.kind === "tests" && typeof receipt.output === "string") return `${LABEL} the tests in ${receipt.file} did not pass in a scratch copy (${cost} spent); nothing was written. ${Who} looks at the output.`;
    return `${LABEL} hand-off failed for ${receipt.file} (${cost} spent); ${who} writes it in the chat.`;
  }
  if (receipt.status === "failed") {
    const why = typeof receipt.output === "string" ? "failed its check in a scratch copy" : "could not be handed off";
    return `${LABEL} the repeated change ${why} (${cost} spent); nothing was changed. ${Who} makes the change in the chat.`;
  }
  if (receipt.status === "undone" && Array.isArray(receipt.restored)) {
    const left = (receipt.left_alone ?? []).length ? `, ${receipt.left_alone.length} changed since and left alone` : "";
    return `${LABEL} hand-off ${receipt.id} undone (${count(receipt.restored.length, "file")} restored${left}).`;
  }
  if (receipt.status === "refused") {
    return Array.isArray(receipt.problems)
      ? `${LABEL} hand-off form not complete (${receipt.problems.length} to fix); nothing was sent.`
      : `${LABEL} hand-off refused (${String(receipt.reason ?? "no reason given")}); nothing was sent.`;
  }
  return null;
}

/** The project files a failed hand-off handed back to the chat's model (written by the server, handoff/chat.ts). */
export function releasedPaths(sid, env = process.env) {
  const v = readJson(join(sessionDir(sid, env), "handoff_released.json"));
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** What the net says for each kind of file: the tool that takes it, its form's fields, and the person's word for it. */
const BY_HAND = {
  document: { tool: HANDOFF_TOOL.docs, form: "kind, file, purpose, readers, sections, facts", word: "document" },
  tests: { tool: HANDOFF_TOOL.tests, form: "file, target, functions, cases, test_command", word: "test file" },
};

/** What the chat's model reads when a new document or test file it typed by hand is refused. */
export function byHandReason(path, kind) {
  const k = BY_HAND[kind];
  return (
    `In this chat a new ${k.word} is not typed by hand: hand ${path} to the ${k.tool} tool (its form: ${k.form}), which has it written and checked. ` +
    "If the hand-off fails, the tool hands the file back and you write it yourself. A change to a file that exists is yours to make."
  );
}

/** The line the person sees with that refusal. */
export const byHandLine = (path, kind) => `${LABEL} a new ${BY_HAND[kind].word} typed by hand was sent back to the hand-off (${path}).`;

/** What the model reads when a hand-off tool is called where hand-off mode does not act. */
export const NOT_A_HANDOFF_CHAT = "The hand-off tools work only in a chat that started in zero-touch hand-off mode. Do this work yourself.";
export const NOT_IN_A_WORKFLOW = "The hand-off tools are not available inside a workflow run. Carry on with the workflow's own steps.";

/** Guard B's refusal in a hand-off chat, for a workflow the chat tried to start by itself. */
export const TYPED_ONLY_REASON = "In this chat a workflow starts only when the person types its command. Carry on with your own tools.";

/** What the person reads when a switch to another model is refused. */
export function switchRefusal(stamp, env = process.env) {
  const home = homeShown(env);
  const pinnedBy = stamp.pin === "admin" ? ", the model your organisation set" : "";
  const change = stamp.pin === "admin" ? "" : `, or set handoff.chat_model in ${home}/ambient.json`;
  return `Zero-touch hand-off mode keeps this chat on ${stamp.chat_model}${pinnedBy}. To use another model, put a or off in ${home}/mode and start a new chat${change}.`;
}

/** The zero-touch home folder as the person would type it ("~/.mmo-ambient"). */
function homeShown(env) {
  const dir = mmoHome(env);
  const home = env.HOME ?? "";
  return home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;
}
