#!/usr/bin/env node
/**
 * collect-orchestrator-usage — reconstruct the run's OWN cost from session
 * transcripts and record it beside (never inside) the dispatched-work totals.
 *
 * The problem this closes: the orchestrator runs as a Claude Code session;
 * its own loop — reasoning, Read/Glob/Bash tool calls, re-sending the growing
 * conversation every turn — never passes through the MCP dispatch server, so
 * it is invisible to telemetry in BOTH auth modes. On real measured runs the
 * plugin reported $1.87 while the session transcripts summed to ≈$236: a
 * ~100× undercount, large enough to INVERT architecture comparisons drawn
 * from dispatched-only numbers. This tool sums the transcripts post-run and
 * appends one `tier: "orchestrator"` event to the run's telemetry, then
 * patches the manifest with an `orchestrator_overhead` block and a
 * `true_total_cost_usd` — leaving `total_cost_usd` dispatched-only, so the
 * two spends are never blended silently.
 *
 * Method, and the facts it rests on (verified against a real 52,985-line
 * session transcript before this tool was written):
 *
 *   1. WHERE: transcripts live in ~/.claude/projects/<hash>/*.jsonl where
 *      <hash> is the absolute project path with `/` and whitespace replaced
 *      by `-`; each session may also have <hash>/<sessionId>/subagents/*.jsonl.
 *      Driver subagents run in-session, so their transcripts count too — all
 *      in-session work is driver-tier work by construction (the plugin ships
 *      only the five driver agents).
 *   2. WHAT: every `"type": "assistant"` line carries `message.usage` with
 *      `input_tokens`, `cache_read_input_tokens`,
 *      `cache_creation_input_tokens`, `output_tokens` — and `message.model`.
 *   3. DEDUPE — the critical one: one API message is written as SEVERAL
 *      JSONL lines (one per content block), each repeating the same
 *      `message.id` and IDENTICAL usage. On the reference transcript 5,218
 *      of 7,203 message ids appeared more than once — naive per-line summing
 *      roughly DOUBLES the cost. Each `message.id` is counted exactly once.
 *   4. EXCLUDE: `message.model === "<synthetic>"` lines are error
 *      placeholders fabricated by the CLI, not billed API traffic.
 *   5. WINDOW ANCHOR: run_id is NOT present in transcript metadata (checked
 *      empirically), so the run window is the manifest's
 *      `started_at`/`ended_at` ± 5 minutes slack, applied per-message via
 *      each line's `timestamp`. File-level pruning uses mtime with a LOWER
 *      bound only (mtime < window start − slack ⇒ the file's last write
 *      predates the run and it cannot contain run messages). There is
 *      deliberately NO mtime upper bound — a session that keeps going after
 *      the run would push mtime past the window and silently drop the run's
 *      own messages. This diverges from report.mjs's artifacts listing,
 *      which bounds mtime on both ends for a different purpose.
 *   6. PRICE: everything at the policy's DERIVED DRIVER MODEL rate (same
 *      derivation the run-start driver-model check uses — route every
 *      judgment phase, require one model), including the cache-write
 *      premium: cache writes dominate real driver-loop cost and are billed
 *      by Anthropic above the fresh-input rate (explicit
 *      `pricing.input_cache_write` when the policy declares one, else
 *      input × 1.25 — see src/pricing.ts). Transcripts do not carry dollars,
 *      only tokens, so a single-rate assumption is required; the observed
 *      per-model message counts are printed, and a WARNING is raised when
 *      any observed model differs from the model the run is priced at.
 *   7. IDEMPOTENT: re-running replaces the prior orchestrator event for
 *      this pass (telemetry.jsonl is rewritten atomically without any
 *      `tier: "orchestrator"` lines, then the fresh event is appended) and
 *      re-patches the manifest. Run it as many times as you like.
 *
 * Known overlap, stated rather than hidden: under `--auth=estimated` the
 * driver-tier judgment phases run in-session AND are logged to telemetry as
 * char-count estimates (`provenance: "estimated"`). The transcript sum
 * necessarily contains that same in-session work, so a true total that adds
 * both is conservative (double-counts the estimated portion). The tool
 * prints the run's estimated-event subtotal beside the overhead figure so a
 * reader can see the overlap's size; the measured transcript figure is the
 * honest one. Vendor-mode runs have no overlap — every dispatched call is an
 * out-of-session API call.
 *
 * This tool lives in plugin/scripts/ (not tools/) so it SHIPS with the
 * installed plugin — the orchestrator's run-end step invokes it via
 * ${CLAUDE_PLUGIN_ROOT}/scripts/, which a repo-only tools/ file could not
 * provide.
 *
 * Usage:
 *   node collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>]
 *        [--policy <name>] [--policy-path <file>]
 *        [--transcripts-dir <dir>] [--dry-run]
 *
 *   <pass-dir>          the run's output dir (holds manifest.json +
 *                       telemetry.jsonl), e.g. examples/<study>/passes/<run>
 *   --project-root      the repo the run was launched from. Defaults to the
 *                       current directory. This determines the transcript
 *                       location hash, so it must be the directory `claude`
 *                       ran in.
 *   --policy            policy name to price with. Defaults to the
 *                       manifest's `policy_name` — the policy the run
 *                       actually used.
 *   --policy-path       explicit policy file; beats --policy and the
 *                       repo-local override, mirroring the server's loader.
 *   --transcripts-dir   read transcripts from this directory instead of
 *                       ~/.claude/projects/<hash> (tests; or a transcript
 *                       tree copied from another machine).
 *   --dry-run           print everything, write nothing.
 *
 * Exit codes: 0 = event written (or --dry-run). 1 = bad arguments, missing
 * manifest, or no billable assistant messages found in the run window (the
 * run WAS driven by a session, so an empty window means the wrong
 * project-root/transcripts-dir — nothing is written).
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveDriverModel } from "./driver-model-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/** Same slack the report's artifacts window uses; applied per-message. */
const WINDOW_SLACK_MS = 5 * 60_000;

