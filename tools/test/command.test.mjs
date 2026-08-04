/**
 * command.test.mjs — guards the two-prompt user surface.
 *
 * The whole product promise is that a person types two prompts and gets a run:
 * one prompt to install, one to start. The second prompt is `/sdlc-run`, and it
 * only holds if the command genuinely needs no arguments — a single required
 * flag turns "type this" into "read the docs first", which is the failure this
 * file exists to prevent.
 *
 * These are contract tests over the command and agent definitions. They cannot
 * prove the run behaves correctly — only a paid end-to-end run does that — but
 * they do catch the cheap, silent regressions: a flag creeping back into the
 * wizard, the output contract drifting between the command and the agent that
 * has to honour it, or a documented path that no longer exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const WIZARD = "plugin/commands/sdlc-run.md";
const FULL = "plugin/commands/run-sdlc-pass.md";
const AGENT = "plugin/agents/orchestrator.md";

/** Split a command/agent markdown file into its YAML frontmatter and body. */
function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "command files must open with a YAML frontmatter block");
  return { head: match[1], body: match[2] };
}

test("both commands ship, and the wizard is the one prompt 2 names", () => {
  assert.ok(existsSync(join(ROOT, WIZARD)), `${WIZARD} is missing — prompt 2 has nothing to invoke`);
  assert.ok(existsSync(join(ROOT, FULL)), `${FULL} is missing — the flag surface is documented as still available`);
});

test("/sdlc-run declares no arguments", () => {
  const { head } = frontmatter(read(WIZARD));

  // An empty argument-hint is what tells Claude Code, and the reader of
  // /help, that there is nothing to supply. A populated hint would put the
  // burden back on the user that this command exists to remove.
  assert.match(head, /argument-hint:\s*""/, "argument-hint must be empty — the wizard takes no arguments");
  assert.match(head, /description:\s*\S/, "a description is what the user sees in /help");
});

test("/sdlc-run keeps the run-record flags off the user surface", () => {
  const body = frontmatter(read(WIZARD)).body;

  // --study and --run-id name an internal layout that meant something when
  // this repo held recorded study passes. To someone building their own
  // project they are noise, and asking for them implies the run belongs to
  // some catalogue rather than to the user's folder.
  for (const flag of ["--study", "--run-id", "--auth=", "--policy="]) {
    assert.ok(
      !body.includes(flag),
      `${flag} must not appear in the wizard — it is resolved by asking, not by flag`
    );
    }
});

test("/sdlc-run checks the install before it can spend anything", () => {
  const body = frontmatter(read(WIZARD)).body;

  // The bundled model server is built at setup time, not committed. If that
  // build is missing the run still starts, bills the judgment phases, and
  // dies at the first mechanical dispatch. The check has to come first.
  assert.match(body, /verify-setup\.mjs/, "the wizard must run the setup check");
  const verifyAt = body.indexOf("verify-setup.mjs");
  const runAt = body.indexOf("orchestrator");
  assert.ok(verifyAt < runAt, "the setup check must come before the orchestrator is invoked");
  assert.ok(existsSync(join(ROOT, "plugin", "scripts", "verify-setup.mjs")), "the script the wizard calls must exist");
});

test("/sdlc-run offers every brief the repo actually ships", () => {
  const body = frontmatter(read(WIZARD)).body;

  const shipped = readdirSync(join(ROOT, "examples"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "examples", e.name, "brief.md")))
    .map((e) => `examples/${e.name}/brief.md`);

  for (const brief of shipped) {
    assert.ok(body.includes(brief), `the wizard must offer ${brief} — a shipped brief the user cannot pick is dead weight`);
  }
});

test("/sdlc-run writes generated code to src/, and the run record beside it", () => {
  const body = frontmatter(read(WIZARD)).body;
  assert.match(body, /`\.\/src`/, "generated code goes to ./src — an ordinary directory the user can run and commit");
  assert.match(body, /`\.\/\.sdlc\/?`/, "the run record goes to ./.sdlc, out of the way of the code");
});

test("the orchestrator accepts the settings the wizard resolves", () => {
  const agent = read(AGENT);

  // The wizard hands over a resolved set. If the agent still expects to read
  // flags, the handover silently loses settings the user was just asked for.
  for (const setting of ["brief_path", "auth_mode", "policy", "code_dir", "output_dir"]) {
    assert.ok(agent.includes(setting), `the orchestrator must name ${setting} — the wizard passes it`);
  }
  assert.match(agent, /\/sdlc-run/, "the orchestrator must know which command invokes it");
});

test("the orchestrator runs the generated tests where the generated code is", () => {
  const agent = read(AGENT);

  // Code and run record now live in different directories. Running the
  // application's test suite from the run-record directory finds no
  // package.json and reports a failure that has nothing to do with the code.
  const testStep = agent.split("**Run tests.**")[1];
  assert.ok(testStep, "the orchestrator must still run the generated test suite");
  const npmLine = testStep.split("\n").find((l) => l.includes("npm install && npm test"));
  assert.ok(npmLine, "the test step must state the command it runs");
  assert.match(npmLine, /<code_dir>/, "tests run from code_dir, not from the run-record directory");
});

test("the agent frontmatter still grants the tools the run depends on", () => {
  const { head } = frontmatter(read(AGENT));
  for (const tool of [
    "mcp__gemini-flash-server__execute_with_model",
    "mcp__gemini-flash-server__log_telemetry",
    "mcp__gemini-flash-server__load_policy",
  ]) {
    assert.ok(head.includes(tool), `the orchestrator cannot dispatch without ${tool}`);
  }
});

test("every policy the wizard names exists on disk", () => {
  const body = frontmatter(read(WIZARD)).body;
  for (const policy of body.match(/`(opus-only|opus-plus-flash)`/g) ?? []) {
    const name = policy.replace(/`/g, "");
    assert.ok(
      existsSync(join(ROOT, "plugin", "config", "policies", `${name}.yaml`)),
      `the wizard names policy ${name}, which has no YAML file`
    );
  }
});
