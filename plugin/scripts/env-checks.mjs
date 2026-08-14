#!/usr/bin/env node
/**
 * Environment prerequisite checks for brownfield mode. Runs in prompt-1
 * section 2 (§23) as part of the setup shepherd flow. Also invocable
 * standalone for CI/headless use.
 *
 * Checks:
 *   1. Node ≥ 20
 *   2. Git ≥ 2.30
 *   3. Filesystem write permission on ~/.claude
 *   4. Filesystem write permission on .sdlc/ (if inside a repo)
 *   5. Plugin command-name conflicts (best-effort — Claude Code has no
 *      documented enumeration API, so we read ~/.claude/plugins/ manifests
 *      if present and check for command-name collisions)
 *
 * Every check is fail-tolerant: catches its own errors, returns a
 * structured result. The overall exit code:
 *   0 — all checks passed OR all failures are advisory (warn-level)
 *   1 — one or more hard-blocker failures (missing Node/git, unwritable
 *       .sdlc, real plugin conflict)
 *
 * Output on stdout: JSON per --json / structured text per --text (default text).
 *
 * Usage:
 *   node env-checks.mjs              # text output, exit 0/1
 *   node env-checks.mjs --json       # JSON output
 *   node env-checks.mjs --headless   # never prompts; same as default for now
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";

// Our own command names — hardcoded because we OWN them. If a future ticket
// adds one, add it here so conflict detection stays honest.
const OUR_COMMAND_NAMES = new Set([
  "run",           // greenfield
  "pass",          // headless / scripted
  "brownfield",    // existing repo
  "revert",        // undo a brownfield run
  "setup",         // one-shot setup
  "policy",        // show / change policy
]);

const MIN_NODE_MAJOR = 20;
const MIN_GIT_VERSION = [2, 30]; // [major, minor]

// ─── check helpers ───────────────────────────────────────────────────

function check(id, severity, ok, details = {}) {
  return { id, severity, ok, ...details };
}

function parseSemverLike(text) {
  const m = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? "0", 10)];
}

function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ─── individual checks ───────────────────────────────────────────────

function checkNodeVersion() {
  const ver = parseSemverLike(process.versions.node) ?? [0];
  const ok = ver[0] >= MIN_NODE_MAJOR;
  return check("node-version", "blocker", ok, {
    detected: process.versions.node,
    required_min: `${MIN_NODE_MAJOR}.0.0`,
    remediation: ok ? null : [
      "The plugin's scripts and MCP server need Node 20 or newer.",
      "Upgrade with one of:",
      "  • nvm install 20 && nvm use 20    (if you have nvm)",
      "  • brew install node@20            (macOS with brew)",
      "  • Download from https://nodejs.org",
      "Re-run this check after upgrading.",
    ],
  });
}

function checkGitVersion() {
  const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) {
    return check("git-version", "blocker", false, {
      detected: null,
      required_min: MIN_GIT_VERSION.join("."),
      remediation: [
        "git is not on your PATH.",
        "Install it: macOS → xcode-select --install · Ubuntu → sudo apt install git · Windows → https://git-scm.com",
        "Re-run this check after installing.",
      ],
    });
  }
  const ver = parseSemverLike(r.stdout);
  if (!ver) {
    return check("git-version", "blocker", false, {
      detected: r.stdout.trim(),
      required_min: MIN_GIT_VERSION.join("."),
      remediation: ["Could not parse git version. Re-check `git --version` output."],
    });
  }
  const ok = cmpVer(ver, MIN_GIT_VERSION) >= 0;
  return check("git-version", "blocker", ok, {
    detected: ver.join("."),
    required_min: MIN_GIT_VERSION.join("."),
    remediation: ok ? null : [
      `Git ${ver.join(".")} is older than the required ${MIN_GIT_VERSION.join(".")}.`,
      "Upgrade: macOS → brew upgrade git · Ubuntu → sudo apt update && sudo apt install git",
      "Re-run this check after upgrading.",
    ],
  });
}

function checkClaudeDirWritable() {
  const dir = join(homedir(), ".claude");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return check("claude-dir-writable", "blocker", true, { path: dir });
  } catch (e) {
    return check("claude-dir-writable", "blocker", false, {
      path: dir,
      error: e?.message ?? String(e),
      remediation: [
        `Cannot write to ${dir}.`,
        "Check the directory's permissions:",
        `  ls -ld "${dir}"`,
        "Fix ownership if needed:",
        `  sudo chown -R $USER "${dir}"`,
      ],
    });
  }
}

function checkSdlcDirWritable() {
  const root = findRepoRoot();
  if (!root) {
    return check("sdlc-dir-writable", "advisory", true, {
      note: "Not in a git repo — .sdlc/ writability check deferred to first /sdlc:brownfield invocation in a project.",
    });
  }
  const dir = join(root, ".sdlc", "local");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return check("sdlc-dir-writable", "blocker", true, { path: dir });
  } catch (e) {
    return check("sdlc-dir-writable", "blocker", false, {
      path: dir,
      error: e?.message ?? String(e),
      remediation: [
        `Cannot create/write ${dir}.`,
        "The plugin needs this directory to persist per-run state.",
        `Check permissions on ${root} and its .sdlc/ subtree.`,
      ],
    });
  }
}

/**
 * Best-effort scan for plugin command-name conflicts. Claude Code has no
 * documented enumeration API, so we walk ~/.claude/plugins/ if it exists
 * and look at each plugin's .claude-plugin/plugin.json to see whether it
 * ships commands with the same names we do.
 *
 * If we can't enumerate (dir missing, unreadable), we return advisory —
 * the check couldn't run, and we shouldn't block on a check we can't
 * complete. False negatives are OK; false positives would be worse.
 */
