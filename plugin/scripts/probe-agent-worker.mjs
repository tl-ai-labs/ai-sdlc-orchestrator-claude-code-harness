#!/usr/bin/env node
/**
 * probe-agent-worker.mjs — spends about two cents to prove the agent path
 * actually works, before a run spends real money finding out it does not.
 *
 * WHY THIS IS SEPARATE FROM verify-setup.mjs. That script answers "is
 * everything installed" and is deliberately, completely offline: it never reads
 * a credential and never makes a call, which is what makes it safe to run on
 * any machine at any time. Three of the agent path's failure modes are
 * invisible to it, because none of them is a missing file:
 *
 *   1. The Antigravity SDK needs a Gemini Enterprise / Model Garden entitlement
 *      on the billing project that the plain Vertex path does not. Without it
 *      every delegation returns 403.
 *   2. `gemini-3.5-flash` is not deployed in every region. A pinned region that
 *      does not serve the model returns 404.
 *   3. Application Default Credentials can exist on disk, be readable, name a
 *      project — and still be expired, or belong to a project with the Vertex
 *      API switched off.
 *
 * All three surface identically today: the run starts, requirements, design and
 * task planning are billed to the premium tier, and the FIRST delegated packet
 * fails. That is the most expensive possible moment to learn it. This script
 * moves that discovery to second zero, for the price of one trivial delegation
 * — the multi-thousand-token session preamble the SDK sends whatever you ask
 * it. Measured on 2026-08-05 against `gemini-3.5-flash` on the global endpoint:
 * 12,245 input and 154 output tokens, $0.0198 at the policy's pinned rates.
 * That is the floor of this path and it does not vary much, because almost all
 * of it is the preamble rather than the question.
 *
 * WHAT IT DOES NOT DO. It does not mock, stub, or shortcut. It loads the real
 * policy, constructs the real adapter, and runs one real delegation through the
 * same `execute()` path a run uses — in a temporary, empty workspace, so the
 * agent has nothing to damage and nothing to read. Anything it reports about
 * project, region, interpreter, tokens or price is what a run would do, because
 * it is the same code arriving at the same answer.
 *
 * WHY IT LIVES IN plugin/scripts/. The same reason verify-setup.mjs does: it
 * has to be reachable from both install routes. Someone who ran
 * `/plugin install` has no `tools/` directory — only what is inside the plugin.
 *
 * Usage:
 *   node probe-agent-worker.mjs                  # opus-plus-flash
 *   node probe-agent-worker.mjs --policy=<name>  # any policy with an agent leaf
 *
 * Exit 0 means a delegation completed and was priced. Exit 1 means it did not,
 * with the reason named in words rather than as a vendor status code.
 */

import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── pure helpers (unit-tested; no filesystem, no network, no process state) ──

/**
 * The adapter string that means "reach this model as an agent".
 *
 * The probe finds its leaf by ADAPTER rather than by model id, unlike
 * verify-setup.mjs's `AGENT_WORKER_MODEL_ID`. The two are asking different
 * questions. That script asks "did this install SELECT the agent path", which
 * is a question about one specific leaf named in `SDLC_SELECT`. This one asks
 * "does the agent path work at all", which is true or false regardless of what
 * any leaf happens to be called — so it matches on the thing that is actually
 * structural, and keeps working if the leaf is ever renamed or a second one is
 * added.
 */
export const AGENT_ADAPTER = "antigravity-worker";

/**
 * Pick the leaf to probe out of a loaded policy.
 *
 * Deliberately refuses on more than one rather than picking the first. A policy
 * with two agent leaves is a policy where "does the agent path work" has two
 * answers — different models, possibly different regions — and reporting one of
 * them as THE answer would be a lie by omission. Naming one explicitly is a
 * flag away and takes a second; a wrong green light costs a whole run.
 */
