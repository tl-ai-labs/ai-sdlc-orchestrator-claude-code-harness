/**
 * Zero-touch routing, hand-off half: what the hooks say to Opus and how a
 * route is kept, started and ended (docs/ambient-mode.md, "Routing").
 *
 * Plain words only: the person never sees the plugin, a command or a model
 * name in anything zero-touch says (25 Sep 2026). Opus is told the
 * command's name because it must call it; it is told never to repeat it.
 *
 * A route belongs to the prompt it was made for: it is pending until the
 * Skill call that starts the workflow, and it is dropped at the next prompt.
 * Only the rules make a route (26 Sep 2026): an unclear request is never
 * offered or started on the chat model's guess; it stays an ordinary chat. The
 * earlier "ask" / "auto" offers are gone.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedDriverModel } from "../../driver-model-check.mjs";
import { ensureSessionDir, sessionDir } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..");
const SETUP_POLICY = join(SCRIPTS, "setup-policy.mjs");
const DRIVER_MODEL_CHECK = join(SCRIPTS, "driver-model-check.mjs");
const VERIFY_SETUP = join(SCRIPTS, "verify-setup.mjs");

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

/** The two workflow commands routing never starts (typed only), named for the person the same way as the eight jobs. */
const TYPED_ONLY = { brownfield: "project workflow", pass: "pipeline run" };

/** The plain name of any workflow command for the person ("bug-fix workflow"). */
export function plainName(job) {
  return PLAIN[job]?.name ?? TYPED_ONLY[job] ?? "workflow";
}

/**
 * The one line the person sees after a message they typed in a workflow-mode chat: what zero-touch did with it. It
 * is the hook's `systemMessage`, which Claude Code shows in the chat and never gives the model, so it appears every
 * time and cannot be reworded by the model. Every line starts with the same label, so anyone watching the chat can
 * tell zero-touch's notices from the model's own reply.
 */
const LABEL = "Zero-touch:";
/** A job's name in a line: the new-app job is a workflow here like the other seven. */
const lineName = (job) => (job === "greenfield" ? "new-app workflow" : plainName(job));
/** Why a recognised job was not started, in one short sentence per cause (cannotStartInstruction gives the model the fix). */
const NOT_STARTED = {
  busy: "Another chat in this folder is running a workflow.",
  mismatch: "This project's saved workflow choice needs its helpers on a different model.",
  "not-built": "Zero-touch is not fully installed on this machine.",
  "project-file": "The project's saved workflow settings cannot be read.",
  enclosing: "This folder is inside another project.",
};
export const PERSON_LINE = {
  starting: (job) => `${LABEL} starting the ${lineName(job)}.`,
  startingQueued: (job) => `${LABEL} starting the queued ${lineName(job)}.`,
  alreadyRunning: () => `${LABEL} a workflow is already running. Choose Queue it or Replace it.`,
  notStarted: (problem) => `${LABEL} not started. ${NOT_STARTED[problem?.cause] ?? "Its setup could not be checked."}`,
  gateAnswer: () => `${LABEL} taken as your answer to the open gate.`,
  workflowAnswer: () => `${LABEL} taken as your answer to the running workflow.`,
  duringWorkflow: () => `${LABEL} not a new workflow job; the running workflow carries on.`,
  notAJob: () => `${LABEL} not a workflow job, handled as a normal chat.`,
};

/** One wording everywhere, in every instruction and refusal below; it informs, it does not order, and it is exact. */
export const KEEP_OUT = "Keep the plugin, command names and model names out of what you say to the person.";

/** The instruction that starts a routed workflow (the rules recognised the request). */
export function startInstruction({ job, args, auth }) {
  const plain = PLAIN[job];
  const call = args ? `skill "mmo:${job}", args ${JSON.stringify(args)}` : `skill "mmo:${job}" (no arguments)`;
  const lead = `The person's message asks for a full ${plain.name}.`;
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
  return `Start the workflow first: the person asked for the full ${PLAIN[job].name}. Call the Skill tool with skill "mmo:${job}" now; other tools are blocked until it starts. ${KEEP_OUT}`;
}

/**
 * Guard B's refusal for a workflow the chat tried to start by itself. Since 26 Sep only the rules (or a typed
 * command) start one, whatever the chat's model thinks the request is; the chat does the work itself instead.
 */
export const NOT_NOW_REASON = "Full workflows start only when the plugin recognises the request or the person types the command. Carry on with your own tools.";

/**
 * What Opus says when a workflow cannot start in this chat: the real cause and
 * the fix that works for that cause (independent review, 25 Sep: one fixed
 * sentence sent every cause to the one-time setting, which fixes only one).
 *
 * v0.8.3 (25 Sep, after the live desktop test): there is no "unset" cause any
 * more. The workflows' helpers name their model in the plugin's agent files,
 * so no setting is needed, and none can help: the only model mismatch left is
 * a project whose saved choice is an older policy with another judgment model.
 */
