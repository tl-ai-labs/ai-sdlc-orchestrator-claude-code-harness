#!/usr/bin/env node
/**
 * driver-model-check — verify the estimated-mode driver tier will actually run
 * on the model the policy prices it at.
 *
 * The problem this closes: under `--auth=estimated` the premium-judgment tier
 * is not dispatched through the MCP server — it runs *in this Claude Code
 * session* as the five driver subagents (orchestrator, architect, discovery,
 * senior-reviewer, security-reviewer). Which model those subagents execute on
 * is decided by Claude Code itself, from the `CLAUDE_CODE_SUBAGENT_MODEL`
 * environment variable (field-verified to take precedence over agent
 * frontmatter). The policy YAML's driver `model_name` is only used to PRICE
 * that work. When the two disagree, every driver-tier dollar in the report is
 * attributed to a model that never ran.
 *
 * Two facts shape the mechanism:
 *
 *   1. The env var must be set BEFORE the `claude` process launches. A Bash
 *      `export` issued mid-session runs in a child shell and dies with it —
 *      it can never reach the CLI process's environment. So this script does
 *      not try to fix anything; it verifies, and on failure prints the exact
 *      export line so the user can relaunch correctly.
 *   2. The driver model must be derived by the SAME routing code the dispatch
 *      server uses. Re-implementing rule matching here (the line-scanning
 *      style the other setup scripts use to stay dependency-free) could
 *      disagree with the real router — which is precisely the defect class
 *      this check exists to prevent. So this script imports pickModel /
 *      loadPolicy from ../mcp/model-dispatch/dist/, which is guaranteed built
 *      before any run (verify-setup.mjs --fix / /mmo:setup step 1).
 *
 * Derivation: route every judgment phase through the policy and require them
 * all to land on one model. A single env var cannot honor a policy that
 * splits the judgment tier across models, so disagreement is an error, not a
 * majority vote (meeting decision: unresolvable → error and STOP).
 *
 * Exit codes: 0 = env var matches the derived driver model (or --print-only).
 * 1 = unset, mismatch, split judgment tier, non-Anthropic judgment model, or
 * any load/derivation failure. The orchestrator halts the run on non-zero.
 *
 * Usage:
 *   node driver-model-check.mjs --project-root <dir> [--policy <name>]
 *                               [--policy-path <file>] [--print-only]
 *
 * Policy resolution mirrors the server exactly: --policy-path (explicit file)
 * beats <project-root>/routing-policy.yaml, which beats the named preset.
 * MMO_SELECT slot overrides are honored the same way the server honors them.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/**
 * Every phase the orchestrator handles on the driver tier, across both modes
 * (greenfield: requirements → plan → reviews; brownfield adds discovery and
 * change_plan). Mechanical phases (codegen, tests, docs, debug) are dispatched
 * via the MCP server and are irrelevant to the in-session driver model.
 */
export const JUDGMENT_PHASES = [
  "requirements_analysis",
  "architecture_design",
  "plan_task_packets",
  "senior_code_review",
  "security_review",
  "discovery",
  "change_plan",
];

/**
 * Adapters whose model_name is a Claude model the CLI can itself run
 * in-session. A policy that routes the judgment tier to anything else (e.g.
 * antigravity-worker → Gemini) cannot be honored by an estimated-mode run at
 * all — no CLAUDE_CODE_SUBAGENT_MODEL value makes a Claude Code subagent
 * execute a non-Anthropic model — so that is an error, not a mismatch.
 */
export const IN_SESSION_ADAPTERS = new Set(["builtin-anthropic", "claude-cli"]);

/**
 * Route all judgment phases and require one model. Returns
 * { modelName, modelId, perPhase } or throws with a STOP-worthy message.
 * `routing` is the imported dist/routing.js module (injected so tests can
 * exercise derivation without spawning a process).
 */
export function deriveDriverModel(policy, routing, overrides = {}) {
  const perPhase = JUDGMENT_PHASES.map((phase) => {
    // task_type/module are empty and retry_count 0: shipped policies match
    // judgment phases on `phase:` alone, and a rule that additionally
    // requires a task_type deliberately does not describe the phase-level
    // driver route this check verifies. intent stays undefined (greenfield
    // packet shape) so intent-scoped rules never match here either.
    const decision = routing.pickModel(
      { phase, task_type: "", module: "", retry_count: 0 },
      policy,
      overrides
    );
    const model = policy.models.find((m) => m.id === decision.modelId);
    if (!model) {
      throw new Error(
        `policy '${policy.name}': rule for phase '${phase}' resolved to model id ` +
          `'${decision.modelId}' which is not in the models list`
      );
    }
    return { phase, modelId: model.id, modelName: model.model_name, adapter: model.adapter };
  });

  const names = [...new Set(perPhase.map((p) => p.modelName))];
  if (names.length > 1) {
    const table = perPhase.map((p) => `  ${p.phase} → ${p.modelName} (${p.modelId})`).join("\n");
    throw new Error(
      `policy '${policy.name}' splits the judgment tier across ${names.length} models:\n${table}\n` +
        `CLAUDE_CODE_SUBAGENT_MODEL is a single value, so an estimated-mode run cannot ` +
        `honor this policy's driver routing. Run it under --auth=vendor (every call ` +
        `dispatches through the server), or unify the judgment phases on one model.`
    );
  }

  const first = perPhase[0];
  if (!IN_SESSION_ADAPTERS.has(first.adapter)) {
    throw new Error(
      `policy '${policy.name}' routes the judgment tier to '${first.modelName}' via ` +
        `adapter '${first.adapter}', which is not a model Claude Code can run ` +
        `in-session. An estimated-mode run cannot honor this policy's driver tier; ` +
        `run it under --auth=vendor instead.`
    );
  }

  return { modelName: first.modelName, modelId: first.modelId, perPhase };
}

