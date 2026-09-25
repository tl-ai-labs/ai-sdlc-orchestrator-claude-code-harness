/**
 * Zero-touch routing, hand-off half: what the hooks say to Opus and how a
 * route is kept, started, offered and ended (docs/ambient-mode.md, "Routing").
 *
 * Plain words only: the person never sees the plugin, a command or a model
 * name in anything zero-touch says (25 Sep 2026). Opus is told the
 * command's name because it must call it; it is told never to repeat it.
 *
 * A route belongs to the prompt it was made for: it is pending until the
 * Skill call that starts the workflow, and it is dropped at the next prompt.
 * An offer (an unclear request Opus recognised, in "ask" mode) lasts exactly
 * one reply: a plain yes turns it into a route, anything else ends it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSessionDir, sessionDir } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..");
const SETUP_POLICY = join(SCRIPTS, "setup-policy.mjs");
const DRIVER_MODEL_CHECK = join(SCRIPTS, "driver-model-check.mjs");
export const ZERO_TOUCH_SETUP = join(SCRIPTS, "ambient", "setup.mjs");

/** What the person hears for each job, and the steps it runs, in plain words. */
export const PLAIN = {
  greenfield: { name: "new-app build", steps: "requirements, design, build, tests, review" },
  bugfix: { name: "bug-fix workflow", steps: "reproduce, fix, test, review" },
  "feature-extend": { name: "feature workflow", steps: "plan, build, test, review" },
  "feature-new": { name: "new-feature workflow", steps: "design, build, test, review" },
  refactor: { name: "refactor workflow", steps: "plan, change, full test run, review" },
  test: { name: "test-writing workflow", steps: "plan, write the tests, run them" },
  docs: { name: "documentation workflow", steps: "plan, write, review" },
  deps: { name: "dependency-upgrade workflow", steps: "upgrade, fix what breaks, test" },
};

/** One wording everywhere; it informs, it does not order (the chat note's own rule), and it is exact. */
export const KEEP_OUT = "Keep the plugin, command names and model names out of what you say to the person.";

/** A reply that accepts an offer: the whole message is a plain yes, nothing added. */
export function isPlainYes(text) {
  return /^\s*(?:yes|y|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|please do|yes please|run it|start it|sounds good)\s*[.!]*\s*$/i.test(String(text ?? ""));
}

/** The instruction that starts a routed workflow. `via` is "rules" or "yes". */
export function startInstruction({ job, args, via, auth }) {
  const plain = PLAIN[job];
  const call = args ? `skill "mmo:${job}", args ${JSON.stringify(args)}` : `skill "mmo:${job}" (no arguments)`;
  const lead = via === "yes"
    ? `The person agreed to run this as the full ${plain.name}.`
    : `The person's message asks for a full ${plain.name}.`;
  const line = job === "greenfield" ? "Running this as a full new-app build." : `Running this as a full ${plain.name}.`;
  const brief = job === "greenfield"
    ? " Their message is the brief to build from: in the brief step, write it into ./brief.md in the Project Brief layout instead of offering the example briefs, and ask only for what that layout needs and the message does not say."
    : "";
  return (
    `${lead} Start it now with the Skill tool: ${call}. Before the call, tell the person this one plain line: "${line}" ` +
    `Settings already chosen for this run: cost recording "${auth}", and the project's policy is saved, so do not ask about either.${brief} ` +
    `Do nothing else before the workflow starts: other tools are blocked until it does. ${KEEP_OUT}`
  );
}

/** Guard A's refusal while a route waits for its Skill call. */
export function startFirstReason(job) {
  return `Start the workflow first: the person asked for the full ${PLAIN[job].name}. Call the Skill tool with skill "mmo:${job}" now; other tools are blocked until it starts.`;
}

/** Guard B's refusal in "ask" mode: the person must agree first. */
export function askReason(job) {
  const plain = PLAIN[job];
  return (
    `Before this workflow starts, the person must agree. Ask them in one plain sentence, for example: ` +
    `"This looks like a job for the full ${plain.name} (${plain.steps}). Shall I run it?" ` +
    `${KEEP_OUT} If they reply yes, the workflow is started for you; otherwise carry on as an ordinary chat.`
  );
}

