/**
 * Zero-touch hand-off mode, the two tools whose result is RUN before it reaches the project, and the undo.
 *
 *  - write_tests_from_cases: the chat's model decides the cases; the hand-off policy's model writes the test file;
 *    code runs it, with the project's own test command, in a scratch copy of the project. Only a file whose tests
 *    pass is written. A case's expected result is the specification: the typist is told never to change it to make a
 *    test pass, so a test that keeps failing comes back to the chat's model with the output, which is how a real bug
 *    in the code under test is found instead of hidden.
 *  - repeat_edit_across_files: the chat's model makes a change once, in one file; the hand-off policy's model
 *    repeats it in the files named, as exact edits. Code checks every edit applies exactly once and removes only
 *    lines the change is about (a line carrying one of the words the example's change removed), then runs the
 *    project's check command in a scratch copy with all the changed files. Only then are they written.
 *  - undo_hand_off: one call takes a landed hand-off back.
 *
 * Fake typists (no model calls, no network); the test command and the check command really run, in real scratch
 * copies of a small git project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HANDOFF_TOOLS, handleHandoffTool } from "../dist/handoff/tools.js";
import { checkTestsForm, renderTestsShared, renderTestsInstruction } from "../dist/handoff/tests.js";
import { checkRepeatForm, changeMarkers, checkRepeatEdits } from "../dist/handoff/repeat.js";

const FLASH = { id: "flash-completion", model: "gemini-3.8-flash", adapter: "mcp:model-dispatch", policy: "opus-plus-flash-v38" };
const CART = "export function total(items) {\n  return items.reduce((n, i) => n + i.price, 0);\n}\n\nexport function isEmpty(items) {\n  return items.length === 0;\n}\n";
const USES = (name) => `import { getUser } from "./users.js";\n\nexport function ${name}(id) {\n  const user = getUser(id);\n  return user.name;\n}\n`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-handoff-run-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test tests/", check: "node scripts/check-imports.mjs" } }, null, 2) + "\n");
  writeFileSync(join(repo, "src", "cart.js"), CART);
  writeFileSync(join(repo, "src", "users.js"), "export function getUser(id) {\n  return { id, name: `user ${id}` };\n}\n");
  for (const name of ["orders", "invoices", "reports"]) writeFileSync(join(repo, "src", `${name}.js`), USES(name));
  writeFileSync(join(repo, "tests", "users.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { getUser } from "../src/users.js";\n\ntest("a user has a name", () => {\n  assert.equal(getUser(1).name, "user 1");\n});\n');
  mkdirSync(join(repo, "scripts"));
  // The project's check: every file that imports from users.js imports a name users.js exports.
  writeFileSync(join(repo, "scripts", "check-imports.mjs"), 'import { readdirSync, readFileSync } from "node:fs";\nconst users = readFileSync("src/users.js", "utf8");\nlet bad = 0;\nfor (const f of readdirSync("src")) {\n  const m = /import \\{ (\\w+) \\} from "\\.\\/users\\.js"/.exec(readFileSync("src/" + f, "utf8"));\n  if (m && !users.includes("export function " + m[1] + "(")) { console.error(f + " imports " + m[1] + ", which users.js does not export"); bad++; }\n}\nprocess.exit(bad ? 1 : 0);\n');
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const session = join(home, "sessions", "chat1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "chat_mode"), "b");
  const flash = { typist: "flash", policy: "opus-plus-flash-v38" };
  writeFileSync(join(session, "handoff.json"), JSON.stringify({ chat_model: "claude-opus-5", pin: "setting", typists: { documents: flash, tests: flash, repeats: flash } }));
  writeFileSync(join(session, "handoff_models.json"), JSON.stringify({ routes: { docs: FLASH, tests: FLASH, repeat: FLASH } }));
  return { dir, home, repo, session, env: { MMO_HOME: home, HOME: home, PATH: process.env.PATH }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tokens = { input: 900, input_cached: 0, output: 300 };
function fake(door, modelId, modelName, script) {
  const calls = [];
  return {
    door, modelId, modelName, calls,
    async type(req) {
      calls.push(req);
      const s = script(req, calls.length) ?? {};
      return { answer: s.error ? null : s.answer, error: s.error, transport: false, tokens, cost_usd: s.cost ?? 0.004, latency_ms: 5 };
    },
  };
}
function typists({ flash, opus = () => ({ error: "not scripted" }) }) {
  const built = { flash: fake("flash-completion", "flash-completion", "gemini-3.8-flash", flash), opus: fake("lean-opus", "opus", "claude-opus-5", opus) };
  return { built, typistFor: (leaf) => (leaf.id === "opus" ? built.opus : built.flash) };
}
const call = async (s, tool, args, t) => {
  const r = await handleHandoffTool(tool, { ...args, _mmo: { session_id: "chat1", project_dir: s.repo, auth: "estimated" } }, { env: s.env, overrides: {}, typistFor: t?.typistFor, sleep: async () => {}, random: () => 0.5 });
  return { receipt: JSON.parse(r.content[0].text), ...(t?.built ?? {}) };
};

// ─── write_tests_from_cases ─────────────────────────────────────────────

const TESTS_FORM = (over = {}) => ({
  file: "tests/cart.test.js",
  target: "src/cart.js",
  functions: ["total", "isEmpty"],
  cases: [
    { name: "total adds the prices", given: "items priced 2 and 3", expect: "5" },
    { name: "total of no items is zero", given: "an empty list", expect: "0" },
    { name: "isEmpty is true for no items", given: "an empty list", expect: "true" },
  ],
  style_from: "tests/users.test.js",
  test_command: "node --test tests/cart.test.js",
  ...over,
});
const TEST_FILE = (totalOfTwo = 5) => [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { total, isEmpty } from "../src/cart.js";',
  "",
  `test("total adds the prices", () => { assert.equal(total([{ price: 2 }, { price: 3 }]), ${totalOfTwo}); });`,
  'test("total of no items is zero", () => { assert.equal(total([]), 0); });',
  'test("isEmpty is true for no items", () => { assert.equal(isEmpty([]), true); });',
  "",
].join("\n");

test("both tools are listed with their forms, and the undo", () => {
  const byName = Object.fromEntries(HANDOFF_TOOLS.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["repeat_edit_across_files", "undo_hand_off", "write_document", "write_tests_from_cases"]);
  assert.deepEqual([...byName.write_tests_from_cases.inputSchema.required].sort(), ["cases", "file", "functions", "target", "test_command"]);
  assert.deepEqual([...byName.repeat_edit_across_files.inputSchema.required].sort(), ["change", "example", "targets"]);
  assert.deepEqual([...byName.undo_hand_off.inputSchema.required], ["id"]);
  for (const t of HANDOFF_TOOLS) assert.ok(t.inputSchema.properties._mmo, `${t.name} takes the hook's stamp`);
});

test("the tests form is checked against the project before anything is sent", () => {
  const s = sandbox();
  try {
    assert.ok(checkTestsForm(TESTS_FORM(), s.repo).form);
    const problems = (over) => (checkTestsForm(TESTS_FORM(over), s.repo).problems ?? []).join("\n");
    assert.match(problems({ file: "tests/users.test.js" }), /tests\/users\.test\.js exists already/);
    assert.match(problems({ target: "src/basket.js" }), /target src\/basket\.js is not a file of the project/);
    assert.match(problems({ functions: [] }), /functions needs at least one name/);
    assert.match(problems({ functions: ["total", "subtotal"] }), /functions\[1\] subtotal is not in src\/cart\.js/);
    assert.match(problems({ functions: ["tot"] }), /functions\[0\] tot is not in src\/cart\.js/, "a piece of a longer name is not the name");
    assert.match(problems({ cases: [] }), /cases needs at least one case/);
    assert.match(problems({ cases: [{ name: "a", given: "", expect: "1" }] }), /cases\[0\]\.given is empty/);
    assert.match(problems({ cases: [{ name: "a", given: "x", expect: "1" }, { name: "a", given: "y", expect: "2" }] }), /cases\[1\]\.name repeats "a"/);
    assert.match(problems({ cases: [{ name: "a", given: "x", expect: "line one\nline two" }] }), /cases\[0\]\.expect is more than one line/);
    assert.match(problems({ style_from: "tests/none.test.js" }), /style_from tests\/none\.test\.js is not a file of the project/);
    assert.match(problems({ test_command: "" }), /test_command is empty/);
    // The command must be one this project can run: its program exists, and an npm script is in package.json.
    assert.match(problems({ test_command: "no-such-runner-xyz tests/cart.test.js" }), /test_command starts with no-such-runner-xyz, which is not a program on this machine/);
    assert.match(problems({ test_command: "npm run unit" }), /test_command names the npm script unit, which package\.json does not have/);
    assert.equal(problems({ test_command: "npm test" }), "", "an npm script the project has");
    assert.equal(problems({ test_command: "CI=1 node --test tests/cart.test.js" }), "", "a variable set before the program is fine");
  } finally { s.cleanup(); }
});

test("the tests brief: every case, the code under test, and the rule that an expected result is never changed", () => {
  const s = sandbox();
  try {
    const { form } = checkTestsForm(TESTS_FORM(), s.repo);
    assert.match(renderTestsShared(), /never change it, and never weaken an assertion, to make a test pass/);
    const text = renderTestsInstruction(form);
    assert.match(text, /path: tests\/cart\.test\.js/);
    assert.match(text, /code under test: src\/cart\.js \(total, isEmpty\)/);
    assert.match(text, /1\. total adds the prices — given: items priced 2 and 3 → expect: 5/);
    assert.match(text, /test command: node --test tests\/cart\.test\.js/);
  } finally { s.cleanup(); }
});

test("a case's name is found however the test file quotes it", async () => {
  const { checkTestsText } = await import("../dist/handoff/tests.js");
  const form = { cases: [{ name: "isn't empty for one item" }, { name: 'says "hi"' }] };
  assert.equal(checkTestsText(form, "test('isn\\'t empty for one item', () => {});\ntest(\"says \\\"hi\\\"\", () => {});\n").ok, true);
  assert.match(checkTestsText(form, "test('is empty', () => {});\n").reason, /the case "isn't empty for one item" has no test with that name/);
});

test("a test file that passes in a scratch copy is written; the receipt says what ran", async () => {
  const s = sandbox();
  try {
    const t = typists({ flash: (req) => ({ answer: { path: req.unit.path, content: TEST_FILE() } }) });
    const r = await call(s, "write_tests_from_cases", TESTS_FORM(), t);
    assert.equal(r.receipt.status, "written", JSON.stringify(r.receipt));
    assert.equal(r.receipt.file, "tests/cart.test.js");
    assert.equal(r.receipt.written_by, "gemini-3.8-flash");
    assert.equal(r.receipt.id, "h1");
    assert.match(r.receipt.checked.join("; "), /3 cases present/);
    assert.match(r.receipt.checked.join("; "), /`node --test tests\/cart\.test\.js` passed in a scratch copy/);
    assert.equal(readFileSync(join(s.repo, "tests", "cart.test.js"), "utf8"), TEST_FILE());
    const req = r.flash.calls[0];
    assert.equal(req.packet.phase, "tests");
    assert.deepEqual(req.packet.inputs.map((i) => i.path), ["src/cart.js", "tests/users.test.js"], "the code under test and the style file travel with the brief");
    assert.equal(req.packet.inputs[0].content, CART);
  } finally { s.cleanup(); }
});

test("a failing test goes back with the run's output; a file missing a case is refused without a run", async () => {
  const s = sandbox();
  try {
    const t = typists({ flash: (req, n) => ({ answer: { path: req.unit.path, content: n === 1 ? TEST_FILE().replace('test("total of no items is zero"', 'test("zero"') : n === 2 ? TEST_FILE(6) : TEST_FILE() } }), opus: (req) => ({ answer: { path: req.unit.path, content: TEST_FILE() }, cost: 0.09 }) });
    const r = await call(s, "write_tests_from_cases", TESTS_FORM(), t);
    assert.equal(r.receipt.status, "written");
    assert.equal(r.receipt.written_by, "claude-opus-5");
    assert.match(r.flash.calls[1].packet.instruction, /the case "total of no items is zero" has no test with that name/);
    assert.match(r.opus.calls[0].packet.instruction, /the test command failed in a scratch copy of the project/);
    assert.match(r.opus.calls[0].packet.instruction, /5 !== 6|Expected values to be strictly equal/, "the run's own output is what the next attempt reads");
    assert.match(r.receipt.note, /gemini-3\.8-flash failed twice/);
  } finally { s.cleanup(); }
});

test("tests that never pass are not written: the chat's model gets the output, which is how a real bug is found", async () => {
  const s = sandbox();
  try {
    // The code under test is wrong for this case, and the typists (rightly) keep the case as written.
    const form = TESTS_FORM({ cases: [{ name: "total adds the prices", given: "items priced 2 and 3", expect: "6" }], functions: ["total"] });
    const file = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../src/cart.js";\n\ntest("total adds the prices", () => { assert.equal(total([{ price: 2 }, { price: 3 }]), 6); });\n';
    const t = typists({ flash: (req) => ({ answer: { path: req.unit.path, content: file } }), opus: (req) => ({ answer: { path: req.unit.path, content: file } }) });
    const r = await call(s, "write_tests_from_cases", form, t);
    assert.equal(r.receipt.status, "failed");
    assert.ok(!existsSync(join(s.repo, "tests", "cart.test.js")), "a failing test file never reaches the project");
    assert.match(r.receipt.output, /5 !== 6|strictly equal/);
    assert.match(r.receipt.next, /real bug in src\/cart\.js, tell the person/);
    assert.deepEqual(JSON.parse(readFileSync(join(s.session, "handoff_released.json"), "utf8")), ["tests/cart.test.js"]);
  } finally { s.cleanup(); }
});

// ─── repeat_edit_across_files ───────────────────────────────────────────

/** The chat's model makes the change once, by hand: getUser becomes fetchUser in users.js and in orders.js. */
function changeOnce(s) {
  writeFileSync(join(s.repo, "src", "users.js"), "export function fetchUser(id) {\n  return { id, name: `user ${id}` };\n}\n");
  writeFileSync(join(s.repo, "src", "orders.js"), USES("orders").replaceAll("getUser", "fetchUser"));
}
const REPEAT_FORM = (over = {}) => ({
  example: "src/orders.js",
  targets: ["src/invoices.js", "src/reports.js"],
  change: "getUser is renamed fetchUser: the import and every call.",
  check_command: "node scripts/check-imports.mjs",
  ...over,
});
const RENAME = (path) => ({ path, edits: [{ search: 'import { getUser } from "./users.js";', replace: 'import { fetchUser } from "./users.js";' }, { search: "const user = getUser(id);", replace: "const user = fetchUser(id);" }] });

