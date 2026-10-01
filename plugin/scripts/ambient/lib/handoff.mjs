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
import { ensureSessionDir, sessionDir } from "./paths.mjs";
import { googleLoggedIn } from "./route-flow.mjs";
import { lastAssistantModel } from "./transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF_MODELS = resolve(HERE, "..", "..", "handoff-models.mjs");

const STAMP = "handoff.json";
const MODELS = "handoff_models.json";
const MODEL_NOW = "model_now";

/** The hand-off tool each kind of work goes to (the mmo plugin's server registers them). */
export const HANDOFF_TOOL = { docs: "write_document", spec: "write_document", plan: "write_document", tests: "write_tests_from_cases", repeat: "repeat_edit_across_files" };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** A model's name without Claude Code's context tag: "claude-opus-5[1m]" is the model "claude-opus-5". */
export function canonicalModel(name) {
  return typeof name === "string" ? name.replace(/\[[^\]]*\]$/, "").trim() : "";
}

/** The kinds of hand-off work a person chooses a typist for, and the kind each hand-off work falls under. */
export const SETTING_OF = { docs: "documents", spec: "documents", plan: "documents", tests: "tests", repeat: "repeats" };
const SETTINGS = ["documents", "tests", "repeats"];
/** The route (the server's name for the kind of work) each setting is typed under. */
const WORK_OF = { documents: "docs", tests: "tests", repeats: "repeat" };

/**
 * The chat's stamp, or null when it has none or it cannot be read:
 * { chat_model, pin, admin_model, typists: { documents|tests|repeats: { typist, policy } } }.
 * typist is "flash", "sonnet" or "chat" (kept in the chat: policy null). A stamp written before 1 Oct 2026 named one
 * hand-off policy for every kind; it reads as that policy for all three (typist "policy"). A project's own policy
 * file is never used by zero-touch (decided 1 Oct 2026), so an old stamp's `policy_file` is ignored.
 */
export function readStamp(sid, env = process.env) {
  const s = readJson(join(sessionDir(sid, env), STAMP));
  if (!s || typeof s !== "object") return null;
  const policyName = (p) => (typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(p) ? p : null);
  const typists = {};
  if (s.typists && typeof s.typists === "object") {
    for (const k of SETTINGS) {
      const t = s.typists[k];
      if (t?.typist === "chat") typists[k] = { typist: "chat", policy: null };
      else if (policyName(t?.policy)) typists[k] = { typist: String(t.typist ?? "policy"), policy: t.policy };
      else return null;
    }
  } else if (policyName(s.policy)) {
    for (const k of SETTINGS) typists[k] = { typist: "policy", policy: s.policy };
  } else {
    return null;
  }
  return {
    chat_model: typeof s.chat_model === "string" && s.chat_model ? s.chat_model : null,
    pin: typeof s.pin === "string" ? s.pin : "setting",
    admin_model: typeof s.admin_model === "string" && s.admin_model ? s.admin_model : null,
    typists,
  };
}

/** Whether the person keeps this kind of hand-off work in the chat (docs, spec, plan, tests or repeat). */
export function keptInChat(stamp, kind) {
  return stamp?.typists?.[SETTING_OF[kind]]?.typist === "chat";
}

/**
 * The models this chat's hand-offs use: `{ routes: { docs, tests, repeat } }`, each `{ id, model, adapter, policy }`
 * or `{ kept: true }` for work the person keeps in the chat; or `{ error, policy }` when they cannot be named:
 * "not-built" (the plugin's server is not built on this machine), "policy" (a hand-off policy cannot be read), "busy"
 * (the router did not answer in time: a machine under heavy load, never a fault of the policy) or "stamp" (the chat
 * has no settings). Each kind is routed by its own policy (the shipped policy whose typist the person chose), asked of
 * the workflows' own router once per chat and kept; a failure is not kept, so a repaired setup, or a machine with time
 * again, works at the next message.
 */
