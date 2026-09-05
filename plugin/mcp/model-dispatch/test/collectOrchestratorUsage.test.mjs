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
    // No command turn and no run log: both anchors are the manifest's dispatch
    // stamps ± 5 minutes, the window is approximate, and the block says so.
    const { window, ...overhead } = m.orchestrator_overhead;
    assert.deepEqual(window, {
      start: new Date(Date.parse(m.started_at) - 5 * MIN).toISOString(),
      end: new Date(Date.parse(m.ended_at) + 5 * MIN).toISOString(),
      start_anchor: "manifest started_at - 5m",
      end_anchor: "manifest ended_at + 5m",
      exact: false,
      session_id: null,
    });
    assert.deepEqual(overhead, {
      cost_usd: 3.7,
      input_tokens: 1_500_000,
      input_tokens_cached: 2_000_000,
      input_tokens_cache_write: 400_000,
      input_tokens_cache_write_1h: 0,
      output_tokens: 300_000,
      events: 1,
      provenance: "transcript",
      pricing_basis: "the policy's derived driver model",
      cost_source: "transcript (no receipt; unverified; approximate window)",
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

test("pass1: a transcript stripped of its human turns holds the preamble invocation too — ABOVE the receipt in every bucket, refused with exit 3, nothing written", () => {
  const r = fixRun("pass1", "receivables-premium");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  // Every cache write in this session was on the 1-hour tier, and the receipt's
  // own dollars imply that rate — the diagnostic that found the tier bug.
  assert.match(r.stdout, /tokens transcript in 158 · cached 15843890 · cache_write 355943 · out 186812 \| receipt in 142 · cached 15480055 · cache_write 310521 · out 177022/);
  assert.match(r.stdout, /receipt implies a cache-write rate of \$10\.00\/M/);
  assert.match(r.stdout, /claude-opus-5: in 158>142 · cached 15843890>15480055 · cache_write 355943>310521 · out 186812>177022 → over the receipt/);
  // The fixture keeps only assistant lines, so the 8-message preamble that
  // preceded the run's own command turn cannot be separated from the run: the
  // tool says why and writes nothing rather than a number 5.8% high.
  assert.match(r.stderr, /the window holds messages the receipt never billed/);
  assert.match(r.stderr, /the scan is not pinned to a session file, so its human turns cannot be read/);
  assert.doesNotMatch(r.stdout, /true total/);
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
    assert.match(r.stdout, /= \$16\.152465 \[transcript \(no receipt; unverified; approximate window\)\]/);
    // 89 dispatched events were apportioned from the session's own total → inside the transcript, subtracted once.
    assert.match(r.stdout, /in-session dispatch: 89 event\(s\) totaling \$3\.739405/);
    assert.equal(num(/→ true total \$([0-9.]+)/, r.stdout), 16.152465);
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
  const exec = (extra, dry) => spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", root, "--policy-path", join(root, "policy.yaml"), "--transcripts-dir", tDir, ...(dry ? ["--dry-run"] : []), ...extra], { encoding: "utf-8", env: ENV });
  const run = (extra = []) => exec(extra, true);
  const write = (extra = []) => exec(extra, false); // writes telemetry + manifest, for pins on what lands on disk
  return { root, passDir, run, write, rm: () => rmSync(root, { recursive: true, force: true }) };
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
    assert.match(r.stderr, /NOTE: the receipt also bills claude-haiku-4-5 \(110 tokens, \$0\.01\) for calls the transcript does not record/);
    assert.match(r.stdout, /= \$16\.245409 \[receipt \(transcript agrees; no policy rate for a rate check\)\]/);
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
    assert.match(r.stdout, /= \$16\.152465 \[transcript \(receipt pending; provisional; approximate window\)\]/);
    const r2 = spawnSync(process.execPath, [...args, "--receipt", join(passDir, "live-run.log")], { encoding: "utf-8", env: ENV });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /neither a JSON object nor a stream-json capture/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/*
 * The manifest is written by the orchestrator from a prose spec, and its keys
 * drifted from `buildManifest`'s shape: real runs write `policy`/`run_id`
 * where the builder says `policy_name`/`pass`. A reader that knows only one
 * spelling does not fail — it silently reprices the run under whatever the
 * loader falls back to. Same class as the `?? 0` case above, with a policy
 * standing in for the zero.
 */
function fixtureWithManifestKeys(keys) {
  const fix = makeFixture();
  const path = join(fix.passDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf-8"));
  delete manifest.pass;
  delete manifest.policy_name;
  writeFileSync(path, JSON.stringify({ ...manifest, ...keys }, null, 2));
  return fix;
}

test("a manifest in the shape real runs write is priced under the policy it names", () => {
  const fix = fixtureWithManifestKeys({ run_id: "run-20260905T112215Z", policy: "check-collect" });
  try {
    const r = run(fix);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /pass 'run-20260905T112215Z'/);

    const orch = readTelemetry(fix).at(-1);
    assert.equal(orch.tier, "orchestrator");
    // The policy the manifest named — not a fallback the run never chose.
    assert.equal(orch.routing.policy_name, "check-collect");
    assert.equal(orch.pass, "run-20260905T112215Z");
    assert.equal(orch.task_id, "orchestrator-overhead-run-20260905T112215Z");
  } finally { rmSync(fix.root, { recursive: true, force: true }); }
});

test("both manifest spellings produce identical accounting", () => {
  const drifted = fixtureWithManifestKeys({ run_id: "p-test", policy: "check-collect" });
  const builder = fixtureWithManifestKeys({ pass: "p-test", policy_name: "check-collect" });
  try {
    assert.equal(run(drifted).code, 0);
    assert.equal(run(builder).code, 0);

    const a = readTelemetry(drifted).at(-1);
    const b = readTelemetry(builder).at(-1);
    for (const key of ["cost_usd", "input_tokens", "input_tokens_cached", "output_tokens", "task_id", "pass"]) {
      assert.deepEqual(a[key], b[key], `${key} differs between manifest spellings`);
    }
    assert.equal(a.routing.policy_name, b.routing.policy_name);
  } finally {
    rmSync(drifted.root, { recursive: true, force: true });
    rmSync(builder.root, { recursive: true, force: true });
  }
});

// ─── Window anchors: the run's own invocation ───────────────────────────────
// Claude Code bills per invocation, and an invocation begins at its human
// turn. The window opens at the run's own command turn (exact) and closes at
// the next human turn after run.end, or at the end of the session file (also
// exact — assistant messages only ever follow a human turn). Without a
// command turn it opens at run.start minus 5 minutes, else at the manifest's
// started_at minus 5 minutes; started_at is the first DISPATCHED event, and
// opening there dropped 22% of a real run's driver spend (v37-agsdk-1,
// 2026-09-05). Those fallbacks are labelled approximate, and the exact
// per-bucket receipt rule is what decides whether they held.
import { runStartFromLog, runEndFromLog, humanTurns, compareBuckets } from "../../../scripts/collect-orchestrator-usage.mjs";

const ANCHOR_POLICY = `
version: 1
name: check-anchor
models:
  - id: driver
    adapter: builtin-anthropic
    model_name: claude-opus-4-8
    pricing: { input: 1, input_cached: 0.1, output: 10 }
rules:
  - default: driver
`;
// Timeline (all 2026-09-05Z). command turn 18:51:15.673; run.start 18:53:03;
// first dispatch 19:05:00; last dispatch 19:06:00; run.end 19:06:30. The old
// window opened at 19:00:00 (dispatch − 5m).
const COMMAND_TS = "2026-09-05T18:51:15.673Z";
const RUN_START = "2026-09-05T18:53:03.107Z";
const RUN_END = "2026-09-05T19:06:30.000Z";
const NEXT_TURN = "2026-09-05T19:20:00.000Z";
const ANCHOR_MANIFEST = { pass: "r-anchor", policy_name: "check-anchor", started_at: "2026-09-05T19:05:00.000Z", ended_at: "2026-09-05T19:06:00.000Z", totals: { dispatched_cost_usd: 0.5, models_used: ["gemini-3.5-flash"] } };
const ANCHOR_TELEMETRY = [{ pass: "r-anchor", phase: "codegen", task_id: "t-1", provenance: "vendor", model: "gemini-3.5-flash", model_id: "worker", cost_usd: 0.5 }];
// 1,000,000 output tokens at $10/M = $10.00 per message; four candidates:
const ANCHOR_LINES = [
  line("m_old", "claude-opus-4-8", 1_000_000, "2026-09-05T18:40:00.000Z"),   // before the command turn: another invocation
  line("m_setup", "claude-opus-4-8", 1_000_000, "2026-09-05T18:51:30.000Z"), // the driver's setup, 1.5m before run.start
  line("m_pre", "claude-opus-4-8", 1_000_000, "2026-09-05T18:56:00.000Z"),   // after run.start, 9m before the first dispatch: THE BUG
  line("m_in", "claude-opus-4-8", 1_000_000, "2026-09-05T19:05:30.000Z"),    // between the dispatches
];
// The CLI billed the three messages that belong to the run: $30.
const ANCHOR_RECEIPT = { total_cost_usd: 30, modelUsage: { "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 3_000_000, costUSD: 30 } } };
const runLogLine = (iso, event = "run.start", fields = "run_id=r-anchor mode=greenfield") => `MMO: ${iso} INFO   ${event} ${fields}`;
const RUN_LOG = [runLogLine(RUN_START), runLogLine("2026-09-05T18:53:27.000Z", "phase.start", "run_id=r-anchor phase=requirements_analysis"), runLogLine(RUN_END, "run.end", "run_id=r-anchor outcome=completed")];
const withRunLog = (fix, lines, where = "sdlc") => {
  const dir = where === "sdlc" ? join(fix.root, ".sdlc", "runs", "r-anchor") : fix.passDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "orchestrator.log"), lines.join("\n") + "\n");
};
/** A human turn as the CLI writes it: `type: "user"` with a string content. */
const uLine = (ts, text, extra = {}) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
/** The run's command turn: the slash command and its args, as the CLI records a `/mmo:pass` invocation. */
const commandTurn = (ts = COMMAND_TS, runId = "r-anchor") =>
  uLine(ts, `<command-message>mmo:pass is running…</command-message>\n<command-name>/mmo:pass</command-name>\n<command-args>--auth=vendor --policy=check-anchor --study=x${runId ? ` --run-id=${runId}` : ""} brief.md</command-args>`);
const anchorRun = (lines = ANCHOR_LINES, receipt = ANCHOR_RECEIPT) => mkRun({ policy: ANCHOR_POLICY, manifest: ANCHOR_MANIFEST, telemetry: ANCHOR_TELEMETRY, transcripts: { "sess-a.jsonl": lines }, receipt });
const AGREES = /claude-opus-4-8: in 0=0 · cached 0=0 · cache_write 0=0 · out 3000000≤3000000 → agrees/;

// ── Exact window: the command turn opens it ─────────────────────────────────

test("the window opens at the run's command turn and closes at the end of the session file: exact, and the receipt verifies", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES]);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /window 2026-09-05T18:51:15\.673Z → end of session\n/);
    assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:51:15\.673Z in .*sess-a\.jsonl \(exact: the invocation the CLI bills begins there\)/);
    assert.match(r.stdout, /closes at the end of the session file: run\.end 2026-09-05T19:06:30\.000Z in .*\.sdlc\/runs\/r-anchor\/orchestrator\.log and no later human turn \(exact\)/);
    assert.match(r.stdout, /scan pinned to session sess-a/);
    // m_old (18:40) belongs to whatever ran before the command turn.
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
    assert.match(r.stdout, /1 outside window/);
    assert.match(r.stdout, AGREES);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
    assert.match(r.stdout, /→ true total \$30\.5/);
    assert.doesNotMatch(r.stdout, /approximate/);
    assert.doesNotMatch(r.stderr, /NOTE: run\.start is/); // 12 minutes, well under the stale-log note's hour
  } finally { fix.rm(); }
});

