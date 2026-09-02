/**
 * End-to-end pins for plugin/scripts/collect-orchestrator-usage.mjs — the
 * post-run transcript collector that reconstructs the orchestrator's own
 * (telemetry-invisible) cost. Lives in this suite for the same reason the
 * driver-model-check tests do: the script imports this package's compiled
 * dist/, and this suite runs after `npm run build`.
 *
 * Every case spawns the real CLI against a synthetic transcript tree via
 * --transcripts-dir. Fixture timestamps are anchored to NOW at test runtime
 * (not hardcoded dates) because the collector prunes transcript files by
 * mtime lower bound — a fixture written today with a 2020 run window would
 * be pruned before its lines were ever read. Offline; temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs");

// Driver rates chosen for hand-checkable dollars. No explicit cache-write
// rate, so the 1.25× premium fallback is in the arithmetic under test.
const POLICY = `
version: 1
name: check-collect
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: worker
    adapter: mcp:model-dispatch
    model_name: gemini-3.5-flash
    pricing: { input: 0.1, input_cached: 0.01, output: 0.4 }
rules:
  - when: { phase: codegen }
    use: worker
  - default: driver
`;

const MIN = 60_000;

/** One transcript line as the CLI writes it: type/timestamp/message{id,model,usage}. */
function tLine(id, model, usage, ts) {
  return JSON.stringify({ type: "assistant", timestamp: new Date(ts).toISOString(), message: { id, model, usage } });
}