function checkPluginConflicts() {
  const pluginsRoot = join(homedir(), ".claude", "plugins");
  if (!existsSync(pluginsRoot)) {
    return check("plugin-conflicts", "advisory", true, {
      note: "No ~/.claude/plugins/ directory — nothing else installed.",
    });
  }

  const conflicts = [];
  const scanned = [];

  let dirents;
  try {
    dirents = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch (e) {
    return check("plugin-conflicts", "advisory", true, {
      note: `~/.claude/plugins/ unreadable (${e?.message ?? "error"}) — skipping conflict scan.`,
    });
  }

  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;

    // Two common shapes: <plugins>/<plugin-name>/.claude-plugin/plugin.json
    // OR <plugins>/<marketplace>/<plugin>/.claude-plugin/plugin.json
    const candidates = [];
    const first = join(pluginsRoot, ent.name);
    candidates.push(join(first, ".claude-plugin", "plugin.json"));
    try {
      const inner = readdirSync(first, { withFileTypes: true });
      for (const i of inner) {
        if (i.isDirectory() && !i.name.startsWith(".")) {
          candidates.push(join(first, i.name, ".claude-plugin", "plugin.json"));
        }
      }
    } catch { /* skip */ }

    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const st = statSync(p);
        if (st.size > 1024 * 1024) continue;
        const manifest = JSON.parse(readFileSync(p, "utf8"));
        const pluginName = manifest?.name ?? ent.name;
        // Skip ourselves
        if (pluginName === "sdlc") continue;
        scanned.push({ plugin: pluginName, manifest: p });

        // Commands can be declared as an array of { name } or as a `commands: "./dir"` pointer.
        // We check the manifest's declared array, then (best-effort) list files in the pointed dir.
        const declared = Array.isArray(manifest?.commands) ? manifest.commands : [];
        for (const cmd of declared) {
          const name = typeof cmd === "string" ? cmd : cmd?.name;
          if (name && OUR_COMMAND_NAMES.has(name)) {
            conflicts.push({ command: name, other_plugin: pluginName, manifest: p });
          }
        }

        if (typeof manifest?.commands === "string") {
          const cmdDir = resolve(dirname(p), "..", manifest.commands);
          try {
            for (const f of readdirSync(cmdDir)) {
              if (!f.endsWith(".md")) continue;
              const name = f.slice(0, -3);
              if (OUR_COMMAND_NAMES.has(name)) {
                conflicts.push({ command: name, other_plugin: pluginName, manifest: p });
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  if (conflicts.length === 0) {
    return check("plugin-conflicts", "advisory", true, {
      scanned: scanned.length,
      note: `Scanned ${scanned.length} other plugin${scanned.length === 1 ? "" : "s"}, no command-name conflicts.`,
    });
  }

  return check("plugin-conflicts", "blocker", false, {
    conflicts,
    remediation: [
      `Detected ${conflicts.length} command-name conflict${conflicts.length === 1 ? "" : "s"}:`,
      ...conflicts.map((c) => `  · /${c.command} is also declared by plugin "${c.other_plugin}"`),
      "Two plugins can't register the same slash command. Options:",
      "  1) Uninstall the conflicting plugin: /plugin uninstall <name>",
      "  2) Ask that plugin's maintainer to rename their command",
    ],
  });
}

// ─── main ────────────────────────────────────────────────────────────

const CHECKS = [
  checkNodeVersion,
  checkGitVersion,
  checkClaudeDirWritable,
  checkSdlcDirWritable,
  checkPluginConflicts,
];

function parseArgs(argv) {
  const args = { json: false, headless: false };
  for (const a of argv.slice(2)) {
    if (a === "--json") args.json = true;
    else if (a === "--headless") args.headless = true;
  }
  return args;
}

function renderText(report) {
  const lines = [];
  for (const r of report.checks) {
    const status = r.ok ? "✓" : (r.severity === "blocker" ? "✗" : "⚠");
    lines.push(`${status} ${r.id}: ${r.ok ? "ok" : (r.severity + " — " + (r.error ?? "failed"))}`);
    if (!r.ok && Array.isArray(r.remediation)) {
      for (const line of r.remediation) lines.push("    " + line);
    }
    if (r.note) lines.push("    " + r.note);
  }
  const summary = report.blockers > 0
    ? `\nFAILED — ${report.blockers} blocker(s), ${report.advisories} advisory item(s).`
    : `\nPASSED${report.advisories ? ` (${report.advisories} advisory item(s))` : ""}.`;
  return lines.join("\n") + summary + "\n";
}

function main() {
  const args = parseArgs(process.argv);
  const results = CHECKS.map((fn) => {
    try { return fn(); }
    catch (e) { return { id: fn.name, severity: "blocker", ok: false, error: e?.message ?? String(e) }; }
  });
  const blockers = results.filter((r) => !r.ok && r.severity === "blocker").length;
  const advisories = results.filter((r) => !r.ok && r.severity === "advisory").length;
  const report = {
    schema_version: 1,
    ok: blockers === 0,
    blockers,
    advisories,
    checks: results,
    headless: args.headless,
  };
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(renderText(report));
  process.exit(blockers === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({ schema_version: 1, ok: false, error: e?.message ?? String(e) }) + "\n");
  process.exit(1);
}
