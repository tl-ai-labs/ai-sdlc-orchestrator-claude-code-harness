/**
 * The ambient job tools as the server exposes them. Driven with the stub door
 * (MMO_AMBIENT_STUB_DIR), so no test can reach a vendor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMBIENT_TOOLS, AMBIENT_TOOL_NAMES, ambientToolsFor, handleAmbientTool, completionModelFor, completionModelIn, reachableIn, chatPolicyNames, chatWorkerAdapter, chatModelConfig, completionDoor } from "../dist/ambient/tools.js";
import { loadPolicy } from "../dist/policy.js";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-ambient-tools-"));
  const repo = join(dir, "repo"); const home = join(dir, "home"); const stubs = join(dir, "stubs");
  for (const d of [join(repo, "src"), home, stubs]) mkdirSync(d, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "dev@example.com"); git("config", "user.name", "dev");
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "DESIGN.md"), "# Design\n\nb is the constant two.\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on" }));
  writeFileSync(join(stubs, "write_files_from_specs.json"), JSON.stringify({ answer: { creates: [{ path: "src/b.js", content: "export const b = 2;\n" }] } }));
  Object.assign(process.env, { MMO_HOME: home, HOME: home, MMO_AMBIENT_STUB_DIR: stubs });
  return { repo, deps: { projectDir: repo, policies: () => { throw new Error("the stub door must be used; the policies are never consulted"); } }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const body = (r) => JSON.parse(r.content[0].text);
const STAMP = { session_id: "s1", prompt_id: "p", arm: "on", mode: "on" };
const SPECS = { design_file: "DESIGN.md", specs: [{ path: "src/b.js", exports: ["b"], behaviour: "Export the constant b with the value 2. Nothing else." }], context_files: ["src/a.js"] };

test("the ambient tools are listed only when ambient mode is on: with it off, the plugin's tool list is 0.7.7's", async () => {
  // 0.8.3 adds zero-touch on top of 0.7.7 without changing 0.7.7. The shipped default is off.
  const dir = mkdtempSync(join(tmpdir(), "mmo-ambient-list-"));
  try {
    const home = join(dir, "home"); const repo = join(dir, "repo");
    mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true });
    assert.deepEqual(await ambientToolsFor(repo, { MMO_HOME: home, HOME: home }), [], "shipped default: off, nothing listed");
    assert.deepEqual(await ambientToolsFor(repo, { MMO_HOME: home, HOME: home, MMO_AMBIENT: "observe" }), [], "observe acts on nothing");
    assert.deepEqual((await ambientToolsFor(repo, { MMO_HOME: home, HOME: home, MMO_AMBIENT: "on" })).map((t) => t.name), AMBIENT_TOOLS.map((t) => t.name));
    writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "on" }));
    assert.equal((await ambientToolsFor(repo, { MMO_HOME: home, HOME: home })).length, AMBIENT_TOOLS.length, "the person's own setting turns it on");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every ambient tool accepts the stamp field, and only consent demands a person", () => {
  assert.equal(AMBIENT_TOOLS.length, AMBIENT_TOOL_NAMES.size);
  for (const t of AMBIENT_TOOLS) assert.ok(t.inputSchema.properties._mmo, `${t.name}: updatedInput replaces the whole input, so a schema without _mmo would DENY every stamped call`);
  const needPerson = AMBIENT_TOOLS.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true).map((t) => t.name);
  assert.deepEqual(needPerson, ["consent_to_send"]);
});

test("an unstamped call is refused, consent comes first, then a job runs through the stub door", async () => {
  const w = world();
  try {
    assert.match(body(await handleAmbientTool("write_files_from_specs", SPECS, w.deps)).reason, /no session stamp/);
    assert.match(body(await handleAmbientTool("job_result", { job_id: "x" }, w.deps)).reason, /no session stamp/);
    const first = await handleAmbientTool("write_files_from_specs", { ...SPECS, _mmo: STAMP }, w.deps);
    assert.equal(first.isError, true);
    assert.equal(body(first).needs_consent, "google");
    assert.equal(body(await handleAmbientTool("consent_to_send", { vendor: "google", _mmo: STAMP }, w.deps)).status, "recorded");
    // One hand-over, one request: the start call waits for the job and the server lands the checked files itself.
    const started = body(await handleAmbientTool("write_files_from_specs", { ...SPECS, _mmo: STAMP }, w.deps));
    assert.equal(started.status, "landed", JSON.stringify(started));
    assert.ok(started.landed.files.length >= 1);
    assert.equal(started.landing, undefined, "nothing left to land");
    const again = body(await handleAmbientTool("job_result", { job_id: started.job_id, _mmo: STAMP }, w.deps));
    assert.equal(again.status, "landed", "the receipt is still there for a thinker that asks again");
  } finally { w.cleanup(); }
});

test("the completion door never picks an executing agent adapter", () => {
  const policy = { models: [
    { id: "agent", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" },
    { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" },
  ] };
  assert.equal(completionModelFor(policy, "gemini-3.8-flash").id, "flash");
  assert.equal(completionModelFor({ models: [policy.models[0]] }, "gemini-3.8-flash"), null);
});

test("the chat door reads two shipped files: Flash through Google, Sonnet through the Claude login, never an API key", () => {
  assert.deepEqual(chatPolicyNames({}), ["opus-plus-flash-v38", "opus-plus-sonnet-max"]);
  assert.deepEqual(chatPolicyNames({ MMO_AMBIENT_POLICY: " my-policy , other " }), ["my-policy", "other"]);
  const policies = chatPolicyNames({}).map((policyName) => loadPolicy({ policyName }));
  const can = reachableIn(policies);
  assert.equal(can("gemini-3.8-flash"), true);
  assert.equal(can("claude-sonnet-5"), true);
  assert.equal(completionModelIn(policies, "gemini-3.8-flash").adapter, "mcp:model-dispatch");
  assert.equal(completionModelIn(policies, "claude-sonnet-5").adapter, "claude-cli", "Sonnet is reached through the local claude login, not ANTHROPIC_API_KEY");
  const agentOnly = { models: [{ id: "sonnet-agent", adapter: "antigravity-worker", model_name: "claude-sonnet-5" }] };
  assert.equal(reachableIn([agentOnly])("claude-sonnet-5"), false, "an executing agent adapter is never a way to reach a chat worker");
});

function fakeClaude(calls) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: () => setImmediate(() => { child.stderr.emit("data", "not logged in"); child.emit("close", 1); }) };
    child.kill = () => {};
    return child;
  };
}
const WITH_TOOLS_FLAG = "  --safe-mode  x\n  --strict-mcp-config  x\n  --tools <tools...>  Use \"\" to disable all tools\n";
const SONNET = { id: "sonnet", adapter: "claude-cli", model_name: "claude-sonnet-5", pricing: { input: 2, input_cached: 0.2, output: 10 } };
const PACKET = { id: "ambient_x", phase: "codegen", task_type: "ambient_job", module: "ambient", instruction: "brief", inputs: [], acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }, pass_id: "ambient" };

test("a chat job's Sonnet worker is started with no tools; a CLI without that switch is never started", async () => {
  const calls = [];
  const sonnet = chatWorkerAdapter(SONNET, { spawnFn: fakeClaude(calls), probeBinary: () => {}, helpText: WITH_TOOLS_FLAG });
  const res = await sonnet.execute(PACKET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "claude");
  assert.deepEqual(calls[0].args.slice(-2), ["--tools", ""]);
  assert.ok(calls[0].args.includes("claude-sonnet-5"));
  assert.equal(res.success, false, "the fake CLI exited 1");
  const none = [];
  const old = chatWorkerAdapter(SONNET, { spawnFn: fakeClaude(none), probeBinary: () => {}, helpText: "  --model <m>\n" });
  const refused = await old.execute(PACKET);
  assert.equal(none.length, 0, "nothing is started when the CLI cannot switch its tools off");
  assert.match(refused.error, /no --tools/);
});

test("the door passes the worker's own priced cost and its raw text answer through", async () => {
  const fenced = "```json\n{\"edits\":[]}\n```";
  const door = completionDoor([{ models: [SONNET] }], {
    makeAdapter: () => ({ execute: async () => ({ success: true, result: { raw: fenced }, tokens: { input: 100, input_cached: 50, output: 20 }, cost_usd: 0.0123 }) }),
  });
  const out = await door({ kind: "fix_from_analysis", worker: "claude-sonnet-5", brief: "b" });
  assert.equal(out.text, fenced, "a fenced JSON answer reaches the strict reader as the worker wrote it");
  assert.equal(out.cost_usd, 0.0123);
  assert.deepEqual(out.usage, { input_tokens: 150, output_tokens: 20 });
  await assert.rejects(door({ kind: "x", worker: "gemini-3.8-flash", brief: "b" }), /no completion model named gemini-3\.8-flash/);
  // Three live jobs on 22 Sep failed as "the worker call failed"; the adapter had said why in terminal_reason and nobody passed it on.
  const cut = completionDoor([{ models: [SONNET] }], { makeAdapter: () => ({ execute: async () => ({ success: false, result: { raw: "...", _truncated: true }, tokens: { input: 1, input_cached: 0, output: 8192 }, cost_usd: 0.03, terminal_reason: "output_cap_at_model_absolute" }) }) });
  await assert.rejects(cut({ kind: "x", worker: "claude-sonnet-5", brief: "b" }), /cut off \(output cap at model absolute\) after 8192 output tokens/);
});

test("a chat job's Gemini worker types with low reasoning unless the policy says otherwise; the Claude worker is left alone", () => {
  const flash = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };
  assert.deepEqual(chatModelConfig(flash).reasoning, { tier: "low" });
  assert.deepEqual(chatModelConfig({ ...flash, reasoning: { tier: "high" } }).reasoning, { tier: "high" }, "a policy leaf's tier is kept when the setting is the default");
  assert.deepEqual(chatModelConfig(flash, "high").reasoning, { tier: "high" }, "jobs.worker_thinking picks the depth for a measured pair");
  assert.deepEqual(chatModelConfig({ ...flash, reasoning: { tier: "low" } }, "high").reasoning, { tier: "high" }, "the person's setting wins over the leaf");
  assert.equal(chatModelConfig(flash, "policy").reasoning, undefined, "policy: nothing is sent, the vendor's default depth runs");
  assert.equal(chatModelConfig({ id: "sonnet", adapter: "claude-cli", model_name: "claude-sonnet-5" }).reasoning, undefined);
});

test("a chat job's Flash worker may answer up to 32,768 tokens; the pipeline's Flash leaf keeps 0.7.6's 8,192", () => {
  // Seen live on 22 Sep: three chat jobs writing a whole test file, plus the model's own reasoning tokens, were cut
  // off at 8,192 and failed. The pipeline's typists read the SAME policy leaf (executor/typists.ts), so the chat
  // job's floor is applied to the chat job's copy of the leaf, never written into the shared policy file.
  const v38 = loadPolicy({ policyName: "opus-plus-flash-v38" });
  const leaf = v38.models.find((m) => m.id === "flash-completion");
  assert.equal(leaf.max_output_tokens_absolute, 8192, "the typed pipeline's Flash cap is 0.7.6's");
  assert.equal(chatModelConfig(leaf).max_output_tokens_absolute, 32768);
  assert.equal(chatModelConfig(leaf, "policy").max_output_tokens_absolute, 32768, "the thinking setting does not change the cap");
  assert.equal(chatModelConfig({ ...leaf, max_output_tokens_absolute: 65536 }).max_output_tokens_absolute, 65536, "a leaf that allows more keeps more");
  assert.equal(leaf.max_output_tokens_absolute, 8192, "the loaded policy object is not changed in place");
  const sonnet = { id: "sonnet", adapter: "claude-cli", model_name: "claude-sonnet-5" };
  assert.deepEqual(chatModelConfig(sonnet), sonnet, "the Claude worker is left alone");
});

test("job_result takes many ids in one call and returns every job's state", async () => {
  const w = world();
  try {
    await handleAmbientTool("consent_to_send", { vendor: "google", _mmo: STAMP }, w.deps);
    const started = body(await handleAmbientTool("write_files_from_specs", { ...SPECS, _mmo: STAMP }, w.deps));
    assert.equal(started.status, "landed", JSON.stringify(started));
    const got = body(await handleAmbientTool("job_result", { job_ids: [started.job_id], _mmo: STAMP }, w.deps));
    assert.equal(got.status, "collected");
    assert.equal(got.jobs[0].job_id, started.job_id);
    assert.ok(["landed", "ready", "failed"].includes(got.jobs[0].status));
    const schema = AMBIENT_TOOLS.find((t) => t.name === "job_result").inputSchema;
    assert.ok(schema.properties.job_ids && schema.properties.job_id, "one id or many");
    assert.ok(!schema.required?.includes("job_id"), "job_id alone is no longer required");
  } finally { w.cleanup(); }
});

test("lookup is an ambient tool for both sides: it needs no start-tool stamp, answers with a status, and its schema asks for terms", async () => {
  const w = world();
  try {
    const schema = AMBIENT_TOOLS.find((t) => t.name === "lookup");
    assert.ok(schema && schema.inputSchema.required.includes("terms"));
    const out = body(await handleAmbientTool("lookup", { terms: ["nothing-to-find-here"], _mmo: STAMP }, w.deps));
    assert.ok(["ok", "empty", "refused"].includes(out.status), JSON.stringify(out));
  } finally { w.cleanup(); }
});

test("the door reports the thinking depth each answer ran at, so the record and the board can tell a high pair from a low one", async () => {
  const flash = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };
  const seen = [];
  const door = completionDoor([{ models: [flash] }], { thinking: "high", makeAdapter: (m) => { seen.push(m.reasoning); return { execute: async () => ({ success: true, result: { edits: [] }, tokens: { input: 10, input_cached: 0, output: 5 } }) }; } });
  const r = await door({ kind: "write_files_from_specs", worker: "gemini-3.8-flash", brief: "x" });
  assert.equal(r.thinking, "high");
  assert.deepEqual(seen, [{ tier: "high" }], "the adapter was built at the chosen depth");
});

test("write_files is an ambient tool for both sides: the thinker's own files, written and tested in one call; a secret path is refused", async () => {
  const w = world();
  try {
    const schema = AMBIENT_TOOLS.find((t) => t.name === "write_files");
    assert.ok(schema && schema.inputSchema.required.includes("files"));
    const out = body(await handleAmbientTool("write_files", { files: [{ path: "src/c.js", content: "export const c = 3;\n" }, { path: "src/d.js", content: "export const d = 4;\n" }], test_command: "node -e \"process.exit(0)\"", _mmo: STAMP }, w.deps));
    assert.equal(out.status, "written", JSON.stringify(out));
    assert.deepEqual(out.created, ["src/c.js", "src/d.js"]);
    assert.equal(out.tests.passed, true);
    const denied = await handleAmbientTool("write_files", { files: [{ path: ".env", content: "K=1" }], _mmo: STAMP }, w.deps);
    assert.equal(denied.isError, true);
  } finally { w.cleanup(); }
});

/**
 * 23 Sep, pair 10: under one shared schema both `edits` and `creates` were optional, so
 * {"edits":[]} was a schema-valid answer and Gemini 3.8 Flash gave exactly that six times
 * to fourteen-file commissions. A create job now holds the worker to a schema that
 * REQUIRES `creates` (the pipeline's packet schema requires `files` the same way).
 */