export function agentLeafFrom(policy) {
  const leaves = (policy?.models ?? []).filter((m) => m.adapter === AGENT_ADAPTER);
  if (leaves.length === 0) {
    throw new Error(
      `Policy '${policy?.name ?? "?"}' declares no agent-worker leaf ` +
        `(no model with adapter: ${AGENT_ADAPTER}), so there is nothing here to probe. ` +
        `The shipped policy that has one is opus-plus-flash.`
    );
  }
  if (leaves.length > 1) {
    throw new Error(
      `Policy '${policy.name}' declares ${leaves.length} agent-worker leaves ` +
        `(${leaves.map((m) => m.id).join(", ")}). Probe one at a time with --model=<id>.`
    );
  }
  return leaves[0];
}

/** Same selection, narrowed by an explicit `--model=<id>`. */
export function agentLeafById(policy, modelId) {
  const leaf = (policy?.models ?? []).find((m) => m.id === modelId);
  if (!leaf) {
    throw new Error(
      `Policy '${policy?.name ?? "?"}' declares no model '${modelId}'. ` +
        `Declared: ${(policy?.models ?? []).map((m) => m.id).join(", ") || "none"}.`
    );
  }
  if (leaf.adapter !== AGENT_ADAPTER) {
    throw new Error(
      `Model '${modelId}' uses adapter '${leaf.adapter}', not '${AGENT_ADAPTER}'. ` +
        `This probe only exercises the agent path; the model path is covered by preflight_dispatch.`
    );
  }
  return leaf;
}

/**
 * The smallest thing that is still a real delegation.
 *
 * There is no such thing as a cheap agent session — the SDK sends its tool and
 * identity preamble on every turn whatever you ask — so the only lever is the
 * number of TURNS. Hence an instruction that forbids tool use and asks for one
 * JSON object: one turn, one answer, and the floor price of the path. The
 * packet is otherwise an ordinary TaskPacket, because an artificial shape would
 * exercise an artificial code path.
 *
 * `phase: "docs"` because it is the most harmless phase in the union and the
 * policy routes it to the mechanical tier — the probe never asks the router
 * anything, but a reader who finds this packet in a receipt should not have to
 * wonder why a probe claimed to be codegen.
 */
export function probePacket(passId = "probe") {
  return {
    id: `tp_probe_${passId}`,
    phase: "docs",
    task_type: "connectivity_probe",
    module: "cross",
    instruction:
      "Reply with exactly this JSON object and nothing else: {\"ok\": true}. " +
      "Do not read any file, do not write any file, and do not run any command. " +
      "This is a connectivity check, not a task.",
    inputs: [],
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    acceptance: ["Returns {\"ok\": true}", "Touches nothing in the working directory"],
    budget: { maxInputTokens: 4000, maxOutputTokens: 256 },
    pass_id: passId,
  };
}

/**
 * Turn a worker failure into the sentence a human can act on.
 *
 * The raw text is a Python traceback tail carrying a Google API status. Left
 * alone it tells the reader that something returned 403, which is true and
 * useless — the fix for a 403 here is an entitlement request that takes days,
 * and the fix for a 404 is one environment variable. Conflating them wastes
 * whichever of those the reader guesses wrong.
 *
 * Ordered most-specific first: a missing SDK import and a credentials error can
 * both mention words that appear in the broader patterns below them.
 */
