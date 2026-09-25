#!/usr/bin/env node
/**
 * cache-ttl-check — make the project's Claude Code `subagentPromptCacheTtl`
 * match what the run's policy declares, before any driver work is billed.
 *
 * Why a policy cares: under `--auth=estimated` the driver tier runs as Claude
 * Code subagents, and their prompt-cache TTL decides what a long wait costs.
 * The 1h TTL bills each cache write at 2x input instead of 1.25x, but keeps
 * the orchestrator's context warm while it waits on dispatched packets and
 * reviewers and test suites. Since 0.8.8 every run waits inside its turn, so
 * every shipped policy declares 1h (docs/cost-study/README.md); a local policy
 * may still choose 5m. So the TTL belongs to the policy
 * (`subagent_cache_ttl: 5m | 1h`), not to the project, and this script keeps
 * the two in step.
 *
 * What it can and cannot do — same shape as driver-model-check.mjs:
 *
 *   - It reads <project>/.claude/settings.local.json (Claude Code's default
 *     when the key is absent is 5m). With --fix it WRITES the policy's value
 *     there, preserving every other key, so nobody has to know the value.
 *   - It cannot make a running session pick the new value up: Claude Code
 *     reads settings at launch. So after a write it exits 2 and prints the
 *     relaunch instruction; the orchestrator halts on it, the user relaunches
 *     once, and the next run-start passes. A file that already matches is
 *     taken as loaded (there is no way to read the live value); a file edited
 *     by hand after launch is the one case this check cannot see.
 *
 * Exit codes: 0 = matches, or the policy declares no TTL (nothing to enforce).
 * 1 = mismatch without --fix, or any load failure. 2 = mismatch fixed on
 * disk, relaunch required. The orchestrator halts on any non-zero.
 *
 * Usage:
 *   node cache-ttl-check.mjs --project-root <dir> [--policy <name>]
 *                            [--policy-path <file>] [--fix] [--print-only]
 *
 * Policy resolution mirrors the server exactly (same loadPolicy as the
 * dispatch server, imported from ../mcp/model-dispatch/dist/).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "mcp", "model-dispatch", "dist");

/** Claude Code's value when the key is absent. */
export const DEFAULT_TTL = "5m";
export const SETTING_KEY = "subagentPromptCacheTtl";

export function settingsPath(projectRoot) {
  return join(resolve(projectRoot), ".claude", "settings.local.json");
}

/**
 * Read the project's settings.local.json. Absent file → {} (the check still
 * runs: absent key means 5m). Unparsable JSON is an error: --fix must never
 * overwrite a file it could not read back, and a check that guessed would be
 * worse than none.
 */
export function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root is not an object");
    }
    return parsed;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}); fix it by hand before running`);
  }
}

/** The TTL the session would load from these settings. */
export function effectiveTtl(settings) {
  const v = settings[SETTING_KEY];
  return typeof v === "string" && v !== "" ? v : DEFAULT_TTL;
}

/**
 * Return a copy of `settings` that yields `ttl`. The default is expressed by
 * removing the key, not by writing "5m": a project that never set the key
 * should not gain one, and the file stays readable as "nothing special here".
 */
export function withTtl(settings, ttl) {
  const next = { ...settings };
  if (ttl === DEFAULT_TTL) delete next[SETTING_KEY];
  else next[SETTING_KEY] = ttl;
  return next;
}

function parseArgs(argv) {
  const args = { projectRoot: undefined, policy: undefined, policyPath: undefined, fix: false, printOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--fix") args.fix = true;
    else if (a === "--print-only") args.printOnly = true;
    else if (a === "--project-root" || a.startsWith("--project-root=")) args.projectRoot = eat("--project-root");
    else if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else throw new Error(`unknown argument '${a}' (expected --project-root, --policy, --policy-path, --fix, --print-only)`);
  }
  if (!args.projectRoot) throw new Error("--project-root is required");
  return args;
}

async function loadDist() {
  try {
    return await import(pathToFileURL(join(DIST, "policy.js")).href);
  } catch (err) {
    throw new Error(
      `could not load the dispatch server's compiled policy loader from ${DIST} — the MCP ` +
        `server is not built. Fix: node "${join(HERE, "verify-setup.mjs")}" --fix ` +
        `--project-root "$(pwd)"  (original error: ${err.message})`
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const policyMod = await loadDist();
  const policy = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: args.policy, projectRoot: args.projectRoot });

  const wanted = policy.subagent_cache_ttl;
  if (args.printOnly) {
    console.log(wanted ?? "");
    return 0;
  }
  if (wanted === undefined) {
    console.log(
      `cache-ttl-check ok: policy '${policy.name}' declares no subagent_cache_ttl; ` +
        `leaving ${SETTING_KEY} as it is.`
    );
    return 0;
  }

  const path = settingsPath(args.projectRoot);
  const settings = readSettings(path);
  const actual = effectiveTtl(settings);
  if (actual === wanted) {
    console.log(
      `cache-ttl-check ok: ${SETTING_KEY}=${wanted} (${path}${settings[SETTING_KEY] === undefined ? ", key absent = default" : ""}) ` +
        `matches policy '${policy.name}'.`
    );
    return 0;
  }

  const relaunch =
    `Relaunch claude from ${resolve(args.projectRoot)} so the new value loads (Claude Code reads ` +
    `settings at launch; a running session keeps the old TTL), then restart the run.`;

  if (args.fix) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(withTtl(settings, wanted), null, 2)}\n`);
    console.error(
      `cache-ttl-check UPDATED ${path}: ${SETTING_KEY} ${actual} → ${wanted} ` +
        `(policy '${policy.name}' wants ${wanted}; ${wanted === DEFAULT_TTL ? "key removed = Claude Code default" : "key written"}). ` +
        `Every other key was kept.\n\n${relaunch}`
    );
    return 2;
  }

  console.error(
    `cache-ttl-check FAILED: ${SETTING_KEY} is ${actual} (${path}) but policy '${policy.name}' ` +
      `wants ${wanted} — the driver subagents would be billed at the wrong cache rate for this policy.\n\n` +
      `Fix: re-run with --fix to write it, or ${
        wanted === DEFAULT_TTL
          ? `remove "${SETTING_KEY}" from that file`
          : `set "${SETTING_KEY}": "${wanted}" in that file`
      }. ${relaunch}`
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`cache-ttl-check FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}