test("the repeat form: the example must really be changed, every target a file of the project", () => {
  const s = sandbox();
  try {
    assert.match((checkRepeatForm(REPEAT_FORM(), s.repo).problems ?? []).join("\n"), /example src\/orders\.js has no change since the last commit: make the change in it first/);
    changeOnce(s);
    const ok = checkRepeatForm(REPEAT_FORM(), s.repo);
    assert.ok(ok.form, (ok.problems ?? []).join("\n"));
    assert.match(ok.form.diff, /-import \{ getUser \}[\s\S]*\+import \{ fetchUser \}/, "the example's own change is the pattern");
    const problems = (over) => (checkRepeatForm(REPEAT_FORM(over), s.repo).problems ?? []).join("\n");
    assert.match(problems({ targets: [] }), /targets needs at least one file/);
    assert.match(problems({ targets: ["src/nope.js"] }), /targets\[0\] src\/nope\.js is not a file of the project/);
    assert.match(problems({ targets: ["src/invoices.js", "src/invoices.js"] }), /targets\[1\] src\/invoices\.js is listed twice/);
    assert.match(problems({ targets: ["src/orders.js"] }), /targets\[0\] is the example itself/);
    assert.match(problems({ change: "" }), /change is empty/);
    assert.match(problems({ example: "src/new-file.js" }), /example src\/new-file\.js is not a file of the project/);
    assert.match(problems({ check_command: "no-such-runner-xyz" }), /check_command starts with no-such-runner-xyz/);
  } finally { s.cleanup(); }
});