export function classifyFailure(errorText) {
  const text = String(errorText ?? "");
  const has = (...needles) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()));

  if (has("No module named 'google.antigravity'", "No module named \"google.antigravity\"")) {
    return {
      id: "sdk-missing",
      headline: "The Antigravity SDK is not installed in the interpreter that ran the worker.",
      fix: "node <plugin>/scripts/verify-setup.mjs --fix (builds the worker virtualenv and installs it)",
    };
  }
  if (has("DefaultCredentialsError", "could not automatically determine credentials", "default credentials were not found")) {
    return {
      id: "adc-missing",
      headline: "No Application Default Credentials reached the worker process.",
      fix: "gcloud auth application-default login   (then re-run this probe)",
    };
  }
  if (has("invalid_grant", "reauth", "credentials do not contain", "token has been expired", "invalid_rapt")) {
    return {
      id: "adc-stale",
      headline: "Application Default Credentials exist but are no longer valid.",
      fix: "gcloud auth application-default login   (re-authenticates the same account)",
    };
  }
  if (has("403", "PERMISSION_DENIED", "does not have access", "permission to access")) {
    return {
      id: "entitlement",
      headline:
        "Vertex refused the call (403). On this path that almost always means the billing " +
        "project lacks the Gemini Enterprise / Model Garden entitlement the Antigravity SDK " +
        "requires — the plain model path can work on a project where this one does not.",
      fix:
        "Request the entitlement for this project, or run the mechanical tier as a model " +
        "instead of an agent (unset SDLC_SELECT, or set gemini-flash=flash-completion).",
    };
  }
  if (has("404", "NOT_FOUND", "was not found", "is not supported", "not available in")) {
    return {
      id: "region",
      headline:
        "Vertex could not find the model (404). The model is not deployed in the region this " +
        "leaf resolved to — the region, not the model name, is nearly always what is wrong.",
      fix:
        "Unset GOOGLE_CLOUD_LOCATION to use the global endpoint, or pin a region that serves " +
        "this model on the policy leaf's `region:` field.",
    };
  }
  if (has("429", "RESOURCE_EXHAUSTED", "quota")) {
    return {
      id: "quota",
      headline: "Vertex returned a quota error (429). The path is wired correctly; capacity is not there right now.",
      fix: "Retry later, or raise the quota for this model in the project's Vertex AI quotas page.",
    };
  }
  if (has("was killed after", "timed out", "TimeoutError")) {
    return {
      id: "timeout",
      headline:
        "The worker did not finish in time. For a one-turn probe this points at the session " +
        "never starting rather than at a slow answer — a hung credential refresh looks like this.",
      fix: "Check network egress to *.googleapis.com, then re-run this probe.",
    };
  }
  return {
    id: "unknown",
    headline: "The delegation failed for a reason this probe does not recognise.",
    fix: "Read the worker output below; the exception is on the last line.",
  };
}

/** Dollars, at the precision a sub-cent probe actually needs. */
export function formatUsd(amount) {
  const n = Number(amount) || 0;
  if (n === 0) return "$0.000000";
  return `$${n.toFixed(6)}`;
}

/**
 * Say whether the rates a run will be billed at are the rates the policy pins.
 *
 * They differ by exactly the Vertex regional surcharge: +10% on every token
 * class for Gemini 3+ on a non-`global` endpoint. The pin stays honest and the
 * adapter adjusts, which means the number on the report and the number in the
 * YAML are allowed to disagree — and a reader who does not know that reads the
 * difference as a bug. So the probe states which of the two it is, in words,
 * every time.
 */
export function pricingNote(pinned, billed, region) {
  const same =
    pinned?.input === billed?.input &&
    pinned?.input_cached === billed?.input_cached &&
    pinned?.output === billed?.output;
  if (same) {
    return `billed at the policy's pinned rates (region '${region}' carries no surcharge)`;
  }
  return (
    `billed at the pinned rates plus the Vertex regional surcharge, because this leaf runs in ` +
    `'${region}' rather than the global endpoint: in $${pinned.input}/$${pinned.input_cached}/$${pinned.output} ` +
    `→ $${billed.input}/$${billed.input_cached}/$${billed.output} per million (input/cached/output)`
  );
}

/** `--flag=value` out of an argv, so the parsing is testable without a process. */
export function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

// ─── the live probe (everything below touches the network and the disk) ──────

/**
 * Import the built server modules.
 *
 * A dynamic import behind an `existsSync`, rather than a static one at the top,
 * because an unbuilt plugin is the single commonest state this script will be
 * run in — `/plugin install` does not build — and a raw ERR_MODULE_NOT_FOUND
 * stack tells the reader nothing about which of the two scripts fixes it.
 */
async function loadServerModules(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "gemini-flash-server");
  const distPolicy = join(serverDir, "dist", "policy.js");
  const distAdapters = join(serverDir, "dist", "adapters", "index.js");
  if (!existsSync(distPolicy) || !existsSync(distAdapters)) {
    throw new Error(
      `The bundled server is not built, so there is no adapter to probe with. ` +
        `Run: node ${join(pluginRoot, "scripts", "verify-setup.mjs")} --fix`
    );
  }
  const [{ loadPolicy }, { createAdapter }] = await Promise.all([
    import(`file://${distPolicy}`),
    import(`file://${distAdapters}`),
  ]);
  return { loadPolicy, createAdapter };
}

