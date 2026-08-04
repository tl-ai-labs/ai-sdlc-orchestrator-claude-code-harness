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

The auth mode is chosen per run: `/sdlc-run` asks you and recommends one based on the credentials it finds, and `/run-sdlc-pass` takes it from the `--auth` flag (see [running.md](running.md)). The setup wizard does not persist a mode; it only checks which API keys are visible so you know which modes are available.

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

Google exposes Gemini through two front doors. Either one works; the server detects which credentials are present and uses that door.

**Vertex AI — if you have a Google Cloud project.** No API key. Authenticate once and the SDK signs every request with those credentials; the calls bill your project.

```bash
gcloud auth application-default login
```

The billing project is read from the credentials file that command writes. If your account has more than one project, or you authenticate with a service account instead, name it explicitly:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
```

`GOOGLE_CLOUD_LOCATION` selects the Vertex endpoint. It defaults to `global`, and that default is deliberate: Vertex bills regional endpoints **+10% on every token class** for Gemini 3 and later ([Vertex pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), effective 2026-07-01), while the rates pinned in the policy files are the flat global ones. On the default the cost this plugin reports is the cost Google bills.

Pin a region if you need quota or latency the global endpoint cannot give you — the surcharge is then included in the reported cost rather than ignored, so your numbers stay honest either way.

**AI Studio — if you do not.** Get an API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), then export:

```bash
export GEMINI_API_KEY=...
```

If both are present the API key wins, on the reasoning that exporting one is a deliberate choice for this shell while Google Cloud credentials are frequently just ambient machine state. Set `GEMINI_BACKEND=vertex` or `GEMINI_BACKEND=api-key` to override the detection.

If you only plan to run the `opus-only` policy, you can skip Gemini entirely.

**Where you export matters if you installed the plugin rather than cloning.** The `export` lines above assume you launch `claude` from that same shell, which is the clone route. Claude Code started from the desktop app inherits no login shell, so nothing exported in a terminal or written to `~/.zshrc` reaches it. On that route, put the variables in the `env` block of `~/.claude/settings.json`, which Claude Code reads at startup and passes through to the bundled server — or use the Vertex door, which involves no variable at all: `gcloud auth application-default login` writes a credentials file at a fixed path that the server reads directly, taking the project from that file's quota project.

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

**`this run requires auth_mode=vendor|estimated`** — the run reached the orchestrator without a mode. On `/run-sdlc-pass` the `--auth` flag is not optional: add `--auth=vendor` (if `ANTHROPIC_API_KEY` is exported) or `--auth=estimated` (if you're signed in to Claude Code). `/sdlc-run` asks for the mode, so seeing this from `/sdlc-run` means the answer was not carried through — start the command again.

**`Pre-flight failed` before phase 1** — the orchestrator's first act is a free `preflight_dispatch` call that constructs an adapter for every model in the policy without making an API call. Its `halt_reason` names the models this run needs and could not reach, and why. This deliberately stops the run at second zero: adapters are otherwise built lazily, on first use, so a credential problem affecting only the mechanical tier would surface at the codegen phase — after the premium-tier phases had already been billed, and with every remaining packet silently falling back to the premium model. Fix what it names, then start the run again.

**Pre-flight reports a `warnings` entry but the run starts anyway** — that is correct, not a missed error. What is checked depends on the run's auth mode. Under `--auth=vendor` every model is dispatched through the server, so every model's credential must work. Under `--auth=estimated` the premium phases run inside Claude Code on your subscription and that adapter is never constructed, so an unset `ANTHROPIC_API_KEY` cannot affect the run — pre-flight says so and continues. The warning is still printed because it is true of the *policy*: the same run under `--auth=vendor` would not start. Only a model this run actually dispatches to can halt it.

**`env-placeholders` warning from the verify script** — one or more of the variables the plugin forwards (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_BACKEND`) reached the server as the literal text `${NAME}` rather than a value. The plugin manifest declares them as pass-throughs from the host; when the host never set one, the placeholder is forwarded verbatim instead of being dropped. The server discards those values at startup and falls back to Application Default Credentials, so nothing runs on a garbage credential — but the variable you believed was set is not in play. Set it where Claude Code can see it, per the note above about the `env` block of `~/.claude/settings.json`.

**Rerun the wizard** — safe to run `node tools/setup.mjs` repeatedly. It skips steps that are already done.
