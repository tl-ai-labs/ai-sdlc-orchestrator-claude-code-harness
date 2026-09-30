#!/usr/bin/env node
/**
 * driver-model-check — verify the estimated-mode driver tier will actually run
 * on the model the policy prices it at.
 *
 * The problem this closes: under `--auth=estimated` the premium-judgment tier
 * is not dispatched through the MCP server — it runs *in this Claude Code
 * session* as the five driver subagents (orchestrator, architect, discovery,
 * senior-reviewer, security-reviewer). The policy YAML's driver `model_name`
 * is only used to PRICE that work. When the model that runs and the model
 * that is priced disagree, every driver-tier dollar in the report is
 * attributed to a model that never ran.
 *
 * Which model those subagents execute on (v0.8.3, 25 Sep 2026): the model
 * named in their own agent files, `model: claude-opus-5` in all five. Claude
 * Code's order, strongest first (read in the 2.1.281 source; the pinned-vs-chat
 * half checked live in the desktop app on 25 Sep): a model passed on one Agent
 * call, then the agent file's `model:`, then the CLAUDE_CODE_SUBAGENT_MODEL
 * setting, then the chat's own model. The one switch that reorders it is
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE: when on, Claude Code ignores the agent
 * file and the setting decides again.
 *
 * History. Until 2 Sep 2026 the agent files said `model: opus` and nothing
 * checked it, so the judgment tier always ran Opus whatever the policy priced
 * (PR #34). v0.7.x then removed the pins and required the user to set
 * CLAUDE_CODE_SUBAGENT_MODEL before launching claude (a machine-wide setting,
 * read only when a chat starts, that the desktop app reads only from
 * ~/.claude/settings.json), and this script checked that setting. Since Claude
 * Code 2.1.251 an agent file's model wins over the setting, so the pin is back,
 * as one exact model id, and this script checks the PIN against the policy: a
 * mismatch still stops the run, so the PR #34 defect stays closed, and nobody
 * has to set anything.
 *
 * The driver model must be derived by the SAME routing code the dispatch
 * server uses. Re-implementing rule matching here could disagree with the real
 * router — precisely the defect class this check exists to prevent. So this
 * script imports pickModel / loadPolicy from ../mcp/model-dispatch/dist/,
 * which is guaranteed built before any run (verify-setup.mjs --fix /
 * /mmo:setup step 1).
 *
 * Derivation: route every judgment phase through the policy and require them
 * all to land on one model. The driver agents run on one model, so a policy
 * that splits the judgment tier across models is an error, not a majority vote
 * (meeting decision: unresolvable → error and STOP).
 *
 * Not checkable from here, and the same in v0.7.x: a model passed on a single
 * Agent call (nothing in the plugin passes one), and an organisation's model
 * allowlist that excludes the pinned model (Claude Code then keeps the chat's
 * model, as it did for the setting).
 *
 * Exit codes: 0 = the driver agents' model matches the derived driver model
 * (or --print-only). 1 = mismatch, a forced setting that does not match, split
 * judgment tier, non-Anthropic judgment model, agent files that do not name one
 * exact model, or any load/derivation failure. The orchestrator halts the run
 * on non-zero.
 *
 * Usage:
 *   node driver-model-check.mjs --project-root <dir> [--policy <name>]
 *                               [--policy-path <file>] [--print-only]
 *
 * Policy resolution mirrors the server exactly: --policy-path (explicit file)
 * beats <project-root>/routing-policy.yaml, which beats the named preset.
 * MMO_SELECT slot overrides are honored the same way the server honors them.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");
const AGENTS_DIR = join(HERE, "..", "agents");

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

/** The five driver agents: each names the model it runs on in its frontmatter, and all must name the same one. */
export const DRIVER_AGENTS = ["orchestrator", "architect", "discovery", "senior-reviewer", "security-reviewer"];

/**
 * Adapters whose model_name is a Claude model the CLI can itself run
 * in-session. A policy that routes the judgment tier to anything else (e.g.
 * antigravity-worker → Gemini) cannot be honored by an estimated-mode run at
 * all — no Claude Code subagent executes a non-Anthropic model — so that is an
 * error, not a mismatch.
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
        `The driver agents run on one model, so an estimated-mode run cannot ` +
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
 * The one model the five driver agents name in their frontmatter (`model:`),
 * read from the plugin's own agents folder. Throws, naming the file, when a
 * file is missing, has no model line, names an alias instead of an exact id
 * (an alias such as "opus" follows whichever model is newest: the policy would
 * price one model while another runs), or when the files disagree. Any of
 * those is a defect in the plugin itself, never something the user sets.
 */
