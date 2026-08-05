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

**Gemini Enterprise Agent Platform — if you have a Google Cloud project.** This is the service Google renamed from Vertex AI. Both names are still in circulation and you will meet the old one constantly, because the API surface, the client libraries and the pricing pages all still say `vertex` — so does this repo's own configuration, deliberately, since renaming a field name would break every existing install for a cosmetic gain. No API key is involved: authenticate once and the SDK signs every request with those credentials, and the calls bill your project.

```bash
gcloud auth application-default login
```

The billing project is read from the credentials file that command writes. If your account has more than one project, or you authenticate with a service account instead, name it explicitly:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
```

`GOOGLE_CLOUD_LOCATION` selects the platform endpoint. It defaults to `global`, and that default is deliberate: Google bills regional endpoints **+10% on every token class** for Gemini 3 and later ([pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), effective 2026-07-01), while the rates pinned in the policy files are the flat global ones. On the default the cost this plugin reports is the cost Google bills.

Pin a region if you need quota or latency the global endpoint cannot give you — the surcharge is then included in the reported cost rather than ignored, so your numbers stay honest either way.

**AI Studio — if you do not.** Get an API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), then export:

```bash
export GEMINI_API_KEY=...
```

If both are present the API key wins, on the reasoning that exporting one is a deliberate choice for this shell while Google Cloud credentials are frequently just ambient machine state. Set `GEMINI_BACKEND=vertex` or `GEMINI_BACKEND=api-key` to override the detection.

If you only plan to run the `opus-only` policy, you can skip Gemini entirely.

**Where you export matters if you installed the plugin rather than cloning.** The `export` lines above assume you launch `claude` from that same shell, which is the clone route. Claude Code started from the desktop app inherits no login shell, so nothing exported in a terminal or written to `~/.zshrc` reaches it. On that route, put the variables in the `env` block of `~/.claude/settings.json`, which Claude Code reads at startup and passes through to the bundled server — or use the Google Cloud door, which involves no variable at all: `gcloud auth application-default login` writes a credentials file at a fixed path that the server reads directly, taking the project from that file's quota project.

### Every credential combination, and what the check says about each

The setup check reads five things — `GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, the credentials file `gcloud` writes, `GOOGLE_CLOUD_PROJECT`, and `SDLC_SELECT` — and there are only so many ways they can combine. This is all of them. Rows 5, 6 and 8 are the ones worth knowing by name: each was a **green report on a broken install** before the checks were hardened, and each cost its money at the first Gemini call rather than at setup.

