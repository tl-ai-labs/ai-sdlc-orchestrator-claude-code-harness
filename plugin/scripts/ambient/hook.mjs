#!/usr/bin/env node
/**
 * Zero-touch hook dispatcher: one entry point for the hook moments zero-touch's workflow routing needs, in a chat the
 * zero-touch plugin marked at its start (no /mmo: command typed).
 *
 *   node hook.mjs <event>        hook input JSON on stdin, decision JSON on stdout
 *
 * What it does: a message the fixed rules recognise as one of the eight /mmo: jobs (lib/route.mjs) gets the
 * instruction to start that job's workflow (lib/route-flow.mjs); until the workflow starts, tools that change
 * something wait (Guard A, pre-any) and only that workflow's command may start (Guard B, pre-skill). Every other
 * message and every other tool call passes untouched: the chat is plain Claude Code.
 *
 * Hand-off mode (a chat the zero-touch plugin marked "b"; docs/ambient-mode.md, "Hand-off mode"): the chat's own
 * model does the development, so plain words start no workflow. A message asking for a new document, spec, plan,
 * tests or the same change across files is recognised by fixed rules (lib/handoff-route.mjs) and the chat's model is
 * reminded to hand that work to the hand-off tools; the person sees one line saying where the work goes
 * (lib/handoff.mjs). The chat is kept on its pinned model: a switch to another model is refused (pre-model-switch).
 * A workflow command the person types runs as in any chat.
 *
 * A second job while a workflow runs (0.8.4, lib/queue.mjs): plain words recognised as a job, a typed /mmo:
 * workflow command, or the model starting one is held, and the model asks the person "Queue it" or "Replace it";
 * the answer is read from the multiple-choice result (post-question). A queued job starts by itself at the end of
 * the turn in which the running workflow ended (turn-end); a replace stops the running workflow as mmo's own abort
 * does (lib/workflow-log.mjs abortRun). One workflow at a time per project (lib/project-lock.mjs).
 *
 * 0.8.4 removed the generic orchestrator that until 0.8.3 also ran here (the start-of-chat note, Read outlines,
 * refused by-hand typing handed to a worker model, the worker tools, the control arm, the model lock and the savings
 * board). Its code is kept on the branch archive/generic-orchestrator (tag generic-orchestrator-0.8.3).
 *
 * Contract held by every handler:
 *   - Decisions are JSON on stdout with exit 0. The shell shim in front of this file turns ANY exit into 0, so a
 *     crash here can never block a tool call or a prompt. No handler relies on exit 2.
 *   - A chat without the zero-touch mark returns before touching the disk (the shim, then lib/chat-mode.mjs).
 *     Mode "observe", a workflow run and a helper agent's call start nothing.
 *   - Modes: "on" is workflow mode, "b" is hand-off mode; zero-touch acts in both (acts()). "observe" only records.
 *   - No prompt text, file content or command output is ever stored. Paths, sizes, rule ids and numbers only.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, MODES } from "./lib/config.mjs";
import { appendEvent, setEventAgent } from "./lib/events.mjs";
import { typedCommand, WORKFLOW_COMMANDS } from "./lib/commands.mjs";
import { appendPrivate, ensureSessionDir, mmoHome, sessionDir } from "./lib/paths.mjs";
import { sentWhileWorking } from "./lib/transcript.mjs";
import { abortRun, workflowState } from "./lib/workflow-log.mjs";
import { decideChatMode } from "./lib/chat-mode.mjs";
import { folderKind, routeMessage } from "./lib/route.mjs";
import { PERSON_LINE as L, cannotStartInstruction, dropRoute, KEEP_OUT, NOT_NOW_REASON, plainName, readRoute, saveWorkflowPolicy, startFirstReason, startInstruction, startProblem, typedBusyReason, writeRoute } from "./lib/route-flow.mjs";
import { acquire, heldByOther, pipelineSinceOf, release } from "./lib/project-lock.mjs";
import * as Q from "./lib/queue.mjs";
import { handoffMessage } from "./lib/handoff-route.mjs";
import * as H from "./lib/handoff.mjs";

const SELF_STOP_MS = 1500;
const BREAKER_FAILURES = 3;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const DEBUG = process.env.MMO_AMBIENT_DEBUG === "1";
/** The tags Claude Code 2.1.270 wraps its own queued notices in (read from the program, not guessed). */
const NOTICE_TAG = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b/i;

// A hook that hangs is worse than a hook that does nothing. The timer is
// unref'd, so it only matters when something (an open stdin) keeps us alive.
setTimeout(() => process.exit(0), SELF_STOP_MS).unref();