test("the window closes at the next human turn after run.end: a later prompt on the same session, and its messages, are excluded", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES, uLine(NEXT_TURN, "thanks — now summarise what you did"), line("m_after", "claude-opus-4-8", 1_000_000, "2026-09-05T19:21:00.000Z")]);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /window 2026-09-05T18:51:15\.673Z → 2026-09-05T19:20:00\.000Z\n/);
    assert.match(r.stdout, /closes at the next human turn 2026-09-05T19:20:00\.000Z after run\.end 2026-09-05T19:06:30\.000Z in .*orchestrator\.log \(exact: that turn starts the next invocation and is excluded\)/);
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
    assert.match(r.stdout, /2 outside window/);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
    assert.doesNotMatch(r.stdout, /approximate/);
  } finally { fix.rm(); }
});

test("no run.end line but no human turn after the command turn: the session file ends with this invocation, still exact", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES]);
  try {
    withRunLog(fix, [runLogLine(RUN_START)]);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /closes at the end of the session file: no run\.end line in .*orchestrator\.log, and no human turn after the window opens \(exact\)/);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
    assert.doesNotMatch(r.stdout, /approximate/);
  } finally { fix.rm(); }
});

test("no run.end line and a human turn after the command turn: only run.end could place the close, so it falls back to ended_at + 5m and says approximate", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES, uLine(NEXT_TURN, "thanks"), line("m_after", "claude-opus-4-8", 1_000_000, "2026-09-05T19:21:00.000Z")]);
  try {
    withRunLog(fix, [runLogLine(RUN_START)]);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /window 2026-09-05T18:51:15\.673Z → 2026-09-05T19:11:00\.000Z \(approximate\)/);
    assert.match(r.stdout, /closes at the manifest's ended_at 2026-09-05T19:06:00\.000Z \(= last dispatched event\) plus 5 minutes \(approximate: no run\.end line in .*orchestrator\.log, and a human turn after the window opens that only run\.end could place\)/);
    // The receipt rule is what decides whether the approximate close held — here it did.
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
  } finally { fix.rm(); }
});

