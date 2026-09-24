/**
 * The executor's typists, without calling any model: each typist's request
 * pinned to the setup step 2 measured (task folder, probes/s2-typist-bakeoff),
 * the environments built from allowlists, the strict answer contracts,
 * failures classified from the vendors' structured fields, which typist each
 * policy leaf gets, and the lean Opus leaf every policy falls back to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cliLists, leanOpusArgs, leanOpusEnv, leanOpusOutcome, agyEnv, agyWorkerArgs, agyOutcome, flashOutcome, parseAnswer, isTransient, TYPIST_WORKER, FlashCompletionTypist } from "../dist/executor/typists.js";
import { FILE_ANSWER_SCHEMA, EDIT_ANSWER_SCHEMA } from "../dist/executor/brief.js";
import { typistForLeaf, fallbackLeaf, TYPIST_EFFORT, TYPIST_TIMEOUT_S, TRANSPORT } from "../dist/executor/tools.js";
import { loadPolicyFromPath } from "../dist/policy.js";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const HELP = ["--tools <tools...>", "--append-system-prompt-file <f>", "--effort <level>", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"].map((l) => `  ${l}   x`).join("\n");

test("lean Opus: no tools, no MCP servers, safe mode, no transcript, low effort, the shared block as the system-prompt tail", () => {
  const args = leanOpusArgs("claude-opus-5", "low", "/run/shared-brief.txt", HELP);
  assert.deepEqual(args, ["-p", "--model", "claude-opus-5", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--effort", "low", "--append-system-prompt-file", "/run/shared-brief.txt"]);
  // Isolation flags are added only when the installed CLI lists them...
  assert.ok(!leanOpusArgs("m", "low", "/f", HELP.replace(/.*--safe-mode.*\n/, "")).includes("--safe-mode"));
  // ...but a CLI without the flags the route depends on refuses to run it at all.
  for (const needed of ["--tools", "--append-system-prompt-file", "--effort"]) {
    const help = HELP.split("\n").filter((l) => !l.includes(needed)).join("\n");
    assert.throws(() => leanOpusArgs("m", "low", "/f", help), new RegExp(`no ${needed} flag`));
  }
});

test("a flag the CLI's help folds into a sibling's (--name[-file]) counts as listed; a missing one does not", () => {
  // Claude Code 2.1.280's help: --append-system-prompt-file appears only inside --bare's description.
  const real = "  --append-system-prompt <prompt>       Append a system prompt\n                                        --append-system-prompt[-file], --add-dir\n  --tools <tools...>   x";
  assert.equal(cliLists(real, "--append-system-prompt-file"), true);
  assert.equal(cliLists(real, "--append-system-prompt"), true);
  assert.equal(cliLists(real, "--tools"), true);
  assert.equal(cliLists(real, "--system-prompt-file"), false);
  assert.equal(cliLists(real, "--effort"), false);
  assert.deepEqual(leanOpusArgs("m", "low", "/f", real + "\n  --effort <level>  x").slice(-4), ["--effort", "low", "--append-system-prompt-file", "/f"]);
});

test("lean Opus environment: built from an allowlist, as step 2 measured it; the API key only under vendor auth; five-minute cache", () => {
  // A poisoned parent: every variable below changes how claude -p behaves or bills, and none may reach a typist.
  const poison = {
    CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_ENTRYPOINT: "cli",
    MAX_THINKING_TOKENS: "32000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_EFFORT_LEVEL: "high",
    DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1", ANTHROPIC_MODEL: "claude-sonnet-5", ANTHROPIC_BASE_URL: "https://elsewhere",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_SUBAGENT_MODEL: "x", GEMINI_API_KEY: "g", MMO_SELECT: "gemini-flash=flash-agsdk-worker",
  };
  const base = { PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", LANG: "en_US.UTF-8", TERM: "xterm", TMPDIR: "/t", HTTPS_PROXY: "http://proxy", CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_API_KEY: "k", ...poison };
  const est = leanOpusEnv(base, "estimated");
  assert.deepEqual(Object.keys(est).sort(), ["CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "HTTPS_PROXY", "LANG", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER"]);
  assert.equal(est.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.equal(est.DISABLE_AUTOUPDATER, "1", "one CLI version for every typist call of a run");
  const vendor = leanOpusEnv(base, "vendor");
  assert.equal(vendor.ANTHROPIC_API_KEY, "k", "a vendor-auth run bills the API on purpose");
  for (const k of Object.keys(poison)) assert.equal(vendor[k], undefined, k);
});

test("agent typist environment: an allowlist plus the Vertex project and region; no API key can route it elsewhere", () => {
  const env = agyEnv({ PATH: "/bin", HOME: "/h", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2", CLAUDECODE: "1", GOOGLE_CLOUD_LOCATION: "us-central1" }, "proj", "global");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json", GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "global", PYTHONUNBUFFERED: "1" });
});

test("agent typist request: step 2's agy-best setup — the shared block as the system prompt, the brief, FINISH with the answer schema, LOW thinking, three model calls — and the executor's wait rule for rate limits", () => {
  const args = agyWorkerArgs({ briefFile: "/s/brief.md", sharedFile: "/run/shared.txt", schemaFile: "/s/schema.json", model: "gemini-3.8-flash", region: "global", workdir: "/s", receiptFile: "/s/r.json", thinking: "low", maxModelCalls: 3, timeoutSec: 540, apiRetries: 6, apiRetryInitialMs: 2000 });
  assert.deepEqual(args, [TYPIST_WORKER, "--brief-file", "/s/brief.md", "--system-file", "/run/shared.txt", "--answer-schema-file", "/s/schema.json", "--model", "gemini-3.8-flash", "--region", "global", "--workdir", "/s", "--out", "/s/r.json", "--thinking", "LOW", "--max-model-calls", "3", "--timeout", "540", "--api-retries", "6", "--api-retry-initial-ms", "2000"]);
});

test("every typist gets the same stated time limit and the agent door waits out rate limits with the executor's rule", () => {
  const policy = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const byId = (id) => policy.models.find((m) => m.id === id);
  assert.equal(TYPIST_TIMEOUT_S, 540);
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: process.execPath });
  try {
    // A leaf's own worker_timeout_sec is for whole agent jobs; a typist types one file, so the executor's bound applies.
    const agy = typistForLeaf({ ...byId("flash-agsdk-worker"), worker_timeout_sec: 1800 }, "estimated");
    assert.equal(agy.opts.timeoutSec, 540);
    assert.equal(agy.opts.apiRetries, TRANSPORT.maxWaits);
    assert.equal(agy.opts.apiRetryInitialMs, TRANSPORT.baseMs);
    const flash = typistForLeaf(byId("flash-completion"), "estimated");
    assert.equal(flash.requestTimeoutMs, 540_000);
    // A hand-authored policy may still name the completion door by its pre-rename id; the registry accepts it, so the executor does too.
    assert.equal(typistForLeaf({ ...byId("flash-completion"), adapter: "mcp:gemini" + "-flash-server" }, "estimated").door, "flash-completion");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("completion typist request: step 2's flash-low-r2 setup — the shared block first, thinking low, the answer schema as the response schema", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const leaf = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 }, max_output_tokens_absolute: 8192 };
    const t = new FlashCompletionTypist(leaf, "low", 540_000);
    const sent = [];
    t.adapter.transport = { backend: "api-key", location: "", createCache: async () => undefined, generate: async (a) => { sent.push(a); return { text: '{"path":"a.py","content":"x = 1\\n"}', usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, finishReason: "STOP" }; } };
    const packet = { id: "U01", phase: "codegen", task_type: "dto", module: "spec", instruction: "WRITE", inputs: [], outputSchema: FILE_ANSWER_SCHEMA, acceptance: [], budget: { maxInputTokens: 400000, maxOutputTokens: 0 }, pass_id: "p" };
    const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, shared: "SHARED BLOCK", sharedFile: "/dev/null", framed: "", contract: "file", passId: "p" });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].prompt.startsWith("## Project header (inlined; cache miss)\nSHARED BLOCK\n"), "the shared block comes first");
    assert.deepEqual(sent[0].generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.deepEqual(sent[0].generationConfig.responseSchema, FILE_ANSWER_SCHEMA);
    assert.equal(sent[0].generationConfig.maxOutputTokens, 8192, "the leaf's own output cap");
    assert.deepEqual(sent[0].generationConfig.httpOptions, { timeout: 540_000 }, "the stated time limit, on the request itself");
    assert.deepEqual(r.answer, { path: "a.py", content: "x = 1\n" });
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
  }
});

test("the answer contract is read strictly: one JSON object with string path and content, nothing repaired", () => {
  assert.deepEqual(parseAnswer('{"path":"a.py","content":"x=1\\n"}', "file"), { path: "a.py", content: "x=1\n" });
  assert.deepEqual(parseAnswer({ path: "a.py", content: "" }, "file"), { path: "a.py", content: "" });
  for (const bad of ['```json\n{"path":"a.py","content":"x"}\n```', 'Here it is: {"path":"a.py","content":"x"}', '{"path":"a.py"}', '{"path":1,"content":"x"}', "", null, '{"path":"a.py","edits":[{"search":"a","replace":"b"}]}']) {
    assert.equal(parseAnswer(bad, "file"), null, String(bad));
  }
});

test("the fix contract: exact edits, or the whole file, never both and never neither", () => {
  assert.deepEqual(parseAnswer('{"path":"a.py","edits":[{"search":"x = 1","replace":"x = 2"}]}', "edit"), { path: "a.py", edits: [{ search: "x = 1", replace: "x = 2" }] });
  assert.deepEqual(parseAnswer({ path: "a.py", content: "x = 2\n" }, "edit"), { path: "a.py", content: "x = 2\n" });
  for (const bad of ['{"path":"a.py"}', '{"path":"a.py","edits":[]}', '{"path":"a.py","edits":[{"search":"","replace":"b"}]}', '{"path":"a.py","edits":[{"search":"a"}]}', '{"path":"a.py","content":"x","edits":[{"search":"a","replace":"b"}]}']) {
    assert.equal(parseAnswer(bad, "edit"), null, bad);
  }
  assert.deepEqual(EDIT_ANSWER_SCHEMA.required, ["path"]);
  assert.deepEqual(FILE_ANSWER_SCHEMA.required, ["path", "content"]);
});

test("vendor and network failures are told apart from bad answers by the vendor's own fields, never by its wording", () => {
  // HTTP semantics (RFC 9110: 408, 429, 5xx) and Anthropic's 529; Node/undici transit codes.
  for (const s of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isTransient(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422, null, undefined]) assert.equal(isTransient(s), false, String(s));
  for (const c of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) assert.equal(isTransient(undefined, c), true, c);
  assert.equal(isTransient(undefined, "ENOENT"), false);
  for (const c of ["ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]) assert.equal(isTransient(undefined, c), true, `${c}: no connection, so wait`);

  // claude -p: its JSON result carries is_error, subtype and api_error_status.
  const opus = (o) => leanOpusOutcome(o);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 429, result: "API Error: 429" }).transport, true);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 529, result: "Overloaded" }).transport, true);
  assert.equal(opus({ is_error: true, subtype: "error_during_execution", api_error_status: 401, result: "rate limit" }).transport, false, "the words do not decide");
  assert.equal(opus({ is_error: true, subtype: "error_max_turns", api_error_status: null, result: "Overloaded" }).transport, false);

  // The completion door: the HTTP status, network code and RetryInfo delay the adapter recorded on the attempt.
  assert.deepEqual(flashOutcome({ error_status: 429, retry_after_ms: 12000 }), { transport: true, retry_after_ms: 12000 });
  assert.deepEqual(flashOutcome({ error_code: "ECONNRESET" }), { transport: true, retry_after_ms: undefined });
  assert.deepEqual(flashOutcome({ error_status: 400 }), { transport: false, retry_after_ms: undefined });
  assert.deepEqual(flashOutcome(undefined), { transport: false, retry_after_ms: undefined });

  // The agent door: the SDK retries transient API errors itself and its errors carry no HTTP status, so any error it
  // raises is an attempt (fail closed), whatever its message says.
  assert.equal(agyOutcome({ error: "AntigravityExecutionError: executor run failed: Resource exhausted", error_type: "AntigravityExecutionError" }).transport, false);
});

test("each policy leaf gets the typist of its door; every shipped policy has a lean Opus leaf to fall back to", () => {
  const orch = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const solo = loadPolicyFromPath(join(POLICIES, "opus-only-v5.yaml"));
  const byId = (p, id) => p.models.find((m) => m.id === id);
  assert.equal(typistForLeaf(byId(orch, "opus"), "estimated").door, "lean-opus");
  assert.equal(typistForLeaf(byId(solo, "opus"), "estimated").door, "lean-opus");
  assert.equal(fallbackLeaf(orch).id, "opus");
  assert.equal(fallbackLeaf(solo).model_name, "claude-opus-5", "solo's fallback is the same Opus as its typist");
  assert.equal(fallbackLeaf(orch).model_name, fallbackLeaf(solo).model_name, "both arms fall back to the same model");
  assert.equal(TYPIST_EFFORT, "low");
  assert.ok(existsSync(TYPIST_WORKER), "the agent typist's worker ships with the plugin");
  assert.throws(() => typistForLeaf({ id: "x", adapter: "nope", model_name: "m" }, "estimated"), /no typist for adapter 'nope'/);
});

test("a typist process that exits before reading its brief is a failed attempt, never a crashed server", async () => {
  // Found by the independent review: a brief over the pipe's 64 KB buffer, written to a child that has already
  // exited, raised an unhandled EPIPE and took the MCP server down.
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fakebin-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 3\n");
  chmodSync(join(bin, "claude"), 0o755);
  const { LeanOpusTypist } = await import("../dist/executor/typists.js");
  const leaf = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5", pricing: { input: 5, input_cached: 0.5, output: 25 } };
  const t = new LeanOpusTypist(leaf, { authMode: "estimated", effort: "low", timeoutMs: 10_000, help: HELP, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp" } });
  const packet = { id: "U01", phase: "debug", task_type: "other", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
  const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "y".repeat(300_000), shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
  assert.equal(r.answer, null);
  assert.equal(r.transport, false);
  assert.match(r.error, /no JSON receipt/);
});

test("an agent worker whose receipt is damaged is a failed attempt, never a thrown error", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = mkdtempSync(join(tmpdir(), "fakepy-"));
  // A stand-in for the worker's Python: writes half a receipt to --out and exits.
  writeFileSync(join(bin, "python"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then printf \'{"finish_output": "{\\"pa\' > "$2"; fi; shift; done\nexit 0\n');
  chmodSync(join(bin, "python"), 0o755);
  const policy = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "global", GEMINI_WORKER_PYTHON: join(bin, "python") });
  try {
    const t = typistForLeaf(policy.models.find((m) => m.id === "flash-agsdk-worker"), "estimated");
    const packet = { id: "U01", phase: "codegen", task_type: "dto", module: "spec", instruction: "x", inputs: [], outputSchema: {}, acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, pass_id: "p" };
    const r = await t.type({ unit: { id: "U01", path: "a.py" }, packet, framed: "y", shared: "S", sharedFile: "/dev/null", contract: "file", passId: "p" });
    assert.equal(r.answer, null);
    assert.equal(r.transport, false);
    assert.match(r.error, /unreadable receipt/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