function readStdinJson() {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on("end", () => {
      if (size > MAX_STDIN_BYTES) return done(null);
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { done(null); }
    });
    process.stdin.on("error", () => done(null));
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

const canonicalModel = H.canonicalModel;

function num(value, fallback, min = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

// ---------- chat markers (one tiny file each in the chat's folder; presence is the fact) ----------

function sessionMarker(ctx, name) {
  return join(sessionDir(ctx.sid), name);
}
function hasSessionMarker(ctx, name) {
  return existsSync(sessionMarker(ctx, name));
}
function setSessionMarker(ctx, name, text = "") {
  ensureSessionDir(ctx.sid);
  writeFileSync(sessionMarker(ctx, name), text, { mode: 0o600 });
}
function dropSessionMarker(ctx, name) {
  try { rmSync(sessionMarker(ctx, name), { force: true }); } catch { /* already gone */ }
}

function breakerOpen(sid) {
  try {
    const file = join(sessionDir(sid), "failures.log");
    return existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= BREAKER_FAILURES;
  } catch {
    return false;
  }
}
function recordFailure(sid, event, err) {
  try {
    ensureSessionDir(sid);
    appendPrivate(join(sessionDir(sid), "failures.log"), `${new Date().toISOString()} ${event} ${String(err?.message ?? err).slice(0, 200)}\n`);
  } catch { /* nothing more to do */ }
}

/** Zero-touch acts in this chat: workflow mode ("on") or hand-off mode ("b"). A measuring run ("observe") only records. */
function acts(ctx) {
  return ctx.config.mode === "on" || ctx.config.mode === "b";
}

/**
 * Routing (docs/ambient-mode.md, "Routing") may act: workflow mode on for this chat, workflows switched on, no
 * workflow running, and not inside a helper agent. Hand-off mode never routes: there a workflow starts only from a
 * typed command.
 */
function routingOn(ctx) {
  return ctx.config.mode === "on" && ctx.config.routing === "on" && !ctx.pipeline && !ctx.agent;
}

/**
 * A message typed in a hand-off chat that is idle: which hand-off work it asks for, by the fixed rules. The person
 * sees where the work goes; the chat's model is reminded which tool takes it. Nothing is started and nothing is
 * blocked: the chat's model does the work, and hands the recognised part off.
 */
function handoffPrompt(ctx, text) {
  const stamp = H.readStamp(ctx.sid);
  const chat = H.chatState(stamp, H.chatModelNow(ctx.sid, ctx.input.transcript_path));
  const asked = handoffMessage(text);
  if (!asked.kinds.length) {
    appendEvent(ctx.sid, "handoff.none", { reason: asked.reason });
    return void say(null, H.HANDOFF_LINE.chatHandles(chat));
  }
  const found = H.handoffRoutes(ctx.sid, stamp);
  if (found.error) {
    appendEvent(ctx.sid, "handoff.unavailable", { kinds: asked.kinds.join(","), cause: found.error });
    return void say(H.unavailableInstruction(found), H.HANDOFF_LINE.unavailable(found, chat));
  }
  appendEvent(ctx.sid, "handoff.recognised", { kinds: asked.kinds.join(","), rest: asked.rest || undefined });
  say(H.handoffInstruction(asked), H.HANDOFF_LINE.handoff(asked, found.routes, chat));
}

/**
 * The chat is running a /mmo: workflow (29 Sep 2026: from its start until its own log shows it ended). The record
 * holds the moment the workflow started, so its run can be told from any earlier run in the project
 * (lib/workflow-log.mjs). While it runs, zero-touch stands down, exactly as for a typed command.
 */
function markPipeline(ctx, via, { job = null, args = "" } = {}) {
  // The record holds the moment, and (0.8.4) which job: the replace-or-queue question names it in plain words.
  setSessionMarker(ctx, "pipeline", JSON.stringify({ since: new Date().toISOString(), job, args }));
  acquire(ctx.projectDir, ctx.sid, job);
  ctx.pipeline = true;
  appendEvent(ctx.sid, "session.pipeline", { via, job: job ?? undefined });
}
/** When this chat's workflow started: the record's moment, or its file time for a record without one. */
function pipelineSince(ctx) {
  const ms = pipelineSinceOf(ctx.sid);
  if (Number.isFinite(ms)) return ms;
  try { return statSync(sessionMarker(ctx, "pipeline")).mtimeMs; } catch { return NaN; }
}
/** The job the running workflow was started for (null for a record written before 0.8.4). */
function runningJob(ctx) {
  try { return JSON.parse(readFileSync(sessionMarker(ctx, "pipeline"), "utf8")).job ?? null; } catch { return null; }
}
/** The chat's workflow is over (ended, replaced or cleared): the chat is ordinary again and the project is free. */
function endPipeline(ctx) {
  dropSessionMarker(ctx, "pipeline");
  dropRoute(ctx.sid);
  release(ctx.projectDir, ctx.sid);
  ctx.pipeline = false;
}
/**
 * Hands the chat back once its workflow has ended (its log shows the last gate answered, an abort, or a failed
 * end): from the next message on, a job starts its own workflow again and every other message is an ordinary one,
 * as if the person had typed the command and then carried on. A workflow with no logged run yet keeps the chat
 * (lib/workflow-log.mjs says why).
 */
function endPipelineIfOver(ctx) {
  if (!ctx.pipeline) return;
  const w = workflowState(ctx.projectDir, pipelineSince(ctx));
  if (w.state !== "ended") return;
  endPipeline(ctx);
  appendEvent(ctx.sid, "session.pipeline_ended", { run_id: w.runId, outcome: w.outcome });
}

/**
 * What the running workflow waits for, when it has asked the person something: "gate" (one of its gates is open),
 * "first" (it has not logged its run yet: it is still asking its first questions), or null. While it waits, the
 * person's next message is its answer, never a new job.
 */
function waitingFor(ctx) {
  const w = workflowState(ctx.projectDir, pipelineSince(ctx));
  if (w.state === "not-started") return "first";
  return w.state === "running" && w.waiting === true ? "gate" : null;
}

/** Holds a new job and returns what the model is told: ask the person Queue it or Replace it (lib/queue.mjs). */
function ask(ctx, { job, args, via }) {
  const running = runningJob(ctx) ?? "workflow";
  const choice = { job, args: args ?? "", via, running, question: Q.questionFor(running, job), prompt_id: ctx.input.prompt_id ?? null };
  Q.writeChoice(ctx.sid, choice);
  appendEvent(ctx.sid, "route.ask", { job, via, running });
  return Q.askInstruction(choice);
}

/**
 * The person's answer to the question: "queue", "replace" or "other". Returns what the model is told next.
 *   queue    the job joins the chat's queue (a duplicate is not added). After a typed command, whose text the
 *            model holds, nothing that changes anything runs until the turn ends (the hold).
 *   replace  the running workflow is stopped the way its own abort stops it (abortRun: its log records the abort,
 *            its write lock is switched off), then the new one starts: a typed command carries on as the chat's
 *            workflow; any other is routed like a recognised job.
 */
function settle(ctx, choice, kind) {
  Q.dropChoice(ctx.sid);
  const running = plainName(choice.running);
  if (kind === "queue") {
    const res = Q.enqueue(ctx.sid, choice);
    if (choice.via === "typed") Q.setHold(ctx.sid);
    appendEvent(ctx.sid, "route.queued", { job: choice.job, via: choice.via, duplicate: res === "duplicate" || undefined });
    const head = res === "duplicate"
      ? `The ${plainName(choice.job)} is already queued; it is not added twice.`
      : `Queued: the ${plainName(choice.job)} starts by itself when the running ${running} ends.`;
    const tail = choice.via === "typed"
      ? "Tell the person that in one short line. Do not run the command they typed now: stop here; the running workflow carries on when they answer it."
      : "Tell the person that in one short line, then carry on with the running workflow.";
    return `${head} ${tail} ${KEEP_OUT}`;
  }
  if (kind === "replace") {
    const w = workflowState(ctx.projectDir, pipelineSince(ctx));
    const done = abortRun(ctx.projectDir, w.runId, "replaced");
    endPipeline(ctx);
    appendEvent(ctx.sid, "route.replaced", { job: choice.job, via: choice.via, run_id: w.runId, logged: done.logged, unlocked: done.unlocked });
    if (choice.via === "typed") {
      markPipeline(ctx, "replace", { job: choice.job, args: choice.args });
      return `Replaced: the running ${running} is stopped. Carry on with the command the person typed. ${KEEP_OUT}`;
    }
    writeRoute(ctx.sid, { job: choice.job, args: choice.args, via: "replace", status: "pending", prompt_id: ctx.input.prompt_id ?? null });
    appendEvent(ctx.sid, "route.decided", { job: choice.job, via: "replace" });
    return `Replaced: the running ${running} is stopped. ${startInstruction({ job: choice.job, args: choice.args, auth: ctx.config.routing_defaults.auth })}`;
  }
  appendEvent(ctx.sid, "route.choice_neither", { job: choice.job, via: choice.via });
  return `The person chose neither: start nothing new, and carry on. ${KEEP_OUT}`;
}

/** What the model reads while "Queue it" holds a typed command's own steps until the turn ends. */
const HOLD_REASON = `The command the person typed is queued: it starts by itself when the running workflow ends. Do not run its steps now; stop here. ${KEEP_OUT}`;

/**
 * A plugin command typed by the person, decided by the prompt hook alone: it fires for every typed command and sees
 * the typed line (probed on 2.1.282 and 2.1.283), and it is the one hook that can keep the line from the model.
 * Until 0.8.4 the expansion hook (UserPromptExpansion) also marked the chat; it is no longer registered.
 *   - a one-off tool (setup, policy, revert): nothing; it is recorded only so its own Skill call passes Guard B;
 *   - a workflow command while another chat in this project runs one: kept from the model (the prompt hook blocks
 *     it and Claude Code shows the person why);
 *   - a workflow command while this chat runs one: the replace-or-queue question (a typed command is never a gate's
 *     answer);
 *   - otherwise the chat becomes that workflow's run, exactly as before.
 */
function typedMoment(ctx, cmd) {
  const pid = ctx.input.prompt_id ?? null;
  const seen = Q.readTyped(ctx.sid);
  if (seen && pid && seen.prompt_id === pid) return seen.decision ?? {};
  let decision = {};
  if (cmd.workflow && acts(ctx) && !ctx.agent) {
    const lock = heldByOther(ctx.projectDir, ctx.sid);
    if (lock) {
      decision = { block: typedBusyReason(lock) };
      appendEvent(ctx.sid, "route.busy", { job: cmd.name, via: "typed" });
    } else if (ctx.pipeline) {
      decision = { context: ask(ctx, { job: cmd.name, args: cmd.args, via: "typed" }) };
    } else {
      markPipeline(ctx, "typed", { job: cmd.name, args: cmd.args });
    }
  } else if (cmd.workflow && !ctx.pipeline) {
    markPipeline(ctx, "typed", { job: cmd.name, args: cmd.args });
  }
  Q.writeTyped(ctx.sid, { name: cmd.name, prompt_id: pid, decision });
  return decision;
}

/** The chat becomes a workflow run: zero-touch stands down until the run ends, as for a typed command. */
function markStarted(ctx, route) {
  writeRoute(ctx.sid, { ...route, status: "started" });
  markPipeline(ctx, "route", { job: route.job, args: route.args ?? "" });
  appendEvent(ctx.sid, "route.started", { job: route.job, via: route.via });
}

/**
 * Starts a workflow. Every route is made by the prompt hook and was already checked there (only the rules route,
 * since 26 Sep), so the chat is marked first and only then is the policy saved: the start hook stays cheap, and a
 * slow save can never leave a started workflow blocked by Guard A. A failed save is recorded, not fatal: the
 * workflow's own policy step then says so.
 */
function startWorkflow(ctx, route) {
  markStarted(ctx, route);
  if (route.via === "queue") Q.removeStarted(ctx.sid, route);
  try {
    const saved = saveWorkflowPolicy({ projectDir: ctx.projectDir, policy: ctx.config.routing_defaults.policy });
    appendEvent(ctx.sid, "route.policy", { policy: saved.policy, written: saved.written });
  } catch (err) {
    appendEvent(ctx.sid, "route.policy_not_saved", { why: String(err?.message ?? err).slice(0, 120) });
  }
}

/**
 * Tools that change nothing: they may run while a routed workflow waits for
 * its start. Everything else, every other MCP server's tools included, waits.
 */
const CHANGES_NOTHING = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch", "TodoWrite", "TodoRead", "TaskList", "TaskGet", "WebFetch", "WebSearch", "Skill", "AskUserQuestion", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

/**
 * Guard A (the catch-all pre-any hook): while a routed workflow waits for its
 * start, nothing that can change files or start work runs, helpers already
 * running included. The Skill call itself is Guard B's.
 */
function blockUntilStarted(ctx) {
  if (CHANGES_NOTHING.has(String(ctx.input.tool_name ?? ""))) return false;
  // 0.8.4: while the replace-or-queue question waits for its answer, and while "Queue it" holds a typed command's
  // steps, nothing that changes anything runs, the running workflow included.
  const choice = Q.readChoice(ctx.sid);
  if (choice) return void deny(ctx, "route.tool_blocked", Q.askInstruction(choice)) ?? true;
  if (Q.hasHold(ctx.sid)) return void deny(ctx, "route.tool_held", HOLD_REASON) ?? true;
  if (ctx.pipeline) return false;
  const route = readRoute(ctx.sid);
  if (route?.status !== "pending") return false;
  deny(ctx, "route.tool_blocked", startFirstReason(route.job));
  return true;
}

/** Refuses the tool call this PreToolUse hook is about, with the reason the model reads, and logs it. */
function deny(ctx, event, why) {
  appendEvent(ctx.sid, event, { tool: String(ctx.input.tool_name ?? "") });
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
}

/**
 * The chat's start work: its log line and the old-records sweep; after /clear, forgetting the run and the route of
 * the conversation that ended. Runs at the chat's start moment (SessionStart), or LATE, at the first moment of a
 * chat whose start it missed (29 Sep 2026): the zero-touch plugin writes the chat's record in its own start hook,
 * and Claude Code runs the two plugins' start hooks at once, so this plugin's start hook can run before the record
 * exists and do nothing.
 */
function startChat(ctx, { late = false } = {}) {
  appendEvent(ctx.sid, "session.start", {
    mode: ctx.config.mode, routing: ctx.config.routing, config_sources: ctx.sources.join(","),
    source: late ? undefined : ctx.input.source, late: late || undefined, model: canonicalModel(ctx.input.model) || undefined,
    transcript_path: ctx.input.transcript_path,
  });
  sweepOldSessions(ctx);
  setSessionMarker(ctx, "started");
  if (late) return;
  if (ctx.input.source === "clear") {
    // A fresh conversation: nothing earlier counts. A workflow run and a pending route belong to the conversation
    // /clear ended.
    endPipeline(ctx);
    // 0.8.4: the question, the queue and the hold end with the conversation too.
    Q.dropChoice(ctx.sid);
    Q.dropQueue(ctx.sid);
    Q.dropHold(ctx.sid);
    Q.dropTyped(ctx.sid);
  }
}

// ---------- handlers ----------

const handlers = {
  "session-start"(ctx) {
    startChat(ctx);
  },

  prompt(ctx) {
    const text = typeof ctx.input.prompt === "string" ? ctx.input.prompt : "";
    // Claude Code delivers some things through the prompt hook that nobody
    // typed: a background command's completion notice, queued as a message.
    // Such a message is a tagged block; it is never judged as a request.
    // Only the app's own notice tags mark a machine notice; a person pasting HTML is still a person.
    const typed = !NOTICE_TAG.test(text);
    // A workflow that has ended gives the chat back before this message is judged (a new typed command then starts
    // a new run of its own).
    endPipelineIfOver(ctx);
    appendEvent(ctx.sid, "prompt", { prompt_id: ctx.input.prompt_id ?? randomUUID(), typed, chars: text.length });
    if (!typed) return;
    // The replace-or-queue question belongs to the message that raised it (0.8.4): a later message that is one of
    // its two answers, written out, settles it; any other message drops it, so nothing stays blocked.
    const waiting = Q.readChoice(ctx.sid);
    if (waiting && waiting.prompt_id !== (ctx.input.prompt_id ?? null)) {
      const kind = Q.labelKind(text);
      // "Replace it" for a job asked in plain words starts that workflow now; the person sees which one.
      if (kind) return void say(settle(ctx, waiting, kind), kind === "replace" && waiting.via !== "typed" ? L.starting(waiting.job) : null);
      Q.dropChoice(ctx.sid);
      appendEvent(ctx.sid, "route.choice_dropped", { job: waiting.job });
    }
    // A typed plugin command (0.8.4: only a workflow command makes the chat a workflow run; see typedMoment).
    const cmd = typedCommand(text);
    if (cmd) {
      const decision = typedMoment(ctx, cmd);
      if (decision.block) return void emit({ decision: "block", reason: decision.block });
      // A typed command shows no line of its own (the person named the workflow), except when it must wait for
      // the Queue-or-Replace answer.
      if (decision.context) say(decision.context, L.alreadyRunning());
      return;
    }
    if (ctx.pipeline) {
      // Plain words while this chat runs a workflow (0.8.4). A recognised job is held and the person is asked
      // Queue it / Replace it, unless the workflow is waiting for an answer: then the message is that answer.
      if (!acts(ctx) || ctx.agent) return;
      const waits = waitingFor(ctx);
      if (waits) return void say(null, waits === "gate" ? L.gateAnswer() : L.workflowAnswer());
      // Hand-off mode starts no workflow from plain words, so there is no second job to queue.
      if (ctx.config.mode === "b") return void say(null, L.duringWorkflow());
      const r = routeMessage(text, folderKind(ctx.projectDir));
      if (!r.job) return void say(null, L.duringWorkflow());
      return void say(ask(ctx, { job: r.job, args: r.args, via: "words" }), L.alreadyRunning());
    }
    // A message typed while Claude is still working joins the running task (29 Sep 2026): it never starts a
    // workflow and never ends a start that task has pending. Only a message sent when the chat is idle is judged,
    // as the person typing a command would be; work done earlier in the chat does not matter.
    if (sentWhileWorking(ctx.input.transcript_path, text) === true) {
      appendEvent(ctx.sid, "route.none", { reason: "sent while Claude was working: part of the running task" });
      return;
    }
    // A route belongs to one prompt: a new prompt ends it, so nothing stays blocked.
    const stale = readRoute(ctx.sid);
    if (stale?.status === "pending") { dropRoute(ctx.sid); appendEvent(ctx.sid, "route.dropped", { job: stale.job }); }
    // Hand-off mode: the message is the chat's own work; the part that is hand-off work is recognised.
    if (ctx.config.mode === "b") return void (ctx.agent ? undefined : handoffPrompt(ctx, text));
    if (!routingOn(ctx)) return;
    // Only the rules route (26 Sep): a request they do not recognise is an ordinary chat, never an offer and never
    // the chat model's guess. Nothing is added to it.
    const r = routeMessage(text, folderKind(ctx.projectDir));
    if (!r.job) {
      appendEvent(ctx.sid, "route.none", { reason: r.reason });
      return void say(null, L.notAJob());
    }
    const route = { job: r.job, args: r.args, via: "rules" };
    // One workflow at a time in one project (0.8.4), then never tell Opus to start a workflow that its own
    // run-start check would stop.
    const lock = heldByOther(ctx.projectDir, ctx.sid);
    const { problem } = lock
      ? { problem: { cause: "busy", job: lock.job } }
      : startProblem({ projectDir: ctx.projectDir, fallback: ctx.config.routing_defaults.policy, auth: ctx.config.routing_defaults.auth });
    let line;
    if (!problem) {
      writeRoute(ctx.sid, { ...route, status: "pending", prompt_id: ctx.input.prompt_id ?? null });
      appendEvent(ctx.sid, "route.decided", { job: route.job, via: route.via });
      line = startInstruction({ ...route, auth: ctx.config.routing_defaults.auth });
    } else {
      appendEvent(ctx.sid, "route.cannot_start", { job: route.job, cause: problem.cause });
      line = cannotStartInstruction(route.job, problem);
    }
    say(line, problem ? L.notStarted(problem) : L.starting(route.job));
  },

  "pre-skill"(ctx) {
    // Guard B. Every command start, typed or model-started, can be a Skill call
    // (probed live on Claude Code 2.1.282). Zero-touch off: nothing to decide, as on 0.7.7.
    const name = String(ctx.input.tool_input?.skill ?? "").trim().replace(/^\//, "");
    if (!/^mmo:/.test(name) || !acts(ctx)) return;
    // Workflow mode starts a workflow the rules recognised; hand-off mode only one the person typed.
    const notNow = ctx.config.mode === "b" ? H.TYPED_ONLY_REASON : NOT_NOW_REASON;
    const job = name.slice("mmo:".length);
    const typed = Q.readTyped(ctx.sid);
    // The Skill call of a command the person just typed (in modes where a typed command makes one): the prompt
    // hooks have already decided about it.
    const typedNow = typed?.name === job && (!ctx.input.prompt_id || !typed.prompt_id || typed.prompt_id === ctx.input.prompt_id);
    const refuse = (why) => emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    if (!WORKFLOW_COMMANDS.has(job)) {
      // A one-off command (setup, policy, revert) or a skill of the plugin (the brownfield manual): the person's
      // own typing runs it, and so does a running workflow; the chat starting one by itself is refused.
      if (typedNow || ctx.pipeline) return;
      appendEvent(ctx.sid, "route.refused", { job, by: ctx.agent ? "helper" : "chat" });
      return void refuse(notNow);
    }
    // 0.8.4: the replace-or-queue question waits for its answer; no workflow starts before it.
    const waiting = Q.readChoice(ctx.sid);
    if (waiting) return void refuse(Q.askInstruction(waiting));
    // A helper agent never starts the chat's workflow: the person asked the chat, not the helper.
    if (ctx.agent) { appendEvent(ctx.sid, "route.refused", { job, by: "helper" }); return void refuse(notNow); }
    const route = readRoute(ctx.sid);
    if (route?.status === "pending") {
      if (route.job !== job) return void refuse(startFirstReason(route.job));
      startWorkflow(ctx, route);
      return;
    }
    if (typedNow) return;
    if (ctx.pipeline) {
      // The chat starting a second workflow by itself while one runs (0.8.4): held, and the person is asked.
      const args = typeof ctx.input.tool_input?.args === "string" ? ctx.input.tool_input.args : "";
      return void refuse(ask(ctx, { job, args, via: "skill" }));
    }
    // No route: the chat is starting a workflow on its own guess. Only the rules (or a typed command) start one
    // since 26 Sep, so this is always refused and the chat carries on.
    appendEvent(ctx.sid, "route.refused", { job, by: "chat" });
    refuse(notNow);
  },

  "pre-any"(ctx) {
    // Guard A: one catch-all, so every tool that can change something waits
    // for a routed workflow's start, whoever calls it (blockUntilStarted).
    blockUntilStarted(ctx);
  },

  "post-skill"(ctx) {
    // The routed workflow's command really ran. Its start is marked here too,
    // so a start hook that never finished (Claude Code lets the call through
    // on a hook timeout) cannot leave the workflow blocked by Guard A.
    const name = String(ctx.input.tool_input?.skill ?? "").trim().replace(/^\//, "");
    const route = readRoute(ctx.sid);
    if (ctx.agent || route?.status !== "pending" || name !== `mmo:${route.job}`) return;
    startWorkflow(ctx, route);
  },

  "pre-agent"(ctx) {
    const type = String(ctx.input.tool_input?.subagent_type ?? "");
    if (!type.startsWith("mmo:")) return;
    // 0.8.4: while the replace-or-queue question waits, or "Queue it" holds a typed command, no workflow helper starts.
    const waiting = acts(ctx) ? Q.readChoice(ctx.sid) : null;
    if (waiting || (acts(ctx) && Q.hasHold(ctx.sid))) {
      appendEvent(ctx.sid, "agent.mmo-ambient_request", { agent: type, blocked: true, held: true });
      return void emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: waiting ? Q.askInstruction(waiting) : HOLD_REASON } });
    }
    // The five mmo agents belong to a workflow run. In ordinary chat the
    // model picking one up on its own starts a gated run nobody asked for.
    const blocked = !ctx.pipeline && !ctx.agent;
    appendEvent(ctx.sid, "agent.mmo-ambient_request", { agent: type, blocked: blocked && acts(ctx) });
    if (blocked && acts(ctx)) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `${type} runs only inside a workflow the person started or agreed to. None is running in this chat, so carry on with your own tools.`,
        },
      });
    }
  },

  "post-question"(ctx) {
    // The person answered a multiple-choice question (PostToolUse on AskUserQuestion). When it is the waiting
    // replace-or-queue question, its exact label decides (lib/queue.mjs answerFrom); any other question is not ours.
    const waiting = Q.readChoice(ctx.sid);
    if (!waiting || !acts(ctx)) return;
    const kind = Q.answerFrom(ctx.input.tool_response, waiting.question);
    if (kind === null) return;
    emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: settle(ctx, waiting, kind) } });
  },

  "turn-end"(ctx) {
    // The end of a turn (Stop). The hold of a queued typed command ends here. When the chat's workflow has ended and
    // a job is queued, the turn continues with the first one: the reason is what the model reads next. A start the
    // model then does not make is not pushed again (stop_hook_active): the route is dropped, the job stays queued
    // for the next turn's end.
    Q.dropHold(ctx.sid);
    endPipelineIfOver(ctx);
    const route = readRoute(ctx.sid);
    if (ctx.input.stop_hook_active === true) {
      if (route?.status === "pending" && route.via === "queue") { dropRoute(ctx.sid); appendEvent(ctx.sid, "route.queue_not_started", { job: route.job }); }
      return;
    }
    if (!acts(ctx) || ctx.agent || ctx.pipeline || route?.status === "pending" || Q.readChoice(ctx.sid)) return;
    const next = Q.readQueue(ctx.sid)[0];
    if (!next) return;
    const lock = heldByOther(ctx.projectDir, ctx.sid);
    if (lock) return void appendEvent(ctx.sid, "route.queue_waits", { job: next.job, cause: "busy" });
    const { problem } = startProblem({ projectDir: ctx.projectDir, fallback: ctx.config.routing_defaults.policy, auth: ctx.config.routing_defaults.auth });
    if (problem) {
      Q.removeStarted(ctx.sid, next);
      appendEvent(ctx.sid, "route.cannot_start", { job: next.job, cause: problem.cause, via: "queue" });
      return void emit({ decision: "block", reason: cannotStartInstruction(next.job, problem), systemMessage: L.notStarted(problem) });
    }
    writeRoute(ctx.sid, { job: next.job, args: next.args, via: "queue", status: "pending", prompt_id: ctx.input.prompt_id ?? null });
    appendEvent(ctx.sid, "route.decided", { job: next.job, via: "queue" });
    emit({ decision: "block", reason: Q.queuedStartInstruction(next), systemMessage: L.startingQueued(next.job) });
  },

  "pre-handoff"(ctx) {
    // A hand-off tool call (hand-off mode; the tools are the server's, which never sees a chat). In a hand-off chat
    // that runs no workflow the call gets the hook's stamp, so the server knows which chat it belongs to; the chat's
    // models are resolved first, so the server finds them in the chat's records. Anywhere else the call is refused:
    // a chat in workflow mode has no hand-offs, and a workflow run has its own steps and its own bill.
    const tool = H.handoffToolName(ctx.input.tool_name);
    if (!tool) return;
    const refuse = (why, cause) => {
      appendEvent(ctx.sid, "handoff.tool_refused", { tool, cause });
      emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    };
    if (ctx.config.mode !== "b") return void (acts(ctx) ? refuse(H.NOT_A_HANDOFF_CHAT, "not-handoff-chat") : undefined);
    if (ctx.pipeline) return void refuse(H.NOT_IN_A_WORKFLOW, "workflow-run");
    // An undo sends nothing to a model, so it works even when the chat's hand-off policy cannot be read.
    if (tool !== H.UNDO_TOOL) {
      const found = H.handoffRoutes(ctx.sid, H.readStamp(ctx.sid));
      if (found.error) return void refuse(H.unavailableInstruction(found), found.error);
    }
    appendEvent(ctx.sid, "handoff.tool_call", { tool });
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: H.stampedInput(ctx.input.tool_input, { sessionId: ctx.sid, projectDir: ctx.projectDir, auth: ctx.config.routing_defaults.auth }) } });
  },

  "post-handoff"(ctx) {
    // A hand-off tool answered. The person sees one line written by code from the tool's receipt; the model reads
    // the receipt itself, so nothing is added for it.
    if (ctx.config.mode !== "b" || !H.handoffToolName(ctx.input.tool_name)) return;
    const receipt = H.toolReceipt(ctx.input.tool_response);
    const chat = H.chatState(H.readStamp(ctx.sid), H.chatModelNow(ctx.sid, ctx.input.transcript_path));
    const shown = H.receiptLine(receipt, chat);
    if (!shown) return;
    appendEvent(ctx.sid, "handoff.receipt", { status: receipt.status, file: typeof receipt.file === "string" ? receipt.file : undefined, cost_usd: typeof receipt.cost_usd === "number" ? receipt.cost_usd : undefined });
    emit({ systemMessage: shown });
  },

  "pre-model-switch"(ctx) {
    // Hand-off mode keeps the chat on its pinned model: the chat's own model does the development, so which model
    // that is decides the quality and the cost of everything that is not handed off. A switch to the pinned model
    // always passes. A switch whose target cannot be read is never refused: a guard that misreads its input must
    // not lock the person out of their own model picker. Workflow mode never pins the chat.
    if (ctx.config.mode !== "b" || ctx.agent) return;
    const stamp = H.readStamp(ctx.sid);
    const to = canonicalModel(ctx.input.to_model);
    if (!stamp?.chat_model || !to) return;
    const leaves = to !== stamp.chat_model && canonicalModel(ctx.input.requested_model) !== stamp.chat_model;
    appendEvent(ctx.sid, "model.switch_request", { to, refused: leaves });
    if (!leaves) return;
    emit({ hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "deny", permissionDecisionReason: H.switchRefusal(stamp) } });
  },

  "post-model-switch"(ctx) {
    // The chat is on another model now (a switch that passed, or one this plugin could not refuse; Claude Code also
    // sends this when a reopened chat gets its model back). Kept so every line names the model really in use.
    if (ctx.config.mode !== "b" || ctx.agent) return;
    const to = canonicalModel(ctx.input.to_model);
    if (!to) return;
    H.recordModelNow(ctx.sid, to);
    appendEvent(ctx.sid, "model.switched", { to });
  },
};