export function cannotStartInstruction(job, problem) {
  const lead = `The person's message asks for a full ${PLAIN[job].name}, but it cannot start in this chat:`;
  const tail = `Meanwhile handle the request as an ordinary chat if they want. ${KEEP_OUT}`;
  switch (problem?.cause) {
    case "mismatch":
      return `${lead} this project's saved workflow choice is an older one that needs its helpers on a different model than this version of the workflows runs. ` +
        `Tell the person that plainly; the choice is theirs (change the project's saved workflow choice to the current one, then ask again). Do not change it yourself. ${tail}`;
    case "not-built":
      return `${lead} the plugin is not fully installed on this machine. Tell the person in one plain sentence and offer to finish the install; if they agree, run: node ${JSON.stringify(VERIFY_SETUP)} --fix . ${tail}`;
    case "project-file":
      return `${lead} the project's saved workflow settings (.sdlc/project.json) cannot be read. Tell the person plainly and offer to show them the file so they can fix it. ${tail}`;
    case "busy":
      // 0.8.4: one workflow at a time in one project (lib/project-lock.mjs).
      return `${lead} another chat in this project is running a ${plainName(problem.job)}, and two workflows in one project would overwrite each other's records. ` +
        `Tell the person plainly: they can finish it in that chat, or type /clear there, then ask again. ${tail}`;
    case "enclosing":
      return `${lead} this folder is inside another project (${problem.root}), and nothing is set up for workflows there. Tell the person plainly. ${tail}`;
    default:
      return `${lead} ${problem?.why ?? "its setup could not be checked."} Tell the person plainly. ${tail}`;
  }
}

// ─── Route state (one chat) ─────────────────────────────────────────────

const ROUTE = "route.json";

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function readRoute(sid) { return readJson(join(sessionDir(sid), ROUTE)); }
export function writeRoute(sid, route) {
  ensureSessionDir(sid);
  writeFileSync(join(sessionDir(sid), ROUTE), JSON.stringify({ ...route, at: new Date().toISOString() }), { mode: 0o600 });
}
export function dropRoute(sid) { try { rmSync(join(sessionDir(sid), ROUTE), { force: true }); } catch { /* already gone */ } }


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
    const saved = execFileSync(process.execPath, [SETUP_POLICY, "--print-only"], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }).toString().trim();
    return saved ? { policy: saved, saved: true } : { policy: fallback, saved: false };
  } catch {
    return { error: "project-file" };
  }
}

/** The git top folder that setup-policy.mjs would write into, when it is not the project folder itself. */
function enclosingRoot(projectDir) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    return top && realpathSync(top) !== realpathSync(projectDir) ? top : null;
  } catch {
    return null;
  }
}

/**
 * Why a workflow cannot start here, or null when it can; `policy` is the one
 * it will run with. Each cause is the workflow's own: its policy file must
 * read; a folder with no saved choice must be the folder the choice is saved
 * for (never an enclosing project); and, except under vendor (where the
 * workflow skips it), its run-start check (driver-model-check.mjs, the
 * pipeline's router) must pass. Asking the same scripts means the hook and the
 * workflow can never disagree.
 */
export function startProblem({ projectDir, fallback, auth, env = process.env }) {
  const found = workflowPolicy({ projectDir, fallback });
  if (found.error) return { problem: { cause: "project-file" } };
  if (!found.saved) {
    const root = enclosingRoot(projectDir);
    if (root) return { problem: { cause: "enclosing", root } };
  }
  if (auth === "vendor") return { problem: null, policy: found.policy, saved: found.saved };
  let needed;
  try {
    needed = execFileSync(process.execPath, [DRIVER_MODEL_CHECK, "--project-root", projectDir, "--policy", found.policy, "--print-only"], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }).toString().trim();
  } catch {
    return { problem: { cause: "not-built" } };
  }
  try {
    execFileSync(process.execPath, [DRIVER_MODEL_CHECK, "--project-root", projectDir, "--policy", found.policy], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
    return { problem: null, policy: found.policy, saved: found.saved };
  } catch (err) {
    // v0.8.3 (25 Sep): the helpers' model is named in the plugin's agent files, so the check no longer fails for a
    // missing setting. The failure a person meets is a project whose saved choice is an older policy with another
    // judgment model (have = the agent files' model, needed = the policy's). The rest, rare, are passed on in the
    // check's own words: the CLAUDE_CODE_SUBAGENT_MODEL_FORCE switch, or agent files that do not name one model.
    let pinned = null;
    try { pinned = pinnedDriverModel(); } catch { /* a damaged install: the check's own words below say so */ }
    if (pinned && needed !== pinned) return { problem: { cause: "mismatch", have: pinned, needed } };
    const why = String(err?.stderr ?? "").trim().split("\n")[0] || "its run-start model check failed.";
    return { problem: { cause: "check", why } };
  }
}

/** Saves `policy` for the project when none is saved, as /mmo:setup's scripted path does; never overwrites, never into an enclosing project. */
export function saveWorkflowPolicy({ projectDir, policy }) {
  const found = workflowPolicy({ projectDir, fallback: policy });
  if (found.error) throw new Error("the project's saved workflow settings cannot be read");
  if (found.saved) return { policy: found.policy, written: false };
  if (enclosingRoot(projectDir)) throw new Error("the folder is inside another project");
  execFileSync(process.execPath, [SETUP_POLICY, `--policy=${policy}`], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
  return { policy, written: true };
}

/**
 * Shown to the person, not the model, when a typed workflow command is kept back because another chat in this
 * project is running a workflow (0.8.4): the prompt hook blocks the typed line, and Claude Code shows this reason.
 */
export function typedBusyReason(lock) {
  return `Not started: another chat in this project is running a ${plainName(lock?.job)}, and two workflows in one project would overwrite each other's records. Finish it in that chat, or type /clear there, then try again.`;
}