test("--run-id picks this run's command turn: a turn naming another run is never this run's, wherever it sits", () => {
  const fix = anchorRun([commandTurn("2026-09-05T18:30:00.000Z", "other-run"), commandTurn(), ...ANCHOR_LINES]);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:51:15\.673Z/);
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
  } finally { fix.rm(); }
});

test("a command turn naming this run id outranks a later one naming none (no receipt: transcript-priced, unverified, exact window)", () => {
  const fix = anchorRun([commandTurn("2026-09-05T18:30:00.000Z"), commandTurn("2026-09-05T18:35:00.000Z", null), ...ANCHOR_LINES], null);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at the run's command turn 2026-09-05T18:30:00\.000Z/);
    assert.match(r.stdout, /counted 4 unique API message\(s\)/);
    assert.match(r.stdout, /= \$40 \[transcript \(no receipt; unverified\)\]/);
    assert.match(r.stderr, /no receipt at/);
  } finally { fix.rm(); }
});

test("the manifest records the window it measured: anchors, exactness and the pinned session", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES]);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.write();
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(fix.passDir, "manifest.json"), "utf-8"));
    const o = m.orchestrator_overhead;
    assert.deepEqual(o.window, { start: COMMAND_TS, end: null, start_anchor: "command turn", end_anchor: "end of session", exact: true, session_id: "sess-a" });
    assert.equal(o.cost_source, "receipt (transcript agrees, +0.0%)");
    assert.equal(o.cost_usd, 30);
    assert.equal(o.transcript_cost_usd, 30);
    assert.equal(o.receipt_cost_usd, 30);
    assert.equal(o.output_tokens, 3_000_000);
    assert.equal(m.true_total_cost_usd, 30.5);
    assert.equal(m.totals.dispatched_cost_usd, 0.5); // the dispatched figure never grows (this manifest uses the totals.* spelling)
  } finally { fix.rm(); }
});