test("an edit may remove only lines the change is about", () => {
  const diff = ["--- a/src/orders.js", "+++ b/src/orders.js", "@@ -1,5 +1,5 @@", '-import { getUser } from "./users.js";', '+import { fetchUser } from "./users.js";', " ", "-  const user = getUser(id);", "+  const user = fetchUser(id);"].join("\n");
  assert.deepEqual([...changeMarkers(diff)], ["getUser"], "the words the example's change took away");
  const text = USES("invoices");
  assert.equal(checkRepeatEdits(text, RENAME("x").edits, changeMarkers(diff)).ok, true);
  const stray = checkRepeatEdits(text, [...RENAME("x").edits, { search: "  return user.name;", replace: "  return user.email;" }], changeMarkers(diff));
  assert.match(stray.reason, /edit 3 removes the line `return user\.name;`, which the change is not about/);
  // An edit whose search text is not in the file is told as that, not as a line rule.
  assert.match(checkRepeatEdits(text, [{ search: "const user = loadUser(id);", replace: "x" }], changeMarkers(diff)).reason, /its search text appears 0 times/);
  // A removed line that itself starts with dashes (an SQL comment) is a line of the change, not a diff header.
  const sql = ["--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- uses legacy_flag", "+-- uses the new flag", " select 1;"].join("\n");
  assert.deepEqual([...changeMarkers(sql)], ["legacy_flag"], "legacy_flag was taken away; 'uses' is still there, and the file headers are no part of the change");
  // A change that only adds lines has no such words: then no line may be removed at all.
  const added = checkRepeatEdits(text, [{ search: "export function invoices(id) {", replace: "// reviewed\nexport function invoices(id) {" }], new Set());
  assert.equal(added.ok, true, "the line is kept, one is added");
  assert.match(checkRepeatEdits(text, [{ search: "  return user.name;", replace: "  return null;" }], new Set()).reason, /removes the line/);
});

