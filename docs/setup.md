# Setup

Everything you need to prepare your machine for a study run.

## Prerequisites

- **Node.js 20 or newer.** Verify with `node --version`.
- **Claude Code CLI.** Install with:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
  Verify with `claude --version`.
- **A macOS or Linux shell.** Windows via WSL2 also works.

## Anthropic (Claude) authentication — you pick the mode

The setup wizard (`tools/setup.mjs`) asks you **explicitly** which mode to use. There is no auto-detection based on whether `ANTHROPIC_API_KEY` happens to be exported in your shell — that was the old behavior and it caused two people running the same command to get different numbers without realizing why. The wizard now saves your choice to `.workforce-ops-mode` at the repo root; the orchestrator reads that file on every run.

### Option V — Vendor-authoritative (recommended for reproducibility)

Prerequisite: an Anthropic API key. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys), then before running the wizard:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Pick **V** when the wizard asks. The orchestrator routes **every** LLM call through the MCP server, which hits Anthropic's API directly. Every event on the report carries vendor-reported tokens. The final total will match your `console.anthropic.com` dashboard for the run's time window, to within a few cents.

### Option E — Estimator (works with a Claude Code subscription, no API key)

If you have a Claude Pro / Team / Enterprise subscription and you'd rather not set an API key, sign in to Claude Code once:

```bash
claude
# follow the interactive login prompt
```

Pick **E** when the wizard asks. Direct-tier work (Opus phases) runs inside Claude Code's own conversation loop under your subscription; mechanical-tier work (Gemini under `opus-plus-flash`) still goes through the MCP server and carries vendor tokens.

Because the subagent can't read per-call `usage` from inside the Claude Code loop, direct-tier tokens are **char-count estimated** (≈3.8 chars/token) and multiplied by the policy YAML's `pricing:` block. The report labels the run "Estimator mode" and shows `E` next to the affected phases. Expect the total to diverge from the vendor-billed figures — that's inherent to estimation.

Both modes are legitimate. Pick based on what you need. See [methodology.md](methodology.md) for the full derivation and trade-off table.

### Changing your mind

Delete `.workforce-ops-mode` and re-run `node tools/setup.mjs`.

## Google (Gemini) authentication

Required **only** if you plan to run the `opus-plus-flash` policy — the mechanical phases dispatch to Gemini 3.5 Flash.

Get a free-tier API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), then export:

```bash
export GEMINI_API_KEY=...
```

If you only plan to run the `opus-only` policy, you can skip Gemini entirely.

## Install dependencies and register the plugin

From the repo root:

```bash
node tools/setup.mjs
```

The wizard verifies each prerequisite, installs and builds the bundled MCP server, and copies the slash command + orchestrator agent into `./.claude/` so Claude Code finds them in both interactive and headless modes. Nothing is written outside this repo except the newly built `plugin/mcp/gemini-flash-server/node_modules/` and `dist/`.

Once the wizard finishes successfully, you are ready to run. See [running.md](running.md).

## Troubleshooting

**`claude: command not found`** — global npm install path is likely not on your `PATH`. Check `npm root -g` and add its `bin/` directory to your `PATH`, or install Node via `nvm` which handles this for you.

**`Node ... — this repo needs Node 20 or newer`** — install a newer Node via [nodejs.org](https://nodejs.org) or `nvm install --lts`.

**MCP server build fails** — the `plugin/mcp/gemini-flash-server/` directory has its own `package.json`. Try running the install manually:
```bash
cd plugin/mcp/gemini-flash-server
npm install
npm run build
```
The build output goes to `dist/server.js`; if that exists, you are good.

**Rerun the wizard** — safe to run `node tools/setup.mjs` repeatedly. It skips steps that are already done.
