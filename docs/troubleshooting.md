# Troubleshooting

Symptom → cause → fix. If the fix is a command, it is copy-paste-runnable.

## How to inspect what is happening

| Command | What it tells you |
|---|---|
| `/plugin` (inside Claude Code) | Which plugins are installed and enabled. |
| `claude --debug` | Prints the plugin's env pass-through, MCP handshake, and tool invocations. |
| `node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs \| tail -1)"` | Full offline check. Reports blocking (`✗`) and warning (`!`) findings, plus fix commands. |
| `node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/probe-agent-worker.mjs \| tail -1)"` | One real Antigravity delegation, ~2¢. Only cheap way to confirm entitlement, region, and credential liveness. |

From a clone:

```bash
npm run verify --prefix /path/to/ai-sdlc-orchestrator-claude-code-harness
```

## Install and prerequisites

| Symptom | Cause | Fix |
|---|---|---|
| `claude: command not found` | Global npm bin not on `PATH`. | Add the output of `npm root -g`'s `../bin` to `PATH`, or install Node via `nvm`. |
| `Node <n> — this repo needs Node 20 or newer` | Older Node on `PATH`. | `nvm install --lts`, or install from [nodejs.org](https://nodejs.org). |
| `verify-setup.mjs`: `mcp-dependencies` or `mcp-build` (blocking) | `dist/` and `node_modules/` are not tracked in git; a fresh install carries source only. | Re-run with `--fix` — runs `npm ci` then `npm run build` in the server directory. |
| `/plugin marketplace add` reports the marketplace already exists | Cached from an earlier session. `add` is a no-op that leaves the cache stale. | `/plugin marketplace update tilicho-ai-labs`, then install again. |
| `/sdlc-run` isn't in the slash-command menu | Commands register at session start; the install session doesn't have it. | Open a new session in the same folder. |
| `/reload-plugins` returns "isn't available in this environment" | The command does not exist in the desktop app. | Open a new session instead. |

## Auth mode

| Symptom | Cause | Fix |
|---|---|---|
| `this run requires auth_mode=vendor\|estimated` | `/run-sdlc-pass` invoked without `--auth`. | Add `--auth=vendor` (needs `ANTHROPIC_API_KEY`) or `--auth=estimated` (needs a Claude Code subscription sign-in). |
| Report labels a run "Mixed" | `--auth=estimated` and the policy also dispatched Gemini. Direct-tier events are estimated, Gemini events are vendor-reported. | Expected. `E` next to a phase marks the estimated ones. |
| Report totals don't match the Anthropic dashboard exactly | The run was `--auth=estimated`. | Re-run with `--auth=vendor` for numbers that reconcile to the console. |

## Pre-flight (`preflight_dispatch`)

| Symptom | Cause | Fix |
|---|---|---|
| Halts before phase 1 with `halt_reason` naming models | An adapter this run's auth mode requires cannot be constructed — usually a missing credential. | Fix each named credential and restart. Constructions run offline; nothing was billed. |
| Prints a `warnings` entry but the run starts | The failed adapter belongs to a model this run's auth mode never dispatches to (typically `builtin-anthropic` under `--auth=estimated`). | Expected. Only a model this run actually dispatches to halts. |
| Lists a model under `not_selected` | The policy offers more than one way to reach a tier (a `select:` slot), and this run picked the other option. Prerequisites for the losing option are not checked. | Expected. Switch `SDLC_SELECT` if you meant the other one. |

## Anthropic

| Symptom | Cause | Fix |
|---|---|---|
| `anthropic-key` warning | `ANTHROPIC_API_KEY` unset in the environment the plugin sees. | Get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). Put it in the `env` block of `~/.claude/settings.json` — a shell export is not enough, because Claude Code launched from the desktop app inherits no login shell. |
| Vendor-mode run fails immediately | `ANTHROPIC_API_KEY` truly not set, or set to a `${...}` placeholder that arrived unexpanded (see [env-placeholders](#gemini)). | Same fix. Verify with `verify-setup.mjs`. |

## Gemini

| Symptom | Cause | Fix |
|---|---|---|
| `env-placeholders` warning | The host never exported a plugin-declared variable, so `plugin.json`'s `"${NAME}"` pass-through arrived as the literal string. The server discards these at startup and falls back to ADC. | If you meant to set the variable, put it in the `env` block of `~/.claude/settings.json`. Not a failure by itself. |
| `gemini-credentials` warning, nothing else set | No Gemini door open. Claude-only policies still run. | Either `gcloud auth application-default login`, or export `GEMINI_API_KEY`. |
| `gemini-credentials` warning, only `GOOGLE_CLOUD_PROJECT` set | A project ID is where to bill, not who is asking. Works inside Google Cloud (the metadata server supplies the credential); fails on a laptop. | Add a real credential: `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a complete service-account key. On a Cloud-hosted machine, settle for ~2¢ with `probe-agent-worker.mjs`. |
| `gemini-credentials-broken` (blocking) | `GOOGLE_APPLICATION_CREDENTIALS` points at a file that is missing, truncated, or has no recognizable `type` field. An explicit `GOOGLE_APPLICATION_CREDENTIALS` outranks the gcloud ADC file, so a broken one hides a working login. | Point it at a complete service-account key, or unset it and rely on `gcloud auth application-default login`. |
| Gemini call throws about `${GOOGLE_CLOUD_PROJECT}` as a project id | The variable arrived unexpanded and reached a code path that didn't strip it. Should not happen since 2026-08-04. | Update to the current plugin version. If it persists, file an issue with the `verify-setup.mjs` output. |
| Reported Gemini cost feels ~10% low | `GOOGLE_CLOUD_LOCATION` is a region name (anything other than `global`). Vertex bills regional endpoints +10% on Gemini 3+, effective 2026-07-01. | Expected: the plugin applies the surcharge to the reported cost automatically. Unset the variable to hit the flat global endpoint. |
| `GEMINI_BACKEND=<something>` throws | Only `vertex` and `api-key` are accepted. | Set one of those two, or unset it to let credentials decide. |

## Antigravity SDK (agent path)

| Symptom | Cause | Fix |
|---|---|---|
| `select-spec` (blocking) | `SDLC_SELECT` is malformed. Commonest case: written as `flash-agsdk-worker` alone; the correct spelling is `gemini-flash=flash-agsdk-worker`. | Re-run `verify-setup.mjs --enable-agent` (writes it correctly) or `--disable-agent` (clears it). Do not edit by hand. |
| `agent-worker-credentials` (blocking) | `SDLC_SELECT` selects the agent, but no Google Cloud credential is present. The Antigravity SDK is ADC-only; `GEMINI_API_KEY` cannot reach it. | `gcloud auth application-default login`. Or `verify-setup.mjs --disable-agent` to go back to the model path, which works with an AI Studio key. |
| `agent-worker-credentials-unproven` (warning) | Agent selected; only `GOOGLE_CLOUD_PROJECT` is set. Works inside Google Cloud, fails on a laptop. This state cannot be resolved offline. | Settle with `probe-agent-worker.mjs`. If it fails to authenticate, `gcloud auth application-default login`. |
| `agent-worker-python` (blocking) | Agent selected; no Python environment found. | Re-run `verify-setup.mjs --enable-agent` (or `--fix`, which builds the venv). Or set `GEMINI_WORKER_PYTHON` to a Python ≥3.10 with `google-antigravity` installed. Or `--disable-agent` to go back to the model path. |
| `agent-worker-sdk` (blocking) | Python environment exists but cannot import `google.antigravity`. Usually: the interpreter it was built against was upgraded or removed. | Re-run `verify-setup.mjs --fix` — it rebuilds with `venv --clear`, replacing the broken environment. |
| Delegated packet dies with a 403 | Billing project lacks the Antigravity / Model Garden entitlement. Not offline-checkable. | Request the entitlement in Google Cloud Console for the project. Verify with `probe-agent-worker.mjs`. |
| Delegated packet dies with a 404 | Resolved region doesn't serve `gemini-3.5-flash-lite`. | Unset `GOOGLE_CLOUD_LOCATION` to hit `global`, or pin a region that serves the model. |
| Delegated packet dies with a 401 | ADC file exists but the credential expired or was revoked. Not offline-checkable. | `gcloud auth application-default login`. |
| Report has no "Delegated to an agent worker" section on a run that should have delegated | The run did not go through the agent path. `SDLC_SELECT` was missing, malformed, or applied only to a later session. | `verify-setup.mjs` should say why. Settings-file writes reach Claude Code only on the next session start. |

## Two Gemini doors — trade

The trade between the two doors is a token-volume trade at identical published rates. Same model, same bill, different session shape.

| | Model path | Agent path (Antigravity SDK) |
|---|---|---|
| One packet costs | one completion call | multiple tool-loop turns |
| Fixed per-turn overhead | none | ~11.5k tokens of SDK preamble every turn |
| Evidence on disk | telemetry event | telemetry event + task brief + worker sidecar + receipt |
| Fits in cache? | yes (explicit `cache_control`) | yes (implicit context caching does the heavy lifting) |

Recorded on the same brief: model path 43k / 34k tokens for $0.84 wall-clock 28 min; agent path 1.71M / 73k for $2.18 (of which 1.04M were cache reads), 63 min. Wall-clock includes four human approval gates, so it measures the reviewer as much as the pipeline. See the two runs under [../examples/quick-demo/passes/](../examples/quick-demo/passes/).

## Test run (codegen output)

| Symptom | Cause | Fix |
|---|---|---|
| Generated app fails to boot in tests with `Config validation error: "X" is required` | `.env.test` is missing keys the codegen's own `ConfigModule` demands. | Do not patch `.env` by hand — build a debug packet routed to `codegen` to add the keys with schema-valid values. See [plugin/skills/run-ai-sdlc/SKILL.md](../plugin/skills/run-ai-sdlc/SKILL.md). |
| Tests fail at load time on env vars, but `.env.test` looks complete | `.env.test` exists and `.env` does not — the orchestrator copies one to the other before `npm test`. If `.env` already existed it is not overwritten. | Delete a stale `.env`, or update it to match `.env.test`. |

## Repair after `/plugin update`

An update re-copies the plugin from source, which removes the `dist/` and `node_modules/` produced by `--fix`. Re-run:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)" --fix
```
