# Setup

Everything you need to prepare your machine for a run.

## Prerequisites

- **Node.js 20 or newer.** Verify with `node --version`.
- **Claude Code CLI.** Install with:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
  Verify with `claude --version`.
- **A macOS or Linux shell.** Windows via WSL2 also works.

## Anthropic (Claude) authentication

The auth mode is chosen per run via the `--auth` flag on `/run-sdlc-pass` (see [running.md](running.md)). The setup wizard does not persist a mode; it only checks which API keys are visible so you know which modes are available.

### `--auth=vendor` — Anthropic-billed, reconciles to the dashboard

Prerequisite: an Anthropic API key. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys), then export:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Under `--auth=vendor` the orchestrator dispatches **every** LLM call through the MCP server, which hits Anthropic's API directly. Every event on the report carries vendor-reported tokens. The final total matches your `console.anthropic.com` dashboard for the run's time window, to within a few cents.

### `--auth=estimated` — Claude Code subscription, no API key required

If you have a Claude Pro / Team / Enterprise subscription, sign in to Claude Code once:

```bash
claude
# follow the interactive login prompt
```

Under `--auth=estimated`, direct-tier work (Opus phases) runs inside Claude Code's own conversation loop under your subscription; mechanical-tier work (Gemini under `opus-plus-flash`) still goes through the MCP server and carries vendor tokens.

Because the subagent can't read per-call `usage` from inside the Claude Code loop, direct-tier tokens are char-count estimated (≈3.8 chars/token) and multiplied by the policy YAML's `pricing:` block. The report labels the run "Estimator mode" and shows `E` next to the affected phases; totals will diverge from a vendor-billed run.

See [methodology.md](methodology.md) for the derivation and trade-off table.

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

The wizard verifies each prerequisite, installs and builds the bundled MCP server, and copies the slash command + subagents into `./.claude/` so Claude Code finds them in both interactive and headless modes. Nothing is written outside this repo except the newly built `plugin/mcp/gemini-flash-server/node_modules/` and `dist/`.

Once the wizard finishes, you are ready to run. See [running.md](running.md).

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

**`/run-sdlc-pass requires --auth=vendor|estimated`** — the flag is not optional. Add `--auth=vendor` (if `ANTHROPIC_API_KEY` is exported) or `--auth=estimated` (if you're signed in to Claude Code) to the command.

**Rerun the wizard** — safe to run `node tools/setup.mjs` repeatedly. It skips steps that are already done.
