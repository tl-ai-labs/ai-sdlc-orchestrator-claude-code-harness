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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedDriverModel } from "../../driver-model-check.mjs";
import { adcPath, hasGeminiCredentials, inspectCredentialFile, usableEnv, vertexCredentialState } from "../../verify-setup.mjs";
import { ensureSessionDir, sessionDir } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "..");
const DRIVER_MODEL_CHECK = join(SCRIPTS, "driver-model-check.mjs");
const VERIFY_SETUP = join(SCRIPTS, "verify-setup.mjs");
const POLICIES = resolve(SCRIPTS, "..", "config", "policies");
const SERVER_DIST = resolve(SCRIPTS, "..", "mcp", "model-dispatch", "dist", "server.js");
/** The policy a chat whose record names none runs on: the standard pick (a record written before 1 Oct 2026). */
export const STANDARD_POLICY = "opus-plus-flash-v38";
const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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
 * tell zero-touch's notices from the model's own reply. The wording is the final proposal of 1 Oct 2026
 * (MESSAGES-REVIEW.md v2): what happened, why, and what the person can do now.
 */
const LABEL = "Zero-touch:";
/** A job's name in a line: the new-app job is a workflow here like the other seven. */
const lineName = (job) => (job === "greenfield" ? "new-app workflow" : plainName(job));
/** What the person asked for, in a line ("you asked for a new app"). */
const ASKED = {
  greenfield: "a new app", bugfix: "a bug fix", "feature-extend": "an addition to a feature", "feature-new": "a new feature",
  refactor: "a code cleanup", test: "tests", docs: "documentation", deps: "a library upgrade",
};
/** Why a recognised job was not started, one sentence per cause, with what to do (cannotStartInstruction gives the model the same). */
function notStartedWhy(problem, job) {
  const name = lineName(job);
  switch (problem?.cause) {
    case "busy":
      return `the ${name} didn't start, because another chat in this project folder is already running a ${lineName(problem.job)}, and two at once would get in each other's way. When that one has finished, or after you type /clear in that chat, ask again here. Until then, Claude can help in this chat as usual.`;
    case "google":
      return `the ${name} didn't start, because your models include Google's Flash 3.8 and this computer isn't connected to Google. Ask Claude: "help me connect Google for zero-touch". Or type "change zero-touch settings" and choose models without Flash.`;
    case "not-built":
      return `the ${name} didn't start, because part of zero-touch isn't set up on this computer yet. Claude can finish setting it up: just say yes when it asks.`;
    // The approved "anything else" line, with a plain reason (1 Oct 2026): the three offered policies all pass the
    // check, so a mismatch means a damaged or half-updated install, never a wrong choice; model ids stay out of it.
    case "mismatch":
      return `the ${name} didn't start, because its start-up check failed: the models in your settings don't match the models this copy of the workflow runs on. Claude can help you look into it.`;
    default:
      return `the ${name} didn't start, because its start-up check failed: ${problem?.why ?? "no reason was given"}. Claude can help you look into it.`;
  }
}
export const PERSON_LINE = {
  starting: (job) => `${LABEL} you asked for ${ASKED[job] ?? "a job"}, so Claude is starting the ${lineName(job)}. It will wait for your approval at each main step.`,
  startingQueued: (job, ended) => ended
    ? `${LABEL} the ${lineName(ended)} has finished, so the ${lineName(job)} you queued is starting now.`
    : `${LABEL} the ${lineName(job)} you queued is starting now.`,
  alreadyRunning: (running, job) => running && job
    ? `${LABEL} a ${lineName(running)} is still running in this chat. In the box, choose whether the ${lineName(job)} you asked for should wait its turn or replace the running one.`
    : `${LABEL} a workflow is still running in this chat. In the box, choose whether the new one should wait its turn or replace the running one.`,
  notStarted: (problem, job) => `${LABEL} ${notStartedWhy(problem, job)}`,
  gateAnswer: () => `${LABEL} the workflow is waiting for your approval, so this message is taken as your answer to it, not as a new request.`,
  workflowAnswer: () => `${LABEL} the workflow asked you a question, so this message is taken as your answer, not as a new request.`,
  duringWorkflow: (running) => `${LABEL} this isn't a new job, so the running ${running ? lineName(running) : "workflow"} carries on, taking your message into account.`,
  notAJob: () => `${LABEL} this isn't one of the jobs that get a full workflow, so Claude answers it normally.`,
  // What happens next depends on the chat's mode (1 Oct 2026, found in review): Hand-off mode starts no workflow from
  // plain words, so a Hand-off chat is told it is back to its own work.
  ended: (job, mode) => mode === "b"
    ? `${LABEL} the ${lineName(job)} has finished. From here, Claude works in this chat in Hand-off mode again.`
    : `${LABEL} the ${lineName(job)} has finished. From here, asking for a job in your own words starts a new workflow; anything else gets a normal answer.`,
  queued: (job, running) => `${LABEL} queued. The ${lineName(job)} will start by itself when the ${lineName(running)} finishes.`,
  queuedTwice: (job) => `${LABEL} the ${lineName(job)} is already queued, so it wasn't added twice.`,
  replaced: (job, running) => `${LABEL} the ${lineName(running)} was stopped, and the ${lineName(job)} is starting now.`,
  neither: (running) => `${LABEL} nothing new was started; the ${lineName(running)} carries on.`,
};

