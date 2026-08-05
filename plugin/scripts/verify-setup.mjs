#!/usr/bin/env node
/**
 * verify-setup.mjs — proves an installed plugin can actually run, and repairs it.
 *
 * Why this exists: `/plugin install` reports success even when the plugin is
 * unusable. The plugin manifest points the bundled MCP server at
 * `<plugin>/mcp/gemini-flash-server/dist/server.js`, but `dist/` is a build
 * artifact and `node_modules/` is a dependency tree — neither is tracked in
 * git, so neither arrives with a fresh install from GitHub. The install
 * succeeds, the slash command registers, and the failure only surfaces
 * mid-run when the first mechanical phase tries to dispatch to the
 * cost-efficient model. That is the worst possible moment to discover it:
 * premium-tier tokens have already been spent on the phases before it.
 *
 * This script closes that gap. It runs after install, reports every
 * precondition, and with --fix installs dependencies and builds the server so
 * the dispatch path is real before the first run starts.
 *
 * It locates the plugin from its own path (`<pluginRoot>/scripts/` → up one),
 * so the same file works whether it is executed out of the Claude Code plugin
 * cache after an install or out of a git clone during development. Nothing
 * here hardcodes a marketplace name or a cache layout, both of which are
 * outside our control and have changed before.
 *
 * Usage:
 *   node verify-setup.mjs          check and report; exit 1 if unusable
 *   node verify-setup.mjs --fix    check, repair what is repairable, re-check
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── pure helpers (unit-tested; no filesystem, no process state) ──────

/** Major version from a `process.versions.node` string ("20.11.1" → 20). */
export function nodeMajorFrom(versionString) {
  const major = parseInt(String(versionString).split(".")[0], 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Where `gcloud auth application-default login` writes user credentials.
 *
 * This script runs before `npm ci`, so it cannot import the server's
 * TypeScript. The same path is computed in
 * mcp/gemini-flash-server/src/adapters/geminiTransports.ts (`defaultAdcPath`)
 * and the two are kept in sync by hand — if one moves, move both.
 */
export function adcPath(home = homedir()) {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * The environment variables plugin.json declares as host pass-throughs.
 *
 * Kept in sync by hand with PLUGIN_DECLARED_ENV in
 * mcp/gemini-flash-server/src/env.ts. This script runs before `npm ci`, so it
 * cannot import the server's TypeScript — same constraint, and same hand-sync
 * rule, as adcPath() above.
 */
export const DECLARED_ENV = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  // Select-slot choices, e.g. "gemini-flash=flash-agsdk-worker". Unset on
  // most machines, which is exactly why it has to be here — see the matching
  // entry in env.ts for what an unexpanded placeholder does to policy load.
  "SDLC_SELECT",
  // An operator-supplied Python for the agent worker, for people who already
  // have a suitable one. Unexpanded it is a path that does not exist, which
  // the worker refuses outright — see env.ts.
  "GEMINI_WORKER_PYTHON",
];

/**
 * True when a value is a shell placeholder that was never substituted — the
 * literal string `${NAME}`, and nothing else.
 *
 * plugin.json declares the MCP server's environment as `"${GOOGLE_CLOUD_PROJECT}"`
 * style pass-throughs. When the host has the variable set, the value is
 * substituted. When it does not — the default state of anyone who launched Claude
 * Code from the desktop app, which inherits no login shell — the placeholder is
 * handed through verbatim. Confirmed against a live server process on 2026-08-04.
 *
 * That literal is truthy, which is why this check exists: without it, every
 * credential probe below sees a "set" variable and reports a green light, and the
 * user is told their Gemini setup is ready when no door into Gemini is actually
 * open. Anchored at both ends so a legitimate value that merely contains a dollar
 * sign — a path, a passphrase — is left alone.
 */
export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

/**
 * A copy of `env` with unusable values dropped: absent, empty, or an unexpanded
 * placeholder. Returns a new object rather than mutating, because this script
 * only reports — the server does the real in-place stripping at startup
 * (see mcp/gemini-flash-server/src/envBootstrap.ts).
 */
export function usableEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" || isUnexpandedPlaceholder(trimmed)) continue;
    out[key] = value;
  }
  return out;
}

