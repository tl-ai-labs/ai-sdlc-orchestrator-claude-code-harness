#!/usr/bin/env node
/**
 * setup.mjs — interactive onboarding for the AI-SDLC orchestrator harness.
 *
 * Walks the user through prerequisites (Node, Claude Code CLI, API keys),
 * installs the bundled MCP server's dependencies, and project-installs the
 * slash command + subagents into ./.claude/. Prints the next-step commands
 * for both auth modes. Every check has a friendly path forward.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── small helpers ────────────────────────────────────────────────────
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok    = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn  = (m) => console.log(`  ${c.amber}!${c.reset} ${m}`);
const fail  = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const step  = (n, m) => console.log(`\n${c.bold}[${n}]${c.reset} ${m}`);
const hint  = (m) => console.log(`  ${c.dim}${m}${c.reset}`);

const rl = createInterface({ input, output });
const ask = (q) => rl.question(`  ${c.dim}?${c.reset} ${q} `);

async function askYesNo(q, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${q} ${suffix}`)).trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function nodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}

// ─── main flow ────────────────────────────────────────────────────────
console.log(`\n${c.bold}AI-SDLC orchestrator — setup${c.reset}`);
console.log(`${c.dim}This wizard checks prerequisites and prepares your machine to run the pipeline.${c.reset}`);

step(1, "Node.js version");
const nv = nodeMajor();
if (nv >= 20) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} — this repo needs Node 20 or newer.`);
  hint("Install the latest LTS from https://nodejs.org, or via nvm: nvm install --lts");
  process.exit(1);
}

step(2, "Claude Code CLI");
if (which("claude")) {
  try {
    const v = execSync("claude --version", { encoding: "utf8" }).trim();
    ok(`Claude Code detected: ${v}`);
  } catch {
    ok("Claude Code CLI detected");
  }
} else {
  fail("Claude Code CLI not found on PATH.");
  hint("Install it and re-run this wizard:");
  hint("  npm install -g @anthropic-ai/claude-code");
  const proceed = await askYesNo("Continue setup anyway (you'll install it before running)?", false);
  if (!proceed) { rl.close(); process.exit(1); }
}

// ─── API keys — availability check, not a mode-selection step ─────────
// Auth mode is chosen per invocation via /run-sdlc-pass --auth=vendor|estimated
// and enforced by the orchestrator (rule 6). This step only reports what
// keys are visible so the user knows which mode is available to them.
step(3, "API keys — availability");
if (process.env.ANTHROPIC_API_KEY) {
  ok("ANTHROPIC_API_KEY is set — --auth=vendor is available.");
} else {
  hint("ANTHROPIC_API_KEY not set — --auth=vendor will abort until it is exported.");
  hint("  Get a key at https://console.anthropic.com/settings/keys, then:");
  hint("  export ANTHROPIC_API_KEY=sk-ant-...");
  hint("--auth=estimated works without an API key when signed in to a Claude Code subscription.");
}
if (process.env.GEMINI_API_KEY) {
  ok("GEMINI_API_KEY is set — opus-plus-flash policy is available.");
} else {
  hint("GEMINI_API_KEY not set. Only needed for the opus-plus-flash policy.");
  hint("  Free-tier key: https://aistudio.google.com/app/apikey");
}

step(4, "Bundled MCP server dependencies");
const mcpDir = join(ROOT, "plugin", "mcp", "gemini-flash-server");
const nodeMods = join(mcpDir, "node_modules");
if (existsSync(nodeMods) && existsSync(join(mcpDir, "dist", "server.js"))) {
  ok("MCP server already built.");
} else {
  console.log(`  Installing dependencies and building the MCP server...`);
  try {
    execSync("npm install", { cwd: mcpDir, stdio: "inherit" });
    execSync("npm run build", { cwd: mcpDir, stdio: "inherit" });
    ok("MCP server built successfully.");
  } catch {
    fail("MCP server build failed. See the output above.");
    hint("You can retry with: cd plugin/mcp/gemini-flash-server && npm install && npm run build");
    rl.close();
    process.exit(1);
  }
}

step(5, "Project-install the slash command + all subagents");
// Some Claude Code versions do not activate plugin-supplied commands or
// subagents when the user launches with a plain `claude` (no --plugin-dir).
// Project-installing everything into ./.claude/ makes both interactive and
// headless runs discover them without the flag.
const projClaude = join(ROOT, ".claude");
mkdirSync(join(projClaude, "commands"), { recursive: true });
mkdirSync(join(projClaude, "agents"),   { recursive: true });
copyFileSync(
  join(ROOT, "plugin", "commands", "run-sdlc-pass.md"),
  join(projClaude, "commands", "run-sdlc-pass.md"),
);
for (const a of ["orchestrator", "architect", "senior-reviewer", "security-reviewer"]) {
  copyFileSync(
    join(ROOT, "plugin", "agents", `${a}.md`),
    join(projClaude, "agents",   `${a}.md`),
  );
}
ok("Slash command + all subagents installed under ./.claude/");

// Register the bundled MCP server so plain `claude` (no --plugin-dir flag)
// discovers `mcp__gemini-flash-server__*` tools. Required for vendor mode
// dispatch and for opus-plus-flash's Gemini routing.
const mcpJsonPath = join(ROOT, ".mcp.json");
const mcpEntry = {
  mcpServers: {
    "gemini-flash-server": {
      command: "node",
      args: [join(ROOT, "plugin", "mcp", "gemini-flash-server", "dist", "server.js")],
      env: {
        ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
      },
    },
  },
};
writeFileSync(mcpJsonPath, JSON.stringify(mcpEntry, null, 2) + "\n");
ok(".mcp.json written — plain `claude` will discover the MCP server.");

step(6, "Ready");
console.log(`
  ${c.bold}Setup complete.${c.reset} Pick an auth mode per run via --auth on /run-sdlc-pass.

  ${c.bold}Interactive${c.reset} (recommended for first run — you see HITL gates):
    ${c.dim}# --permission-mode acceptEdits auto-approves file reads/writes${c.reset}
    ${c.dim}# inside this repo so the run only stops at the four HITL gates.${c.reset}
    claude --permission-mode acceptEdits
    ${c.dim}# then at the prompt (vendor mode — needs ANTHROPIC_API_KEY):${c.reset}
    > /run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md
    ${c.dim}# or estimator mode (subscription auth, no API key required):${c.reset}
    > /run-sdlc-pass --auth=estimated --run-id=pass1 examples/workforce-ops/brief.md

  ${c.bold}Headless${c.reset} (unattended, captured to a log file):
    ${c.dim}# opus-only baseline under vendor mode${c.reset}
    claude --print "/run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > examples/workforce-ops/passes/pass1/live-run.log

    ${c.dim}# opus + Gemini Flash multi-model under vendor mode${c.reset}
    claude --print "/run-sdlc-pass --auth=vendor --policy=opus-plus-flash --run-id=pass2 examples/workforce-ops/brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > examples/workforce-ops/passes/pass2/live-run.log

  ${c.dim}Wall-clock per pass: about 1 – 1.5 hours.${c.reset}

  After a run finishes, print a summary with:
    node tools/report.mjs examples/workforce-ops/passes/pass1

  To run the pipeline against a brief other than the shipped one, copy
  docs/brief-template.md, fill it in, and invoke:
    /run-sdlc-pass --auth=vendor --study=<your-project> --run-id=pass1 path/to/your-brief.md

  Full docs are in docs/. Start with docs/running.md.
`);

rl.close();