test("the change is repeated in every target, checked in a scratch copy, then written; one call undoes it", async () => {
  const s = sandbox();
  try {
    changeOnce(s);
    const t = typists({ flash: (req) => ({ answer: RENAME(req.unit.path) }) });
    const r = await call(s, "repeat_edit_across_files", REPEAT_FORM(), t);
    assert.equal(r.receipt.status, "landed", JSON.stringify(r.receipt));
    assert.deepEqual(r.receipt.changed, ["src/invoices.js", "src/reports.js"]);
    assert.deepEqual(r.receipt.failed, []);
    assert.match(r.receipt.check, /`node scripts\/check-imports\.mjs` passed in a scratch copy/);
    assert.equal(r.receipt.id, "h1");
    assert.equal(r.receipt.cost_usd, 0.008);
    assert.match(readFileSync(join(s.repo, "src", "invoices.js"), "utf8"), /fetchUser\(id\)/);
    assert.equal(r.flash.calls.length, 2, "one job per target");
    const req = r.flash.calls[0];
    assert.equal(req.packet.phase, "codegen");
    assert.equal(req.contract, "edit");
    assert.match(req.shared, /getUser is renamed fetchUser/);
    assert.match(req.shared, /\+import \{ fetchUser \}/, "the example's change is shown to every job, in the block they share");
    assert.equal(req.packet.inputs[0].content, USES(req.unit.path.replace(/^src\/|\.js$/g, "")), "the target's current text travels with its job");

    const undone = await call(s, "undo_hand_off", { id: "h1" });
    assert.equal(undone.receipt.status, "undone");
    assert.deepEqual(undone.receipt.restored.sort(), ["src/invoices.js", "src/reports.js"]);
    assert.match(readFileSync(join(s.repo, "src", "invoices.js"), "utf8"), /getUser\(id\)/);
    assert.match((await call(s, "undo_hand_off", { id: "h1" })).receipt.reason, /already undone/);
  } finally { s.cleanup(); }
});