/** Guard B's refusal for a workflow the chat may not start now. */
export const NOT_NOW_REASON = "Workflows start in this chat only when the person asks for one. Carry on with your own tools.";

/** The chat note's paragraph on workflows (only while routing is on). */
export function workflowsParagraph() {
  return (
    "Full workflows: when the person asks for a new app (empty folder), a bug fix, a new or extended feature, a refactor, tests, docs " +
    "or a dependency upgrade and none has started, call the Skill tool with mmo:greenfield, mmo:bugfix, mmo:feature-new, " +
    "mmo:feature-extend, mmo:refactor, mmo:test, mmo:docs or mmo:deps, args = the request in one line (none for a new app). " +
    "The plugin starts it or says to ask the person first. " + KEEP_OUT
  );
}

/** What Opus says when a workflow cannot start in this chat, and how the person can fix it. */
export function cannotStartInstruction(job, why) {
  return (
    `The person's message asks for a full ${PLAIN[job].name}, but it cannot start in this chat: ${why} ` +
    `Tell the person in one plain sentence that full workflows need a one-time setting, that it takes effect in a new chat, ` +
    `and offer to add it; if they agree, run: node ${JSON.stringify(ZERO_TOUCH_SETUP)} --apply=routing . ` +
    `Meanwhile handle the request as an ordinary chat if they want. ${KEEP_OUT}`
  );
}

// ─── Route state (one chat) ─────────────────────────────────────────────

const ROUTE = "route.json";
const OFFER = "route-offer.json";

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readRoute(sid) { return readJson(join(sessionDir(sid), ROUTE)); }
export function writeRoute(sid, route) {
  ensureSessionDir(sid);
  writeFileSync(join(sessionDir(sid), ROUTE), JSON.stringify({ ...route, at: new Date().toISOString() }), { mode: 0o600 });
}
export function dropRoute(sid) { try { rmSync(join(sessionDir(sid), ROUTE), { force: true }); } catch { /* already gone */ } }

export function readOffer(sid) { return readJson(join(sessionDir(sid), OFFER)); }
export function writeOffer(sid, offer) {
  ensureSessionDir(sid);
  writeFileSync(join(sessionDir(sid), OFFER), JSON.stringify({ ...offer, at: new Date().toISOString() }), { mode: 0o600 });
}
export function dropOffer(sid) { try { rmSync(join(sessionDir(sid), OFFER), { force: true }); } catch { /* already gone */ } }

// ─── Setup the workflow itself checks ───────────────────────────────────

/**
 * The policy the workflow will run with: the project's saved one, else the
 * routing default. Read exactly as the workflow reads it (setup-policy.mjs
 * --print-only from the project folder, no --project-root), so the two agree
 * on which folder and which file. A project.json that does not parse makes
 * the workflow stop, so it is reported, never guessed around.
 */
export function workflowPolicy({ projectDir, fallback }) {
  try {
    const saved = execFileSync(process.execPath, [SETUP_POLICY, "--print-only"], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], timeout: 4000 }).toString().trim();
    return saved ? { policy: saved, saved: true } : { policy: fallback, saved: false };
  } catch {
    return { error: "the project's saved settings file (.sdlc/project.json) cannot be read." };
  }
}

/**
 * Can a workflow start here under this policy? The workflow's own run-start
 * check decides (plugin/scripts/driver-model-check.mjs, the pipeline's router):
 * the model the helpers run on must be set before the chat starts. Asking the
 * same script means the hook and the workflow can never disagree.
 */
export function prerequisites({ projectDir, policy, env = process.env }) {
  try {
    execFileSync(process.execPath, [DRIVER_MODEL_CHECK, "--project-root", projectDir, "--policy", policy], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 4000 });
    return { ok: true };
  } catch {
    return { ok: false, why: "the chat was started without the setting that tells the workflow's helpers which model to run on." };
  }
}

/** Saves `policy` for the project when none is saved, as /mmo:setup's scripted path does; never overwrites. */
export function saveWorkflowPolicy({ projectDir, policy }) {
  const found = workflowPolicy({ projectDir, fallback: policy });
  if (found.error) throw new Error(found.error);
  if (found.saved) return { policy: found.policy, written: false };
  execFileSync(process.execPath, [SETUP_POLICY, `--policy=${policy}`], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], timeout: 4000 });
  return { policy, written: true };
}