To walk a row, set what its second column names and run the check. Nothing here spends anything.

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)"
```

| # | What is set | Finding | Runs? |
|---|---|---|---|
| 1 | Nothing | `gemini-credentials` (warning) | Claude-only policies run. The multi-model policy has no door open. |
| 2 | `GEMINI_API_KEY` | — | Model path, through AI Studio. The agent question is not asked: that path cannot use a key. |
| 3 | `gcloud auth application-default login` | — | Model path, through the platform. The agent path is available and offered. |
| 4 | `GOOGLE_APPLICATION_CREDENTIALS` → a complete service-account file | — | Same as row 3. |
| 5 | **`GOOGLE_CLOUD_PROJECT` only** | `gemini-credentials` (warning) | A project ID says where to bill, not who is asking. Inside Google Cloud the credential arrives from the metadata server and this works; on a laptop it does not, and nothing offline can tell the two apart — hence a warning rather than a block. |
| 6 | **`GOOGLE_APPLICATION_CREDENTIALS` → a file that is missing, truncated, or not a credential** | `gemini-credentials-broken` (blocking) | Nothing. This variable outranks the `gcloud` file, so a broken one hides a perfectly good login sitting right behind it. |
| 7 | `GEMINI_API_KEY` **and** Google Cloud credentials | — | Model path through AI Studio — the key wins, on the reasoning that setting one is deliberate while cloud credentials are often ambient. `GEMINI_BACKEND` overrides. The agent path is still available. |
| 8 | **`SDLC_SELECT=gemini-flash=flash-agsdk-worker` with only `GEMINI_API_KEY`** | `agent-worker-credentials` (blocking) | Nothing. The run is routed to the agent path and the key cannot reach it — the wrong door, not a partial credential. |

Two combinations are deliberately absent from the table because they are not credential states. A variable that arrived as the literal `${NAME}` is reported separately as `env-placeholders` and treated as unset. And row 8 with a *named project but no credential* downgrades to a warning, `agent-worker-credentials-unproven`, for the same reason row 5 does.

What none of these rows can tell you is whether a well-formed credential is still live, whether the project carries the Antigravity entitlement, or whether the region serves the model. Those need one real call — see [Confirming it works, before a run finds out](#confirming-it-works-before-a-run-finds-out).

## Gemini as a model, or Gemini as an agent

Everything above sets up Gemini as a **model**, which is the default and what every run of this plugin has used. There is a second way to reach the same tier, and it is a genuinely different thing rather than a setting.

**As a model.** For each packet the orchestrating Claude session reads the files it judges relevant, sends that text to Gemini, and gets text back. Gemini never sees your folder. Claude writes the result to disk. One request, one response, per packet.

**As an agent.** Gemini is handed the working directory and works in it: it lists and reads files on its own, runs shell commands, and writes its own edits. Claude then reviews what changed. This runs through Google's [Antigravity SDK](https://pypi.org/project/google-antigravity/), which is a Python package, so this path — and only this path — adds a Python dependency to a plugin that otherwise has none.

Three things are worth knowing before choosing it:

- **It costs several times more per task.** An agent re-sends the whole conversation on every tool call, on top of a fixed preamble of several thousand tokens it carries every turn. Same published per-token rates; many more tokens.
- **It needs Python 3.10 or newer.** The Antigravity SDK declares that minimum, and macOS ships `/usr/bin/python3` as 3.9 — so the interpreter your machine reaches for by default is the one that will not work. The setup script looks for a usable one by asking each candidate its own version rather than trusting its name.
- **Google Cloud only.** The Antigravity SDK signs with Application Default Credentials against the same project the model path uses, and has no API-key door, so `GEMINI_API_KEY` cannot reach this path. `gcloud auth application-default login` is a prerequisite, not an alternative.

### Choosing it

Both installation routes ask, and neither asks unless it finds Google Cloud credentials — without them this path is unavailable, so offering it would be offering something that cannot work.

That leaves a gap worth knowing about, because the question is asked once and credentials arrive whenever they arrive: if you run `gcloud auth application-default login` a week after installing, nothing prompts you to install again, and the second door opens without anyone mentioning it. So the verify script watches for exactly that — on an install that is on the model path and now has real credentials, it ends with the `--enable-agent` line. It is a one-line note, not a nag: the model path is the cheaper default and staying on it is a perfectly good answer.

On the clone route, `node tools/setup.mjs` asks as part of the wizard. On the plugin route, the setup instructions ask, and a yes runs the verify script with `--enable-agent`. You can run that yourself at any time, on either route:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)" --enable-agent
```

or, from a clone:

```bash
npm run verify -- --enable-agent
```

That one command does everything the path needs: it records the selection, builds a virtual environment under `plugin/mcp/gemini-flash-server/worker/.venv/`, installs the SDK into it, and re-checks. `--disable-agent` reverses the selection; the virtual environment can stay where it is, unused, or be deleted.

The selection is recorded in `.claude/settings.local.json` **in the folder you ran it from** — this folder only, so opening another project does not inherit it. Add `--user` to write `~/.claude/settings.json` instead and have it apply everywhere. On a clone, the command also updates the `.mcp.json` that `npm run setup` wrote, because a stdio MCP server does not inherit the parent environment and that file's `env` block is the only thing the server actually reads.

Either way, a settings file is read when a Claude Code session *starts*, so the selection reaches the session after this one, not the one you ran the command in.

**Do not write the variable by hand.** It is `SDLC_SELECT=gemini-flash=flash-agsdk-worker` — a `slot=option` pair, and the slot is the half that gets dropped. A spec missing it looks correct, passes the setup check, and then throws when the policy loads, by which point the premium phases of a run have been billed. The verify script now reports a malformed spec as a blocking problem for exactly that reason, but the flag is what stops it from happening.

If you already maintain a Python 3.10+ environment with `google-antigravity` installed and would rather not have a second one built inside the plugin, point at yours instead and no virtual environment is created:

```bash
export GEMINI_WORKER_PYTHON=/path/to/your/venv/bin/python
```

Nothing here reaches an install that did not choose it. Without `SDLC_SELECT` naming the agent, the verify script never looks for Python, pre-flight never constructs the agent's adapter, and the mechanical tier dispatches exactly as it always did.

### Confirming it actually took effect

The switch is easy to set and easy to think you have set. A run that used the agent says so in two places, and both are absent on a run that did not:

- `node tools/report.mjs <pass-dir>` prints a **Delegated to an agent worker** section — one row per delegated packet, with the tool calls it made and what changed in the working directory while it held it.
- the pass directory contains `delegation/`, holding the brief each worker was given and a receipt for what it did.