test("a target whose edits never pass is named back; the others land. A failing check lands nothing.", async () => {
  const s = sandbox();
  try {
    changeOnce(s);
    // reports.js: every attempt rewrites a line the change is not about.
    const wrong = (path) => ({ path, edits: [...RENAME(path).edits, { search: "  return user.name;", replace: "  return user.email;" }] });
    const t = typists({ flash: (req) => ({ answer: req.unit.path === "src/reports.js" ? wrong(req.unit.path) : RENAME(req.unit.path) }), opus: (req) => ({ answer: wrong(req.unit.path) }) });
    const r = await call(s, "repeat_edit_across_files", REPEAT_FORM({ check_command: undefined }), t);
    assert.equal(r.receipt.status, "landed");
    assert.deepEqual(r.receipt.changed, ["src/invoices.js"]);
    assert.equal(r.receipt.failed.length, 1);
    assert.equal(r.receipt.failed[0].file, "src/reports.js");
    assert.match(r.receipt.failed[0].reason, /which the change is not about/);
    assert.match(r.receipt.check, /not run/);
    assert.match(r.receipt.next, /src\/reports\.js yourself/);
    assert.match(readFileSync(join(s.repo, "src", "reports.js"), "utf8"), /getUser\(id\)/, "the failed target is untouched");
  } finally { s.cleanup(); }
  const s2 = sandbox();
  try {
    changeOnce(s2);
    // The edits apply and touch only lines the change is about, but leave the project broken: the import is renamed to a name users.js does not export.
    const broken = (path) => ({ path, edits: [{ search: 'import { getUser } from "./users.js";', replace: 'import { loadUser } from "./users.js";' }] });
    const t = typists({ flash: (req) => ({ answer: broken(req.unit.path) }) });
    const r = await call(s2, "repeat_edit_across_files", REPEAT_FORM(), t);
    assert.equal(r.receipt.status, "failed");
    assert.match(r.receipt.reason, /the check command failed in a scratch copy/);
    assert.match(r.receipt.output, /imports loadUser, which users\.js does not export/);
    assert.match(readFileSync(join(s2.repo, "src", "invoices.js"), "utf8"), /import \{ getUser \}/, "nothing was changed in the project");
    assert.match(r.receipt.next, /Nothing was changed/);
  } finally { s2.cleanup(); }
});