export function pinnedDriverModel(agentsDir = AGENTS_DIR) {
  const found = DRIVER_AGENTS.map((name) => {
    let text;
    try {
      text = readFileSync(join(agentsDir, `${name}.md`), "utf8");
    } catch {
      throw new Error(`the driver agent file ${name}.md is missing from ${agentsDir}`);
    }
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const line = frontmatter.split("\n").find((l) => /^model:/.test(l));
    if (!line) throw new Error(`${name}.md has no model: line: every driver agent must name the model it runs on`);
    const value = line.replace(/^model:\s*/, "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (!/^claude-[a-z0-9.-]+(\[[a-z0-9]+\])?$/.test(value)) {
      throw new Error(`${name}.md names '${value}': a driver agent must name an exact model id, not an alias`);
    }
    return { name, value };
  });
  const values = [...new Set(found.map((f) => f.value))];
  if (values.length > 1) {
    throw new Error(
      `the driver agent files disagree: ${found.map((f) => `${f.name}.md → ${f.value}`).join(", ")}; ` +
        `they must all name one model`
    );
  }
  return values[0];
}

/** Claude Code's own reading of an on/off variable (its isEnvTruthy, 2.1.281): on only for 1, true, yes or on, any case. */
export function isEnvTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase().trim());
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

  const expected = derived.modelName;
  const setting = process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? "";

  // CLAUDE_CODE_SUBAGENT_MODEL_FORCE on: Claude Code drops the agent file's model and
  // the setting decides (with no setting, the chat's own model). Then the setting is
  // what must match; the fix is to turn the switch off, so the agent files decide.
  if (isEnvTruthy(process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE)) {
    if (setting === expected) {
      console.log(
        `driver-model-check ok: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on and CLAUDE_CODE_SUBAGENT_MODEL=${setting} ` +
          `matches policy '${policy.name}' (driver model '${derived.modelId}').`
      );
      return 0;
    }
    const runsOn = setting === "" ? "whatever this chat's model is" : `'${setting}' (CLAUDE_CODE_SUBAGENT_MODEL)`;
    console.error(
      `driver-model-check FAILED: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, which makes Claude Code ignore ` +
        `the model named in this plugin's agent files, so the driver agents would run on ${runsOn}, but ` +
        `policy '${policy.name}' prices the driver tier as '${expected}'. The report would price driver ` +
        `work against a model that did not run. Turn CLAUDE_CODE_SUBAGENT_MODEL_FORCE off (the agent files ` +
        `then decide), then start a new chat and restart the run.`
    );
    return 1;
  }

  const pinned = pinnedDriverModel();
  if (pinned === expected) {
    console.log(
      `driver-model-check ok: the driver agents run on ${pinned}, named in this plugin's agent files, ` +
        `which is the judgment model of policy '${policy.name}' (driver model '${derived.modelId}').`
    );
    // A value left over from v0.7.x, when this setting was required. It no longer decides
    // anything for these agents, but it is still the default for every other helper agent
    // on the machine, so the person should know it can go.
    if (setting !== "") {
      console.log(
        `NOTE: CLAUDE_CODE_SUBAGENT_MODEL=${setting} is set but no longer needed by this plugin: its agent ` +
          `files name the model, and Claude Code gives them priority. The setting is still the default ` +
          `model of other helper agents on this machine; remove it if nothing else needs it.`
      );
    }
    return 0;
  }

  console.error(
    `driver-model-check FAILED: policy '${policy.name}' prices the driver tier as '${expected}', but this ` +
      `plugin's driver agents run on '${pinned}', named in their agent files (Claude Code gives the agent ` +
      `file priority over any setting and over the chat's model). The report would price driver work ` +
      `against a model that did not run. Pick a policy whose judgment tier is ${pinned} (the default, ` +
      `opus-plus-flash-v38, is one), or run under --auth=vendor, where every call dispatches through the server.`
  );
  return 1;
}

// import.meta.url is the module's real path; argv[1] keeps the caller's spelling (a symlinked plugin
// folder, /var against /private/var), so the entry is compared by its real path too.
const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`driver-model-check FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