function parseArgs(argv) {
  const args = {
    passDir: undefined,
    projectRoot: undefined,
    policy: undefined,
    policyPath: undefined,
    transcriptsDir: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--project-root" || a.startsWith("--project-root=")) args.projectRoot = eat("--project-root");
    else if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else if (a === "--transcripts-dir" || a.startsWith("--transcripts-dir=")) args.transcriptsDir = eat("--transcripts-dir");
    else if (a.startsWith("--")) throw new Error(`unknown argument '${a}'`);
    else if (args.passDir === undefined) args.passDir = a;
    else throw new Error(`unexpected extra positional '${a}' (pass dir already given: ${args.passDir})`);
  }
  if (!args.passDir) throw new Error("usage: collect-orchestrator-usage.mjs <pass-dir> [--project-root <dir>] [--policy <name>] [--policy-path <file>] [--transcripts-dir <dir>] [--dry-run]");
  return args;
}

async function loadDist() {
  try {
    const policyMod = await import(pathToFileURL(join(DIST, "policy.js")).href);
    const routingMod = await import(pathToFileURL(join(DIST, "routing.js")).href);
    const pricingMod = await import(pathToFileURL(join(DIST, "pricing.js")).href);
    return { policyMod, routingMod, pricingMod };
  } catch (err) {
    throw new Error(
      `could not load the dispatch server's compiled modules from ${DIST} — the MCP ` +
        `server is not built. Fix: node "${join(HERE, "verify-setup.mjs")}" --fix ` +
        `--project-root "$(pwd)"  (original error: ${err.message})`
    );
  }
}

/** The CLI's transcript directory name for a project: path with / and whitespace → "-". */
export function transcriptsDirFor(projectRoot) {
  const hash = resolve(projectRoot).replace(/[\/\s]/g, "-");
  return join(homedir(), ".claude", "projects", hash);
}

/**
 * Every transcript file that COULD contain run-window messages: top-level
 * session *.jsonl plus each session's subagents/*.jsonl, pruned by the
 * mtime lower bound only (see header, fact 5).
 */