test("a file that needs no change is reported unchanged, not failed", async () => {
  const s = sandbox();
  try {
    changeOnce(s);
    writeFileSync(join(s.repo, "src", "plain.js"), "export const one = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: s.repo });
    const t = typists({ flash: (req) => ({ answer: req.unit.path === "src/plain.js" ? { path: req.unit.path, edits: [{ search: "export const one = 1;", replace: "export const one = 1;" }] } : RENAME(req.unit.path) }) });
    const r = await call(s, "repeat_edit_across_files", REPEAT_FORM({ targets: ["src/invoices.js", "src/plain.js"], check_command: undefined }), t);
    assert.equal(r.receipt.status, "landed");
    assert.deepEqual(r.receipt.changed, ["src/invoices.js"]);
    assert.deepEqual(r.receipt.unchanged, ["src/plain.js"]);
  } finally { s.cleanup(); }
});

test("a project that is not a git repository: the hand-off is refused with the reason, before anything is sent", async () => {
  const s = sandbox();
  try {
    rmSync(join(s.repo, ".git"), { recursive: true, force: true });
    const t = typists({ flash: (req) => ({ answer: { path: req.unit.path, content: TEST_FILE() } }) });
    const r = await call(s, "write_tests_from_cases", TESTS_FORM(), t);
    assert.equal(r.receipt.status, "refused");
    assert.match(r.receipt.reason, /not a git repository/);
    assert.equal(r.receipt.cause, "no-git", "a fixed code, so the person's line is the plain one, not this reason");
    assert.equal(r.flash.calls.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(s.session, "handoff_released.json"), "utf8")), ["tests/cart.test.js"], "the chat's model may write the test file itself");
  } finally { s.cleanup(); }
});
