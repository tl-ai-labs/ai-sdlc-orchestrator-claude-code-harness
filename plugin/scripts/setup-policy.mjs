#!/usr/bin/env node
/**
 * Setup-time policy chooser. Invoked by the setup shepherd once per project.
 *
 * The console (plugin/policy-console) is a shared install-level Next.js app —
 * it doesn't know which project launched it. So this script does the coupling:
 * snapshot policies before → launch console + browser → wait for user to save →
 * diff to find the new/modified policy → write its name to the current project's
 * .sdlc/project.json as `default_policy`. Both /sdlc-run and /sdlc-brownfield
 * read that field via session-hydrate.
 *
 * Flow is hybrid on purpose:
 *   - happy path: user saves, presses Enter, script detects exactly one new file
 *     and uses it silently
 *   - user closes without saving OR saves multiple times: script prints the full
 *     list and asks them to type one name
 *
 * Usage:
 *   node setup-policy.mjs                    # interactive; the shepherd's default call
 *   node setup-policy.mjs --policy=<name>    # scripted; skip browser, just write the name
 *   node setup-policy.mjs --no-browser       # start server, print URL, don't auto-open
 *   node setup-policy.mjs --skip-install     # assume npm install already ran
 *   node setup-policy.mjs --print-only       # print resolved default_policy from project.json; no writes
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { platform } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const CONSOLE_DIR = join(PLUGIN_ROOT, "policy-console");
const POLICIES_DIR = join(PLUGIN_ROOT, "config", "policies");
const DEFAULT_PORT = 3000;
const PORT_PROBE_MAX = 10;
const SERVER_READY_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const out = { policy: null, noBrowser: false, skipInstall: false, printOnly: false };
  for (const a of argv) {
    if (a === "--no-browser") out.noBrowser = true;
    else if (a === "--skip-install") out.skipInstall = true;
    else if (a === "--print-only") out.printOnly = true;
    else if (a.startsWith("--policy=")) out.policy = a.slice("--policy=".length);
  }
  return out;
}

function findRepoRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) {
    fail("not inside a git repository — setup requires one so .sdlc/ can be committed.");
  }
  return r.stdout.trim();
}

function fail(msg) {
  process.stderr.write(`setup-policy: ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`setup-policy: ${msg}\n`);
}

// ── policy directory helpers ─────────────────────────────────────────

function listPolicies() {
  if (!existsSync(POLICIES_DIR)) return [];
  return readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

function snapshotPolicies() {
  if (!existsSync(POLICIES_DIR)) return new Map();
  const out = new Map();
  for (const f of readdirSync(POLICIES_DIR)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const full = join(POLICIES_DIR, f);
    const st = statSync(full);
    out.set(f, st.mtimeMs);
  }
  return out;
}

function diffPolicies(before) {
  const after = snapshotPolicies();
  const added = [];
  const modified = [];
  for (const [name, mtime] of after) {
    if (!before.has(name)) added.push(name);
    else if (before.get(name) !== mtime) modified.push(name);
  }
  return { added, modified };
}

// ── port + server ────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", () => { resolvePromise(true); });
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + PORT_PROBE_MAX; p++) {
    if (await isPortFree(p)) return p;
  }
  fail(`ports ${start}-${start + PORT_PROBE_MAX - 1} all busy — free one and retry.`);
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolvePromise) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => { resolvePromise(false); });
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(url) {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "linux" ? "xdg-open" : null;
  if (!cmd) {
    log(`auto-open not supported on ${p} — open ${url} manually.`);
    return;
  }
  try { spawnSync(cmd, [url], { stdio: "ignore" }); }
  catch { log(`could not auto-open browser; visit ${url} manually.`); }
}

// ── project.json writer ──────────────────────────────────────────────

function readProjectJson(sdlcDir) {
  const path = join(sdlcDir, "project.json");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return {}; }
}

function writeProjectJson(sdlcDir, obj) {
  if (!existsSync(sdlcDir)) mkdirSync(sdlcDir, { recursive: true });
  const path = join(sdlcDir, "project.json");
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o644 });
  return path;
}

function saveDefaultPolicy(repoRoot, policyName) {
  const sdlcDir = join(repoRoot, ".sdlc");
  const existing = readProjectJson(sdlcDir);
  const merged = {
    schema_version: existing.schema_version ?? 1,
    ...existing,
    default_policy: policyName,
    last_updated_at: new Date().toISOString(),
  };
  const path = writeProjectJson(sdlcDir, merged);
  return path;
}

// ── prompt helpers ───────────────────────────────────────────────────

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolvePromise) => {
    rl.question(question, (ans) => { rl.close(); resolvePromise(ans.trim()); });
  });
}

async function pickPolicyName(existing) {
  process.stderr.write("\nAvailable policies:\n");
  for (const name of existing) process.stderr.write(`  • ${name}\n`);
  const ans = await prompt("\nType the policy name to use as this project's default: ");
  if (!ans) fail("no policy name provided.");
  if (!existing.includes(ans)) {
    fail(`policy "${ans}" not found in ${POLICIES_DIR}. Save it in the console first.`);
  }
  return ans;
}

// ── main flows ───────────────────────────────────────────────────────

async function scriptedFlow(policyName, repoRoot) {
  const existing = listPolicies();
  if (!existing.includes(policyName)) {
    fail(`policy "${policyName}" not found in ${POLICIES_DIR}. Available: ${existing.join(", ")}`);
  }
  const path = saveDefaultPolicy(repoRoot, policyName);
  log(`wrote default_policy="${policyName}" to ${path}`);
}

async function printOnlyFlow(repoRoot) {
  const existing = readProjectJson(join(repoRoot, ".sdlc"));
  const name = existing.default_policy ?? null;
  process.stdout.write((name ?? "") + "\n");
}

async function interactiveFlow(repoRoot, args) {
  if (!existsSync(CONSOLE_DIR)) {
    fail(`policy console not found at ${CONSOLE_DIR}.`);
  }

  const before = snapshotPolicies();

  if (!args.skipInstall && !existsSync(join(CONSOLE_DIR, "node_modules"))) {
    log("running npm install in the policy console (first-time only)…");
    const install = spawnSync("npm", ["install", "--silent"], { cwd: CONSOLE_DIR, stdio: "inherit" });
    if (install.status !== 0) fail("npm install failed in the policy console.");
  }

  const port = await findFreePort(DEFAULT_PORT);
  log(`starting policy console on http://localhost:${port} …`);

  const server = spawn("npm", ["run", "dev"], {
    cwd: CONSOLE_DIR,
    env: { ...process.env, PORT: String(port), BROWSER: "none" },
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });
  server.on("error", (e) => fail(`could not start dev server: ${e.message}`));

  const cleanup = () => { try { server.kill("SIGTERM"); } catch { /* already dead */ } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const url = `http://localhost:${port}`;
  const ready = await waitForServer(port, SERVER_READY_TIMEOUT_MS);
  if (!ready) fail(`dev server did not become ready in ${SERVER_READY_TIMEOUT_MS / 1000}s.`);

  if (!args.noBrowser) openBrowser(url);
  else log(`open ${url} in your browser.`);

  process.stderr.write("\n");
  process.stderr.write(`  → Configure your policy in the browser, then click Save.\n`);
  process.stderr.write(`  → When done, return here and press Enter.\n`);
  process.stderr.write(`  → To skip and use the shipped opus-plus-flash preset, press Enter without saving.\n\n`);
  await prompt("Press Enter when ready: ");

  const { added, modified } = diffPolicies(before);
  const candidates = [...added, ...modified];

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
    log(`detected saved policy: "${chosen}"`);
  } else if (candidates.length === 0) {
    log("no new policy detected — pick from the existing list or skip to defaults.");
    const existing = listPolicies();
    chosen = await pickPolicyName(existing);
  } else {
    log(`multiple new/modified policies detected: ${candidates.join(", ")}`);
    chosen = await pickPolicyName(candidates);
  }

  const path = saveDefaultPolicy(repoRoot, chosen);
  log(`wrote default_policy="${chosen}" to ${path}`);
  cleanup();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();

  if (args.printOnly) return printOnlyFlow(repoRoot);
  if (args.policy) return scriptedFlow(args.policy, repoRoot);
  return interactiveFlow(repoRoot, args);
}

main().catch((e) => fail(e?.message ?? String(e)));
