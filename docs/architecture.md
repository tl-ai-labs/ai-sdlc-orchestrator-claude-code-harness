# Architecture

Reference for the pieces that make up the plugin, in the order a request flows through them: install surface, MCP server, routing, adapters, the two Gemini doors, the agent path, telemetry, auth modes, install routes.

## 1. Plugin surface

Claude Code loads the plugin from `plugin/.claude-plugin/plugin.json`. The manifest declares four things.

| Field | Value | Purpose |
|---|---|---|
| `commands` | `./commands` | Slash commands the plugin registers when a session starts. |
| `skills` | `./skills` | Skill files invocable via the `Skill` tool. |
| `mcpServers.gemini-flash-server` | stdio server at `${CLAUDE_PLUGIN_ROOT}/mcp/gemini-flash-server/dist/server.js` | Owns every dispatch, credential probe, and telemetry write. |
| `mcpServers.gemini-flash-server.env` | 8 pass-through vars | Values arrive as `${NAME}` placeholders when the host never set them. See §2. |

Additional plugin content:

| Path | Contents |
|---|---|
| [plugin/agents/](../plugin/agents/) | Subagents: `orchestrator`, `architect`, `senior-reviewer`, `security-reviewer`. |
| [plugin/commands/run.md](../plugin/commands/run.md) | The two-prompt-flow entry point. Takes no arguments; asks for what it needs. |
| [plugin/commands/pass.md](../plugin/commands/pass.md) | Every setting as a flag; the form used for scripting and repeat runs. |
| [plugin/skills/run-ai-sdlc/](../plugin/skills/run-ai-sdlc/) | Skill body loaded by the orchestrator. |
| [plugin/hooks/hooks.json](../plugin/hooks/hooks.json) | `PostToolUse` hook matching the MCP tool name under both install routes. |
| [plugin/config/policies/](../plugin/config/policies/) | Two policy YAMLs. |

The hook matcher is a regex because the plugin route namespaces MCP tools with the plugin name (`mcp__plugin_sdlc_gemini-flash-server__execute_with_model`) while the clone route registers them bare (`mcp__gemini-flash-server__execute_with_model`). Both forms match.

## 2. MCP server

The bundled server exposes four tools over stdio.

| Tool | Purpose |
|---|---|
| `execute_with_model` | Dispatch a TaskPacket to the model the policy names; return result + tokens + cost. |
| `simulate_policy` | Recompute cost from an existing telemetry stream against a different policy. No LLM call. |
| `log_telemetry` | Append a TelemetryEvent the orchestrator emitted itself (direct-tier). Server stamps `ts` and nulls `latency_ms`. |
| `preflight_dispatch` | Construct every adapter this run's auth mode will use. Halts on any that fails. No API call. |

Two files run before anything else:

| File | Role |
|---|---|
| [envBootstrap.ts](../plugin/mcp/gemini-flash-server/src/envBootstrap.ts) | Side-effect import. Must be first — deletes `PLUGIN_DECLARED_ENV` entries whose value is the literal `${NAME}` placeholder. ES module evaluation order is the only ordering guarantee that keeps this before third-party SDKs read `process.env`. |
| [env.ts](../plugin/mcp/gemini-flash-server/src/env.ts) | Pure helpers behind the bootstrap. Importable from tests without mutating the test runner's environment. |
| [preflight.ts](../plugin/mcp/gemini-flash-server/src/preflight.ts) | Auth-mode-aware reachability check. Under `vendor` every model is required; under `estimated` the in-session adapter (`builtin-anthropic`) is skipped. |

`preflight_dispatch` reports `not_selected` for policy leaves that lost a `select:` slot decision — their prerequisites (a Python venv, a worker script) are not this run's problem, and halting on them would be a false positive.

## 3. Routing

Policies live under [plugin/config/policies/](../plugin/config/policies/) as YAML. Each declares models, optional `select:` slots, and ordered rules.

| Field | Shape | Notes |
|---|---|---|
| `models[].id` | string | Referenced by rules and by `SDLC_SELECT`. |
| `models[].adapter` | `builtin-anthropic` \| `mcp:gemini-flash-server` \| `antigravity-worker` | Selects the adapter class. |
| `models[].pricing` | `{input, input_cached, output}` USD per 1M | Flat global/AI-Studio rates. Vertex regional surcharge is applied at dispatch, not written in the file. |
| `models[].pricing_source`, `pricing_last_verified` | URL, ISO date | Vendor page and last verify date. |
| `models[].max_output_tokens_absolute` | number | Doubling-loop clamp for completion adapters. Absent on `antigravity-worker`. |
| `select.<slot>.default` | model id | Used when no `SDLC_SELECT` names this slot. |
| `select.<slot>.options` | model id[] | The vetted set the run may pick from. |
| `rules[].when` | `{phase, task_type?, module?, retry_count?}` | Ordered matcher. First match wins. |
| `rules[].use` | model id **or** slot name | A slot resolves through `select` at routing time, not policy-load time. |
| `rules[].default` | model id or slot | Fell-through terminal rule. |