/** Declared variables that reached us as unexpanded placeholders, in declaration order. */
export function unexpandedDeclaredEnv(env = {}) {
  return DECLARED_ENV.filter((name) => isUnexpandedPlaceholder(env[name]));
}

/**
 * Whether ANY door into Gemini is open, mirroring the precedence in
 * geminiTransports.ts `selectGeminiBackend`: an API key, an explicit service
 * account file, a gcloud ADC file, or a GCP project named in the environment.
 *
 * Callers must pass an env that has already been through usableEnv() — this
 * function trusts every value it is given, by design, so that the "what counts as
 * a real value" rule lives in exactly one place.
 *
 * Split out because the previous check only looked at GEMINI_API_KEY and
 * GOOGLE_APPLICATION_CREDENTIALS, so the ordinary enterprise setup — a plain
 * `gcloud auth application-default login`, which sets no environment variable
 * at all — was reported as "no credentials" even though runs work fine.
 */
export function hasGeminiCredentials({ env = {}, hasAdcFile = false } = {}) {
  return Boolean(
    env.GEMINI_API_KEY ||
      env.GOOGLE_APPLICATION_CREDENTIALS ||
      hasAdcFile ||
      env.GOOGLE_CLOUD_PROJECT
  );
}

/** The three paths that decide whether the MCP dispatch path is real. */
export function mcpPaths(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "gemini-flash-server");
  return {
    serverDir,
    distEntry: join(serverDir, "dist", "server.js"),
    nodeModules: join(serverDir, "node_modules"),
  };
}

/**
 * The policy leaf that reaches Gemini as an AGENT rather than as a model.
 *
 * Spelled out here as a literal because this script cannot import the policy —
 * it runs before `npm ci`, and the policy is YAML read by TypeScript that may
 * not be built yet. Kept in sync by hand with the `flash-agsdk-worker` entry in
 * config/policies/opus-plus-flash.yaml. If that id is ever renamed, rename it
 * here too, or this check silently stops firing.
 */
export const AGENT_WORKER_MODEL_ID = "flash-agsdk-worker";

/**
 * Where the agent worker's Python environment lives.
 *
 * Fourth copy of this path, and the reason is the same as adcPath()'s: nothing
 * here can import the server's TypeScript. The authority is
 * `workerVenvPython()` in mcp/gemini-flash-server/src/delegation/workerProcess.ts
 * — that is what actually launches the interpreter, so if the two ever disagree,
 * that one is right and this one is the bug.
 */
export function workerPaths(pluginRoot) {
  const workerDir = join(pluginRoot, "mcp", "gemini-flash-server", "worker");
  return {
    workerDir,
    venvPython: join(workerDir, ".venv", "bin", "python"),
    requirements: join(workerDir, "requirements.txt"),
  };
}

/**
 * Has this install asked for Gemini-as-an-agent?
 *
 * Everything the agent path needs — Python 3.10+, a virtualenv, the Antigravity
 * SDK — is checked ONLY when this returns true. Someone on the model path never
 * touches Python, and telling them their setup is broken because they have no
 * virtualenv would be a false alarm on the check that is supposed to be the
 * trustworthy one.
 *
 * Deliberately a substring-free parse rather than `includes(...)`: SDLC_SELECT
 * is a comma-separated list of `slot=option` pairs, and a slot NAMED after the
 * worker would otherwise read as a selection OF it.
 */
export function selectsAgentWorker(env = {}) {
  const spec = usableEnv(env).SDLC_SELECT;
  if (!spec) return false;
  return String(spec)
    .split(",")
    .some((pair) => pair.split("=").slice(1).join("=").trim() === AGENT_WORKER_MODEL_ID);
}