/**
 * Claude Code does not apply an `env` block from a project's
 * .claude/settings.json — only the user file at ~/.claude/settings.json. A
 * reader who follows the obvious instinct sets it in the project file, sees no
 * effect across repeated app restarts, and has nothing to tell them why. Return
 * the value declared there so the failure can name that trap instead of
 * repeating generic advice.
 */
export function declaredInProjectSettings(projectRoot) {
  if (!projectRoot) return undefined;
  try {
    const raw = readFileSync(join(resolve(projectRoot), ".claude", "settings.json"), "utf8");
    const declared = JSON.parse(raw)?.env?.CLAUDE_CODE_SUBAGENT_MODEL;
    return typeof declared === "string" && declared !== "" ? declared : undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const args = { projectRoot: undefined, policy: undefined, policyPath: undefined, printOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--print-only") args.printOnly = true;
    else if (a === "--project-root" || a.startsWith("--project-root=")) args.projectRoot = eat("--project-root");
    else if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else throw new Error(`unknown argument '${a}' (expected --project-root, --policy, --policy-path, --print-only)`);
  }
  return args;
}

async function loadDist() {
  try {
    const policyMod = await import(pathToFileURL(join(DIST, "policy.js")).href);
    const routingMod = await import(pathToFileURL(join(DIST, "routing.js")).href);
    return { policyMod, routingMod };
  } catch (err) {
    throw new Error(
      `could not load the dispatch server's compiled routing from ${DIST} — the MCP ` +
        `server is not built. Fix: node "${join(HERE, "verify-setup.mjs")}" --fix ` +
        `--project-root "$(pwd)"  (original error: ${err.message})`
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { policyMod, routingMod } = await loadDist();

  const policy = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: args.policy, projectRoot: args.projectRoot });
  const overrides = routingMod.parseSelectOverrides(process.env.MMO_SELECT);
  const derived = deriveDriverModel(policy, routingMod, overrides);

  if (args.printOnly) {
    console.log(derived.modelName);
    return 0;
  }

  const actual = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (actual === derived.modelName) {
    console.log(
      `driver-model-check ok: CLAUDE_CODE_SUBAGENT_MODEL=${actual} matches policy ` +
        `'${policy.name}' (driver model '${derived.modelId}').`
    );
    return 0;
  }

  const problem =
    actual === undefined || actual === ""
      ? `CLAUDE_CODE_SUBAGENT_MODEL is not set, so the driver tier would run on ` +
        `whatever this session's model happens to be`
      : `CLAUDE_CODE_SUBAGENT_MODEL=${actual}, but policy '${policy.name}' prices ` +
        `the driver tier as '${derived.modelName}'`;
  const stranded = declaredInProjectSettings(args.projectRoot);
  const strandedNote = stranded
    ? `\n\nNOTE: ${join(String(args.projectRoot), ".claude", "settings.json")} already ` +
      `declares CLAUDE_CODE_SUBAGENT_MODEL=${stranded}, and it has not taken effect. ` +
      `Claude Code does not apply an "env" block from a project settings file — ` +
      `only from ~/.claude/settings.json. Move the entry there.`
    : "";

  console.error(
    `driver-model-check FAILED: ${problem} — the report would price driver work ` +
      `against a model that did not run.${strandedNote}\n\n` +
      `Fix (must happen BEFORE claude launches — an export inside the session ` +
      `cannot reach the CLI process):\n\n` +
      `  Terminal:     export CLAUDE_CODE_SUBAGENT_MODEL=${derived.modelName}\n` +
      `  Desktop app:  add "CLAUDE_CODE_SUBAGENT_MODEL": "${derived.modelName}" to the\n` +
      `                "env" block of ~/.claude/settings.json — the app is not\n` +
      `                launched from a login shell, so an export never reaches it,\n` +
      `                and an "env" block in a project's .claude/settings.json is\n` +
      `                not applied. That user file is machine-wide: it pins the\n` +
      `                driver model for every session on this machine, so remove\n` +
      `                the entry once the run is done\n\n` +
      `then relaunch claude and restart the run.`
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`driver-model-check FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
