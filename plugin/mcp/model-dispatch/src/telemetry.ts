/**
 * Telemetry — append-only JSONL writer + rollup builder for manifest.json.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEvent } from "./types.js";

export function appendEvent(jsonlPath: string, ev: TelemetryEvent): void {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, JSON.stringify(ev) + "\n", "utf-8");
}

/**
 * Normalize an event handed to us by a model rather than measured by this
 * server (the direct tier — orchestrator phases that never pass through
 * `execute_with_model`). A model has no clock, so its `ts` and `latency_ms`
 * are invented. Stamp arrival time server-side and record latency as null
 * (the honest value — this server never saw the call). `buildManifest` sorts
 * by `ts` to derive run duration, so placeholder timestamps would corrupt it.
 */
export function normalizeDirectTierEvent(
  ev: TelemetryEvent,
  now: Date = new Date(),
): TelemetryEvent {
  return {
    ...ev,
    ts: now.toISOString(),
    latency_ms: null,
    // Direct-tier events are char-count estimates by construction (vendor-
    // measured numbers only ever come from execute_with_model, which never
    // routes through here). A model that forgets the stamp must not cause
    // the report to disown the event as "unknown"; an explicit stamp is
    // passed through untouched.
    provenance: ev.provenance ?? "estimated",
  };
}

export function readEvents(jsonlPath: string): TelemetryEvent[] {
  if (!existsSync(jsonlPath)) return [];
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as TelemetryEvent);
}

export interface Manifest {
  pass: string;
  policy_name: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  /**
   * DISPATCHED-WORK cost only — the calls this server (or log_telemetry)
   * saw. The orchestrator's own loop never passes through the MCP server,
   * so its cost is NOT here; it lives in `orchestrator_overhead` when the
   * post-run collector has run, and `true_total_cost_usd` is the sum. Kept
   * dispatched-only (rather than silently growing) so every consumer that
   * ever read this field keeps meaning the same thing.
   */
  total_cost_usd: number;
  total_input_tokens: number;
  total_input_tokens_cached: number;
  /** Dispatched-work cache-write tokens. Absent on manifests built before the bucket existed. */
  total_input_tokens_cache_write?: number;
  total_output_tokens: number;
  /**
   * The run's own overhead — reasoning, file reads, growing-conversation
   * re-sends — reconstructed from session transcripts by
   * collect-orchestrator-usage.mjs. Present only after the collector runs;
   * derived from `tier: "orchestrator"` events, which buildManifest
   * PARTITIONS OUT of every dispatched sum above so the two spends are
   * never blended silently.
   */
  orchestrator_overhead?: {
    cost_usd: number;
    input_tokens: number;
    input_tokens_cached: number;
    input_tokens_cache_write: number;
    /** 1-hour-TTL share of input_tokens_cache_write (2x input); absent before the tier split. */
    input_tokens_cache_write_1h?: number;
    output_tokens: number;
    events: number;
    provenance: "transcript";
    /** Which model's rate priced the overhead, in words. */
    pricing_basis?: string;
    /**
     * How cost_usd was arrived at, in words; the report matches on the prefix.
     * "receipt (transcript agrees, ±x%)" — every token bucket in the window
     * equals the CLI's own receipt, so the receipt's dollars are booked;
     * "receipt-only"; "transcript (receipt covers only the last invocation,
     * verified ±x%; N earlier invocation(s) unverified)"; "transcript (receipt
     * pending; provisional)"; "transcript (no receipt; unverified)". A
     * "; approximate window" suffix marks a window anchored without the run's
     * own command turn.
     */
    cost_source?: string;
    /** The transcript-priced figure, kept beside cost_usd when a receipt supplied or verified it. */
    transcript_cost_usd?: number | null;
    /** Claude Code's own end-of-session total for the driver session, when a receipt was found. */
    receipt_cost_usd?: number | null;
    receipt_path?: string | null;
    /**
     * The window the collector measured: ISO bounds (end null = the end of the
     * session file), the anchor each bound came from, whether both were exact,
     * and the session file the scan was pinned to (null = every file scanned).
     */
    window?: { start: string; end: string | null; start_anchor: string; end_anchor: string; exact: boolean; session_id: string | null };
    /** Dispatched dollars that ran inside the session and were subtracted once from true_total_cost_usd. */
    dispatched_in_session_cost_usd?: number;
    dispatched_in_session_events?: number;
  };
  /**
   * total_cost_usd − orchestrator_overhead.dispatched_in_session_cost_usd +
   * orchestrator_overhead.cost_usd. Present only alongside the block. Before
   * the in-session field existed it was the plain sum.
   */
  true_total_cost_usd?: number;
  model_breakdown: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  /** Older manifests without token fields still load; dashboard falls back. */
  phase_breakdown: Record<string, {
    calls: number;
    cost_usd: number;
    models: string[];
    input_tokens?: number;
    input_tokens_cached?: number;
    output_tokens?: number;
    by_model?: Record<string, {
      calls: number;
      cost_usd: number;
      input_tokens: number;
      input_tokens_cached: number;
      output_tokens: number;
    }>;
  }>;
  module_breakdown: Record<string, { calls: number; cost_usd: number }>;
  task_type_breakdown: Record<string, { calls: number; cost_usd: number }>;
  artifacts?: { files: number; loc: number; tests: number; test_pass_rate: number };
  quality_scores?: Record<string, number>;
}