/**
 * Turn observed facts into an ordered problem list.
 *
 * Kept pure so the decision table is testable without installing anything.
 * `severity: "blocking"` means a run cannot succeed; "warning" means a run
 * can start but some policies will fail. Only blocking problems fail the exit
 * code, because a user running the Claude-only policy legitimately has no
 * Gemini credentials and must not be told their setup is broken.
 */
export function evaluate({
  nodeMajor,
  hasClaudeCli,
  hasNodeModules,
  hasDist,
  hasAdcFile = false,
  env = {},
  /**
   * What was found when the agent worker's Python environment was probed, or
   * `null` when it was not probed because this install did not ask for it.
   * `{ hasVenv, sdkImportable, detail }` — `detail` carries whatever the probe
   * learned (a version string, an import error) so the message can quote it.
   */
  agentWorker = null,
}) {
  const problems = [];

  if (nodeMajor < 20) {
    problems.push({
      id: "node-version",
      severity: "blocking",
      message: `Node ${nodeMajor || "unknown"} detected; this plugin needs Node 20 or newer.`,
      fix: "Install the current LTS from https://nodejs.org (or `nvm install --lts`).",
    });
  }

  if (!hasClaudeCli) {
    problems.push({
      id: "claude-cli",
      severity: "blocking",
      message: "Claude Code CLI not found on PATH.",
      fix: "npm install -g @anthropic-ai/claude-code",
    });
  }

  // The two artifacts a fresh install never carries. Both are repairable
  // in place, so --fix resolves them rather than sending the user away.
  if (!hasNodeModules) {
    problems.push({
      id: "mcp-dependencies",
      severity: "blocking",
      message: "The bundled MCP server has no installed dependencies.",
      fix: "Re-run this script with --fix (runs `npm ci` in the server directory).",
    });
  }

  if (!hasDist) {
    problems.push({
      id: "mcp-build",
      severity: "blocking",
      message:
        "The bundled MCP server is not built — the plugin manifest points at dist/server.js, which does not exist. " +
        "Model dispatch would fail partway through a run.",
      fix: "Re-run this script with --fix (runs `npm run build` in the server directory).",
    });
  }

  // Everything below asks "is this credential set?", and the honest answer
  // depends on discarding values that look set but carry no information. Do
  // that once, here, so no individual check can be fooled by a placeholder.
  const declaredPlaceholders = unexpandedDeclaredEnv(env);
  const realEnv = usableEnv(env);

  if (declaredPlaceholders.length > 0) {
    problems.push({
      id: "env-placeholders",
      severity: "warning",
      message:
        `${declaredPlaceholders.length} plugin environment variable(s) arrived unset and unexpanded ` +
        `(${declaredPlaceholders.join(", ")}). The server strips these at startup and falls back to ` +
        "Application Default Credentials, so this is not itself a failure — but if you meant to set " +
        "any of them, the value is not reaching the plugin.",
      fix:
        "Set them where Claude Code itself will see them — the `env` block of ~/.claude/settings.json — " +
        "not just in a terminal profile. Claude Code launched from the desktop app inherits no login shell.",
    });
  }

  // Credentials are reported, never repaired: writing a key anywhere on the
  // user's behalf is not this script's business.
  if (!realEnv.ANTHROPIC_API_KEY) {
    problems.push({
      id: "anthropic-key",
      severity: "warning",
      message:
        "ANTHROPIC_API_KEY is not set. Vendor-billed runs need it; a Claude Code subscription covers " +
        "subscription-auth runs without it.",
      fix: "export ANTHROPIC_API_KEY=... (https://console.anthropic.com/settings/keys)",
    });
  }

  if (!hasGeminiCredentials({ env: realEnv, hasAdcFile })) {
    problems.push({
      id: "gemini-credentials",
      severity: "warning",
      message:
        "No Gemini credentials found. Policies that route mechanical phases to Gemini will abort at the " +
        "first dispatch; Claude-only policies are unaffected.",
      fix:
        "Either `gcloud auth application-default login` for Vertex AI on a Google Cloud project " +
        "(no key; set GOOGLE_CLOUD_PROJECT if the account has several), or " +
        "export GEMINI_API_KEY=... for the AI Studio path (https://aistudio.google.com/app/apikey).",
    });
  }

  // The agent path's prerequisites. Blocking rather than warning, because this
  // install has already declared it will route mechanical work there: the
  // adapter's constructor refuses without a working interpreter, pre-flight
  // exercises that constructor, and the run halts. Saying so here — before a
  // run is even started — is the same information one step earlier.
  if (agentWorker) {
    if (!agentWorker.hasVenv) {
      problems.push({
        id: "agent-worker-python",
        severity: "blocking",
        message:
          `SDLC_SELECT routes the mechanical tier to '${AGENT_WORKER_MODEL_ID}', which runs a Python ` +
          "agent worker, but the worker has no Python environment. Every mechanical task would fail.",
        // --fix is named first because it is the one repair that works on both
        // install routes. `node tools/setup.mjs` exists only in a clone; an
        // installed plugin has no tools/ directory, and sending someone there
        // from a plugin cache is a dead end.
        fix:
          "Re-run this check with --fix, which builds the environment. On a clone, " +
          "`node tools/setup.mjs` does the same and asks first. Or set GEMINI_WORKER_PYTHON " +
          "to a Python >= 3.10 that already has google-antigravity installed. " +
          "To go back to the model path instead, remove SDLC_SELECT.",
      });
    } else if (!agentWorker.sdkImportable) {
      problems.push({
        id: "agent-worker-sdk",
        severity: "blocking",
        message:
          "The agent worker's Python environment exists but cannot import google.antigravity" +
          (agentWorker.detail ? ` (${agentWorker.detail})` : "") +
          ". The interpreter starts and then dies at its first import, inside a subprocess, " +
          "which is a much harder failure to read than this line.",
        // Same repair as the missing-environment case, and for the same reason:
        // --fix rebuilds with `venv --clear`, which empties the existing
        // directory first, so a broken environment is replaced rather than
        // patched. Nothing to delete by hand.
        fix:
          "Re-run this check with --fix, which rebuilds the environment from scratch. " +
          "The commonest cause is an environment built against an interpreter that has since " +
          "been upgraded or removed.",
      });
    }
  }

  return { ok: problems.every((p) => p.severity !== "blocking"), problems };
}