/**
 * A full fixture: project root (policy), pass dir (manifest + telemetry),
 * transcript tree (session + subagent files). The run window is
 * [now−30m, now−10m]; in-window messages sit at now−20m.
 *
 * Expected overhead at the driver rate:
 *   msg_A  1,000,000 in + 2,000,000 cached + 400,000 cache-write + 100,000 out
 *          = 1 + 0.2 + (0.4 × 1.25) + 0.5           = $2.20
 *   msg_B    500,000 in + 200,000 out (subagent)     = $1.50
 *   total                                            = $3.70
 * plus the manifest's dispatched $0.05 → true total    $3.75
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-"));
  writeFileSync(join(root, "routing-policy.yaml"), POLICY);

  const now = Date.now();
  const started = new Date(now - 30 * MIN).toISOString();
  const ended = new Date(now - 10 * MIN).toISOString();
  const inWindow = now - 20 * MIN;

  const passDir = join(root, "passes", "p-test");
  mkdirSync(passDir, { recursive: true });
  writeFileSync(
    join(passDir, "manifest.json"),
    JSON.stringify({ pass: "p-test", policy_name: "check-collect", started_at: started, ended_at: ended, duration_sec: 1200, total_cost_usd: 0.05 }, null, 2)
  );
  // One dispatched estimated event: must survive the rewrite untouched, and
  // its provenance should surface the estimator-overlap note.
  const dispatched = JSON.stringify({ pass: "p-test", phase: "codegen", task_id: "t-1", provenance: "estimated", cost_usd: 0.05 });
  writeFileSync(join(passDir, "telemetry.jsonl"), dispatched + "\n");

  const tDir = join(root, "transcripts");
  const subDir = join(tDir, "sess-1", "subagents");
  mkdirSync(subDir, { recursive: true });
  const usageA = { input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 400_000, output_tokens: 100_000 };
  writeFileSync(
    join(tDir, "sess-1.jsonl"),
    [
      tLine("msg_A", "claude-opus-4-8", usageA, inWindow),
      // Same API message, second content block: identical id and usage.
      // Counting it would double msg_A — the dedupe under test.
      tLine("msg_A", "claude-opus-4-8", usageA, inWindow),
      // CLI error placeholder: never billed, never counted.
      tLine("msg_synth", "<synthetic>", { input_tokens: 9_999_999, output_tokens: 9_999_999 }, inWindow),
      // Real message from an earlier session in the same file — outside the window.
      tLine("msg_old", "claude-opus-4-8", { input_tokens: 7_000_000, output_tokens: 7_000_000 }, now - 3 * 60 * MIN),
      // Non-assistant traffic is ignored wholesale.
      JSON.stringify({ type: "user", message: { content: "hi" } }),
    ].join("\n") + "\n"
  );
  // Subagent transcript — in-session driver work; a model label differing
  // from the derived driver must WARN but still be counted at the driver rate.
  writeFileSync(
    join(subDir, "agent-1.jsonl"),
    tLine("msg_B", "claude-haiku-4-5", { input_tokens: 500_000, output_tokens: 200_000 }, inWindow) + "\n"
  );

  return { root, passDir, tDir, dispatched };
}

function run(fix, extraArgs = []) {
  const env = { ...process.env };
  delete env.MMO_SELECT;
  const res = spawnSync(
    process.execPath,
    [SCRIPT, fix.passDir, "--project-root", fix.root, "--transcripts-dir", fix.tDir, ...extraArgs],
    { env, encoding: "utf-8" }
  );
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const readTelemetry = (fix) =>
  readFileSync(join(fix.passDir, "telemetry.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const readManifest = (fix) => JSON.parse(readFileSync(join(fix.passDir, "manifest.json"), "utf-8"));

test("collector dedupes, windows, excludes synthetic, includes subagents, and writes exact dollars", () => {
  const fix = makeFixture();
  try {
    const r = run(fix);
    assert.equal(r.code, 0, r.stderr);
    // 2 unique messages out of: A ×2 (dup), synthetic, out-of-window, user line, B.
    assert.match(r.stdout, /counted 2 unique API message\(s\)/);
    assert.match(r.stdout, /1 duplicate content-block line\(s\) skipped, 1 synthetic, 1 outside window/);
    assert.match(r.stdout, /"claude-opus-4-8":1/);
    assert.match(r.stdout, /"claude-haiku-4-5":1/);
    // The single-rate assumption is surfaced, not silent.
    assert.match(r.stderr, /WARNING/);
    assert.match(r.stderr, /claude-haiku-4-5/);
    // Estimator overlap surfaced from the dispatched event's provenance.
    assert.match(r.stdout, /1 estimated direct-tier event\(s\) totaling \$0\.05/);

    const events = readTelemetry(fix);
    assert.equal(events.length, 2);
    // The dispatched line survives byte-identical.
    assert.equal(JSON.stringify(events[0]), fix.dispatched);
    const orch = events[1];
    assert.equal(orch.tier, "orchestrator");
    assert.equal(orch.phase, "orchestrator_overhead");
    assert.equal(orch.task_id, "orchestrator-overhead-p-test");
    assert.equal(orch.provenance, "transcript");
    assert.equal(orch.model, "claude-opus-4-8");
    assert.equal(orch.input_tokens, 1_500_000);
    assert.equal(orch.input_tokens_cached, 2_000_000);
    assert.equal(orch.input_tokens_cache_write, 400_000);
    assert.equal(orch.output_tokens, 300_000);
    assert.equal(orch.cost_usd, 3.7);

    const m = readManifest(fix);
    assert.equal(m.total_cost_usd, 0.05); // dispatched figure NEVER grows
    assert.deepEqual(m.orchestrator_overhead, {
      cost_usd: 3.7,
      input_tokens: 1_500_000,
      input_tokens_cached: 2_000_000,
      input_tokens_cache_write: 400_000,
      output_tokens: 300_000,
      events: 1,
      provenance: "transcript",
    });
    assert.equal(m.true_total_cost_usd, 3.75);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("re-running replaces the prior orchestrator event — never accumulates", () => {
  const fix = makeFixture();
  try {
    assert.equal(run(fix).code, 0);
    const r2 = run(fix);
    assert.equal(r2.code, 0, r2.stderr);
    const events = readTelemetry(fix);
    assert.equal(events.filter((e) => e.tier === "orchestrator").length, 1);
    assert.equal(events.length, 2);
    assert.equal(readManifest(fix).true_total_cost_usd, 3.75);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("--dry-run prints the figures but writes nothing", () => {
  const fix = makeFixture();
  try {
    const r = run(fix, ["--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /dry-run: nothing written/);
    assert.equal(readTelemetry(fix).length, 1);
    assert.equal(readManifest(fix).orchestrator_overhead, undefined);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("an empty run window exits 1 and writes nothing — wrong transcript location must not record $0", () => {
  const fix = makeFixture();
  try {
    const empty = join(fix.root, "empty-transcripts");
    mkdirSync(empty);
    const res = spawnSync(
      process.execPath,
      [SCRIPT, fix.passDir, "--project-root", fix.root, "--transcripts-dir", empty],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no billable assistant messages/);
    assert.equal(readTelemetry(fix).length, 1);
    assert.equal(readManifest(fix).orchestrator_overhead, undefined);
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test("a pass dir without manifest.json is a clear failure, not a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-"));
  try {
    const res = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * Transcript discovery depth. Subagent transcripts nest to varying depths
 * under `subagents/`: a plain delegation writes one level down, a workflow adds
 * a directory per run below that. Reading a single flat level found the shallow
 * shape only, so the subagent spend — most of what this collector exists to
 * measure — summed to nothing while the run still reported a confident total.
 */
import { candidateTranscripts } from "../../../scripts/collect-orchestrator-usage.mjs";

function transcriptTree() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-transcripts-"));
  const session = join(dir, "session-a");
  mkdirSync(join(session, "subagents", "workflows", "wf-1"), { recursive: true });
  mkdirSync(join(dir, "subagents"), { recursive: true });
  writeFileSync(join(dir, "main.jsonl"), "");
  writeFileSync(join(session, "subagents", "flat.jsonl"), "");
  writeFileSync(join(session, "subagents", "workflows", "wf-1", "agent-1.jsonl"), "");
  writeFileSync(join(dir, "subagents", "top-level.jsonl"), "");
  writeFileSync(join(session, "not-a-transcript.txt"), "");
  return dir;
}