// ── The exact receipt rule ──────────────────────────────────────────────────

test("SHORT: a bucket below the receipt means billed messages are missing from the tree — refused, exit 3, nothing written", () => {
  // Real-shaped usage: cache reads carry the evidence, so a missing message shows as a cache_read shortfall.
  const full = (id, ts, cached) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-4-8", stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: 1000 } } });
  const receipt = { total_cost_usd: 1, modelUsage: { "claude-opus-4-8": { inputTokens: 30, cacheReadInputTokens: 6_000_000, cacheCreationInputTokens: 0, outputTokens: 3000, costUSD: 1 } } };
  const fix = anchorRun([commandTurn(), full("a", "2026-09-05T18:52:00.000Z", 1_000_000), full("b", "2026-09-05T18:56:00.000Z", 2_000_000)], receipt);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.write();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-opus-4-8: in 20<30 · cached 3000000<6000000 · cache_write 0=0 · out 2000≤3000 → short of the receipt/);
    assert.match(r.stderr, /BELOW the CLI's own receipt \(claude-opus-4-8 input: transcript 20 < receipt 30; claude-opus-4-8 input_cached: transcript 3000000 < receipt 6000000/);
    assert.match(r.stderr, /has no tolerance to widen/);
    assert.doesNotMatch(r.stdout, /true total/);
    assert.equal(JSON.parse(readFileSync(join(fix.passDir, "manifest.json"), "utf-8")).orchestrator_overhead, undefined);
  } finally { fix.rm(); }
});

