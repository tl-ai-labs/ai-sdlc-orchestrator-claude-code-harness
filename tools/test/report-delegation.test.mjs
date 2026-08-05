/**
 * Guards the "Delegated to an agent worker" report section — the only
 * externally visible sign a run went through the agent door. Quiet failures:
 *   - the section prints on runs that never delegated (invents a distinction);
 *   - it prints nothing on runs that DID delegate, because the receipts moved
 *     or the filenames drifted;
 *   - the delegated and non-delegated costs do not add up to the run total, so
 *     a reader who checks the arithmetic stops trusting the whole report;
 *   - a retried packet shows one attempt's cost as the packet's cost, quietly
 *     understating it;
 *   - the Markdown branch eats `<packet>` as an HTML tag and loses the pointer
 *     to the receipts.
 *
 * The report is run as a real subprocess against a real fixture directory,
 * because what is being tested is what a person sees in a terminal.
 *
 * $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");

/** One telemetry event, with only the fields the report actually reads. */
const event = (task_id, phase, cost, over = {}) => ({
  task_id,
  phase,
  model: "m",
  input_tokens: 1000,
  output_tokens: 500,
  cost_usd: cost,
  provenance: "vendor",
  success: true,
  ...over,
});

/** One delegation receipt, shaped as `buildDelegationRecord` writes it. */
const receipt = (task_id, phase, over = {}) => ({
  schema: "delegation-record/1",
  task_id,
  phase,
  model_id: "flash-agsdk-worker",
  model_name: "gemini-3.5-flash",
  cable: { sdk: "google-antigravity", sdk_version: "1.1.4", vertex_project: "p", vertex_location: "asia-south1" },
  workdir: "/w",
  started_at: "2026-08-05T09:00:00.000Z",
  duration_ms: 90_000,
  success: true,
  cost_usd: 0.01,
  tokens: {},
  tool_calls: { count: 7, truncated: false, sample: [] },
  files: { added: ["a.ts"], modified: [], removed: [], unchanged: 9, scanned: 10, truncated: false, unreadable: [] },
  artifacts: { brief: `worker-task-${task_id}.md`, usage: `worker-usage-${task_id}.json` },
  ...over,
});

/** Build a pass directory, run the report over it, return stdout. */
function report({ events, receipts = [], extraFiles = {}, markdown = false }) {
  const dir = mkdtempSync(join(tmpdir(), "report-delegation-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ policy_name: "p", started_at: "2026-08-05T09:00:00Z" }));
    writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (receipts.length || Object.keys(extraFiles).length) mkdirSync(join(dir, "delegation"), { recursive: true });
    for (const r of receipts) {
      writeFileSync(join(dir, "delegation", `worker-delegation-${r.task_id}.json`), JSON.stringify(r, null, 2));
    }
    for (const [name, body] of Object.entries(extraFiles)) writeFileSync(join(dir, "delegation", name), body);
    return execFileSync("node", markdown ? [REPORT, dir, "--markdown"] : [REPORT, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a run that never delegated says nothing about delegation", () => {
  const out = report({ events: [event("tp_1", "codegen", 0.1)] });
  // The section must be absent, not empty. An "0 delegations" table on an
  // all-Opus run invents a distinction the run did not make, and every reader
  // of every non-connector run would have to skip past it forever.
  assert.doesNotMatch(out, /Delegated to an agent worker/);
});

test("a run that delegated names the worker, the tool calls and the files", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.1), event("tp_2", "codegen", 0.05)],
    receipts: [receipt("tp_2", "codegen")],
  });
  assert.match(out, /Delegated to an agent worker/);
  // The authorship claim itself — the one sentence the whole connector exists
  // to make true.
  assert.match(out, /\[G\].*Antigravity SDK worker/);
  assert.match(out, /\[C\].*harness.*writes no shipped code/);
  assert.match(out, /tp_2/);
});

test("the delegated and non-delegated costs add up to the run total", () => {
  const out = report({
    events: [event("tp_1", "codegen", 0.2500), event("tp_2", "codegen", 0.0500), event("tp_3", "tests", 0.0250)],
    receipts: [receipt("tp_2", "codegen"), receipt("tp_3", "tests")],
  });
  // $0.0500 + $0.0250 delegated, $0.2500 not. A reader who adds the two rows
  // and gets something other than the SDLC total below stops trusting every
  // other number in the report, so this is checked rather than assumed.
  assert.match(out, /2 delegations.*\$0\.0750/);
  assert.match(out, /everything else in this run.*1 calls.*\$0\.2500/);
});

test("a retried packet is priced across every attempt, not just the one on file", () => {
  const out = report({
    events: [
      event("tp_2", "codegen", 0.0300, { attempt_number: 1, success: false }),
      event("tp_2", "codegen", 0.0400, { attempt_number: 2 }),
    ],
    receipts: [receipt("tp_2", "codegen")],
  });
  // Both attempts ran and both were billed, but a retry overwrites the receipt
  // — so the receipt's own $0.0100 describes the last attempt alone. Taking the
  // cost from telemetry instead is what makes the row honest, and the marker is
  // what tells the reader the other columns are still the final attempt's.
  assert.match(out, /tp_2\*/);
  assert.match(out, /\$0\.0700/);
  assert.match(out, /\* retried/);
});

test("a delegation that died is still in the table, still with its cost", () => {
  const out = report({
    events: [event("tp_2", "codegen", 0.0440, { success: false })],
    receipts: [receipt("tp_2", "codegen", { success: false, error: "killed after 570s" })],
  });
  // The case a reader most needs the receipt for. A failed delegation dropped
  // from the table takes its spend with it, and the run's cost story acquires a
  // hole exactly where the interesting thing happened.
  assert.match(out, /tp_2!/);
  assert.match(out, /\$0\.0440/);
  assert.match(out, /did not finish.*still billed/);
});

test("a receipt that cannot be parsed is counted, not silently dropped", () => {
  const out = report({
    events: [event("tp_2", "codegen", 0.05)],
    receipts: [receipt("tp_2", "codegen")],
    extraFiles: { "worker-delegation-tp_9.json": "{ truncated mid-wri" },
  });
  // A run killed mid-write leaves a half-written receipt. Skipping it quietly
  // would make the table look complete when it is not.
  assert.match(out, /1 receipt in delegation\/ could not be parsed/);
});

test("the Markdown branch keeps the receipt path readable", () => {
  const out = report({
    events: [event("tp_2", "codegen", 0.05)],
    receipts: [receipt("tp_2", "codegen")],
    markdown: true,
  });
  // `<packet>` unescaped is parsed as an HTML tag and vanishes, taking the only
  // pointer to the receipts with it — the reader is told receipts exist and not
  // where to find them.
  assert.match(out, /worker-delegation-&lt;packet&gt;\.json/);
  assert.doesNotMatch(out, /worker-delegation-<packet>/);
});

test("the actor tags in the report are the ones logfmt defines", async () => {
  const { ACTOR } = await import(join(ROOT, "tools", "logfmt.mjs"));
  const out = report({
    events: [event("tp_2", "codegen", 0.05)],
    receipts: [receipt("tp_2", "codegen")],
  });
  // Pinned against the module rather than against literals, so the gutter
  // vocabulary has exactly one definition. Changing a tag there changes the
  // report; changing it in only one of the two places fails here.
  for (const tag of [ACTOR.driver, ACTOR.worker, ACTOR.handoff]) assert.ok(out.includes(tag), `missing ${tag}`);
});