/**
 * A workspace that is empty, temporary, and NOT the user's project.
 *
 * The agent is handed `policies=[allow_all()]` and a working directory it may
 * edit. On a probe there is nothing to gain from pointing that at real files
 * and everything to lose, so it gets a fresh temp directory with nothing in it.
 * The evidence directory is a SIBLING rather than a child, which keeps the
 * workspace genuinely empty — so if the delegation's file-change inventory
 * reports anything at all, the agent really did write it, and the probe can say
 * so plainly.
 */
function makeProbeDirs() {
  const root = mkdtempSync(join(tmpdir(), "sdlc-agent-probe-"));
  const workspace = join(root, "workspace");
  const evidence = join(root, "evidence");
  mkdirSync(workspace);
  mkdirSync(evidence);
  return { root, workspace, evidence };
}

async function main() {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const argv = process.argv.slice(2);
  const policyName = readFlag(argv, "policy") ?? "opus-plus-flash";
  const modelId = readFlag(argv, "model");
  const log = (m = "") => console.log(m);

  log("\nAI-SDLC orchestrator — agent-worker probe");
  log("  One trivial delegation, in an empty temporary workspace, at real cost.\n");

  const { loadPolicy, createAdapter } = await loadServerModules(pluginRoot);
  const policy = loadPolicy({ policyName });
  const leaf = modelId ? agentLeafById(policy, modelId) : agentLeafFrom(policy);

  // Construction is itself a gate: this adapter's constructor resolves the GCP
  // project, the worker script and the interpreter, and throws on any of them.
  // Everything it can catch, it catches here — before a subprocess exists and
  // therefore before a token is spent.
  const adapter = createAdapter(leaf);

  log(`  policy      ${policy.name}`);
  log(`  model leaf  ${leaf.id} → ${leaf.model_name}`);
  log(`  project     ${adapter.project}`);
  log(`  region      ${adapter.location}`);
  log(`  interpreter ${adapter.python}`);
  log(`  rates       ${pricingNote(leaf.pricing, adapter.billedPricing, adapter.location)}`);
  if (leaf.pricing_source) log(`  pinned from ${leaf.pricing_source}`);
  if (leaf.pricing_last_verified) log(`  verified    ${leaf.pricing_last_verified}`);

  const dirs = makeProbeDirs();
  log(`\n  workspace   ${dirs.workspace}  (empty, temporary)`);
  log(`  evidence    ${dirs.evidence}`);
  log("\n  Delegating…");

  const result = await adapter.execute(probePacket(), undefined, {
    work_dir: dirs.workspace,
    telemetry_path: join(dirs.evidence, "telemetry.jsonl"),
  });

  const { input, input_cached, output } = result.tokens;
  log(
    `\n  tokens      ${input} input, ${input_cached} cached, ${output} output ` +
      `(in ${(result.latency_ms / 1000).toFixed(1)}s)`
  );
  log(`  cost        ${formatUsd(result.cost_usd)}`);

  if (result.success) {
    log("\n  ✓ The agent path works. A run selecting this leaf will dispatch, bill and be priced.");
    log(`    Answer: ${JSON.stringify(result.result)}`);
    log(`\n  Delete the probe directory when you are done with it: ${dirs.root}\n`);
    return 0;
  }

  const verdict = classifyFailure(result.error);
  log(`\n  ✗ ${verdict.headline}`);
  log(`    fix: ${verdict.fix}`);
  // Printed even when the classification is confident: the classification is a
  // reading of this text, and a reader who disagrees with it needs the source.
  log(`\n  Worker output:\n    ${String(result.error ?? "").split("\n").join("\n    ")}`);
  log(`\n  Evidence kept at: ${dirs.evidence}\n`);
  return 1;
}

// Run only when executed directly, so the pure helpers above can be imported by
// the test suite without spending anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  ✗ ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