/** One wording everywhere, in every instruction and refusal below; it informs, it does not order, and it is exact. */
export const KEEP_OUT = "Keep the plugin, command names and model names out of what you say to the person.";

/**
 * The arguments that start a routed workflow: a tag with this run's models and cost recording, chosen by zero-touch,
 * then the person's own words for the job: `[zero-touch policy=<name> auth=<mode>] <words>`. The workflow commands
 * read the tag as this run's choice (the same explicit choice /mmo:pass makes with its policy flag), which wins over
 * the project's saved choice and any routing-policy.yaml. It is a tag, not a flag, on purpose: a person typing a
 * command gets exactly the surface they had, with no new flags to learn (tools/test/command.test.mjs).
 */
export function startArgs({ args, auth, policy }) {
  const tag = `[zero-touch policy=${POLICY_NAME.test(String(policy ?? "")) ? policy : STANDARD_POLICY} auth=${auth === "vendor" ? "vendor" : "estimated"}]`;
  return args ? `${tag} ${args}` : tag;
}

/** The instruction that starts a routed workflow (the rules recognised the request). */
export function startInstruction({ job, args, auth, policy }) {
  const plain = PLAIN[job];
  const call = `skill "mmo:${job}", args ${JSON.stringify(startArgs({ args, auth, policy }))}`;
  const lead = `The person's message asks for a full ${plain.name}.`;
  const line = job === "greenfield" ? "Running this as a full new-app build." : `Running this as a full ${plain.name}.`;
  const brief = job === "greenfield"
    ? " Their message is the brief to build from: in the brief step, write it into ./brief.md in the Project Brief layout instead of offering the example briefs, and ask only for what that layout needs and the message does not say."
    : "";
  return (
    `${lead} Start it now with the Skill tool: ${call}. Before the call, tell the person this one plain line: "${line}" ` +
    `The arguments carry this run's models and cost recording, chosen by zero-touch: do not ask about either.${brief} ` +
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
 * What Opus says when a workflow cannot start in this chat: the real cause and the fix that works for that cause
 * (independent review, 25 Sep: one fixed sentence sent every cause to the one-time setting, which fixes only one).
 * The same causes as the person's line (PERSON_LINE.notStarted), so the two never disagree.
 */
export function cannotStartInstruction(job, problem) {
  const lead = `The person's message asks for a full ${PLAIN[job].name}, but it cannot start in this chat:`;
  const tail = `Meanwhile handle the request as an ordinary chat if they want. ${KEEP_OUT}`;
  switch (problem?.cause) {
    case "not-built":
      return `${lead} the plugin is not fully set up on this machine. Tell the person in one plain sentence and offer to finish the setup; if they agree, run: node ${JSON.stringify(VERIFY_SETUP)} --fix . ${tail}`;
    case "google":
      return `${lead} its models include Flash, and this machine has no Google login. Tell the person plainly; if they want help, walk them through connecting Google (for example "gcloud auth application-default login", which opens their browser to sign in). Do not change their zero-touch settings yourself. ${tail}`;
    case "busy":
      // 0.8.4: one workflow at a time in one project (lib/project-lock.mjs).
      return `${lead} another chat in this project is running a ${plainName(problem.job)}, and two workflows in one project would overwrite each other's records. ` +
        `Tell the person plainly: they can finish it in that chat, or type /clear there, then ask again. ${tail}`;
    case "mismatch":
      return `${lead} the chosen models need the workflow's helpers on ${problem.needed}, but they run on ${problem.have}. Tell the person plainly; they can choose other models with "change zero-touch settings". ${tail}`;
    default:
      return `${lead} ${problem?.why ?? "its start-up check failed."} Tell the person plainly. ${tail}`;
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


// ─── What zero-touch checks before it starts a workflow ─────────────────

/**
 * The models every workflow zero-touch starts in this chat runs on: the chat's own record, written at its start from
 * the person's settings (zero-touch/scripts/mark.mjs, `workflow.json`). A chat marked before 1 Oct 2026 has none and
 * runs on the standard pick. The project's saved choice and its routing-policy.yaml are not used by zero-touch
 * (decided 1 Oct 2026); a workflow typed by hand still follows them.
 */
export function chatPolicy(sid, env = process.env) {
  try {
    const p = JSON.parse(readFileSync(join(sessionDir(sid, env), "workflow.json"), "utf8"))?.policy;
    if (POLICY_NAME.test(String(p ?? "")) && existsSync(join(POLICIES, `${p}.yaml`))) return p;
  } catch { /* none: the standard pick */ }
  return STANDARD_POLICY;
}

/** The shipped file of a policy name: passed as an explicit path, it wins over a project's own file everywhere. */
export function policyPath(policy) {
  return join(POLICIES, `${policy}.yaml`);
}

/** Whether a shipped policy sends any work to Google (a Gemini model): then a Google login is needed. */
export function policyUsesGoogle(policy) {
  try { return /^\s*model_name:\s*gemini-/m.test(readFileSync(policyPath(policy), "utf8")); } catch { return false; }
}

/**
 * Whether this machine has a Google login, by mmo's own rule (verify-setup.mjs, the same functions): an API key, or a
 * login file that can be used; a project name alone is not a login. Offline: a login that has expired is caught at
 * the first call to Google, where the workflow's own pre-flight and dispatch report it.
 */
export function googleLoggedIn(env = process.env) {
  const real = usableEnv(env);
  const serviceAccountFile = real.GOOGLE_APPLICATION_CREDENTIALS ? inspectCredentialFile(real.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const adcFile = inspectCredentialFile(adcPath(real.HOME || undefined));
  return hasGeminiCredentials({ env: real, vertex: vertexCredentialState({ env: real, serviceAccountFile, adcFile }) });
}

/**
 * Why a workflow cannot start here, or null when it can. The workflow's own run-start check (driver-model-check.mjs,
 * the pipeline's router) is asked with the policy's shipped file, so the hook and the workflow judge the same policy,
 * and a project's routing-policy.yaml decides nothing. Causes: "google" (the policy uses Flash and there is no Google
 * login), "not-built" (the server's build is missing: the only case that is really "not installed"), "mismatch" (the
 * policy's judgment model is not the one the workflow's helpers run on), "check" (any other failure of the check, in
 * the check's own words; until 1 Oct 2026 every failure of its first step was wrongly called "not installed").
 */
export function startProblem({ projectDir, policy, auth, env = process.env }) {
  if (policyUsesGoogle(policy) && !googleLoggedIn(env)) return { problem: { cause: "google" } };
  if (auth === "vendor") return { problem: null, policy };
  if (!existsSync(SERVER_DIST)) return { problem: { cause: "not-built" } };
  const args = ["--project-root", projectDir, "--policy-path", policyPath(policy)];
  const first = (err) => String(err?.stderr ?? "").trim().split("\n")[0] || "its run-start model check failed.";
  let needed;
  try {
    needed = execFileSync(process.execPath, [DRIVER_MODEL_CHECK, ...args, "--print-only"], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }).toString().trim();
  } catch (err) {
    return { problem: { cause: "check", why: first(err) } };
  }
  try {
    execFileSync(process.execPath, [DRIVER_MODEL_CHECK, ...args], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
    return { problem: null, policy };
  } catch (err) {
    let pinned = null;
    try { pinned = pinnedDriverModel(); } catch { /* a damaged install: the check's own words below say so */ }
    if (pinned && needed && needed !== pinned) return { problem: { cause: "mismatch", have: pinned, needed } };
    return { problem: { cause: "check", why: first(err) } };
  }
}

/**
 * Shown to the person, not the model, when a typed workflow command is kept back because another chat in this
 * project is running a workflow (0.8.4): the prompt hook blocks the typed line, and Claude Code shows this reason.
 */
export function typedBusyReason(lock) {
  return `Zero-touch: this didn't start, because another chat in this project folder is already running a ${lineName(lock?.job)}, and two at once would get in each other's way. When that one has finished, or after you type /clear in that chat, try again.`;
}