export function candidateTranscripts(dir, windowStartMs) {
  if (!existsSync(dir)) return [];
  const out = [];
  const fresh = (p) => {
    try { return statSync(p).mtimeMs >= windowStartMs - WINDOW_SLACK_MS; } catch { return false; }
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (fresh(p)) out.push(p);
    } else if (entry.isDirectory()) {
      const sub = join(p, "subagents");
      if (!existsSync(sub)) continue;
      for (const s of readdirSync(sub)) {
        const sp = join(sub, s);
        if (s.endsWith(".jsonl") && fresh(sp)) out.push(sp);
      }
    }
  }
  return out.sort();
}

/**
 * Sum billable usage across transcript files, deduped by message.id and
 * windowed per-message. Returns token buckets + scan stats + the observed
 * model → unique-message-count map.
 */
export function sumTranscriptUsage(files, windowStartMs, windowEndMs) {
  const seen = new Set();
  const observedModels = {};
  const tokens = { input: 0, input_cached: 0, input_cache_write: 0, output: 0 };
  const stats = { files: files.length, lines: 0, assistant: 0, counted: 0, duplicates: 0, synthetic: 0, outside_window: 0 };
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      stats.lines++;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type !== "assistant") continue;
      stats.assistant++;
      const msg = obj.message;
      const usage = msg?.usage;
      if (!usage) continue;
      if (msg.model === "<synthetic>") { stats.synthetic++; continue; }
      if (obj.timestamp) {
        const t = Date.parse(obj.timestamp);
        if (Number.isFinite(t) && (t < windowStartMs - WINDOW_SLACK_MS || t > windowEndMs + WINDOW_SLACK_MS)) {
          stats.outside_window++;
          continue;
        }
      }
      // One API message = many JSONL lines (one per content block), all
      // repeating the same id and the same usage — count each id ONCE.
      if (msg.id) {
        if (seen.has(msg.id)) { stats.duplicates++; continue; }
        seen.add(msg.id);
      }
      stats.counted++;
      const model = msg.model ?? "(unlabeled)";
      observedModels[model] = (observedModels[model] ?? 0) + 1;
      tokens.input += usage.input_tokens ?? 0;
      tokens.input_cached += usage.cache_read_input_tokens ?? 0;
      tokens.input_cache_write += usage.cache_creation_input_tokens ?? 0;
      tokens.output += usage.output_tokens ?? 0;
    }
  }
  return { tokens, stats, observedModels };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const passDir = resolve(args.passDir);
  const manifestPath = join(passDir, "manifest.json");
  const telemetryPath = join(passDir, "telemetry.jsonl");
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest.json in ${passDir} — is this a run's pass directory?`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const windowStartMs = Date.parse(manifest.started_at);
  const windowEndMs = Date.parse(manifest.ended_at);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    throw new Error(`manifest.json has no parseable started_at/ended_at — cannot anchor the run window`);
  }

  const { policyMod, routingMod, pricingMod } = await loadDist();
  const projectRoot = resolve(args.projectRoot ?? process.cwd());
  // Default to the policy the run recorded — pricing overhead under any
  // other policy would attribute dollars the run never saw.
  const policy = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: args.policy ?? manifest.policy_name, projectRoot });
  const overrides = routingMod.parseSelectOverrides(process.env.MMO_SELECT);
  const derived = deriveDriverModel(policy, routingMod, overrides);
  const driver = policy.models.find((m) => m.id === derived.modelId);

  const tDir = args.transcriptsDir ? resolve(args.transcriptsDir) : transcriptsDirFor(projectRoot);
  const files = candidateTranscripts(tDir, windowStartMs);
  const { tokens, stats, observedModels } = sumTranscriptUsage(files, windowStartMs, windowEndMs);

  console.log(`collect-orchestrator-usage: pass '${manifest.pass}' window ${manifest.started_at} → ${manifest.ended_at} (±5m)`);
  console.log(`transcripts: ${tDir}`);
  console.log(
    `scanned ${stats.files} file(s), ${stats.lines} line(s): counted ${stats.counted} unique API message(s) ` +
      `(${stats.duplicates} duplicate content-block line(s) skipped, ${stats.synthetic} synthetic, ${stats.outside_window} outside window)`
  );
  console.log(`observed_models ${JSON.stringify(observedModels)}`);

  if (stats.counted === 0) {
    console.error(
      `collect-orchestrator-usage FAILED: no billable assistant messages found in the run window. ` +
        `The run was driven by a session, so this almost always means the wrong --project-root ` +
        `(transcript location is derived from it) or a transcript tree that lives elsewhere ` +
        `(--transcripts-dir). Nothing was written.`
    );
    return 1;
  }

  const mismatched = Object.keys(observedModels).filter((m) => m !== derived.modelName && m !== "(unlabeled)");
  if (mismatched.length > 0) {
    console.error(
      `WARNING: transcript messages ran on ${JSON.stringify(mismatched)} but the overhead is priced ` +
        `at the policy's driver model '${derived.modelName}' — the dollars below assume a single rate. ` +
        `If the mismatch is the driver itself, the run-start driver-model check should have caught it.`
    );
  }

  const cost = pricingMod.computeCostUsd(tokens, driver.pricing);
  const event = {
    ts: new Date().toISOString(),
    pass: manifest.pass,
    phase: "orchestrator_overhead",
    task_type: "orchestrator_overhead",
    task_id: `orchestrator-overhead-${manifest.pass}`,
    module: "orchestrator",
    model: derived.modelName,
    model_id: derived.modelId,
    routed_by: "orchestrator",
    provenance: "transcript",
    tier: "orchestrator",
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: -1,
      rule_reason: "orchestrator overhead — reconstructed from session transcripts, priced at the derived driver model",
    },
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    output_tokens: tokens.output,
    cost_usd: cost,
    latency_ms: null,
    success: true,
    retry_count: 0,
  };

  const trueTotal = pricingMod.round6((manifest.total_cost_usd ?? 0) + cost);
  console.log(
    `overhead: in ${tokens.input} + cached ${tokens.input_cached} + cache_write ${tokens.input_cache_write} ` +
      `+ out ${tokens.output} tokens @ '${derived.modelName}' = $${cost}`
  );
  console.log(`dispatched total $${manifest.total_cost_usd ?? 0} → true total $${trueTotal}`);

  // Estimated-mode overlap, surfaced not hidden (see header).
  if (existsSync(telemetryPath)) {
    const estimated = readFileSync(telemetryPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((ev) => ev && ev.provenance === "estimated" && ev.tier !== "orchestrator");
    if (estimated.length > 0) {
      const estCost = pricingMod.round6(estimated.reduce((s, ev) => s + (ev.cost_usd ?? 0), 0));
      console.log(
        `note: this run has ${estimated.length} estimated direct-tier event(s) totaling $${estCost}; ` +
          `that in-session work is also inside the transcript-measured overhead, so the true total ` +
          `is conservative by up to that amount.`
      );
    }
  }

  if (args.dryRun) {
    console.log("dry-run: nothing written.");
    return 0;
  }

  // Replace-on-rerun: rewrite telemetry without any prior orchestrator
  // event, append the fresh one, then atomically swap. A crash mid-write
  // can never leave a half-written telemetry.jsonl behind.
  const existing = existsSync(telemetryPath)
    ? readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean)
    : [];
  const kept = existing.filter((l) => {
    try { return JSON.parse(l).tier !== "orchestrator"; } catch { return true; }
  });
  kept.push(JSON.stringify(event));
  const tmpT = `${telemetryPath}.tmp-collect`;
  writeFileSync(tmpT, kept.join("\n") + "\n", "utf-8");
  renameSync(tmpT, telemetryPath);

  manifest.orchestrator_overhead = {
    cost_usd: cost,
    input_tokens: tokens.input,
    input_tokens_cached: tokens.input_cached,
    input_tokens_cache_write: tokens.input_cache_write,
    output_tokens: tokens.output,
    events: 1,
    provenance: "transcript",
  };
  manifest.true_total_cost_usd = trueTotal;
  const tmpM = `${manifestPath}.tmp-collect`;
  writeFileSync(tmpM, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmpM, manifestPath);

  console.log(`written: 1 orchestrator event → ${telemetryPath}; manifest patched with orchestrator_overhead + true_total_cost_usd.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`collect-orchestrator-usage FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
