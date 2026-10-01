/**
 * Zero-touch hand-off mode, the safety net: a NEW document or test file is not typed by hand.
 *
 * In a hand-off chat the chat's model is told to hand new documents, specs, plans and tests to the hand-off tools.
 * Being told is not enough: a model that types the file itself has done the expensive typing, and nothing checked
 * the result. So the hook refuses the write and names the tool that takes it. What is refused is narrow on purpose:
 *   - only a file that does not exist yet (a change to a file that exists is the chat model's own edit);
 *   - only inside the project, and never a tool's own folder or an agent's instruction file;
 *   - only a document (by its file type) or a test file (by its name);
 *   - written with the Write tool, or through the shell (a redirect or `tee`), which is how a model in an
 *     auto-approving permission mode usually writes.
 * It stands down whenever handing off is not possible or not wanted: a file a failed hand-off handed back, a
 * hand-off policy that cannot be read, a workflow run (which has its own rules), a chat in workflow mode.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { fileKind, shellTargets } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff-net.mjs"));
// Whether a hand-off can run is asked of the workflows' own router, which needs the built server.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

/**
 * A person who chose Hand-off ("b", Flash 3.8 typing every kind, the chat on Opus 5) or Workflows ("a") in the
 * settings box.
 */
function sandbox({ mode = "b" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-net-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  writeFileSync(join(repo, "README.md"), "# Shop\n");
  writeFileSync(join(repo, "tests", "users.test.js"), "// tests\n");
  writeZtSettings(home, { mode: mode === "a" ? "workflows" : "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" } });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The chat's stamp names a policy that no longer exists (a damaged install): nothing can be handed off. */
function breakPolicy(s, sid) {
  const file = join(s.home, "sessions", sid, "handoff.json");
  const st = JSON.parse(readFileSync(file, "utf8"));
  for (const k of Object.keys(st.typists)) st.typists[k].policy = "no-such-policy";
  writeFileSync(file, JSON.stringify(st));
  rmSync(join(s.home, "sessions", sid, "handoff_models.json"), { force: true });
}

function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
const startOn = (s, sid) => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
const write = (s, sid, path, extra = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Write", tool_input: { file_path: path.startsWith("/") ? path : join(s.repo, path), content: "text\n" }, ...extra }, s);
const bash = (s, sid, command, extra = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command }, ...extra }, s);
const denied = (r) => (r.json?.hookSpecificOutput?.permissionDecision === "deny" ? r.json.hookSpecificOutput.permissionDecisionReason : null);
const line = (r) => r.json?.systemMessage ?? null;

test("which files the net is about: a document by its type, a test file by its name", () => {
  const doc = ["README.md", "docs/setup.md", "docs/api/reference.mdx", "design/cache.rst", "notes.adoc", "PLAN.md"];
  const tests = ["tests/cart.test.js", "src/cart.spec.ts", "src/__tests__/cart.js", "tests/test_cart.py", "pkg/cart_test.go", "spec/cart_spec.rb", "src/test/java/CartTest.java", "CartTests.cs"];
  const neither = ["src/cart.js", "package.json", "tests/fixtures/orders.json", "tests/helpers.js", "docs/diagram.svg", "openapi.yaml", "contest.js", "src/latest.ts", "README", "test.js"];
  for (const p of doc) assert.equal(fileKind(p), "document", p);
  for (const p of tests) assert.equal(fileKind(p), "tests", p);
  for (const p of neither) assert.equal(fileKind(p), null, p);
  // A tool's own folder and an agent's instruction file are not the project's documents.
  for (const p of [".claude/notes.md", ".github/PULL_REQUEST_TEMPLATE.md", ".sdlc/design.md", "docs/.cache/x.md", "CLAUDE.md", "sub/CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"]) assert.equal(fileKind(p), null, p);
});