`SDLC_SELECT` is spelled `slot=option[,slot=option...]`. Parsing lives in [routing.ts](../plugin/mcp/gemini-flash-server/src/routing.ts) (`parseSelectOverrides`) and is duplicated in [verify-setup.mjs](../plugin/scripts/verify-setup.mjs) (`parseSelectSpec`), which cannot import TypeScript. Both refuse malformed specs. `unreachableModelIds` excludes losing options from pre-flight without dropping ones a rule names directly.

`simulate_policy` replays events against a different policy using the current run's slot choices, so a what-if on a slotted policy prices the tier this install would actually dispatch to.

## 4. Adapters

One interface, three implementations, plus a factory.

| File | Adapter class | Model tier |
|---|---|---|
| [ModelAdapter.ts](../plugin/mcp/gemini-flash-server/src/adapters/ModelAdapter.ts) | interface | — |
| [BuiltinAnthropicAdapter.ts](../plugin/mcp/gemini-flash-server/src/adapters/BuiltinAnthropicAdapter.ts) | `BuiltinAnthropicAdapter` | Anthropic direct SDK. Under `vendor`, dispatched here; under `estimated`, never constructed. |
| [GeminiFlashAdapter.ts](../plugin/mcp/gemini-flash-server/src/adapters/GeminiFlashAdapter.ts) | `GeminiFlashAdapter` | Gemini as a model, via `@google/genai`. Delegates transport to §5. |
| [AntigravityWorkerAdapter.ts](../plugin/mcp/gemini-flash-server/src/adapters/AntigravityWorkerAdapter.ts) | `AntigravityWorkerAdapter` | Gemini as an agent. Launches the Python worker. See §6. |
| [index.ts](../plugin/mcp/gemini-flash-server/src/adapters/index.ts) | `createAdapter(model)` | Factory keyed on `model.adapter`. |
| [pricing.ts](../plugin/mcp/gemini-flash-server/src/pricing.ts) | — | `computeCostUsd(tokens, pricing)` on disjoint cached/fresh counts. |

The two completion adapters share an **output-cap doubling loop**: on a vendor `max_tokens` signal, retry with `2×` the previous ceiling, up to 3 doublings or `max_output_tokens_absolute`. Every attempt emits its own TelemetryEvent with `attempt_number` and `ceiling_used`, all sharing the packet's `task_id`. The agent adapter has no such loop — an agent session sets its own per-turn limits and a retry would be a fresh, fully-billed session.

## 5. The two Gemini doors

Both live in [geminiTransports.ts](../plugin/mcp/gemini-flash-server/src/adapters/geminiTransports.ts) and run on `@google/genai`. They differ only in how a request is signed and which endpoint receives it.

| Door | Backend name | Auth | Env-var trigger |
|---|---|---|---|
| AI Studio | `api-key` | API key in an env var | `GEMINI_API_KEY` |
| Vertex ADC | `vertex-adc` | Application Default Credentials | ADC file, `GOOGLE_APPLICATION_CREDENTIALS`, or `GOOGLE_CLOUD_PROJECT` |

`selectGeminiBackend` precedence (pure function; unit-tested):

1. `GEMINI_BACKEND=vertex|api-key` — explicit override.
2. Policy's key env var is set → `api-key`. A key is a deliberate local choice; ADC is often ambient machine state.
3. Any Vertex signal (`GOOGLE_APPLICATION_CREDENTIALS`, ADC file, or `GOOGLE_CLOUD_PROJECT`) → `vertex-adc`.
4. Nothing → throw, naming both doors.

**Regional surcharge.** `GOOGLE_CLOUD_LOCATION` defaults to `global`. Vertex bills non-global endpoints **+10%** on every token class for Gemini 3 and later, effective 2026-07-01. `applyVertexSurcharge` multiplies the policy's pinned rates at dispatch when the backend is `vertex-adc`, the location is not `global`, and the model family is `gemini-3+`. The `flash-agsdk-worker` leaf in `opus-plus-flash.yaml` deliberately does not pin `region:`, so both leaves follow the same env var and both hit the flat global endpoint by default.

**Billed output tokens.** `billedOutputTokens(usage) = candidatesTokenCount + thoughtsTokenCount`. Gemini 3.x reports reasoning tokens in `thoughtsTokenCount` — a sibling of the candidate count, billed at the output rate. `cachedContentTokenCount`, by contrast, is a subset of `promptTokenCount` and is subtracted before pricing. Getting either wrong moves the headline number.

## 6. Agent path (Antigravity SDK)

Selecting this path routes the mechanical tier to `flash-agsdk-worker`.

