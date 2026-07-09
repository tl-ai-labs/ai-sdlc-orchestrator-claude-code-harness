#!/usr/bin/env node
/**
 * setup.mjs — interactive onboarding for the Workforce Ops study.
 *
 * Walks the user through prerequisites (Node, Claude Code CLI, API keys),
 * installs the bundled MCP server's dependencies, project-installs the
 * slash command + orchestrator subagent into ./.claude/, and prints the
 * next-step commands. Every check has a friendly path forward — never
 * throws a raw error at the user.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
console.log(`\n${c.bold}Workforce Ops — self-run setup${c.reset}`);
console.log(`${c.dim}This wizard checks prerequisites and prepares your machine to run the study.${c.reset}`);

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

// ─── Auth mode — user picks explicitly ───────────────────────────────
// The mode is the load-bearing authenticity decision on this repo — it
// determines whether the report's dollars are Anthropic-billed or
// char-count-estimated. We do NOT infer from ANTHROPIC_API_KEY presence,
// because many devs have that env var exported for unrelated reasons and
// would silently get a different report than they expected. The choice
// gets persisted to `.workforce-ops-mode` at the repo root and the
// orchestrator (rule 6 in plugin/agents/orchestrator.md) reads it there.
step(3, "Auth mode — pick how this run's numbers get produced");
console.log(`  Two modes. Pick the one that matches how you want to be billed and reported.`);
console.log(``);
console.log(`  ${c.bold}(V) Vendor-authoritative${c.reset} — needs an Anthropic API key.`);
console.log(`      Every LLM call is billed to your Anthropic account. The report's dollar`);
console.log(`      totals will match your console.anthropic.com dashboard for the run's`);
console.log(`      time window, to within a few cents. This is the mode our published`);
console.log(`      numbers on studies.ai-sdlc.tilicho.in were produced under; picking it`);
console.log(`      is the way to reproduce them.`);
console.log(``);
console.log(`  ${c.bold}(E) Estimator${c.reset} — uses your Claude Code subscription for direct-tier work.`);
console.log(`      No Anthropic API key needed. Direct-tier tokens (Opus phases) are`);
console.log(`      char-count estimated at ~3.8 chars/token because Claude Code's`);
console.log(`      subscription loop doesn't expose per-call usage. Expect the report`);
console.log(`      to differ from published vendor-mode numbers by roughly ±15%.`);
console.log(``);

const modeAns = (await ask("Pick a mode [V/E]")).trim().toLowerCase();
let mode;
if (modeAns === "v" || modeAns === "vendor") {
  mode = "vendor";
} else if (modeAns === "e" || modeAns === "estimated" || modeAns === "estimator") {
  mode = "estimated";
} else {
  fail(`Unrecognized choice "${modeAns}". Enter V or E.`);
  rl.close();
  process.exit(1);
}

if (mode === "vendor") {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("Vendor mode picked, but ANTHROPIC_API_KEY is not set in this shell.");
    hint("Get a key at https://console.anthropic.com/settings/keys, then:");
    hint("  export ANTHROPIC_API_KEY=sk-ant-...");
    hint("Then re-run this wizard. (I did not save the mode file — nothing to undo.)");
    rl.close();
    process.exit(1);
  }
  writeFileSync(join(ROOT, ".workforce-ops-mode"), "vendor\n");
  ok(`${c.bold}Vendor-authoritative mode${c.reset} saved to .workforce-ops-mode.`);
  console.log(`  Every event will carry Anthropic-reported tokens and provenance: "vendor".`);
} else {
  writeFileSync(join(ROOT, ".workforce-ops-mode"), "estimated\n");
  ok(`${c.bold}Estimator mode${c.reset} saved to .workforce-ops-mode.`);
  console.log(`  Direct-tier tokens are char/3.8 estimated; MCP-dispatched calls`);
  console.log(`  (e.g. Gemini under opus-plus-flash) still carry vendor-reported tokens.`);
  console.log(`  The report will label the run "Estimator mode" and show E next to affected phases.`);
  if (process.env.ANTHROPIC_API_KEY) {
    hint("ANTHROPIC_API_KEY is set in your environment but will be ignored in this mode.");
  }
}

// ─── Gemini auth — only needed for opus-plus-flash ───────────────────
step(4, "Gemini auth — status");
if (process.env.GEMINI_API_KEY) {
  ok("GEMINI_API_KEY is set. You can run either opus-only or opus-plus-flash.");
} else {
  ok("GEMINI_API_KEY not set. This is fine for opus-only (the default).");
  hint("Set GEMINI_API_KEY only if you plan to run opus-plus-flash. Free-tier key: https://aistudio.google.com/app/apikey");
}

step(5, "Bundled MCP server dependencies");
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

step(6, "Project-install the slash command + all subagents");
// Some Claude Code versions do not activate plugin-supplied commands or
// subagents when the user launches with a plain `claude` (no --plugin-dir).
// We project-install everything into ./.claude/ so both interactive and
// headless runs discover them without requiring the flag.
const projClaude = join(ROOT, ".claude");
mkdirSync(join(projClaude, "commands"), { recursive: true });
mkdirSync(join(projClaude, "agents"),   { recursive: true });
copyFileSync(
  join(ROOT, "plugin", "commands", "run-sdlc-pass.md"),
  join(projClaude, "commands", "run-sdlc-pass.md"),
);
// All four subagents — the orchestrator delegates to the other three at
// specific phases, so all of them must resolve from ./.claude/agents/.
for (const a of ["orchestrator", "architect", "senior-reviewer", "security-reviewer"]) {
  copyFileSync(
    join(ROOT, "plugin", "agents", `${a}.md`),
    join(projClaude, "agents",   `${a}.md`),
  );
}
ok("Slash command + all subagents installed under ./.claude/");

// Register the bundled MCP server at the repo root so plain `claude`
// (no --plugin-dir flag) discovers `mcp__gemini-flash-server__*` tools.
// This is what closes the loop for vendor-authoritative mode — without
// it, the orchestrator's dispatch calls resolve to "tool not in toolset"
// and the run either flails or silently falls back to estimator behavior.
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

step(7, "Ready");
console.log(`
  ${c.bold}You are set up.${c.reset} Two ways to run — pick one:

  ${c.bold}Interactive${c.reset} (recommended for first run — you see HITL gates):
    ${c.dim}# --permission-mode acceptEdits auto-approves file reads/writes${c.reset}
    ${c.dim}# inside this repo so the run only stops at the four HITL gates.${c.reset}
    claude --permission-mode acceptEdits
    ${c.dim}# then at the prompt:${c.reset}
    > /run-sdlc-pass --run-id=pass1 brief.md

  ${c.bold}Headless${c.reset} (unattended, captured to a log file):
    ${c.dim}# opus-only baseline${c.reset}
    claude --print "/run-sdlc-pass --run-id=pass1 brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > passes/pass1/live-run.log

    ${c.dim}# opus + Gemini Flash multi-model${c.reset}
    claude --print "/run-sdlc-pass --policy=opus-plus-flash --run-id=pass2 brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > passes/pass2/live-run.log

  ${c.dim}Expected wall-clock: 1 – 1.5 hours per pass.${c.reset}

  After a run finishes, print a summary with:
    node tools/report.mjs passes/pass1

  Full docs are in docs/. Start with docs/running.md.
`);

rl.close();
