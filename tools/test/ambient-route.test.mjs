/**
 * Zero-touch routing, recognition half (ask 2, step 3): which /mmo: job an ordinary chat message asks for, or
 * none. Two signals must agree: the message (an instruction whose job verb opens it) and the folder (a new folder
 * can only be greenfield; an existing project can only be one of the seven brownfield jobs). Precision first: a
 * wrong route starts a paid pipeline nobody asked for, a missed route only leaves the chat to the generic
 * orchestrator. So anything unsure is no route. The labelled set below is the contract; the rules may change,
 * these answers may not without a reason written next to the case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { routeMessage, folderKind, ROUTABLE_JOBS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route.mjs"));

const NEW = "new";
const EXISTING = "existing";

// [message, folder, expected job or null]
const ROUTED = [
  // greenfield: an instruction to build a whole app, in a new folder
  ["build me a todo app with a React frontend and a Node backend", NEW, "greenfield"],
  ["Create a small Go service that answers /ping with pong", NEW, "greenfield"],
  ["please build a REST API for a library catalogue", NEW, "greenfield"],
  ["Can you scaffold a new FastAPI backend for invoices?", NEW, "greenfield"],
  ["Let's make a simple CLI tool that converts units", NEW, "greenfield"],
  ["I want you to build a receivables-ops web app from the brief below.\n\n# Brief\n...", NEW, "greenfield"],
  ["# Project brief: TeamBoard\n\nA kanban board for small teams...", NEW, "greenfield"],
  // bugfix
  ["fix the /login endpoint returning 500 on missing password", EXISTING, "bugfix"],
  ["Fix the bug where the invoice total ignores discounts", EXISTING, "bugfix"],
  ["please debug why the export job crashes on empty files", EXISTING, "bugfix"],
  ["Can you fix the failing date parser test?", EXISTING, "bugfix"],
  ["fix this bug: TypeError: cannot read properties of undefined (reading 'id') in orders.ts", EXISTING, "bugfix"],
  ["fix the login bug and add a regression test", EXISTING, "bugfix"],
  // refactor
  ["refactor the payment module to remove the duplicated retry logic", EXISTING, "refactor"],
  ["Extract the shared date logic into a util module and update all call sites", EXISTING, "refactor"],
  ["please restructure the api folder by resource", EXISTING, "refactor"],
  ["consolidate the three config loaders into one", EXISTING, "refactor"],
  // test
  ["add unit tests for src/payments", EXISTING, "test"],
  ["Write integration tests for the orders API", EXISTING, "test"],
  ["backfill tests for the auth module to reach 80% line coverage", EXISTING, "test"],
  ["increase test coverage of the parser to 90%", EXISTING, "test"],
  // docs
  ["document the auth module", EXISTING, "docs"],
  ["Write API docs for the billing endpoints", EXISTING, "docs"],
  ["add docstrings to the scheduler package", EXISTING, "docs"],
  ["update the README with the new setup steps", EXISTING, "docs"],
  // deps
  ["upgrade jest from 28 to 29 and fix whatever breaks", EXISTING, "deps"],
  ["bump react to 19", EXISTING, "deps"],
  ["update all dependencies", EXISTING, "deps"],
  ["Upgrade the npm packages to their latest versions", EXISTING, "deps"],
  // feature-extend: a capability added to something that exists
  ["add a ?filter param to the existing /users endpoint", EXISTING, "feature-extend"],
  ["add pagination to the orders endpoint", EXISTING, "feature-extend"],
  ["extend the export command to support CSV", EXISTING, "feature-extend"],
  // feature-new: a new subsystem
  ["add a webhooks module (endpoint, storage, retry loop)", EXISTING, "feature-new"],
  ["add a notifications module with email and SMS", EXISTING, "feature-new"],
  ["build a new reporting page for managers", EXISTING, "feature-new"],
  ["fix 3 failing tests in the parser", EXISTING, "bugfix"],
];

const NOT_ROUTED = [
  // questions and explanations
  ["how do I fix the login bug?", EXISTING, "a question"],
  ["why does the export job crash on empty files?", EXISTING, "a question"],
  ["what would it take to refactor the payment module?", EXISTING, "a question"],
  ["should I upgrade jest to 29?", EXISTING, "a question"],
  ["can you explain how the auth module works", EXISTING, "an explanation, not a job"],
  ["is it worth adding tests for the parser?", EXISTING, "a question"],
  ["explain the architecture of this repo", EXISTING, "an explanation"],
  // negations
  ["don't refactor anything yet, just read the code", EXISTING, "negated"],
  ["please do not fix the bug, only find it", EXISTING, "negated"],
  // bare references to earlier context: a follow-up, not a new job
  ["fix it", EXISTING, "no object"],
  ["fix this", EXISTING, "no object"],
  ["refactor that too", EXISTING, "no object"],
  ["add tests for it", EXISTING, "no object"],
  // small edits: never a pipeline
  ["fix the typo in the README", EXISTING, "a typo"],
  ["fix the lint errors", EXISTING, "lint"],
  ["fix formatting in utils.py", EXISTING, "formatting"],
  ["rename getUser to fetchUser", EXISTING, "a rename"],
  ["update the button colour to blue", EXISTING, "an edit, not a dependency"],
  // two different jobs in one message
  ["refactor the parser and update the docs", EXISTING, "two jobs"],
  ["upgrade react to 19 and add tests for the forms", EXISTING, "two jobs"],
  // the folder disagrees
  ["build me a todo app with React", EXISTING, "greenfield words in an existing project"],
  ["fix the /login endpoint returning 500", NEW, "a bugfix in an empty folder"],
  ["add unit tests for src/payments", NEW, "tests in an empty folder"],
  // found by the offline audit over 6,934 real messages (25 Sep): kept here as hand-written look-alikes
  ["so we need to fix the export job too?", EXISTING, "a question: it ends with a question mark and is not a can-you request"],
  ["fix is in the repo now, so the total is right", EXISTING, "'fix' as a noun: a verb follows it"],
  ["fix 2 worked fine", EXISTING, "'fix' as a noun: a verb follows it"],
  ["Build an inventory REST API in TypeScript with Express", EXISTING, "api/service/dashboard can be a whole app: unsure in an existing project"],
  ["build a new admin dashboard for managing users", EXISTING, "a dashboard can be a whole app: unsure in an existing project"],
  ["implement a new notifications service with email and SMS", EXISTING, "a service can be a whole app: unsure in an existing project"],
  ["add the export button to the reports page as well", EXISTING, "'as well': a follow-up to earlier work"],
  ["also refactor the parser", EXISTING, "'also': a follow-up to earlier work"],
  ["fix the same bug in the invoices module too", EXISTING, "'too': a follow-up to earlier work"],
  ["fix the upload bug again", EXISTING, "'again': a follow-up to earlier work"],
  // independent review, 25 Sep: ordinary requests that routed. A new app must be what is built (no preposition
  // between the article and the app word); a project job must name something in the software; a pasted brief
  // is /mmo:greenfield's own "# Project Brief" layout and not a question.
  ["write me a haiku about a bot", NEW, "a poem about a bot, not a bot"],
  ["write a cover letter for a backend role", NEW, "a letter, not a backend"],
  ["write an email to my boss about the project", NEW, "an email"],
  ["generate a report on the website traffic", NEW, "a report"],
  ["## Requirements\n- users can log in\nIs this list complete?", NEW, "a question about requirements"],
  ["# Project Brief: TeamBoard\n\nA kanban board.\n\nIs this brief complete?", NEW, "a brief with a question is a question"],
  ["fix the spelling: teh", EXISTING, "a spelling fix"],
  ["fix typo: teh -> the", EXISTING, "a typo"],
  ["fix the grammar: this are wrong", EXISTING, "grammar"],
  ["fix merged", EXISTING, "news, not a job: nothing in the software named"],
  ["fix deployed, thanks", EXISTING, "news"],
  ["fix nothing yet, just explain the bug", EXISTING, "negated"],
  ["fix your mistake", EXISTING, "nothing in the software named"],
  ["fix my last commit message", EXISTING, "a commit message edit"],
  ["troubleshoot my wifi", EXISTING, "not software in this project"],
  ["fix the code below", EXISTING, "pasted code, not the project"],
  ["refactor done", EXISTING, "news"],
  ["restructure this essay", EXISTING, "an essay"],
  ["document what you did", EXISTING, "a follow-up about the chat"],
  ["update the deps list in the README", EXISTING, "a docs edit about deps, not an upgrade"],
  // not a pipeline job at all
  ["build the project", EXISTING, "compile, not a job"],
  ["run the tests", EXISTING, "run, not a job"],
  ["review my PR", EXISTING, "review, not one of the eight jobs"],
  ["write a function that reverses a string", NEW, "a snippet, not an app"],
  ["status", EXISTING, "chat"],
  ["ok go", EXISTING, "chat"],
  ["thanks mate", NEW, "chat"],
  ["/mmo:greenfield", NEW, "a typed command is handled by Claude Code itself"],
  ["", NEW, "empty"],
];

test("every job the router can name is a /mmo: command that exists", () => {
  const commands = ["greenfield", "docs", "bugfix", "feature-extend", "feature-new", "refactor", "test", "deps"];
  assert.deepEqual([...ROUTABLE_JOBS].sort(), [...commands].sort());
  for (const c of commands) readFileSync(join(ROOT, "plugin", "commands", `${c}.md`), "utf8");
});

test("routed: each instruction goes to its job, with the message as the job's description", () => {
  for (const [message, folder, job] of ROUTED) {
    const r = routeMessage(message, folder);
    assert.equal(r.job, job, `${JSON.stringify(message)} in a ${folder} folder: ${r.reason}`);
    if (job !== "greenfield") {
      assert.ok(r.args.length > 0 && r.args.length <= 300 && !r.args.includes("\n"), `a one-line description for ${JSON.stringify(message)}`);
    } else {
      assert.equal(r.args, "", "/mmo:greenfield takes no arguments");
    }
  }
});

test("not routed: questions, negations, follow-ups, small edits, two jobs, a disagreeing folder, chat", () => {
  for (const [message, folder, why] of NOT_ROUTED) {
    const r = routeMessage(message, folder);
    assert.equal(r.job, null, `${JSON.stringify(message)} (${why}) was routed to ${r.job}`);
    assert.ok(r.reason, "every no-route says why");
  }
});

test("the folder check is /mmo:greenfield's own four signals of an existing repo, plus any source file", () => {
  const guard = readFileSync(join(ROOT, "plugin", "commands", "greenfield.md"), "utf8");
  for (const signal of ["`./src/` exists and is non-empty", "`git ls-files | head -1`", "`package.json`, `pyproject.toml`, `go.mod`", "longer than a stub (>200 bytes)"]) {
    assert.ok(guard.includes(signal), `greenfield.md still lists: ${signal} (if it changed, change folderKind with it)`);
  }
  const dir = mkdtempSync(join(tmpdir(), "mmo-route-"));
  const fresh = (name) => { const d = join(dir, name); mkdirSync(d); return d; };
  try {
    const empty = fresh("empty");
    assert.equal(folderKind(empty), NEW);
    const brief = fresh("brief-only"); writeFileSync(join(brief, "brief.md"), "# Brief\n" + "x".repeat(5000));
    assert.equal(folderKind(brief), NEW, "a brief alone is how a greenfield build starts");
    const shortReadme = fresh("short-readme"); writeFileSync(join(shortReadme, "README.md"), "# x\n");
    assert.equal(folderKind(shortReadme), NEW, "a stub README is not a project");
    const longReadme = fresh("long-readme"); writeFileSync(join(longReadme, "README.md"), "x".repeat(201));
    assert.equal(folderKind(longReadme), EXISTING);
    const src = fresh("src"); mkdirSync(join(src, "src")); writeFileSync(join(src, "src", "notes.txt"), "x");
    assert.equal(folderKind(src), EXISTING, "./src/ non-empty");
    const manifest = fresh("manifest"); writeFileSync(join(manifest, "go.mod"), "module x\n");
    assert.equal(folderKind(manifest), EXISTING);
    const code = fresh("loose-code"); writeFileSync(join(code, "main.py"), "print(1)\n");
    assert.equal(folderKind(code), EXISTING, "a source file of its own");
    const git = fresh("git"); execFileSync("git", ["init", "-q"], { cwd: git });
    writeFileSync(join(git, "notes.txt"), "x"); execFileSync("git", ["add", "notes.txt"], { cwd: git });
    assert.equal(folderKind(git), EXISTING, "git tracks a file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