export function handoffRoutes(sid, stamp, env = process.env, { timeoutMs = 3000 } = {}) {
  if (!stamp) return { error: "stamp" };
  const file = join(sessionDir(sid, env), MODELS);
  const kept = readJson(file)?.routes;
  const usable = (r) => r && (r.kept === true || (typeof r.model === "string" && r.model && typeof r.policy === "string"));
  if (kept && usable(kept.docs) && usable(kept.tests) && usable(kept.repeat)) return { routes: withGoogle(kept, env) };
  const byPolicy = new Map();
  const routes = {};
  for (const setting of SETTINGS) {
    const work = WORK_OF[setting];
    const t = stamp.typists[setting];
    if (t.typist === "chat") { routes[work] = { kept: true }; continue; }
    if (!byPolicy.has(t.policy)) {
      try {
        const out = execFileSync(process.execPath, [HANDOFF_MODELS, "--policy", t.policy], { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).toString();
        byPolicy.set(t.policy, JSON.parse(out).routes);
      } catch (err) {
        // A child stopped at the time limit has no exit status (it was killed): that is the machine, not the policy.
        if (err?.code === "ETIMEDOUT" || (err?.status == null && err?.signal)) return { error: "busy", policy: t.policy };
        return { error: err?.status === 2 ? "not-built" : "policy", policy: t.policy };
      }
    }
    routes[work] = { ...byPolicy.get(t.policy)[work], policy: t.policy };
  }
  ensureSessionDir(sid, env);
  writeFileSync(file, JSON.stringify({ routes, at: new Date().toISOString() }), { mode: 0o600 });
  return { routes: withGoogle(routes, env) };
}

/**
 * The routes as they can be used right now (1 Oct 2026). A kind whose model is one of Google's (Flash 3.8) cannot be
 * handed off while this computer has no Google login, by mmo's own rule (route-flow.mjs googleLoggedIn, the one the
 * workflow start uses): its route gets `noGoogle: true`, and that kind is done by the chat's own model, as the start
 * message promised ("work set to Flash 3.8 is done by this chat's model instead"). Before this, the line said Flash
 * would write it, the call failed twice at the server, and only then did the chat's model step in.
 * Checked at every use and never kept in the chat's file, so a person who connects Google mid-chat hands off again at
 * the next message. Offline: a login that has expired is caught at the call, where the ladder's last attempt covers it.
 */
function withGoogle(routes, env) {
  const needsGoogle = (r) => Boolean(r && !r.kept && /^gemini-/.test(String(r.model ?? "")));
  if (!Object.values(routes).some(needsGoogle) || googleLoggedIn(env)) return routes;
  const out = {};
  for (const [work, r] of Object.entries(routes)) out[work] = needsGoogle(r) ? { ...r, noGoogle: true } : r;
  return out;
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
 * A model's name as a person reads it, with its version: "claude-opus-5" is Opus 5, "claude-sonnet-5" Sonnet 5,
 * "gemini-3.8-flash" Flash 3.8. An id of another shape is shown as it is, never guessed at.
 */
export function displayName(modelId) {
  const name = canonicalModel(modelId);
  const claude = /^claude-([a-z]+)-(\d+(?:[.-]\d+)?)(?:-\d{8})?$/.exec(name);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2].replace("-", ".")}`;
  const gemini = /^gemini-([\d.]+)-([a-z]+(?:-[a-z]+)*)$/.exec(name);
  if (gemini) return `${gemini[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")} ${gemini[1]}`;
  return name;
}

/**
 * Who the chat is, for a line: `name` (its model, or null when its model is not known) and `reminder`, the sentence
 * added to every line while the chat is on another model than the one it is kept on.
 */
export function chatState(stamp, model) {
  const pin = stamp?.chat_model ?? null;
  const offPin = Boolean(pin && model && model !== pin);
  return {
    // A model is named only when Claude Code said which one the chat is on: never guessed from the pin.
    name: model ? displayName(model) : null,
    reminder: offPin ? ` This chat is on ${displayName(model)}, not ${displayName(pin)}: switch it using the model menu next to the message box (in the terminal, type /model ${pin}).` : "",
  };
}

const LABEL = "Zero-touch:";
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const who = (chat) => chat.name ?? "the chat's model";
/** Why hand-off cannot run, in the person's words. */
function unavailableWhy(found) {
  if (found.error === "google") return "this computer isn't connected to Google";
  if (found.error === "not-built") return "part of zero-touch isn't set up on this computer";
  if (found.error === "policy") return "the models for this work can't be read";
  if (found.error === "busy") return "the computer was too busy to check; ask again";
  return "this chat's hand-off settings can't be read";
}

/** The kinds of written work (a README, a design doc, release notes are all documents to the person). */
const WRITTEN = new Set(["docs", "spec", "plan"]);

/**
 * The one line the person sees after a message they typed in a hand-off chat. It is the hook's `systemMessage`, which
 * Claude Code shows in the chat and never gives the model, so it appears every time and cannot be reworded.
 */
export const HANDOFF_LINE = {
  /** Nothing is handed off: the chat's model does the work. */
  chatHandles: (chat) => `${LABEL} this isn't the kind of work zero-touch hands off (new documents, specs, plans, tests, or one change repeated in many files), so ${who(chat)} does it directly.${chat.reminder}`,
  /** Hand-off work, one sentence per kind; `routes` names the model each goes to, or that the person keeps it in the chat. */
  handoff({ kinds, rest }, routes, chat) {
    const me = who(chat);
    const route = (k) => routes[WRITTEN.has(k) ? "docs" : k];
    // Every kind asked for needs Google, and this computer has no Google login: the approved "can't be handed off"
    // line, as for any other reason (1 Oct 2026).
    if (kinds.length && kinds.every((k) => route(k)?.noGoogle)) return HANDOFF_LINE.unavailable({ error: "google" }, chat);
    const sentences = [];
    const written = kinds.filter((k) => WRITTEN.has(k));
    // One kind that needs Google beside others that do not: that kind in the same words, the others as usual.
    const noGoogle = (what, verb) => `${what} can't be handed off right now, because this computer isn't connected to Google, so ${me} ${verb} directly.`;
    if (written.length) {
      const what = written.length > 1 ? "documents" : "document";
      sentences.push(routes.docs?.kept
        ? `new documents are set to stay in this chat (your setting), so ${me} writes the new ${what} directly.`
        : routes.docs?.noGoogle ? noGoogle(`the new ${what}`, `writes ${written.length > 1 ? "them" : "it"}`)
          : `${me} will collect the facts and give ${displayName(routes.docs.model)} instructions to write the new ${what}. It's checked automatically before it's added to your project.`);
    }
    if (kinds.includes("tests")) {
      sentences.push(routes.tests?.kept
        ? `new tests are set to stay in this chat (your setting), so ${me} writes them directly.`
        : routes.tests?.noGoogle ? noGoogle("the new tests", "writes them")
          : `${me} will decide what to test, and ${displayName(routes.tests.model)} will write the tests. They're run in a test copy of your project first, and only added if they pass.`);
    }
    if (kinds.includes("repeat")) {
      sentences.push(routes.repeat?.kept
        ? `the same change in many files is set to stay in this chat (your setting), so ${me} makes it directly.`
        : routes.repeat?.noGoogle ? noGoogle("the same change in many files", "makes it")
          : `${me} will make the change in one file, and ${displayName(routes.repeat.model)} will repeat it in the others. If your project has an automatic check (such as its tests), it's run on a test copy first, and nothing is changed unless it passes.`);
    }
    if (rest) sentences.push(`${me} does the rest directly.`);
    return `${LABEL} ${sentences.map((x, i) => (i ? capital(x) : x)).join(" ")}${chat.reminder}`;
  },
  /** Hand-off work was asked for but cannot run here. */
  unavailable: (found, chat) => `${LABEL} this can't be handed off right now, because ${unavailableWhy(found)}. So ${who(chat)} does it directly.${chat.reminder}`,
};

/** What the chat's model reads with a message that asks for hand-off work: which tool takes which part. */
export function handoffInstruction({ kinds, rest }, routes = {}) {
  const parts = [];
  const kept = [];
  const offline = [];
  const place = (route, what, handed) => (route?.kept ? kept.push(what) : route?.noGoogle ? offline.push(what) : parts.push(handed));
  const written = kinds.filter((k) => WRITTEN.has(k));
  if (written.length) {
    const what = written.map((k) => ({ docs: "document", spec: "spec", plan: "planning text" })[k]).join(" and ");
    place(routes.docs, `the new ${what}`, `the new ${what}: gather its facts, then one ${HANDOFF_TOOL.docs} call for each file`);
  }
  if (kinds.includes("tests")) place(routes.tests, "the new tests", `the new tests: decide the cases yourself, then one ${HANDOFF_TOOL.tests} call`);
  if (kinds.includes("repeat")) place(routes.repeat, "the same change in several files", `the same change in several files: make it yourself in one file, then one ${HANDOFF_TOOL.repeat} call for the others`);
  const lines = [];
  if (parts.length) {
    lines.push(
      `The person's message asks for hand-off work. Hand it off instead of typing it yourself: ${parts.join("; ")}. ` +
      "Fill in every field of the tool's form with exact facts from the project; the form is a brief, never the finished text.",
    );
  }
  if (kept.length) lines.push(`The person keeps this work in the chat: do it yourself, with your own tools: ${kept.join("; ")}.`);
  if (offline.length) lines.push(`This computer is not connected to Google, so this work cannot be handed off (the person has been told): do it yourself, with your own tools: ${offline.join("; ")}.`);
  if (rest) lines.push("The rest of the message is yours to do.");
  if (parts.length) lines.push("If the work turns out not to be of this kind, do it yourself and say so in one line.");
  return lines.join(" ");
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
 * changed, by which model and what it cost, and how to undo it; that the chosen model failed and another did the
 * work; that the hand-off failed and the chat's model does the work itself; that the brief was incomplete; or that a
 * hand-off was undone. Null for a reply that is no receipt.
 */
export function receiptLine(receipt, chat, { documentsHandedOff = false } = {}) {
  if (!receipt || typeof receipt.status !== "string") return null;
  const me = who(chat);
  // The project is not set up with git (1 Oct 2026): the approved words, not the server's reason. Tests and a repeated
  // change are tried in a test copy first, and git is what tells the project's own files from downloaded packages.
  // "New documents can still be handed off" is said only when this chat hands documents off.
  if (receipt.status === "refused" && receipt.cause === "no-git") {
    return `${LABEL} this can't be handed off here, because the test copy it needs only works in a project set up with git. So ${me} does it directly.${documentsHandedOff ? " (New documents can still be handed off.)" : ""}`;
  }
  const Me = capital(me);
  const cost = dollars(receipt.cost_usd);
  const routed = displayName(receipt.routed_model);
  const undo = typeof receipt.id === "string" && receipt.id ? ` To undo it, ask Claude to undo hand-off ${receipt.id}.` : "";
  if (receipt.status === "written" && typeof receipt.file === "string") {
    const by = displayName(receipt.written_by);
    return receipt.routed_model && receipt.written_by !== receipt.routed_model
      ? `${LABEL} ${routed} couldn't write ${receipt.file}, so ${by} wrote it. It was checked automatically. Cost: ${cost}.${undo}`
      : `${LABEL} ${receipt.file} was written by ${by} and checked automatically. Cost: ${cost}.${undo}`;
  }
  if (receipt.status === "landed" && Array.isArray(receipt.changed)) {
    // A repeated change: how many files it reached, whether a command checked them, and what is left for the chat.
    if (!receipt.changed.length && !(receipt.failed ?? []).length) return `${LABEL} no file needed the change. Cost: ${cost}.`;
    const helped = receipt.by_fallback ? ` (${count(receipt.by_fallback, "file")} by ${displayName(receipt.fallback_model)} after ${routed} failed)` : "";
    const checked = String(receipt.check ?? "").startsWith("not run") ? "no automatic check was available" : "your project's check passed on a test copy";
    const left = (receipt.failed ?? []).length ? ` ${count(receipt.failed.length, "file")} still ${receipt.failed.length === 1 ? "needs" : "need"} the change, and ${me} will do ${receipt.failed.length === 1 ? "it" : "them"}.` : "";
    return `${LABEL} ${routed} made the change in ${count(receipt.changed.length, "file")}${helped}, and ${checked}. Cost: ${cost}.${undo}${left}`;
  }
  if (receipt.status === "failed" && typeof receipt.file === "string") {
    // Tests that ran and did not pass are not a typing failure: the output may show a real bug.
    if (receipt.kind === "tests" && typeof receipt.output === "string") return `${LABEL} the new tests in ${receipt.file} didn't pass in the test copy (cost: ${cost}), so nothing was added. ${Me} will look at why: if a test was wrong, it fixes the test; if the code has a real bug, it tells you.`;
    return `${LABEL} the hand-off of ${receipt.file} didn't work (cost so far: ${cost}), and nothing was added to your project. ${Me} will write it directly now.`;
  }
  if (receipt.status === "failed") {
    const why = typeof receipt.output === "string" ? "your project's check failed on the test copy" : "it couldn't be handed off";
    return `${LABEL} the change couldn't be repeated safely (${why}; cost: ${cost}), so nothing was changed. ${Me} will make the change directly.`;
  }
  if (receipt.status === "undone" && Array.isArray(receipt.restored)) {
    const left = (receipt.left_alone ?? []).length ? ` (${count(receipt.left_alone.length, "file")} had been changed again since, so ${receipt.left_alone.length === 1 ? "it was" : "they were"} left as ${receipt.left_alone.length === 1 ? "it is" : "they are"}.)` : "";
    return `${LABEL} hand-off ${receipt.id} was undone: ${count(receipt.restored.length, "file")} ${receipt.restored.length === 1 ? "is" : "are"} back as ${receipt.restored.length === 1 ? "it was" : "they were"}.${left}`;
  }
  if (receipt.status === "refused") {
    return Array.isArray(receipt.problems)
      ? `${LABEL} ${me}'s instructions for the hand-off were missing ${count(receipt.problems.length, "thing")}, so nothing was sent and nothing was charged. ${Me} is fixing them and will try again.`
      : `${LABEL} the hand-off was refused (${String(receipt.reason ?? "no reason given")}), so nothing was sent and nothing was charged.`;
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

/** The line the person sees with that refusal. `chat` names the chat's model; `typist` the model the work goes to. */
export const byHandLine = (path, kind, chat = { name: null }, typist = null) =>
  `${LABEL} ${who(chat)} started writing the new ${BY_HAND[kind].word} ${path} itself. In Hand-off mode that work goes to ${typist ? displayName(typist) : "the hand-off"}, so zero-touch stopped it and told ${who(chat)} to hand it off.`;

/** What the model reads when a hand-off tool is called where hand-off mode does not act. */
export const NOT_A_HANDOFF_CHAT = "The hand-off tools work only in a chat that started in zero-touch hand-off mode. Do this work yourself.";
export const NOT_IN_A_WORKFLOW = "The hand-off tools are not available inside a workflow run. Carry on with the workflow's own steps.";

/** What the model reads when it calls a hand-off tool for work the person keeps in the chat. */
export const KEPT_IN_CHAT_REASON = "The person keeps this kind of work in the chat (their zero-touch setting), so it is not handed off. Do it yourself, with your own tools.";
/** A hand-off tool called for a kind whose model needs Google, on a computer with no Google login (1 Oct 2026). */
export const NO_GOOGLE_REASON = "This kind of work goes to a Google model, and this computer is not connected to Google, so it cannot be handed off now. Do it yourself, with your own tools, and tell the person in one plain line that it was not handed off because Google is not connected.";

/** Guard B's refusal in a hand-off chat, for a workflow the chat tried to start by itself. */
export const TYPED_ONLY_REASON = "In this chat no full workflow starts from the person's plain words: do the work yourself, with your own tools.";

/** What the person reads when a switch to another model is refused. */
export function switchRefusal(stamp) {
  const model = displayName(stamp.chat_model);
  if (stamp.pin === "admin") return `Zero-touch hand-off mode keeps this chat on ${model}, the model your organisation set.`;
  return `Zero-touch keeps this Hand-off chat on ${model}, the chat model you chose, because it does the development and decides the hand-offs. To use a different model, type "change zero-touch settings", then start a new chat.`;
}

