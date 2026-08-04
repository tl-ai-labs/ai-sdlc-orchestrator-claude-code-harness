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

  return { ok: problems.every((p) => p.severity !== "blocking"), problems };
}

// ─── observation + repair (IO; thin by design) ────────────────────────

function onPath(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
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

  process.exit(report(state, log) ? 0 : 1);
}
