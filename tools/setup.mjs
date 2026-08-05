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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// The plugin's own setup checker. Plain ESM with no build step and no
// side effects on import, so this wizard can borrow its logic instead of
// growing a second copy that drifts.
// `vertexCredentialState` and `inspectCredentialFile` are borrowed rather than
// re-implemented for a specific reason: this wizard used to decide the same
// question with its own one-line `existsSync(ADC) || GOOGLE_APPLICATION_CREDENTIALS`,
// which disagreed with the checker's version, so a machine could be told it had
// credentials by one script and not the other in the same install.
import {
  buildWorkerEnvironment,
  workerPaths,
  vertexCredentialState,
  inspectCredentialFile,
} from "../plugin/scripts/verify-setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Where `gcloud auth application-default login` writes user credentials.
// Same path as plugin/scripts/verify-setup.mjs `adcPath()` and the server's
// `defaultAdcPath()` — three copies because none of the three can import the
// others (different package roots, and this runs before the server is built).
const ADC_FILE = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

// ─── small helpers ────────────────────────────────────────────────────
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok    = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn  = (m) => console.log(`  ${c.amber}!${c.reset} ${m}`);
const fail  = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
// Steps number themselves. One of them is conditional — the Python worker is
// only built if the user asks for the agent path — and hand-numbered headings
// would either skip a number or lie about how many are left.
let stepNo = 0;
const step  = (m) => console.log(`\n${c.bold}[${++stepNo}]${c.reset} ${m}`);
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