test("what a shell command writes: its redirects and tee, never the text of a here-document", () => {
  // Each target is written as the command's starting folder sees it: a `cd` before it is already applied.
  const t = (c) => shellTargets(c);
  assert.deepEqual(t("cat > docs/setup.md <<'EOF'\n# Setup\n> a quote, not a redirect > x.md\nEOF"), ["docs/setup.md"]);
  assert.deepEqual(t("echo hi >> notes.md"), ["notes.md"]);
  assert.deepEqual(t('printf "%s" "a > b.md" > "docs/my guide.md"'), ["docs/my guide.md"], "a > inside quotes is text; a quoted target is one path");
  assert.deepEqual(t("npm test 2>&1 | tee out.log docs/run.md"), ["out.log", "docs/run.md"]);
  assert.deepEqual(t("npm test > /dev/null 2>&1"), ["/dev/null"]);
  assert.deepEqual(t("node build.js &> build.log; ls"), ["build.log"]);
  assert.deepEqual(t("echo x >| docs/clobber.md"), ["docs/clobber.md"], "the overwrite form of a redirect");
  assert.deepEqual(t("cat <<-END | tee -a CHANGELOG.md\n\tline > not.md\n\tEND"), ["CHANGELOG.md"]);
  assert.deepEqual(t("diff <(sort a) <(sort b)"), []);
  assert.deepEqual(t("git log --format='%s > %an'"), []);
  // A cd moves what follows it, wherever it stands; one inside brackets ends with them.
  assert.deepEqual(t("cd docs && cat > guide.md <<EOF\nx\nEOF"), ["docs/guide.md"]);
  assert.deepEqual(t("mkdir -p docs/api && cd docs/api && echo x > ref.md; cd .. ; echo y > index.md"), ["docs/api/ref.md", "docs/index.md"]);
  assert.deepEqual(t("(cd docs && echo x > sub.md); echo y > top.md"), ["docs/sub.md", "top.md"]);
  assert.deepEqual(t("cd /var/tmp && echo x > a.md"), ["/var/tmp/a.md"]);
  // A folder or a path the command computes cannot be known from its text: such a target is left out, never guessed.
  assert.deepEqual(t("echo a > $HOME/notes.md"), []);
  assert.deepEqual(t('cd "$DIR" && echo a > notes.md; echo b > `pwd`/x.md'), []);
  assert.deepEqual(t("cd ~/work && echo a > notes.md"), []);
  for (const odd of [undefined, "", 42, "echo 'unclosed > x.md"]) assert.deepEqual(t(odd), []);
});

test("a new document or test file typed with the Write tool is refused, and the reason names the hand-off tool", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "n1");
    const doc = await write(s, "n1", "docs/setup.md");
    assert.match(denied(doc) ?? "", /docs\/setup\.md/);
    assert.match(denied(doc), /write_document/);
    assert.match(denied(doc), /kind, file, purpose, readers, sections, facts/, "the form's fields, so the next call is the right one");
    assert.match(denied(doc), /A change to a file that exists is yours to make/);
    assert.equal(line(doc), "Zero-touch: Opus 5 started writing the new document docs/setup.md itself. In Hand-off mode that work goes to Flash 3.8, so zero-touch stopped it and told Opus 5 to hand it off.");
    const tests = await write(s, "n1", "tests/cart.test.js");
    assert.match(denied(tests) ?? "", /write_tests_from_cases/);
    assert.match(denied(tests), /file, target, functions, cases, test_command/);
    assert.equal(line(tests), "Zero-touch: Opus 5 started writing the new test file tests/cart.test.js itself. In Hand-off mode that work goes to Flash 3.8, so zero-touch stopped it and told Opus 5 to hand it off.");
    // A helper the chat started is held to the same rule: the work is the chat's.
    assert.match(denied(await write(s, "n1", "docs/guide.md", { agent_id: "helper-1" })) ?? "", /write_document/);
  } finally { s.cleanup(); }
});

