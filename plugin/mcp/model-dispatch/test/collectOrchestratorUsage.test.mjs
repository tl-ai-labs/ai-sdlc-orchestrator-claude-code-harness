/**
 * End-to-end pins for plugin/scripts/collect-orchestrator-usage.mjs — the
 * post-run transcript collector that reconstructs the orchestrator's own
 * (telemetry-invisible) cost. Lives in this suite for the same reason the
 * driver-model-check tests do: the script imports this package's compiled
 * dist/, and this suite runs after `npm run build`.
 *
 * Every case spawns the real CLI against a transcript tree via
 * --transcripts-dir. The synthetic cases anchor their timestamps to NOW at
 * test runtime because the collector prunes transcript files by mtime lower
 * bound — a fixture written today with a 2020 run window would be pruned
 * before its lines were ever read. The real-run cases at the bottom use the
 * fixed 2026-08-16 dates of the runs they were copied from and rely on the
 * checkout's mtime being later than that. Offline; temp dirs only.
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
    // The dispatched event ran inside the session (provenance "estimated"), so
    // it is already inside the transcript overhead: subtracted once, said aloud.
    assert.match(r.stdout, /in-session dispatch: 1 event\(s\) totaling \$0\.05/);
    assert.match(r.stdout, /5m 400000 \/ 1h 0/);
    // No receipt beside the manifest: transcript-priced, and the tool says so.
    assert.match(r.stderr, /no receipt at/);

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
      input_tokens_cache_write_1h: 0,
      output_tokens: 300_000,
      events: 1,
      provenance: "transcript",
      pricing_basis: "the policy's derived driver model",
      cost_source: "transcript",
      transcript_cost_usd: 3.7,
      receipt_cost_usd: null,
      receipt_path: null,
      dispatched_in_session_cost_usd: 0.05,
      dispatched_in_session_events: 1,
    });
    // true total = dispatched 0.05 − in-session 0.05 + overhead 3.70: the
    // estimated packet is counted once, inside the overhead, not twice.
    assert.equal(m.true_total_cost_usd, 3.7);
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
    assert.equal(readManifest(fix).true_total_cost_usd, 3.7);
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


// ── Real runs: three receivables-ops passes with Claude Code's own receipt ──
// Fixtures: tools/test/fixtures/receivables-ops (see its README). Everything
// below is cross-checked against what the CLI itself billed.
const FIX = join(HERE, "..", "..", "..", "..", "tools", "test", "fixtures", "receivables-ops");
const fixRun = (pass, policy, extra = []) =>
  spawnSync(
    process.execPath,
    [SCRIPT, join(FIX, pass), "--project-root", FIX, "--policy-path", join(FIX, "policies", `${policy}.yaml`),
      "--transcripts-dir", join(FIX, pass, "transcripts"), "--dry-run", ...extra],
    { encoding: "utf-8", env: { ...process.env, MMO_SELECT: "" } }
  );
const receiptOf = (pass) => JSON.parse(readFileSync(join(FIX, pass, "claude-session.json"), "utf-8"));
const telemetryOf = (pass) => readFileSync(join(FIX, pass, "telemetry.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const num = (re, text) => { const m = text.match(re); assert.ok(m, `no match for ${re} in:\n${text}`); return Number(m[1]); };

test("pass1: 1-hour cache writes priced at 2x land the transcript within 6% of the receipt, above it, and in-session dispatch is subtracted once", () => {
  const r = fixRun("pass1", "receivables-premium");
  assert.equal(r.status, 0, r.stderr);
  const receipt = receiptOf("pass1").total_cost_usd;
  // Every cache write in this session was on the 1-hour tier.
  assert.match(r.stdout, /cache_write 355943 \(5m 0 \/ 1h 355943\)/);
  // The receipt's own dollars imply the 1-hour rate — the diagnostic that found the bug.
  assert.match(r.stdout, /receipt implies a cache-write rate of \$10\.00\/M/);
  const transcript = num(/receipt cross-check: transcript \$([0-9.]+)/, r.stdout);
  assert.ok(transcript >= receipt, `transcript ${transcript} must not sit below the receipt ${receipt}`);
  assert.ok(transcript <= receipt * 1.06, `transcript ${transcript} is more than 6% over the receipt ${receipt}`);
  // 89 dispatched events were apportioned from the session's own total → inside the transcript.
  const dispatched = 3.739405;
  assert.match(r.stdout, /in-session dispatch: 89 event\(s\) totaling \$3\.739405/);
  const trueTotal = num(/→ true total \$([0-9.]+)/, r.stdout);
  assert.equal(trueTotal, transcript);
  // Without the fix this run reported $3.74 for a session the CLI billed at $15.27.
  assert.ok(trueTotal > 4 * dispatched);
});

test("pass3: a Gemini-only policy still prices the Opus session that drove it, from the receipt, and adds the out-of-session Gemini work once", () => {
  const r = fixRun("pass3", "receivables-floor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /prices no Claude model; receipt bills claude-opus-5/);
  const receipt = receiptOf("pass3").total_cost_usd;
  const events = telemetryOf("pass3");
  const outside = events.filter((e) => e.provenance !== "apportioned_from_measured_total").reduce((s, e) => s + e.cost_usd, 0);
  assert.ok(outside > 5, "the Gemini work (real Vertex calls) must stay in the total");
  // The telemetry carries one apportioned Opus event added by a later repair,
  // but the manifest's dispatched $6.08 names only gemini-3.7-flash — so no
  // part of the dispatched figure is inside the session, nothing is subtracted.
  assert.doesNotMatch(r.stdout, /in-session dispatch:/);
  const trueTotal = num(/→ true total \$([0-9.]+)/, r.stdout);
  const expected = Math.round((6.076299 + receipt) * 1e6) / 1e6;
  assert.ok(Math.abs(trueTotal - expected) < 0.000002, `true total ${trueTotal} ≠ dispatched + receipt = ${expected}`);
  // The dashboard's hand-corrected figure for this pass was $22.31.
  assert.ok(trueTotal > 21.3 && trueTotal < 22.4, `true total ${trueTotal} is not in the corrected-dashboard range`);
});

test("pass2: a transcript tree missing a subagent file sits far below the receipt — refused with exit 3, nothing written", () => {
  const r = fixRun("pass2", "receivables-hybrid");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /BELOW the CLI's own receipt/);
  assert.match(r.stderr, /subagent transcript not copied/);
  assert.match(r.stdout, /receipt cross-check: transcript \$2\.6[0-9]+ vs receipt \$4\.76/);
});

test("no receipt: transcript-priced at the policy rate, and the tool asks for one", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-noreceipt-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass1", f)));
    const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-premium.yaml"), "--transcripts-dir", join(FIX, "pass1", "transcripts"), "--dry-run"], { encoding: "utf-8", env: { ...process.env, MMO_SELECT: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no receipt at .*claude-session\.json/);
    assert.match(r.stdout, /= \$16\.152465 \[transcript\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit --receipt path that does not exist is an error, not a silent unverified run", () => {
  const r = fixRun("pass1", "receivables-premium", ["--receipt", join(FIX, "pass1", "no-such-receipt.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--receipt .*no-such-receipt\.json does not exist/);
});

test("receipt-only: no transcript in the window but a receipt beside the manifest — its dollars are used verbatim and said so", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-receipt-only-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl", "claude-session.json"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass3", f)));
    const empty = join(root, "empty"); mkdirSync(empty);
    const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-floor.yaml"), "--transcripts-dir", empty, "--dry-run"], { encoding: "utf-8", env: { ...process.env, MMO_SELECT: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /its \$16\.235409 is used verbatim/);
    assert.match(r.stdout, /= \$16\.235409 \[receipt-only\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pricing: 1-hour cache writes bill at 2x input, 5-minute at 1.25x, disjoint and additive", async () => {
  const pricing = await import(join(HERE, "..", "dist", "pricing.js"));
  const card = { input: 4, input_cached: 0.4, output: 20 };
  assert.equal(pricing.computeCostUsd({ input: 0, input_cached: 0, output: 0, input_cache_write: 1_000_000 }, card), 5);
  assert.equal(pricing.computeCostUsd({ input: 0, input_cached: 0, output: 0, input_cache_write_1h: 1_000_000 }, card), 8);
  assert.equal(pricing.computeCostUsd({ input: 0, input_cached: 0, output: 0, input_cache_write: 500_000, input_cache_write_1h: 500_000 }, card), 6.5);
  // An explicit 1-hour rate on the policy wins over the multiplier.
  assert.equal(pricing.computeCostUsd({ input: 0, input_cached: 0, output: 0, input_cache_write_1h: 1_000_000 }, { ...card, input_cache_write_1h: 7 }), 7);
});


test("headless recipe: the last result line of a stream-json live-run.log beside the manifest is picked up as the receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-stream-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass3", f)));
    const receipt = receiptOf("pass3");
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: receipt.session_id }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: receipt.session_id, total_cost_usd: receipt.total_cost_usd, usage: receipt.usage, modelUsage: receipt.modelUsage, num_turns: receipt.num_turns }),
    ].join("\n") + "\n";
    writeFileSync(join(passDir, "live-run.log"), stream);
    const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-floor.yaml"), "--transcripts-dir", join(FIX, "pass3", "transcripts"), "--dry-run"], { encoding: "utf-8", env: { ...process.env, MMO_SELECT: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /receipt: .*live-run\.log → \$16\.235409/);
    assert.match(r.stdout, /→ true total \$22\.311708/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── Reviewer scenarios: unit pins on the exported helpers, then end-to-end ──
import { pathToFileURL } from "node:url";
const helpers = () => import(pathToFileURL(SCRIPT).href);
const ENV = { ...process.env, MMO_SELECT: "" };

test("inSessionDispatched: consistent telemetry subtracts exactly the in-session events; vendor calls stay", async () => {
  const { inSessionDispatched } = await helpers();
  const policy = { models: [{ id: "d", model_name: "claude-opus-5", adapter: "builtin-anthropic" }, { id: "g", model_name: "gemini-3.7-flash", adapter: "mcp:model-dispatch" }] };
  const events = [{ model: "claude-opus-5", provenance: "estimated", cost_usd: 1 }, { model: "gemini-3.7-flash", provenance: "vendor", cost_usd: 2 }];
  const r = inSessionDispatched(events, policy, { totals: { models_used: ["claude-opus-5", "gemini-3.7-flash"] } }, 3);
  assert.deepEqual([r.cost, r.count, r.consistent, r.notes], [1, 1, true, []]);
});

test("inSessionDispatched: rewritten telemetry is bounded by dispatched minus the out-of-session events, and says so", async () => {
  const { inSessionDispatched } = await helpers();
  const policy = { models: [{ id: "d", model_name: "claude-opus-5", adapter: "builtin-anthropic" }, { id: "g", model_name: "gemini-3.7-flash", adapter: "mcp:model-dispatch" }] };
  // Opus events re-apportioned to $15 after the run; Gemini's $2 of real Vertex calls untouched; dispatched was $3.
  const events = [{ model: "claude-opus-5", provenance: "apportioned_from_measured_total", cost_usd: 15 }, { model: "gemini-3.7-flash", provenance: "vendor", cost_usd: 2 }];
  const r = inSessionDispatched(events, policy, { totals: { models_used: ["claude-opus-5", "gemini-3.7-flash"] } }, 3);
  assert.equal(r.cost, 1);
  assert.equal(r.consistent, false);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /rewritten after the run/);
  // A model the manifest never dispatched contributes nothing, however the telemetry was rewritten.
  const r2 = inSessionDispatched(events, policy, { totals: { models_used: ["gemini-3.7-flash"] } }, 3);
  assert.equal(r2.cost, 0);
  assert.equal(r2.count, 0);
});

test("inSessionDispatched: a claude-cli worker is inside only when its session was scanned; an API call on a model also listed as a claude-cli seat is never subtracted by name", async () => {
  const { inSessionDispatched } = await helpers();
  const policy = { models: [{ id: "d", model_name: "claude-opus-5", adapter: "builtin-anthropic" }, { id: "w", model_name: "claude-sonnet-5", adapter: "claude-cli" }, { id: "oc", model_name: "claude-opus-5", adapter: "claude-cli" }] };
  const worker = [{ model: "claude-sonnet-5", provenance: "vendor", cost_usd: 6 }];
  assert.equal(inSessionDispatched(worker, policy, {}, 6, { claudeCliScanned: true }).cost, 6);
  assert.equal(inSessionDispatched(worker, policy, {}, 6, { claudeCliScanned: false }).cost, 0);
  const ambiguous = [{ model: "claude-opus-5", provenance: "vendor", cost_usd: 1 }];
  assert.equal(inSessionDispatched(ambiguous, policy, {}, 1).cost, 0, "same model on builtin-anthropic and claude-cli: the name alone cannot classify it");
  assert.equal(inSessionDispatched([{ ...ambiguous[0], model_id: "oc" }], policy, {}, 1).cost, 1, "model_id names the claude-cli seat");
  assert.equal(inSessionDispatched([{ ...ambiguous[0], model_id: "d" }], policy, {}, 1).cost, 0, "model_id names the API seat");
});

test("filesForSession: pins to the receipt's session when a file carries the id, falls back to everything otherwise", async () => {
  const { filesForSession } = await helpers();
  const files = ["/t/aaaa-1111.jsonl", "/t/bbbb-2222.jsonl", "/t/aaaa-1111/subagents/x.jsonl"];
  assert.deepEqual(filesForSession(files, "aaaa-1111"), ["/t/aaaa-1111.jsonl", "/t/aaaa-1111/subagents/x.jsonl"]);
  assert.deepEqual(filesForSession(files, "zzzz-9999"), files);
  assert.deepEqual(filesForSession(files, null), files);
});

/** A small real-shaped run: policy, pass dir, transcript tree, optional receipt. */
function mkRun({ policy, manifest, telemetry, transcripts, receipt }) {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-rev-"));
  const passDir = join(root, "pass"); mkdirSync(passDir);
  const tDir = join(root, "transcripts"); mkdirSync(tDir);
  writeFileSync(join(root, "policy.yaml"), policy);
  writeFileSync(join(passDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(passDir, "telemetry.jsonl"), telemetry.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [name, lines] of Object.entries(transcripts)) {
    mkdirSync(dirname(join(tDir, name)), { recursive: true });
    writeFileSync(join(tDir, name), lines.join("\n") + "\n");
  }
  if (receipt) writeFileSync(join(passDir, "claude-session.json"), JSON.stringify(receipt));
  const run = (extra = []) => spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir, "--dry-run", ...extra], { encoding: "utf-8", env: ENV });
  return { root, passDir, run, rm: () => rmSync(root, { recursive: true, force: true }) };
}
const line = (id, model, out, ts, sessionId) => JSON.stringify({ type: "assistant", timestamp: ts, sessionId, message: { id, model, stop_reason: "end_turn", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
const CLI_POLICY = `
version: 1
name: rev-cli
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-5
    pricing: { input: 1, input_cached: 0.1, output: 5 }
  - id: worker
    adapter: claude-cli
    model_name: claude-sonnet-5
    pricing: { input: 1, input_cached: 0.1, output: 5 }
rules:
  - when: { phase: codegen }
    use: worker
  - default: driver
`;

test("a claude-cli worker's dollars stay in the total when the scan is pinned to the driver's receipt session; without a receipt its swept-in session is subtracted once", () => {
  const T0 = "2026-08-16T10:00:00.000Z", T1 = "2026-08-16T10:05:00.000Z", T2 = "2026-08-16T10:10:00.000Z";
  const base = {
    policy: CLI_POLICY,
    manifest: { pass: "p", policy_name: "rev-cli", started_at: T0, ended_at: T2, totals: { dispatched_cost_usd: 6, models_used: ["claude-sonnet-5"] } },
    telemetry: [{ ts: T1, model: "claude-sonnet-5", model_id: "worker", provenance: "vendor", cost_usd: 6, phase: "codegen" }],
    transcripts: { "aaaa-1111.jsonl": [line("m1", "claude-opus-5", 2_000_000, T1, "aaaa-1111")], "bbbb-2222.jsonl": [line("m2", "claude-sonnet-5", 2_000_000, T1, "bbbb-2222")] },
  };
  const withReceipt = mkRun({ ...base, receipt: { session_id: "aaaa-1111", total_cost_usd: 10, modelUsage: { "claude-opus-5": { outputTokens: 2_000_000, costUSD: 10 } } } });
  const without = mkRun(base);
  try {
    const r = withReceipt.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scanned 1 file\(s\)/);
    assert.doesNotMatch(r.stdout, /in-session dispatch:/);
    assert.match(r.stdout, /→ true total \$16\b/);
    const r2 = without.run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /scanned 2 file\(s\)/);
    assert.match(r2.stdout, /in-session dispatch: 1 event\(s\) totaling \$6/);
    assert.match(r2.stdout, /→ true total \$20\b/);
  } finally { withReceipt.rm(); without.rm(); }
});

test("a session that keeps running past ended_at is fully counted when the scan is pinned to its receipt; another session's file is left out", () => {
  const T0 = "2026-08-16T10:00:00.000Z", T1 = "2026-08-16T10:05:00.000Z", TEND = "2026-08-16T10:10:00.000Z", LATE = "2026-08-16T10:30:00.000Z";
  const policy = CLI_POLICY;
  const manifest = { pass: "p", policy_name: "rev-cli", started_at: T0, ended_at: TEND, totals: { dispatched_cost_usd: 0, models_used: [] } };
  const transcripts = { "aaaa-1111.jsonl": [line("m1", "claude-opus-5", 1_000_000, T1, "aaaa-1111"), line("m2", "claude-opus-5", 1_000_000, LATE, "aaaa-1111")], "other.jsonl": [line("m3", "claude-opus-5", 1_000_000, T1, "cccc-3333")] };
  const pinned = mkRun({ policy, manifest, telemetry: [], transcripts, receipt: { session_id: "aaaa-1111", total_cost_usd: 10, modelUsage: { "claude-opus-5": { outputTokens: 2_000_000, costUSD: 10 } } } });
  const loose = mkRun({ policy, manifest, telemetry: [], transcripts });
  try {
    const r = pinned.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scan pinned to session aaaa-1111; no upper time bound/);
    assert.match(r.stdout, /counted 2 unique API message\(s\)/);
    assert.match(r.stdout, /receipt cross-check: transcript \$10 vs receipt \$10 → \+0\.0%/);
    const r2 = loose.run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /1 outside window/);
    assert.match(r2.stdout, /counted 2 unique API message\(s\)/); // m1 + the other session's m3
  } finally { pinned.rm(); loose.rm(); }
});