test("two invocations on one session: the receipt covers only the last leg, which verifies; the whole window is written transcript-priced and labelled so", () => {
  const [mOld, mSetup, mPre, mIn] = ANCHOR_LINES;
  const lastLeg = { total_cost_usd: 10, modelUsage: { "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1_000_000, costUSD: 10 } } };
  const fix = anchorRun([commandTurn(), mOld, mSetup, mPre, uLine("2026-09-05T18:58:00.000Z", "Continue the run from where it stopped."), mIn], lastLeg);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /claude-opus-4-8: in 0=0 · cached 0=0 · cache_write 0=0 · out 3000000>1000000 → over the receipt/);
    assert.match(r.stdout, /last invocation \(from the human turn at 2026-09-05T18:58:00\.000Z, 1 earlier turn\(s\) in the window\):/);
    assert.match(r.stdout, /claude-opus-4-8: in 0=0 · cached 0=0 · cache_write 0=0 · out 1000000≤1000000 → agrees/);
    assert.match(r.stdout, /transcript \$10 vs receipt \$10 → \+0\.0%; the last invocation agrees with the receipt/);
    assert.match(r.stdout, /= \$30 \[transcript \(receipt covers only the last invocation, verified \+0\.0%; 1 earlier invocation\(s\) unverified\)\]/);
    assert.match(r.stderr, /NOTE: the receipt bills only the last invocation/);
  } finally { fix.rm(); }
});

test("two invocations, and the receipt matches neither the whole window nor the last leg: refused, exit 3", () => {
  const [mOld, mSetup, mPre, mIn] = ANCHOR_LINES;
  const wrong = { total_cost_usd: 20, modelUsage: { "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 2_000_000, costUSD: 20 } } };
  const fix = anchorRun([commandTurn(), mOld, mSetup, mPre, uLine("2026-09-05T18:58:00.000Z", "Continue."), mIn], wrong);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the receipt matches neither the whole window nor its last invocation/);
    assert.match(r.stderr, /no number is guessed/);
  } finally { fix.rm(); }
});

test("ABOVE with a single human turn: nothing explains the extra messages — refused, exit 3, no guess", () => {
  const four = { total_cost_usd: 20, modelUsage: { "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 2_000_000, costUSD: 20 } } };
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES], four);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /the window holds messages the receipt never billed \(claude-opus-4-8 output: transcript 3000000 > receipt 2000000\) and no continuation turn explains them: the session file .*sess-a\.jsonl carries 1 human turn\(s\) inside the window/);
  } finally { fix.rm(); }
});

test("a receipt for another session cannot referee this run: exit 3", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES], { ...ANCHOR_RECEIPT, session_id: "sess-b" });
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /is for session sess-b, but the run's command turn \(2026-09-05T18:51:15\.673Z\) is in session sess-a \(.*sess-a\.jsonl\), and session sess-b holds no command turn for run 'r-anchor'/);
  } finally { fix.rm(); }
});

test("a receipt model the transcript never recorded is a NOTE, not a mismatch: its dollars are inside the booked total", () => {
  const receipt = { total_cost_usd: 30.02, modelUsage: { ...ANCHOR_RECEIPT.modelUsage, "claude-haiku-4-5": { inputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 50, costUSD: 0.02 } } };
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES], receipt);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /NOTE: the receipt also bills claude-haiku-4-5 \(250 tokens, \$0\.02\) for calls the transcript does not record/);
    assert.match(r.stdout, /= \$30\.02 \[receipt \(transcript agrees, -0\.1%\)\]/);
  } finally { fix.rm(); }
});

test("rate drift: the receipt's own tokens at the policy card no longer reproduce its dollars — booked, and the NOTE names the gap", () => {
  const receipt = { total_cost_usd: 33, modelUsage: { "claude-opus-4-8": { ...ANCHOR_RECEIPT.modelUsage["claude-opus-4-8"], costUSD: 33 } } };
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES], receipt);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /NOTE: rate drift — the receipt's own 'claude-opus-4-8' tokens priced at the policy card come to \$30, but the receipt bills \$33 for them \(-9\.1%\)/);
    assert.match(r.stdout, /= \$33 \[receipt \(transcript agrees, -9\.1%\)\]/);
  } finally { fix.rm(); }
});