test("everything else passes untouched: existing files, code, other folders, other tools", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "p1");
    for (const path of ["README.md", "tests/users.test.js", "src/cart.js", "tests/fixtures/orders.json", ".claude/notes.md", "CLAUDE.md", join(s.dir, "elsewhere", "notes.md")]) {
      assert.equal((await write(s, "p1", path)).stdout, "", path);
    }
    assert.equal((await run("pre-any", { session_id: "p1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "README.md"), old_string: "Shop", new_string: "The shop" } }, s)).stdout, "", "an edit to a file that exists");
    assert.equal((await run("pre-any", { session_id: "p1", cwd: s.repo, tool_name: "Read", tool_input: { file_path: join(s.repo, "docs", "setup.md") } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

test("a new document written through the shell is refused too", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "b1");
    const heredoc = await bash(s, "b1", "cat > docs/setup.md <<'EOF'\n# Setup\nnpm ci\nEOF");
    assert.match(denied(heredoc) ?? "", /docs\/setup\.md[\s\S]*write_document/);
    assert.match(denied(await bash(s, "b1", "cd docs && printf '# Guide' > guide.md")) ?? "", /docs\/guide\.md/, "a leading cd is followed");
    assert.match(denied(await bash(s, "b1", "echo '# tests' | tee tests/cart.test.js")) ?? "", /write_tests_from_cases/);
    for (const fine of ["npm test > out.log 2>&1", "echo '- fixed' >> README.md", "git log --oneline > /dev/null", "ls docs", "cat > src/cart.js <<'EOF'\nexport const a = 1;\nEOF"]) {
      assert.equal((await bash(s, "b1", fine)).stdout, "", fine);
    }
  } finally { s.cleanup(); }
});

test("the net stands down when handing off is not possible or not wanted", { skip: SKIP ?? false }, async () => {
  // A file a failed hand-off handed back is the chat model's to write.
  const s = sandbox();
  try {
    await startOn(s, "r1");
    writeFileSync(join(s.home, "sessions", "r1", "handoff_released.json"), JSON.stringify(["docs/setup.md"]));
    assert.equal((await write(s, "r1", "docs/setup.md")).stdout, "");
    assert.match(denied(await write(s, "r1", "docs/other.md")) ?? "", /write_document/, "only that file");
    // A workflow run has its own rules for what may be written.
    await run("prompt", { session_id: "r1", cwd: s.repo, prompt: "/mmo:docs write the API docs", prompt_id: "r1-1" }, s);
    assert.equal((await write(s, "r1", "docs/other.md")).stdout, "", "inside a workflow run");
  } finally { s.cleanup(); }
  // A hand-off policy that cannot be read: there is nothing to hand the file to.
  const broken = sandbox();
  try {
    await startOn(broken, "x1");
    breakPolicy(broken, "x1");
    assert.equal((await write(broken, "x1", "docs/setup.md")).stdout, "");
  } finally { broken.cleanup(); }
  // A chat in workflow mode has no hand-offs at all.
  const a = sandbox({ mode: "a" });
  try {
    await startOn(a, "a1");
    assert.equal((await write(a, "a1", "docs/setup.md")).stdout, "");
  } finally { a.cleanup(); }
});

test("the start note tells the chat's model which by-hand writes the net refuses: the Write tool and a shell command", () => {
  // The note once said "with Write or Edit". Edit cannot create a file, and the shell, which can, was not named: a
  // model told only about Write reaches for a redirect next, and learns of the net by being refused. The note names
  // the two routes the net covers, in the words the refusal uses, and that a file that exists is the model's own.
  const note = readFileSync(join(ROOT, "zero-touch", "scripts", "messages.mjs"), "utf8"); // the rules note lives there (1 Oct 2026)
  assert.doesNotMatch(note, /with Write or Edit is refused/);
  assert.match(note, /Creating such a file yourself, with the Write tool or a shell command, is refused; a change to a file that exists is yours to make\./);
});