// ─── observation + repair (IO; thin by design) ────────────────────────

function onPath(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

/**
 * Probe the agent worker's Python, or return null if this install never asked
 * for it.
 *
 * The import is actually attempted rather than inferred from the presence of a
 * directory, because "the package folder is there" and "the package imports on
 * this interpreter" come apart often enough to matter — a venv built against a
 * Python that was later upgraded or uninstalled looks perfectly healthy on disk
 * and fails on its first line.
 *
 * GEMINI_WORKER_PYTHON is honoured here for the same reason the adapter honours
 * it: someone who already maintains a suitable environment should not be told
 * to build a second one. Same name, same precedence — see resolveWorkerPython()
 * in src/delegation/workerProcess.ts.
 */
function observeAgentWorker(pluginRoot, env) {
  if (!selectsAgentWorker(env)) return null;

  const override = usableEnv(env).GEMINI_WORKER_PYTHON;
  const python = override || workerPaths(pluginRoot).venvPython;
  if (!existsSync(python)) return { hasVenv: false, sdkImportable: false, detail: null };

  const probe = spawnSync(python, ["-c", "import google.antigravity"], { encoding: "utf8" });
  if (probe.status === 0) return { hasVenv: true, sdkImportable: true, detail: null };
  // The last line of a traceback is the exception; the rest is machinery no
  // one reading a setup report needs.
  const stderr = (probe.stderr || "").trim().split("\n").filter(Boolean).pop() ?? null;
  return { hasVenv: true, sdkImportable: false, detail: stderr };
}

function observe(pluginRoot) {
  const { nodeModules, distEntry } = mcpPaths(pluginRoot);
  return {
    nodeMajor: nodeMajorFrom(process.versions.node),
    hasClaudeCli: onPath("claude"),
    hasNodeModules: existsSync(nodeModules),
    hasDist: existsSync(distEntry),
    hasAdcFile: existsSync(adcPath()),
    env: process.env,
    agentWorker: observeAgentWorker(pluginRoot, process.env),
  };
}

/**
 * Install dependencies and build the server, in that order.
 *
 * `npm ci` rather than `npm install`: the lockfile is committed, and a build
 * that silently resolves different versions than the ones we verified is a
 * worse outcome than a loud failure.
 */
function repair(pluginRoot, log) {
  const { serverDir } = mcpPaths(pluginRoot);
  for (const [label, args] of [
    ["installing dependencies", ["ci"]],
    ["building the server", ["run", "build"]],
  ]) {
    log(`  → ${label} (npm ${args.join(" ")})`);
    const result = spawnSync("npm", args, { cwd: serverDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      log(`  ✗ ${label} failed:\n${(result.stderr || result.stdout || "").trim()}`);
      return false;
    }
  }
  return true;
}

/**
 * The oldest Python the Antigravity SDK accepts.
 *
 * Not a style preference — `google-antigravity` declares `requires-python
 * >= 3.10`, and macOS ships 3.9 as `/usr/bin/python3`, so the machine's default
 * interpreter is the one interpreter guaranteed not to work.
 */
export const MIN_PYTHON = [3, 10];

/**
 * Find an interpreter new enough to run the worker, newest name first.
 *
 * Version-suffixed names are tried before bare `python3` because a bare
 * `python3` is whatever happens to be first on PATH — frequently the system 3.9
 * — and finding a usable one under an explicit name is worth more than finding
 * an unusable one under the obvious name. Each candidate is asked its own
 * version rather than trusted by name, since `python3.12` on PATH can be a
 * symlink to anything.
 */
export function findWorkerPython(run = spawnSync, resolve = onPath) {
  for (const name of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    if (!resolve(name)) continue;
    const probe = run(name, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { command: name, version: `${major}.${minor}` };
    }
  }
  return null;
}

/**
 * Create the agent worker's virtual environment and install the SDK into it.
 *
 * A virtualenv rather than the machine's Python for two reasons: `pip install`
 * into a Homebrew or system interpreter is refused outright on current setups
 * (PEP 668), and pinning the SDK inside the plugin means upgrading it can never
 * disturb anything else the user has installed.
 *
 * Lives here, rather than in tools/setup.mjs, so both installation routes share
 * one implementation — the clone route imports this function, and the plugin
 * route reaches it through `--fix`. A plugin-cache install has no tools/
 * directory, so a repair that only existed there would be unreachable for
 * exactly the users who most need it.
 */
export function buildWorkerEnvironment(pluginRoot, log = () => {}) {
  const { workerDir, venvPython } = workerPaths(pluginRoot);
  const python = findWorkerPython();
  if (!python) {
    return {
      ok: false,
      reason: "no-python",
      detail: `No Python ${MIN_PYTHON.join(".")} or newer found. macOS ships 3.9, which is too old. Install one (e.g. \`brew install python@3.12\`) and retry.`,
    };
  }

  log(`  → creating the worker environment with ${python.command} (${python.version})`);
  for (const [label, cmd, args] of [
    // --clear empties an existing .venv before rebuilding, and is the whole
    // reason this function can be used as a repair rather than only as an
    // install. Without it, `venv` on an existing directory leaves site-packages
    // in place, so the commonest breakage — an environment whose interpreter
    // was upgraded or removed underneath it — would survive its own repair and
    // report the same failure again. Every caller reaches here only because the
    // environment is missing or already known to be broken, so there is nothing
    // healthy to lose.
    ["creating the virtual environment", python.command, ["-m", "venv", "--clear", ".venv"]],
    ["installing the Antigravity SDK", venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"]],
  ]) {
    const result = spawnSync(cmd, args, { cwd: workerDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: `${label} failed:\n${(result.stderr || result.stdout || "").trim()}`,
      };
    }
  }
  return { ok: true, reason: null, detail: `${python.command} (${python.version})` };
}

/**
 * Say out loud what this script cannot prove, but only to the people it can
 * cost money.
 *
 * Everything above is offline by design, and on the model path that is the
 * whole story: a green report there really does mean the next run will
 * dispatch. On the agent path it does not. Two failure modes are invisible to
 * every check in this file, because neither is a missing file — the billing
 * project's Antigravity entitlement (403) and whether the resolved region
 * actually serves the model (404). Both surface at the FIRST delegated packet,
 * which is after requirements, design and task planning have been billed to the
 * premium tier.
 *
 * So a green report is told to say so. Returns null on the model path, and on
 * any install that is not yet green — someone still fixing a blocking problem
 * does not need a second command to run, and the probe would fail on the same
 * cause anyway.
 */
export function agentProbeHint(pluginRoot, env = {}, ok = true) {
  if (!ok || !selectsAgentWorker(env)) return null;
  return (
    `\n  This install selects the agent path, and the checks above are all offline.\n` +
    `  They cannot tell whether this project carries the Antigravity entitlement, or\n` +
    `  whether its region serves the model — both fail at the first delegated packet,\n` +
    `  after the premium phases are already billed. One trivial delegation settles\n` +
    `  both for about two cents:\n` +
    `    node ${join(pluginRoot, "scripts", "probe-agent-worker.mjs")}`
  );
}

function report({ ok, problems }, log) {
  const blocking = problems.filter((p) => p.severity === "blocking");
  const warnings = problems.filter((p) => p.severity === "warning");

  for (const p of blocking) log(`  ✗ ${p.message}\n    fix: ${p.fix}`);
  for (const p of warnings) log(`  ! ${p.message}\n    fix: ${p.fix}`);

  if (ok && warnings.length === 0) log("  ✓ Setup is complete. The plugin is ready to run.");
  else if (ok) log("  ✓ The plugin can run. Warnings above limit which policies will work.");
  return ok;
}

// Run only when executed directly, so the pure helpers above can be imported
// by the test suite without triggering a setup check.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const log = (m) => console.log(m);
  const shouldFix = process.argv.includes("--fix");

  log("\nAI-SDLC orchestrator — setup check");

  let state = evaluate(observe(pluginRoot));
  const needsRepair = state.problems.some(
    (p) => p.id === "mcp-dependencies" || p.id === "mcp-build"
  );

  if (needsRepair && shouldFix) {
    log("  The bundled MCP server needs building. Repairing:");
    if (repair(pluginRoot, log)) state = evaluate(observe(pluginRoot));
  }

  // Repairable for the same reason the build is: this install asked for the
  // agent path, and everything the agent path needs is ours to create. Kept
  // separate from repair() above because it is conditional — an install that
  // never selected the agent worker must not have a virtualenv built for it.
  const needsWorker = state.problems.some(
    (p) => p.id === "agent-worker-python" || p.id === "agent-worker-sdk"
  );
  if (needsWorker && shouldFix) {
    log("  The agent worker needs a Python environment. Repairing:");
    const built = buildWorkerEnvironment(pluginRoot, log);
    if (built.ok) state = evaluate(observe(pluginRoot));
    else log(`  ✗ ${built.detail}`);
  }

  const passed = report(state, log);
  const hint = agentProbeHint(pluginRoot, process.env, passed);
  if (hint) log(hint);

  process.exit(passed ? 0 : 1);
}