| Piece | File / detail |
|---|---|
| Adapter | [AntigravityWorkerAdapter.ts](../plugin/mcp/gemini-flash-server/src/adapters/AntigravityWorkerAdapter.ts) |
| Worker | [worker/gemini_worker.py](../plugin/mcp/gemini-flash-server/worker/gemini_worker.py) — Python 3.10+, `google-antigravity` |
| Auth | Application Default Credentials only. No API-key branch. |
| Timeout | `worker_timeout_sec: 540` in the policy YAML — 9 minutes, then the process group is killed. |
| Interpreter resolution | `resolveWorkerPython`: `GEMINI_WORKER_PYTHON` override, else the plugin-built venv at `plugin/mcp/gemini-flash-server/worker/.venv/bin/python`. |
| Delegation records | [evidence.ts](../plugin/mcp/gemini-flash-server/src/delegation/evidence.ts) — three files per packet (task brief, worker usage sidecar, receipt). |

For each delegated packet the server takes an inventory of the working directory before and after the worker runs. The diff (added / modified / removed) lands on the receipt; it establishes what changed while the worker held the directory, not who wrote each byte.

Session state is written by the SDK as opaque SQLite containing absolute local paths and is excluded from published evidence. The JSON delegation record and usage sidecar carry everything an auditor needs.

## 7. Telemetry

One JSON object per LLM call, appended to `<pass-dir>/telemetry.jsonl`. `manifest.json` is a rollup derived from it.

| Field | Notes |
|---|---|
| `ts` | ISO timestamp. Stamped server-side for `execute_with_model` and re-stamped by `normalizeDirectTierEvent` for `log_telemetry` events (a model has no clock). |
| `phase`, `task_type`, `task_id`, `module` | Join keys back to the TaskPacket. |
| `model` | Vendor's model name. Same across both Gemini doors. |
| `model_id` | Policy leaf that dispatched: `opus` / `flash-completion` / `flash-agsdk-worker`. The only field that distinguishes the two Gemini doors. |
| `input_tokens`, `input_tokens_cached`, `output_tokens` | Vendor-reported under `vendor`; char-count-estimated under `estimated`. |
| `output_tokens_reasoning` | Gemini only; already counted in `output_tokens`. Absent on adapters that do not report it (JSON.stringify drops undefined). |
| `cost_usd` | `(tokens × policy pricing) / 1M`. Cached fraction subtracted before pricing. Vertex regional surcharge applied at dispatch. |
| `attempt_number`, `ceiling_used`, `retry_reason` | Doubling-loop attempts share a `task_id`. |
| `routing.select` | `{slot, chosen, overridden}` when the matched rule went through a slot. Absent on unslotted policies. |
| `latency_ms` | `null` for direct-tier events (the server never saw the call). Real ms for MCP-dispatched calls. |

`buildManifest` sorts by `ts`, derives `started_at` / `ended_at` / `duration_sec`, and rolls up per-model, per-phase, per-module, per-task-type. The `PostToolUse` hook writes `.hook-logs/hook.jsonl` — one line per MCP call, size + timestamp — as an independent cross-check.

## 8. Auth modes

Chosen per run. `/sdlc:run` asks; `/sdlc:pass --auth=<mode>` requires the flag.

| Mode | Billed to | Every event | Direct-tier tokens | Mechanical-tier tokens |
|---|---|---|---|---|
| `vendor` | Anthropic API key + Google (Gemini calls) | dispatched through the MCP server | vendor-reported | vendor-reported |
| `estimated` | Claude Code subscription (direct-tier) + Google (Gemini) | mixed | char/3.8 heuristic, `latency_ms: null` | vendor-reported |

Under `estimated` the orchestrator runs the direct tier inside the Claude Code loop, where per-call `usage` is not visible. The report labels it "Estimator mode" and marks affected phases with `E`. Totals will not match a vendor-billed run exactly.

`preflight_dispatch` respects the mode: under `estimated`, an unset `ANTHROPIC_API_KEY` is a warning, not a halt.

## 9. Install routes

Two ways in. Both end up running the same MCP server.

| Route | Entry | What arrives |
|---|---|---|
| Plugin (default) | Two-prompt flow → [SETUP.md](../SETUP.md) → `/plugin install` → `verify-setup.mjs --fix` | `plugin/` under `~/.claude/plugins/cache/tilicho-ai-labs/sdlc/*/`. The MCP server's `dist/` and `node_modules/` are not tracked in git; `--fix` builds them. |
| Clone | `git clone` → [tools/setup.mjs](../tools/setup.mjs) | The full repo, plus a project-level `.mcp.json` that registers the built server directly. |

`.mcp.json` on the clone route holds an exhaustive `env` block, because a stdio MCP server inherits nothing from its parent. `verify-setup.mjs --enable-agent` writes the `SDLC_SELECT` selection into both `.claude/settings.local.json` (read by Claude Code) and `.mcp.json` (read by the server); a settings-only write would be dropped at the server boundary.

`plugin/examples/` duplicates `examples/` so the shipped briefs are reachable from an installed plugin, which has no repo checkout beside it.