test("--receipt-tolerance is gone: the check is exact and the flag is an error", () => {
  const fix = anchorRun([commandTurn(), ...ANCHOR_LINES]);
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run(["--receipt-tolerance", "0.1"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--receipt-tolerance no longer exists: the receipt check is exact per token bucket and has no tolerance to widen/);
  } finally { fix.rm(); }
});

// ── Approximate windows: no command turn in the tree ────────────────────────

test("no command turn: the window opens at run.start minus 5 minutes, says approximate, and the receipt still verifies it", () => {
  const fix = anchorRun();
  try {
    withRunLog(fix, [runLogLine(RUN_START), runLogLine("2026-09-05T18:53:27.000Z", "phase.start", "run_id=r-anchor phase=requirements_analysis")]);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /window 2026-09-05T18:48:03\.107Z → 2026-09-05T19:11:00\.000Z \(approximate\)/);
    assert.match(r.stdout, /opens at run\.start 2026-09-05T18:53:03\.107Z in .*\.sdlc\/runs\/r-anchor\/orchestrator\.log minus 5 minutes \(approximate: no run command turn found in/);
    assert.match(r.stdout, /closes at the manifest's ended_at 2026-09-05T19:06:00\.000Z \(= last dispatched event\) plus 5 minutes \(approximate: no run\.end line in .*orchestrator\.log, and the scan is not pinned to a session file\)/);
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
    assert.match(r.stdout, /1 outside window/);
    assert.match(r.stdout, AGREES);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
    assert.doesNotMatch(r.stderr, /NOTE: run\.start is/);
  } finally { fix.rm(); }
});

test("no command turn and a run.end line: closes at run.end plus 5 minutes, approximate because no session file is pinned", () => {
  const fix = anchorRun();
  try {
    withRunLog(fix, RUN_LOG);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /window 2026-09-05T18:48:03\.107Z → 2026-09-05T19:11:30\.000Z \(approximate\)/);
    assert.match(r.stdout, /closes at run\.end 2026-09-05T19:06:30\.000Z in .*orchestrator\.log plus 5 minutes \(approximate: the scan is not pinned to a session file, so no human turn can bound it\)/);
    assert.match(r.stdout, /= \$30 \[receipt \(transcript agrees, \+0\.0%\)\]/);
  } finally { fix.rm(); }
});

test("without a run.start line the window falls back to the manifest's started_at, says so, and the receipt check exposes the gap", () => {
  const fix = anchorRun();
  try {
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /window 2026-09-05T19:00:00\.000Z → 2026-09-05T19:11:00\.000Z \(approximate\)/);
    assert.match(r.stdout, /opens at the manifest's started_at 2026-09-05T19:05:00\.000Z \(= first dispatched event\) minus 5 minutes \(approximate: no run command turn found in .* and no run\.start line in .*\.sdlc\/runs\/r-anchor\/orchestrator\.log\)/);
    // Only m_in survives: m_pre (9m before the dispatch) and m_setup are outside the old window.
    assert.match(r.stdout, /counted 1 unique API message\(s\)/);
    assert.match(r.stdout, /3 outside window/);
    assert.match(r.stdout, /out 1000000≤3000000 → short of the receipt/);
    assert.match(r.stderr, /BELOW the CLI's own receipt/);
    assert.match(r.stderr, /a run log with no run\.start line/);
  } finally { fix.rm(); }
});

test("a reused run id: the LAST run.start at or before the first dispatch wins, and the earlier run's messages stay outside", () => {
  const fix = anchorRun();
  try {
    // Yesterday's run under the same id, appended first; its message must not be swept in.
    const yesterday = line("m_yesterday", "claude-opus-4-8", 1_000_000, "2026-09-04T19:00:00.000Z");
    writeFileSync(join(fix.root, "transcripts", "sess-a.jsonl"), [yesterday, ...ANCHOR_LINES].join("\n") + "\n");
    withRunLog(fix, [runLogLine("2026-09-04T18:53:03.000Z"), runLogLine("2026-09-04T19:30:00.000Z", "run.end", "run_id=r-anchor outcome=completed"), runLogLine(RUN_START)]);
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at run\.start 2026-09-05T18:53:03\.107Z/);
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
    assert.match(r.stdout, /2 outside window/);
  } finally { fix.rm(); }
});