test("a create job holds the worker to a schema that requires creates; an edit job keeps the shared one", async () => {
  const { answerSchemaFor } = await import("../dist/ambient/tools.js");
  const create = answerSchemaFor("write_files_from_specs");
  assert.deepEqual(create.required, ["creates"], "a create job's answer must hold creates");
  assert.equal(create.properties.edits, undefined, "and offers no edits to fall back on");
  assert.deepEqual(answerSchemaFor("write_tests_from_cases").required, ["creates"]);
  const edit = answerSchemaFor("repeat_edit_across_files");
  assert.equal(edit.required, undefined, "a repeated edit that applies to no more files is a legitimate empty answer");
  assert.ok(edit.properties.edits && edit.properties.creates);
  assert.equal(answerSchemaFor("fix_from_analysis"), edit);
  const seen = [];
  const flash = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };
  const door = completionDoor([{ models: [flash] }], { makeAdapter: () => ({ execute: async (packet) => { seen.push(packet.outputSchema); return { success: true, result: { creates: [] }, tokens: { input: 1, input_cached: 0, output: 1 } }; } }) });
  await door({ kind: "write_files_from_specs", worker: "gemini-3.8-flash", brief: "b" });
  await door({ kind: "fix_from_analysis", worker: "gemini-3.8-flash", brief: "b" });
  assert.deepEqual(seen[0].required, ["creates"], "the door sends the create schema for a create kind");
  assert.equal(seen[1].required, undefined, "and the shared schema for an edit kind");
});