/**
 * The prompt hook's one reply to a typed message: `text` is added to what the model reads with the message, and
 * `line` is shown to the person (a `systemMessage`: the model never reads it). Either may be absent; the line is
 * shown only in a chat where zero-touch acts (a measuring run that only records shows nothing).
 */
function say(text, line = null) {
  const shown = line && showsLines ? line : null;
  if (!text && !shown) return;
  emit({ ...(shown ? { systemMessage: shown } : {}), ...(text ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } } : {}) });
}
/** Set once per hook run (main): zero-touch acts in the chat (workflow or hand-off mode) and the call is the chat's own, not a helper's. */
let showsLines = false;

/**
 * Once a day, drop session folders older than the retention window. `logs` is swept too: 0.8.3's generic
 * orchestrator wrote there, and nothing does now, so its old records age out.
 */
function sweepOldSessions(ctx) {
  const home = mmoHome();
  const stamp = join(home, "last-sweep");
  const dayMs = 24 * 3600 * 1000;
  try {
    if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < dayMs) return;
    writeFileSync(stamp, "", { mode: 0o600 });
    const keepMs = num(ctx.config.retention_days, 30, 1) * dayMs;
    for (const root of [join(home, "sessions"), join(home, "logs")]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (Date.now() - statSync(dir).mtimeMs > keepMs) rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch { /* housekeeping must never fail a session start */ }
}

async function main() {
  const event = process.argv[2];
  const handler = handlers[event];
  if (!handler) return;
  const input = await readStdinJson();
  if (!input || typeof input !== "object" || typeof input.session_id !== "string" || !input.session_id) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const { config, sources } = loadConfig({ projectDir });
  const sid = input.session_id;
  // Each chat is decided once, when it starts (lib/chat-mode.mjs, 29 Sep 2026): the zero-touch plugin's start hook
  // writes the chat's record at a fresh start (a new chat or /clear), so enabling or disabling that plugin in Claude
  // Code's plugin list is the switch; every moment acts on the record, so a chat is never half on and half off. A
  // chat with no record is off. MMO_AMBIENT is a one-run override for a developer or a measuring setup.
  const override = MODES.includes(process.env.MMO_AMBIENT) ? process.env.MMO_AMBIENT : undefined;
  const mode = decideChatMode({ event, source: input.source, override, sessionId: sid });
  if (!mode) return;
  config.mode = mode;

  if (breakerOpen(sid)) return;
  // A call from inside a helper agent carries agent_id; the session id is the parent chat's.
  const agent = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  const ctx = { input, sid, cwd, projectDir, config, sources, agent };
  showsLines = acts({ config }) && !agent;
  setEventAgent(agent);
  try {
    ctx.pipeline = hasSessionMarker(ctx, "pipeline");
    // The chat's start work, if its start hook ran before the zero-touch plugin had marked the chat (startChat).
    if (event !== "session-start" && !hasSessionMarker(ctx, "started")) {
      startChat(ctx, { late: true });
    }
    await handler(ctx);
  } catch (err) {
    recordFailure(sid, event, err);
    if (DEBUG) console.error(`[mmo zero-touch] ${event}: ${err?.stack ?? err}`);
  }
}

main().catch(() => {}).finally(() => {
  // Flush stdout before leaving; process.exit() alone can cut a pipe short.
  process.stdout.write("", () => process.exit(0));
});