test("a run.start stamped after the first dispatch cannot be this run's: ignored, fallback to started_at, refused by the receipt", () => {
  const fix = anchorRun();
  try {
    withRunLog(fix, [runLogLine("2026-09-05T19:10:00.000Z")]);
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /opens at the manifest's started_at 2026-09-05T19:05:00\.000Z \(= first dispatched event\) minus 5 minutes/);
    assert.match(r.stderr, /BELOW the CLI's own receipt/);
  } finally { fix.rm(); }
});

test("brownfield shape: the run log inside the pass directory itself is the second place looked", () => {
  const fix = anchorRun();
  try {
    withRunLog(fix, [runLogLine(RUN_START)], "pass");
    const r = fix.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /opens at run\.start 2026-09-05T18:53:03\.107Z in .*\/pass\/orchestrator\.log minus 5 minutes/);
    assert.match(r.stdout, /counted 3 unique API message\(s\)/);
  } finally { fix.rm(); }
});

test("a run.start more than an hour before the first dispatch is used and flagged; the messages it sweeps in fail the receipt, nothing is guessed", () => {
  const fix = anchorRun();
  try {
    withRunLog(fix, [runLogLine("2026-09-05T17:00:00.000Z")]);
    const r = fix.run();
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /NOTE: run\.start is 125 minutes before the first dispatched event/);
    // m_old (18:40) is now inside; all four count and the transcript sits over the receipt.
    assert.match(r.stdout, /counted 4 unique API message\(s\)/);
    assert.match(r.stderr, /the window holds messages the receipt never billed \(claude-opus-4-8 output: transcript 4000000 > receipt 3000000\)/);
    assert.match(r.stderr, /the scan is not pinned to a session file, so its human turns cannot be read/);
  } finally { fix.rm(); }
});

// ── Unit pins on the exported helpers ───────────────────────────────────────