test("the create tools say up front which files stay with the thinker, so a forbidden file is never commissioned", () => {
  const byName = Object.fromEntries(AMBIENT_TOOLS.map((t) => [t.name, t]));
  assert.match(byName.write_files_from_specs.description, /test-runner configs .*stay with you/i);
  assert.match(byName.write_files_from_specs.description, /lock files/i);
  assert.match(byName.write_files_from_specs.description, /refused at once, before any worker is paid/i);
  assert.match(byName.write_tests_from_cases.description, /jest\.config.*stays with you/i);
});

test("the create tool's contract: a design file is required and each entry is exports, behaviour, mirror", () => {
  const t = AMBIENT_TOOLS.find((x) => x.name === "write_files_from_specs");
  assert.ok(t.inputSchema.required.includes("design_file"), "the design is written once, on disk");
  const item = t.inputSchema.properties.specs.items;
  assert.deepEqual(item.required, ["path", "behaviour"]);
  assert.ok(item.properties.exports && item.properties.mirror, "exports and a file to mirror are the other two fields");
  assert.ok(!item.properties.spec, "the free-prose spec is gone");
  assert.match(t.description, /design/i);
  assert.match(t.description, /cost more than the files they describe are refused/i, "the economics are stated where the tool is described, with no magic length");
});