test("pass2 in receipt-only mode: the Gemini vendor spend survives the in-session subtraction (bounded by dispatched minus out-of-session events)", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-pass2ro-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl", "claude-session.json"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass2", f)));
    const empty = join(root, "empty"); mkdirSync(empty);
    const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-hybrid.yaml"), "--transcripts-dir", empty, "--dry-run"], { encoding: "utf-8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const gemini = telemetryOf("pass2").filter((e) => e.model === "gemini-3.7-flash").reduce((s, e) => s + e.cost_usd, 0);
    const trueTotal = num(/→ true total \$([0-9.]+)/, r.stdout);
    const receipt = receiptOf("pass2").total_cost_usd;
    assert.ok(trueTotal >= receipt + gemini - 0.000002, `true total ${trueTotal} lost Gemini's $${gemini.toFixed(4)} (receipt ${receipt})`);
    assert.match(r.stderr, /rewritten after the run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Gemini-only policy with a two-model receipt still takes the receipt branch", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-twomodel-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass3", f)));
    const receipt = receiptOf("pass3");
    receipt.modelUsage["claude-haiku-4-5"] = { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 100, costUSD: 0.01 };
    receipt.total_cost_usd = receipt.total_cost_usd + 0.01;
    writeFileSync(join(passDir, "claude-session.json"), JSON.stringify(receipt));
    const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-floor.yaml"), "--transcripts-dir", join(FIX, "pass3", "transcripts"), "--dry-run"], { encoding: "utf-8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /receipt bills claude-opus-5 \+ claude-haiku-4-5/);
    assert.match(r.stdout, /= \$16\.245409 \[receipt \(no policy rate to cross-check against\)\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a headless capture with no result line yet is 'not final': transcript-priced, marked unverified, exit 0; as an explicit --receipt it is an error", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-collect-nostream-"));
  try {
    const passDir = join(root, "pass"); mkdirSync(passDir);
    for (const f of ["manifest.json", "telemetry.jsonl"]) writeFileSync(join(passDir, f), readFileSync(join(FIX, "pass1", f)));
    writeFileSync(join(passDir, "live-run.log"), JSON.stringify({ type: "system", subtype: "init" }) + "\n" + JSON.stringify({ type: "assistant", message: {} }) + "\n");
    const args = [SCRIPT, passDir, "--project-root", FIX, "--policy-path", join(FIX, "policies", "receivables-premium.yaml"), "--transcripts-dir", join(FIX, "pass1", "transcripts"), "--dry-run"];
    const r = spawnSync(process.execPath, args, { encoding: "utf-8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /has no "result" line yet .* UNVERIFIED/);
    assert.match(r.stdout, /= \$16\.152465 \[transcript\]/);
    const r2 = spawnSync(process.execPath, [...args, "--receipt", join(passDir, "live-run.log")], { encoding: "utf-8", env: ENV });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /neither a JSON object nor a stream-json capture/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