test("runStartFromLog reads the line format the loggers emit, with or without the MMO: prefix, and ignores other events", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-runstart-"));
  try {
    const p = join(dir, "orchestrator.log");
    const notAfter = Date.parse("2026-09-05T19:05:00Z");
    writeFileSync(p, ["MMO: 2026-09-05T18:53:27.211Z INFO   phase.start run_id=x phase=requirements_analysis", "MMO: 2026-09-05T18:53:03.107Z INFO   run.start run_id=x mode=greenfield", ""].join("\n"));
    assert.deepEqual(runStartFromLog(p, notAfter), { ms: Date.parse("2026-09-05T18:53:03.107Z"), iso: "2026-09-05T18:53:03.107Z" });
    writeFileSync(p, "2026-09-05T18:53:03.107Z INFO   run.start run_id=x\n"); // MMO_LOG_PREFIX=""
    assert.equal(runStartFromLog(p, notAfter).iso, "2026-09-05T18:53:03.107Z");
    writeFileSync(p, "MMO: 2026-09-05T18:53:03.107Z INFO   run.started run_id=x\n"); // not the event
    assert.equal(runStartFromLog(p, notAfter), null);
    assert.equal(runStartFromLog(join(dir, "missing.log"), notAfter), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runEndFromLog: the first lifecycle marker after run.start must be run.end; another run.start, or nothing, is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-runend-"));
  try {
    const p = join(dir, "orchestrator.log");
    const startMs = Date.parse(RUN_START);
    writeFileSync(p, [runLogLine("2026-09-04T19:30:00.000Z", "run.end", "run_id=x outcome=completed"), runLogLine(RUN_START), runLogLine("2026-09-05T18:53:27.000Z", "phase.start", "run_id=x phase=a"), runLogLine(RUN_END, "run.end", "run_id=x outcome=completed"), runLogLine("2026-09-05T20:00:00.000Z", "run.end", "run_id=x outcome=completed"), ""].join("\n"));
    assert.deepEqual(runEndFromLog(p, startMs), { ms: Date.parse(RUN_END), iso: RUN_END }); // the first run.end AFTER run.start; yesterday's is ignored
    writeFileSync(p, [runLogLine(RUN_START), runLogLine("2026-09-05T19:30:00.000Z"), runLogLine("2026-09-05T20:00:00.000Z", "run.end", "run_id=x outcome=completed"), ""].join("\n"));
    assert.equal(runEndFromLog(p, startMs), null); // a second run.start came first: that run.end is not this run's
    writeFileSync(p, runLogLine(RUN_START) + "\n");
    assert.equal(runEndFromLog(p, startMs), null);
    assert.equal(runEndFromLog(join(dir, "missing.log"), startMs), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("humanTurns: real prompts only — the CLI's bookkeeping lines are not turns, the run command and its --run-id are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-turns-"));
  try {
    const p = join(dir, "abc-123.jsonl");
    writeFileSync(p, [
      line("m1", "claude-opus-4-8", 1, "2026-09-05T18:52:00.000Z"),                                   // assistant: never a turn
      uLine("2026-09-05T18:58:00.000Z", "Continue."),                                                  // a plain prompt
      commandTurn(),                                                                                    // the run command, out of order on purpose
      uLine("2026-09-05T18:53:00.000Z", "[Request interrupted]", { isMeta: true }),                    // CLI bookkeeping
      uLine("2026-09-05T18:53:10.000Z", "tool output", { toolUseResult: { stdout: "x" } }),           // tool result envelope
      JSON.stringify({ type: "user", timestamp: "2026-09-05T18:53:20.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-05T19:30:00.000Z", sessionId: "abc-123", message: { role: "user", content: [{ type: "text", text: "<command-name>/ai-sdlc-measured</command-name>\n<command-args>--run-id=v37-x</command-args>" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "no timestamp" } }),
      "not json",
      "",
    ].join("\n"));
    const turns = humanTurns(p);
    assert.deepEqual(turns.map((t) => [t.iso, t.command, t.run_id, t.session_id]), [
      [COMMAND_TS, true, "r-anchor", "abc-123"],
      ["2026-09-05T18:58:00.000Z", false, null, "abc-123"],
      ["2026-09-05T19:30:00.000Z", true, "v37-x", "abc-123"],
    ]);
    assert.deepEqual(humanTurns(join(dir, "missing.jsonl")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compareBuckets: equal deterministic buckets with output at or below the receipt agree; anything else names the bucket", () => {
  const T = (input, input_cached, input_cache_write, output) => ({ input, input_cached, input_cache_write, output, input_cache_write_1h: 0 });
  const R = (input, input_cached, input_cache_write, output, cost_usd = 1) => ({ input, input_cached, input_cache_write, output, cost_usd });
  let c = compareBuckets({ opus: T(10, 100, 5, 40) }, { opus: R(10, 100, 5, 50) });
  assert.deepEqual([c.ok, c.above, c.short, c.unrecorded], [true, [], [], []]);
  assert.deepEqual(c.lines, ["opus: in 10=10 · cached 100=100 · cache_write 5=5 · out 40≤50 → agrees"]);
  c = compareBuckets({ opus: T(10, 100, 5, 60) }, { opus: R(10, 100, 5, 50) });
  assert.deepEqual([c.ok, c.above], [false, ["opus output: transcript 60 > receipt 50"]]);
  c = compareBuckets({ opus: T(10, 90, 5, 40) }, { opus: R(10, 100, 5, 50) });
  assert.deepEqual([c.ok, c.short], [false, ["opus input_cached: transcript 90 < receipt 100"]]);
  assert.match(c.lines[0], /→ short of the receipt$/);
  // A receipt model the transcript never saw is reported, not a failure; a transcript model the receipt never billed is over.
  c = compareBuckets({ opus: T(10, 100, 5, 40) }, { opus: R(10, 100, 5, 50), haiku: R(1, 0, 0, 1, 0.01) });
  assert.deepEqual([c.ok, c.unrecorded], [true, ["haiku"]]);
  c = compareBuckets({ opus: T(10, 100, 5, 40), sonnet: T(1, 0, 0, 1) }, { opus: R(10, 100, 5, 50) });
  assert.deepEqual([c.ok, c.above], [false, ["sonnet: 2 tokens in the transcript, none on the receipt"]]);
  c = compareBuckets({ "(unlabeled)": T(1, 0, 0, 1) }, {});
  assert.match(c.above[0], /no model name/);
  // Degenerate case: no input or cache tokens on either side leaves output as the only evidence, so it must match exactly.
  c = compareBuckets({ opus: T(0, 0, 0, 40) }, { opus: R(0, 0, 0, 50) });
  assert.deepEqual([c.ok, c.short], [false, ["opus output: transcript 40 < receipt 50 (no input or cache tokens on either side, so output alone must match)"]]);
  c = compareBuckets({ opus: T(0, 0, 0, 50) }, { opus: R(0, 0, 0, 50) });
  assert.equal(c.ok, true);
});