test("transcript discovery finds subagent files nested below the flat subagents/ level", () => {
  const dir = transcriptTree();
  try {
    const found = candidateTranscripts(dir, 0).map((p) => p.slice(dir.length + 1));
    assert.ok(found.includes("main.jsonl"), "the main session transcript must still be found");
    assert.ok(found.includes(join("session-a", "subagents", "flat.jsonl")), "flat subagent transcripts must still be found");
    assert.ok(
      found.includes(join("session-a", "subagents", "workflows", "wf-1", "agent-1.jsonl")),
      "a subagent transcript one directory deeper must be found — this is the spend the collector missed",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transcript discovery reads a subagents/ directory sitting directly under the project dir", () => {
  const dir = transcriptTree();
  try {
    const found = candidateTranscripts(dir, 0).map((p) => p.slice(dir.length + 1));
    assert.ok(found.includes(join("subagents", "top-level.jsonl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transcript discovery ignores non-transcript files", () => {
  const dir = transcriptTree();
  try {
    const found = candidateTranscripts(dir, 0);
    assert.ok(found.every((p) => p.endsWith(".jsonl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/*
 * `output_tokens` is complete only on a message's terminal line — the one
 * carrying `stop_reason`. Booking any other line under-counts the message,
 * and it does so silently, toward under-reporting.
 */
import { sumTranscriptUsage } from "../../../scripts/collect-orchestrator-usage.mjs";

/** Write one session file from `[output_tokens, stop_reason]` pairs. */
function transcript(dir, rows, id = "msg_one") {
  const lines = rows.map(([out, stop]) => JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      id,
      model: "claude-opus-5",
      stop_reason: stop,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 17850,
        cache_creation_input_tokens: 5024,
        output_tokens: out,
      },
    },
  }));
  const f = join(dir, "session.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  return [f];
}

function withTranscript(rows, assertions, id) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-stream-"));
  try {
    assertions(sumTranscriptUsage(transcript(dir, rows, id), 0, Date.now() + 60_000));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a streamed message books the terminal line's output, not the first line's", () => {
  withTranscript([[2, null], [2, null], [2, null], [865, "tool_use"]], ({ tokens, stats }) => {
    assert.equal(stats.counted, 1, "four lines are one message");
    assert.equal(stats.duplicates, 3);
    assert.equal(tokens.output, 865);
    assert.equal(tokens.input, 2, "input is identical across lines, counted once");
    assert.equal(tokens.input_cached, 17850);
    assert.equal(tokens.input_cache_write, 5024);
  });
});

test("the terminal line wins even when a non-terminal line reports more", () => {
  // Guards the difference between this rule and "take the largest": a
  // mid-stream line must never outrank the message's own end-of-stream marker.
  withTranscript([[2, null], [9999, null], [865, "end_turn"]], ({ tokens }) => {
    assert.equal(tokens.output, 865);
  });
});

test("the terminal line wins when it arrives before the others", () => {
  withTranscript([[865, "end_turn"], [2, null], [9999, null]], ({ tokens }) => {
    assert.equal(tokens.output, 865);
  });
});

test("with no terminal line the largest value is kept as a lower bound", () => {
  withTranscript([[2, null], [400, null], [120, null]], ({ tokens }) => {
    assert.equal(tokens.output, 400);
  });
});

test("two distinct messages each book their own terminal value", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-stream-"));
  try {
    const rows = [
      { id: "a", out: 2, stop: null }, { id: "a", out: 500, stop: "end_turn" },
      { id: "b", out: 7, stop: null }, { id: "b", out: 300, stop: "end_turn" },
    ].map((r) => JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { id: r.id, model: "claude-opus-5", stop_reason: r.stop, usage: { input_tokens: 1, output_tokens: r.out } },
    }));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, rows.join("\n") + "\n");
    const { tokens, stats } = sumTranscriptUsage([f], 0, Date.now() + 60_000);
    assert.equal(stats.counted, 2);
    assert.equal(tokens.output, 800);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/*
 * The original defect was not the wrong key name — it was `?? 0` turning a
 * missing key into a confident wrong answer. Renaming the key fixes today's
 * manifest; refusing to assume zero is what keeps the next rename loud.
 */
test("a manifest carrying no dispatched cost is refused, never treated as $0", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-nocost-"));
  try {
    mkdirSync(join(dir, "pass"), { recursive: true });
    const now = new Date();
    writeFileSync(join(dir, "pass", "manifest.json"), JSON.stringify({
      pass: "p1",
      policy_name: "opus-only",
      started_at: new Date(now - 60_000).toISOString(),
      ended_at: now.toISOString(),
      totals: { dispatched_events: 1 },   // no dispatched_cost_usd, no total_cost_usd
    }));
    const tdir = join(dir, "t");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "s.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: now.toISOString(),
      message: { id: "m1", model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } },
    }) + "\n");

    const res = spawnSync(process.execPath, [SCRIPT, join(dir, "pass"), "--transcripts-dir", tdir], { encoding: "utf-8" });
    assert.equal(res.status, 1, "must exit non-zero rather than report overhead as the whole cost");
    assert.match(res.stderr, /dispatched cost/i);
    assert.match(res.stderr, /totals\.dispatched_cost_usd/, "names the key it looked for");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