If neither appears, the run went through the model path regardless of what the variable says. Both are described in [understanding-output.md](understanding-output.md#delegated-to-an-agent-worker).

### Confirming it works, before a run finds out

Everything the setup and verify scripts check is offline — files, versions, variables. Three things they cannot see decide whether this path works at all, because none of them is a missing file:

- whether the billing project carries the **Gemini Enterprise / Model Garden entitlement** the SDK needs and the plain model path does not (a 403 without it);
- whether the **region actually serves the model** — `gemini-3.5-flash-lite` in particular is not deployed everywhere (a 404 where it isn't);
- whether Application Default Credentials are not just present but **still valid**, on a project with the platform API enabled.

All three surface at the same moment: the first delegated packet, after requirements, design and task planning have already been billed to the premium tier. One trivial delegation settles them at second zero instead:

```bash
node plugin/scripts/probe-agent-worker.mjs
```

On the plugin route, where there is no repo to stand in:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/probe-agent-worker.mjs | tail -1)"
```

It loads the real policy, constructs the real adapter, and runs one real delegation in an empty temporary directory — no mock, no stub, no separate code path. It prints the project, the region, the interpreter, the per-token rates a run will be billed at, and what the delegation actually cost, then exits 0 if the path works. On failure it names the cause in words: an entitlement request that takes days reads differently from a region that takes one environment variable, and the two are never reported as the same thing.

It is not free, because nothing on this path is: the Antigravity SDK re-sends a multi-thousand-token preamble every turn whatever you ask it. Measured against `gemini-3.5-flash` on the global endpoint, one probe is 12,245 input and 154 output tokens — **about two cents**, and roughly the same every time, since almost all of it is the preamble rather than the question. `verify-setup.mjs` offers this command at the end of its own output when — and only when — the install selects the agent and everything offline already passed.

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

**Pre-flight lists a model under `not_selected`** — a policy can offer more than one way to reach a tier (`opus-plus-flash` reaches the mechanical tier either as a model or as an agent, see above), and only the one this run selected can be dispatched to. The other is named here rather than silently omitted, so "you did not choose it" stays distinguishable from "pre-flight forgot about it". Its prerequisites are not checked, which is the point: a machine with no Python would otherwise fail pre-flight over a tier it will never call.

**`select-spec` from the verify script** — `SDLC_SELECT` is set to something no policy can resolve. The value is a `slot=option` pair, comma-separated for more than one, and the commonest way to get it wrong is to write the option on its own: `flash-agsdk-worker` instead of `gemini-flash=flash-agsdk-worker`. The option is the half that carries the meaning, which is why it is the half people write, and it reads like a complete answer. Before this check existed, that spelling produced a green setup report and then a throw at policy load, with the premium phases of the run already billed. Re-run the verify script with `--enable-agent` to have the pair written correctly, or `--disable-agent` to clear it.

**`agent-worker-credentials` from the verify script** — `SDLC_SELECT` routes the mechanical tier to the agent worker, and this install has no Google Cloud credentials. The Antigravity SDK signs with Application Default Credentials and has no API-key branch, so a `GEMINI_API_KEY` does not help here — it is the other door, and the message says so when it finds one. Run `gcloud auth application-default login` (and set `GOOGLE_CLOUD_PROJECT` if the account has several projects), or run the verify script with `--disable-agent` to go back to the model path, which does work with an AI Studio key. This is offline-checkable and therefore checked; the entitlement and region problems below are not, which is what the probe is for.

**`agent-worker-python` or `agent-worker-sdk` from the verify script** — `SDLC_SELECT` routes the mechanical tier to the Antigravity agent, but the Python environment that path needs is missing (`agent-worker-python`) or exists and cannot import the SDK (`agent-worker-sdk`, which quotes the interpreter's own error). Both are blocking, and both have the same two exits: build the environment with `--enable-agent` or `--fix` on the verify script (or `node tools/setup.mjs` on a clone), or run `--disable-agent` and go back to the model path, which needs no Python at all. The second failure usually means the environment was built against an interpreter that has since been upgraded or removed; both flags rebuild with `venv --clear`, so they replace the broken environment rather than patching it, and there is nothing to delete by hand.

**`env-placeholders` warning from the verify script** — one or more of the variables the plugin forwards (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_BACKEND`, `SDLC_SELECT`, `GEMINI_WORKER_PYTHON`) reached the server as the literal text `${NAME}` rather than a value. The plugin manifest declares them as pass-throughs from the host; when the host never set one, the placeholder is forwarded verbatim instead of being dropped. The server discards those values at startup and falls back to Application Default Credentials, so nothing runs on a garbage credential — but the variable you believed was set is not in play. Set it where Claude Code can see it, per the note above about the `env` block of `~/.claude/settings.json`.

**Rerun the wizard** — safe to run `node tools/setup.mjs` repeatedly. It skips steps that are already done.