step("Node.js version");
const nv = nodeMajor();
if (nv >= 20) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} — this repo needs Node 20 or newer.`);
  hint("Install the latest LTS from https://nodejs.org, or via nvm: nvm install --lts");
  process.exit(1);
}

step("Claude Code CLI");
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
step("API keys — availability");
if (process.env.ANTHROPIC_API_KEY) {
  ok("ANTHROPIC_API_KEY is set — --auth=vendor is available.");
} else {
  hint("ANTHROPIC_API_KEY not set — --auth=vendor will abort until it is exported.");
  hint("  Get a key at https://console.anthropic.com/settings/keys, then:");
  hint("  export ANTHROPIC_API_KEY=sk-ant-...");
  hint("--auth=estimated works without an API key when signed in to a Claude Code subscription.");
}
// Gemini is reachable through either of Google's two front doors, so report
// on both. The Google Cloud door needs no key at all — `gcloud auth
// application-default login` writes a credentials file under $HOME and the SDK
// signs with it — which is why an absent GEMINI_API_KEY is not, on its own, a
// problem.
//
// The state is computed once here and reused by the question below, so the two
// can never disagree about what this machine has.
const vertex = vertexCredentialState({
  env: process.env,
  serviceAccountFile: process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? inspectCredentialFile(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : null,
  adcFile: inspectCredentialFile(ADC_FILE),
});
const hasVertex = vertex.state === "credential";

if (hasVertex) {
  ok(`Google Cloud credentials found (${vertex.source}) — opus-plus-flash routes Gemini`);
  hint("  through Gemini Enterprise Agent Platform, the service formerly called Vertex AI.");
} else if (process.env.GEMINI_API_KEY) {
  ok("GEMINI_API_KEY is set — opus-plus-flash routes Gemini through AI Studio.");
} else if (vertex.state === "broken") {
  // Reported ahead of "no credentials", because it is a different problem with
  // a different fix: something IS configured, and it is the thing that is wrong.
  // The old check called existsSync and stopped, so this machine was reported as
  // fully set up and failed at the first Gemini call.
  warn("A Google credential is configured but cannot be used:");
  hint(`  ${vertex.detail}`);
  hint("  Fix that file, or run: gcloud auth application-default login");
} else {
  hint("No Gemini credentials. Only needed for the opus-plus-flash policy.");
  hint("  Google Cloud (no key): gcloud auth application-default login");
  hint("  AI Studio key:         https://aistudio.google.com/app/apikey");
  if (vertex.state === "project-only") {
    // GOOGLE_CLOUD_PROJECT is set and nothing else. It is the variable every
    // Google Cloud tutorial names first, so it is easy to believe it is enough.
    hint(`  GOOGLE_CLOUD_PROJECT is set ('${process.env.GOOGLE_CLOUD_PROJECT}'), but a project ID`);
    hint("  says where to bill, not who is asking — it is not a credential on its own.");
  }
}

// ─── how Gemini works on the mechanical tier ──────────────────────────
// Asked here, once, because it is the only question in this wizard whose
// answer changes what has to be INSTALLED. The agent path runs a Python
// worker; the model path does not, and someone on the model path should
// never be walked through a virtualenv they will not use.
//
// Skipped entirely when no Gemini credentials are visible: the question is
// "which of two Gemini doors", and someone with neither is not going through
// either. They can re-run this wizard after `gcloud auth application-default
// login`. Also skipped for AI-Studio-key-only setups — the Antigravity SDK
// signs with Application Default Credentials and has no API-key door, so
// offering the agent path there would be offering something that cannot work.
step("How Gemini works on the mechanical tier");
let geminiAsAgent = false;
if (!hasVertex) {
  // The Antigravity SDK signs with application default credentials and has no
  // API-key branch, so this is not a question worth asking here — the agent
  // path could not work whichever way it was answered.
  hint("No Google Cloud credentials, so the mechanical tier has one door for now.");
  hint("  The other one — Gemini as an agent, through the Antigravity SDK — signs with");
  hint("  Google Cloud credentials only. To open it later:");
  hint("    gcloud auth application-default login");
  hint("    npm run verify -- --enable-agent");
} else {
  // Both doors lead to the same Google Cloud project and the same bill. What
  // differs is what is on the other side: a model that answers, or an agent that
  // works. The platform is named the way Google names it today, with the old
  // name in brackets — this repo was written when it was Vertex AI, the API
  // surface still says `vertex`, and most people's muscle memory still says
  // Vertex too.
  console.log(`
  Gemini can work two ways here. Both bill the same Google Cloud project.

    ${c.bold}As a model${c.reset}  — through ${c.bold}Gemini Enterprise Agent Platform${c.reset} (formerly Vertex AI),
                  Google's own API for the model. Claude reads your code and sends
                  it over, Gemini sends text back. Cheap and predictable: one
                  request, one answer, per task. Nothing to install.

    ${c.bold}As an agent${c.reset} — through Google's ${c.bold}Antigravity SDK${c.reset}, signing against that same
                  project. Gemini opens the folder itself, runs commands and edits
                  files, and Claude reviews the result. It needs Python 3.10+ and
                  the Antigravity SDK, a Python package this wizard installs for
                  you. It costs several times more per task: an agent re-sends the
                  whole conversation on every tool call, on top of a fixed
                  multi-thousand-token preamble it carries every turn.

  The model path is the default, and it is the right answer for most work. Pick
  the agent path when you want Gemini to do the work rather than describe it.
`);
  // Named as a command rather than as a file to edit. The selection is spelled
  // `slot=option` and the slot is the half nobody guesses, so every route to it
  // that ends in "open this file and type the value" produces the same silent
  // failure: a plausible-looking spec that no policy can resolve.
  hint("You can change this later, either way round:");
  hint("  npm run verify -- --enable-agent    # agent path (builds what it needs)");
  hint("  npm run verify -- --disable-agent   # back to the model path");
  geminiAsAgent = await askYesNo("Set up the Antigravity SDK agent path as well?", false);
  if (geminiAsAgent) {
    ok("Antigravity SDK agent path selected — this wizard will build the Python worker environment.");
  } else {
    ok("Model path selected — no Python needed.");
  }
}

step("Bundled MCP server dependencies");
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

// ─── the agent worker's Python environment ────────────────────────────
// Only reached when the agent path was chosen above.
//
// The work itself lives in verify-setup.mjs, imported rather than repeated,
// because both installation routes have to be able to build this environment
// and only one of them can see this file: a `/plugin install` puts the plugin
// in Claude Code's cache with no tools/ directory, so its users reach the same
// function through `verify-setup.mjs --fix`. One implementation means the two
// routes cannot drift into producing different environments.
if (geminiAsAgent) {
  step("Antigravity agent worker (Python)");
  const { venvPython } = workerPaths(join(ROOT, "plugin"));
  if (existsSync(venvPython)) {
    // Present is not the same as working, and this wizard deliberately does not
    // spend a subprocess finding out — `npm run verify` already does exactly
    // that check, quotes the interpreter's error, and repairs it. Pointing
    // there is cheaper than duplicating it, and keeps one repair path.
    ok("Worker environment already present.");
    hint("If the agent path later fails to start: npm run verify -- --fix");
  } else {
    const built = buildWorkerEnvironment(join(ROOT, "plugin"), (m) => console.log(m));
    if (built.ok) {
      ok(`Antigravity SDK installed into the worker's own environment — ${built.detail}.`);
    } else {
      fail(built.detail.split("\n")[0]);
      for (const line of built.detail.split("\n").slice(1)) hint(line);
      if (built.reason === "no-python") hint("  brew install python@3.12   # then: npm run setup");
      warn("Continuing on the model path — nothing else in this wizard needs Python.");
      // Not merely cosmetic: this flag also decides whether SDLC_SELECT is
      // written below. Leaving it true would hand the user a config that
      // routes every mechanical task to a worker that cannot start.
      geminiAsAgent = false;
    }
  }
}

step("Project-install the slash command + all subagents");
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
// discovers its tools. Required for vendor mode dispatch and for
// opus-plus-flash's Gemini routing.
//
// The bare key below is what makes this the *clone* route: a server registered
// through a project `.mcp.json` keeps its key verbatim, so its tools surface as
// `mcp__gemini-flash-server__*`. The plugin route does not — Claude Code
// namespaces a plugin-provided MCP server with the plugin's own name, so
// `/plugin install` yields `mcp__plugin_multi-model-orchestrator_gemini-flash-server__*`
// instead. The orchestrator's frontmatter grants both spellings for exactly
// this reason; see "The MCP tool names depend on how the plugin was installed"
// in plugin/agents/orchestrator.md. Do not "simplify" either side to one name.
const mcpJsonPath = join(ROOT, ".mcp.json");
const mcpEntry = {
  mcpServers: {
    "gemini-flash-server": {
      command: "node",
      args: [join(ROOT, "plugin", "mcp", "gemini-flash-server", "dist", "server.js")],
      // A stdio MCP server does not inherit the full parent environment, so
      // every variable the server reads has to be forwarded explicitly. The
      // Google block covers the Vertex door: a service-account file, the
      // billing project, the region, and the backend override. None is
      // required — with a plain `gcloud auth application-default login` the
      // server finds the credentials file under $HOME and reads the project
      // out of it — but a service-account or multi-project setup needs them.
      env: {
        ...Object.fromEntries(
          [
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GEMINI_BACKEND",
            "SDLC_SELECT",
            "GEMINI_WORKER_PYTHON",
          ]
            .filter((name) => process.env[name])
            .map((name) => [name, process.env[name]]),
        ),
        // The answer to the one question above, written down rather than left
        // in this shell. It has to outlive the wizard — the server is launched
        // by Claude Code minutes or days later, from an environment that never
        // saw the answer — and it belongs beside the other run settings so a
        // reader can see which tier a run used without being told.
        //
        // Written only on the agent path, so the file a model-path user gets is
        // byte-identical to the one they got before this question existed. The
        // spread order matters: this wins over an inherited SDLC_SELECT, because
        // the answer given ten seconds ago is the more recent statement of intent.
        ...(geminiAsAgent ? { SDLC_SELECT: "gemini-flash=flash-agsdk-worker" } : {}),
      },
    },
  },
};
writeFileSync(mcpJsonPath, JSON.stringify(mcpEntry, null, 2) + "\n");
ok(".mcp.json written — plain `claude` will discover the MCP server.");
if (geminiAsAgent) {
  ok("Mechanical tier set to the agent path (SDLC_SELECT=gemini-flash=flash-agsdk-worker).");
  hint("  To go back to the model path: npm run verify -- --disable-agent");
}

step("Ready");
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