export function buildManifest(allEvents: TelemetryEvent[], opts: {
  pass: string;
  policy_name: string;
  artifacts?: Manifest["artifacts"];
}): Manifest {
  if (allEvents.length === 0) {
    const now = new Date().toISOString();
    return emptyManifest(opts.pass, opts.policy_name, now);
  }
  // Partition FIRST: orchestrator-overhead events (post-run transcript
  // reconstruction, tier: "orchestrator") never enter the dispatched sums
  // or breakdowns below. This is the structural guarantee that re-deriving
  // a manifest from collector-touched telemetry can't blend the two spends.
  const events = allEvents.filter((ev) => ev.tier !== "orchestrator");
  const orchEvents = allEvents.filter((ev) => ev.tier === "orchestrator");
  // Run window comes from dispatched events (the collector's event is
  // stamped at collection time, after the run); overhead-only input is a
  // degenerate case where the overhead event is the only clock we have.
  const windowSource = events.length > 0 ? events : orchEvents;
  const sorted = windowSource.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0].ts;
  const ended_at = sorted[sorted.length - 1].ts;
  const duration_sec = Math.max(
    1,
    Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000)
  );

  const model_breakdown: Manifest["model_breakdown"] = {};
  const phase_breakdown: Manifest["phase_breakdown"] = {};
  const module_breakdown: Manifest["module_breakdown"] = {};
  const task_type_breakdown: Manifest["task_type_breakdown"] = {};
  let total_cost_usd = 0,
    total_input_tokens = 0,
    total_input_tokens_cached = 0,
    total_input_tokens_cache_write = 0,
    total_output_tokens = 0;

  for (const ev of events) {
    total_cost_usd += ev.cost_usd;
    total_input_tokens += ev.input_tokens;
    total_input_tokens_cached += ev.input_tokens_cached;
    total_input_tokens_cache_write += ev.input_tokens_cache_write ?? 0;
    total_output_tokens += ev.output_tokens;

    const mb = (model_breakdown[ev.model] ??= {
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
    mb.calls++;
    mb.cost_usd += ev.cost_usd;
    mb.input_tokens += ev.input_tokens;
    mb.output_tokens += ev.output_tokens;

    const pb = (phase_breakdown[ev.phase] ??= {
      calls: 0, cost_usd: 0, models: [],
      input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
      by_model: {},
    });
    pb.calls++;
    pb.cost_usd += ev.cost_usd;
    pb.input_tokens = (pb.input_tokens ?? 0) + ev.input_tokens;
    pb.input_tokens_cached = (pb.input_tokens_cached ?? 0) + ev.input_tokens_cached;
    pb.output_tokens = (pb.output_tokens ?? 0) + ev.output_tokens;
    if (!pb.models.includes(ev.model)) pb.models.push(ev.model);
    const pbm = ((pb.by_model ??= {})[ev.model] ??= {
      calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0,
    });
    pbm.calls++;
    pbm.cost_usd += ev.cost_usd;
    pbm.input_tokens += ev.input_tokens;
    pbm.input_tokens_cached += ev.input_tokens_cached;
    pbm.output_tokens += ev.output_tokens;

    const modb = (module_breakdown[ev.module] ??= { calls: 0, cost_usd: 0 });
    modb.calls++;
    modb.cost_usd += ev.cost_usd;

    const tb = (task_type_breakdown[ev.task_type] ??= { calls: 0, cost_usd: 0 });
    tb.calls++;
    tb.cost_usd += ev.cost_usd;
  }

  const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  total_cost_usd = r6(total_cost_usd);
  for (const k of Object.keys(model_breakdown))
    model_breakdown[k].cost_usd = r6(model_breakdown[k].cost_usd);
  for (const k of Object.keys(phase_breakdown)) {
    phase_breakdown[k].cost_usd = r6(phase_breakdown[k].cost_usd);
    const bm = phase_breakdown[k].by_model;
    if (bm) for (const mk of Object.keys(bm)) bm[mk].cost_usd = r6(bm[mk].cost_usd);
  }
  for (const k of Object.keys(module_breakdown))
    module_breakdown[k].cost_usd = r6(module_breakdown[k].cost_usd);
  for (const k of Object.keys(task_type_breakdown))
    task_type_breakdown[k].cost_usd = r6(task_type_breakdown[k].cost_usd);

  // The overhead block + true total exist ONLY when overhead events exist —
  // a manifest rebuilt from untouched telemetry is byte-compatible with one
  // built before this field existed.
  let orchestrator_overhead: Manifest["orchestrator_overhead"];
  let true_total_cost_usd: number | undefined;
  if (orchEvents.length > 0) {
    orchestrator_overhead = {
      cost_usd: r6(orchEvents.reduce((s, ev) => s + ev.cost_usd, 0)),
      input_tokens: orchEvents.reduce((s, ev) => s + ev.input_tokens, 0),
      input_tokens_cached: orchEvents.reduce((s, ev) => s + ev.input_tokens_cached, 0),
      input_tokens_cache_write: orchEvents.reduce((s, ev) => s + (ev.input_tokens_cache_write ?? 0), 0),
      output_tokens: orchEvents.reduce((s, ev) => s + ev.output_tokens, 0),
      events: orchEvents.length,
      provenance: "transcript",
    };
    true_total_cost_usd = r6(total_cost_usd + orchestrator_overhead.cost_usd);
  }

  return {
    pass: opts.pass,
    policy_name: opts.policy_name,
    started_at,
    ended_at,
    duration_sec,
    total_cost_usd,
    total_input_tokens,
    total_input_tokens_cached,
    total_input_tokens_cache_write,
    total_output_tokens,
    orchestrator_overhead,
    true_total_cost_usd,
    model_breakdown,
    phase_breakdown,
    module_breakdown,
    task_type_breakdown,
    artifacts: opts.artifacts,
  };
}

function emptyManifest(pass: string, policy_name: string, ts: string): Manifest {
  return {
    pass,
    policy_name,
    started_at: ts,
    ended_at: ts,
    duration_sec: 0,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_input_tokens_cached: 0,
    total_output_tokens: 0,
    model_breakdown: {},
    phase_breakdown: {},
    module_breakdown: {},
    task_type_breakdown: {},
  };
}

export function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}
