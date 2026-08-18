# MMO v1 — namespace rename, per-job brownfield commands, orchestrator logging

**Type:** Epic · **Priority:** High · **Estimate:** 1–1.5 weeks · **Depends on:** none (extends the shipped plugin)

**Design plan:** none shipped separately — this ticket is the design. §14 lists every source it draws on.

**Status:** awaiting approval. No code has landed.

A reference implementation of §5.1 sits on the local branch `feat/mmo-rename-code-wip` (commit `6e6b6a6`, 106 files), deliberately unpushed. What was verified on it: root suite 210/212, `tsc` clean, build clean, and a live MCP `initialize` + `tools/list` returning `model-dispatch` with all five tools and zero non-JSON bytes on stdout. What was **not**: the 107-test server suite was never re-run there, so treat §5.1 as demonstrated rather than fully proven.

---

## 1. Summary

Three changes, shipped together because the second and third depend on the first.

1. **Rename the plugin `sdlc` → `mmo`.** Commands become `/mmo:*`, the workflow skill becomes `pipeline`, the MCP server becomes `model-dispatch`, and `SDLC_*` variables become `MMO_*`. `/sdlc:run` becomes `/mmo:greenfield`, pairing with `/mmo:brownfield`.
2. **Add seven explicit brownfield job commands** — `/mmo:bugfix`, `/mmo:docs`, `/mmo:test`, `/mmo:refactor`, `/mmo:deps`, `/mmo:feature-new`, `/mmo:feature-extend` — each an alias into the existing brownfield entry point with the job type pre-selected.
3. **Add an orchestrator log stream.** Every line prefixed `MMO:`, every delegation recorded — subagent hand-offs, model dispatches, vendor API calls, and Antigravity (AG SDK) worker sessions — with a verbose mode that turns on the detail.

They ship together because the new commands must be born with `/mmo:` names rather than renamed a week later, and the logging touches the same files the rename moves.

## 2. Problem

### 2.1 The command surface fails a first read

An engineer opening `/help` sees `/sdlc:run` and `/sdlc:brownfield` and cannot tell they are siblings, nor that `run` means "build a whole new application from a brief." `pass` is worse: it is a research word inherited from this repo's origin as a cost study, where one "pass" meant one recorded traversal of the pipeline. The plugin also publishes itself as `sdlc` while being called the Multi-Model Orchestrator everywhere else.

There is no way to express "run a bugfix" in one keystroke. The job type is chosen interactively at step 4a of a 227-line manual, so it cannot be bound to a shortcut, linked from a runbook, or discovered from `/help`.

The seven job types are re-listed in prose across six files with no machine-readable source, so they drift with nothing to catch it.

### 2.2 The orchestrator is close to silent

| Observation | Evidence |
|---|---|
| The MCP server writes to a stream twice in ~3,200 lines of TypeScript | `plugin/mcp/gemini-flash-server/src/envBootstrap.ts:16`, `src/adapters/AntigravityWorkerAdapter.ts:343` |
| No logger, no level, no timestamp, no prefix | whole of `src/` |
| The AG SDK worker's stderr is captured then discarded on success; only the last 4000 chars survive, and only on a non-zero exit | `src/adapters/AntigravityWorkerAdapter.ts:283-284`, `tail()` at `:388` |
| `.sdlc/local/debug.log` is promised in two shipped docs and written by nothing | `docs/brownfield.md:126`, `docs/brownfield-setup-issues.md:35` |
| The only debug switch gates one `console.error` | `plugin/scripts/write-contract-check.mjs:142` |
| Phase 5's execution loop has no print instruction, so the user sees silence between pre-flight and Gate 1 | `plugin/skills/run-ai-sdlc/SKILL.md:168-176` |

`telemetry.jsonl` is cost accounting, not a log. It records what a call cost. It never records that a call was attempted, which model was chosen and why, or what the agent worker did while it held the working directory.

The delegation you most want to watch — the AG SDK worker editing files and running commands — is the one that leaves the least trace.

### 2.3 This was already designed and deferred

`docs/brownfield-v1-planning/plan.md:573` (§14.11) specifies debug mode: verbose traces to `.sdlc/local/debug.log`, every line tagged with `run_id` and `phase`, rotating at 5 MB. Decision **D4** (`plan.md:1454`) specifies a central env reader at `plugin/scripts/env.mjs`. Neither was built. This ticket ships them.

## 3. Solution (high level)

- One token — `mmo` — in the command namespace, the log prefix, and the env-var prefix.
- One machine-readable intent registry, `plugin/config/intents.json`, replacing six prose copies.
- One shared brownfield operating manual, extracted to a skill, so eight commands point at one copy instead of eight duplicates of a 227-line file.
- One logger contract, implemented twice (TypeScript for the server, ESM for the scripts) because the two layers cannot import each other, with a test asserting they emit byte-identical lines.

## 4. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| MMO-D1 | `MMO` everywhere — `/mmo:*`, `MMO:` log prefix, `MMO_*` variables | One token to learn. Reverses commit `bf6e94d` (`multi-model-orchestrator` → `sdlc`); say so in the PR or it reads as churn. |
| MMO-D2 | `/mmo:greenfield` + `/mmo:brownfield` as a symmetric pair | `run` gives no hint it means "new app," and it sorts away from `brownfield` in `/help`, so the pair is invisible. |
| MMO-D3 | `/mmo:pass` keeps its name | Considered `unattended`, `auto`, `no-prompts`, `headless`. Deferred rather than churned; revisit separately. |
| MMO-D4 | Skills renamed `pipeline` and `brownfield-guide` | `run-ai-sdlc` carries two stale words — `run` (a command that stops existing) and `sdlc` (the namespace being left). |
| MMO-D5 | MCP server renamed `gemini-flash-server` → `model-dispatch` | It has three dispatch paths — Anthropic Opus, Gemini as a model, Gemini as an agent — and the old name describes one. The MCP tool names break from the plugin rename regardless, so breaking them once beats breaking them twice. |
| MMO-D6 | `.sdlc/` is **not** renamed | It holds `provenance.json` and the per-run backups `/mmo:revert` reads, and appears verbatim in `OFF_LIMITS_DEFAULT` as `.sdlc/**`. Renaming it would silently stop the write contract protecting it. It is hidden and nobody types it, so the readability payoff is zero against a real data-migration risk. `AI-SDLC` (the methodology) is likewise untouched. |
| MMO-D7 | Hard rename, no `/sdlc:*` aliases | The MCP tool-name change already forces a reinstall, so aliases soften nothing while doubling the `/help` listing — working directly against the readability goal. |
| MMO-D8 | Two compatibility shims, warn-and-continue | A plugin update replaces everything under `plugin/`, but never a policy the user authored into their own repo nor a variable `tools/setup.mjs` wrote into their shell profile. |
| MMO-D9 | Seven job commands are aliases, not a second pipeline | Preserves the substance of the brownfield plan's D5, which is a different decision from MMO-D5 above. See §12.1. |

### MMO-D8 in detail — the only two names that need a compatibility path

| Name | Lives in | Handling |
|---|---|---|
| `mcp:gemini-flash-server` (adapter id) | `routing-policy.yaml` and `.sdlc/local/user-policy.yaml` in the **user's** repo; also `plugin/policy-console/index.html:217` | Canonical becomes `mcp:model-dispatch`; `createAdapter` accepts the old id and warns |
| `SDLC_SELECT` (92 occurrences; 72 in executable code) | Shell profiles and `settings.json`, written by `tools/setup.mjs` | Canonical becomes `MMO_SELECT`; the reader accepts the old name and warns |

Everything else hard-breaks, because reinstalling replaces it.

**Reading the decision ids.** This ticket numbers its own decisions `MMO-D1`–`MMO-D9`. A bare `D<n>` anywhere in this document refers to a decision in `docs/brownfield-v1-planning/plan.md`, which has its own unrelated numbering — that plan's D4 and D5 are cited below and are not this ticket's MMO-D4 and MMO-D5.

## 5. In scope

### 5.1 The rename

Measured surface, excluding the historical directories named below: **247 `/sdlc:` occurrences across 49 files**, **124 `gemini-flash-server` across 34 files**. Counting the historical directories as well: 311 and 144.

Directory and file moves (use `git mv` so history follows):

| From | To |
|---|---|
| `plugin/commands/run.md` | `plugin/commands/greenfield.md` |
| `plugin/skills/run-ai-sdlc/` | `plugin/skills/pipeline/` |
| `plugin/mcp/gemini-flash-server/` | `plugin/mcp/model-dispatch/` |

Token replacements, applied in this order (most specific first, or `/sdlc:run` gets half-rewritten):

1. `plugin_sdlc_` → `plugin_mmo_`
2. `mcp:gemini-flash-server` → `mcp:model-dispatch`
3. `gemini-flash-server` → `model-dispatch`
4. `/sdlc:run` → `/mmo:greenfield`
5. `/sdlc:` → `/mmo:`
6. `run-ai-sdlc` → `pipeline`
7. `SDLC_SELECT` / `SDLC_DEBUG` / `SDLC_REL` → `MMO_*`
8. `plugins/cache/tilicho-ai-labs/sdlc` → `.../mmo`
9. `sdlc@tilicho-ai-labs` → `mmo@tilicho-ai-labs`

**Never replaced:** `.sdlc/` and every path under it, `AI-SDLC`, `SDLC` as prose, the `SDLC:` session marker, `--sdlc` (a path flag for the state directory), the repo URL, and identifiers about the state directory (`sdlcDir`, `findSdlcRoot`, `sdlc_root`).

Version to `0.6.0` in both `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`; a test asserts they match.

Historical records get a dated note rather than a rewrite — `docs/brownfield-v1-planning/**` and `docs/walkthroughs/**` describe the plugin as it was named when they were written, and editing them to use names they never used would be falsification.

### 5.2 Per-job brownfield commands

**The intent registry.** New `plugin/config/intents.json`, one entry per intent with `id`, `title`, `example`, `argument_hint`, `summary`, and an `interview` array. The `interview` questions currently exist only for `bugfix`, inline at `plugin/commands/brownfield.md:112-115`.

Ids exactly match the Intent-matrix rows at `plugin/skills/run-ai-sdlc/SKILL.md:255`: `docs`, `bugfix`, `feature-extend`, `feature-new`, `refactor`, `test`, `deps`.

**The shared manual.** Steps 1–7 of `plugin/commands/brownfield.md` move to `plugin/skills/brownfield-guide/SKILL.md`, with step 4 made conditional on two optional handover keys:

| Handover key | Effect |
|---|---|
| `intent: <id>` | Job type already chosen. Step 4a does not ask. Gate 0 still re-confirms. |
| `seed_description: <text>` | The user's own words. Step 4b skips its first question and asks only the rest. |

`/mmo:brownfield` supplies neither. A per-job command supplies `intent`, and `seed_description` when the user typed one. Nothing else differs — same pre-check, same discovery, same Gate 0, same write contract, same gates 1–4.

**Two contract bugs fixed while extracting**, both of which break a literal reading of the current flow:

- `auth_mode` is never passed. `plugin/agents/orchestrator.md:143-148` makes it required and says to abort without it; `brownfield.md:186-193` passes six fields and none of them is `auth_mode`. Add it to Gate 0 beside the policy question, and pass `code_dir` and `output_dir` too, which rule 2 says arrive resolved.
- The orchestrator does not advertise brownfield. Its `description` at `orchestrator.md:3` names only the greenfield entry points, and its body says "Two commands reach you."

**The seven command files.** About 15 lines each; only `intent:`, the description, and `argument-hint` differ. No manifest change — `plugin.json` declares `"commands": "./commands"`, so a new file is a new command.

Arguments: **optional free text, no flags.** Claude Code substitutes `$ARGUMENTS` as prose, so it costs nothing when omitted. Typing `/mmo:bugfix` already declares the job type; finishing the sentence removes an interview round-trip. Flags stay on `/mmo:pass`, preserving the interactive-versus-headless split. **Gate 0 fires unconditionally** — the argument seeds the brief, it never skips confirmation.

### 5.3 The logging layer

**Line format.** One grammar for every layer, greppable by prefix, parseable as logfmt after it:

```
MMO: 2026-08-18T11:04:22.418Z INFO  dispatch.end packet=tp_codegen_004 model_id=flash-completion phase=codegen ok=true in=8214 out=1902 cost_usd=0.0031 latency_ms=4180 run_id=20260818-110000-bugfix-a7f3
```

The event name is a dotted verb from the taxonomy below — stable and greppable, never a free-form sentence.

**Levels.**

| Level | Emitted | Contents |
|---|---|---|
| `ERROR` | always | dispatch failures, halts, worker crashes |
| `WARN` | always | write-contract denials, preflight warnings, retired names still in use |
| `INFO` | always | phase and gate boundaries, routing decisions, dispatch summaries, AG SDK spawn and exit |
| `DEBUG` | verbose only | per-call detail, adapter internals, env and credential resolution |
| `TRACE` | verbose only, explicit | worker stderr passthrough, payload byte counts, inventory detail |

**Enablement**, highest precedence first:

1. a per-call `log_level` / `verbose` argument on the MCP tool call
2. `MMO_LOG_LEVEL=trace|debug|info|warn|error`
3. `MMO_VERBOSE=1` → `debug`
4. `MMO_DEBUG=1`, or legacy `SDLC_DEBUG=1` with a warning → `debug`
5. default `info`

The per-call argument is not polish. The server process starts when the session starts, so its environment cannot change mid-session; a per-call argument is the only way a `--verbose` on one run reaches it.

`MMO_VERBOSE`, `MMO_LOG_LEVEL`, and `MMO_LOG_PREFIX` must be added to the `mcpServers.model-dispatch.env` block in `plugin.json`. That block is a whitelist — an unlisted variable never reaches the server. `tools/test/setup.test.mjs` already asserts the forwarding list matches what the server reads, so omitting this fails the suite.

**Sinks.**

| Sink | Path | Why |
|---|---|---|
| stderr | — | Always. **Never stdout** — stdout is the MCP stdio JSON-RPC transport, and one stray byte corrupts the framing. The rule is already stated at `envBootstrap.ts:13-15`. |
| Run log | `dirname(telemetry_path)/orchestrator.log` | Derived from the `telemetry_path` the server already receives, so no new plumbing, and it keeps the log with the run — the same argument `orchestrator.md:92-96` makes for delegation evidence. |
| Pre-run fallback | `.sdlc/local/debug.log` | Events before a run directory exists: policy load, credential discovery, env bootstrap. The file two shipped docs already promise. |

Rotation at 5 MB, keeping one previous file as `.1`.

**Redaction.** `docs/brownfield-privacy.md` documents what leaves the machine; logs must not widen it.

- **Never logged:** environment variable *values*, API keys, tokens, ADC file contents, prompt text, file contents, model output, diff bodies.
- **Logged instead:** names, paths, byte counts, token counts, 16-character hash prefixes, enum classifications.

Free text that cannot be structured — error messages, worker stderr — passes through the existing tested secret-pattern registry in `plugin/scripts/dispatch-sanitize.mjs` before reaching any sink. Reuse it; do not write a second scrubber. Its patterns are covered by `tools/test/dispatch-sanitize.test.mjs`.

#### The event taxonomy

**A. Run lifecycle** — emitted by the orchestrator through the CLI wrapper, since the orchestrator is a prompt and cannot call a module.

| Event | Fields | Level |
|---|---|---|
| `run.start` | run_id, mode, intent, policy, auth_mode, code_dir, output_dir, plugin_version, node_version, git_head | INFO |
| `phase.start` / `phase.end` | run_id, phase, form (default or intent-specific), duration_ms | INFO |
| `phase.skip` | run_id, phase, reason (the matrix cell) | INFO |
| `gate.open` / `gate.resolved` | run_id, gate, title, response, wait_ms | INFO |
| `run.end` | run_id, outcome, duration_ms, phases_run, phases_skipped, total_cost_usd, files_touched | INFO |

**B. Subagent delegation** — the half the MCP server never sees, and the reason a server-only logger would answer only half the ask.

| Event | Fields | Level |
|---|---|---|
| `delegate.subagent.start` | run_id, phase, subagent (architect, senior-reviewer, security-reviewer, discovery), prompt_bytes | INFO |
| `delegate.subagent.end` | run_id, phase, subagent, duration_ms, ok, artifact_path, output_bytes | INFO |

**C. Model dispatch via MCP** (`execute_with_model`).

| Event | Fields | Level |
|---|---|---|
| `tool.call.start` / `.end` | tool, arg_keys (names only), duration_ms, ok, error_class | DEBUG |
| `packet.validate.fail` | packet_id, missing_fields | WARN |
| `route.decide` | packet_id, phase, task_type, module, retry_count, rule_index, rule_reason, model_id, model_name, adapter, select slot/chosen/overridden | INFO |
| `adapter.construct` | model_id, adapter, cache_hit | DEBUG |
| `dispatch.start` | packet_id, model_id, adapter, input_slices, input_bytes, max_in, max_out, cache_context, work_dir | INFO |
| `dispatch.attempt` | packet_id, attempt_number, ceiling_used, hit_output_cap, stop_reason | DEBUG |
| `dispatch.end` | packet_id, model_id, ok, terminal_reason, tokens, cost_usd, latency_ms, attempts | INFO |
| `dispatch.error` | packet_id, model_id, error_class, message (scrubbed) | ERROR |
| `telemetry.append` | telemetry_path, events_written | DEBUG |

**D. Vendor and Agent Platform API transport.**

| Event | Fields | Level |
|---|---|---|
| `api.anthropic.request` / `.response` | model_name, max_tokens, system_bytes, messages_bytes, cache_control, stop_reason, usage, http_status, request_id | DEBUG |
| `api.gemini.backend` | backend (vertex-adc or ai-studio), reason, project, location, adc_file_present | INFO, once per run |
| `api.gemini.request` / `.response` | model_name, transport, cached_content, max_output_tokens, thinking_budget, finish_reason, usage, http_status | DEBUG |
| `api.gemini.cache.create` / `.hit` | cache_context, token_count, ttl | DEBUG |

**E. Antigravity (AG SDK) agent-worker delegation** — the specific ask, and today the least visible path.

| Event | Fields | Level |
|---|---|---|
| `agsdk.spawn` | packet_id, python_path, arg_count, work_dir, timeout_sec, forwarded_env_keys (**names only**), project, location | INFO |
| `agsdk.inventory.before` | packet_id, files_scanned, truncated | DEBUG |
| `agsdk.worker.stderr` | packet_id, line (scrubbed, capped) | TRACE |
| `agsdk.sidecar` | packet_id, sdk, sdk_version, vertex_project, vertex_location, thinking, tool_call_count, tool_calls_truncated | INFO |
| `agsdk.toolcall` | packet_id, index, name, target | DEBUG |
| `agsdk.diff` | packet_id, added_n, modified_n, removed_n, unchanged, truncated, unreadable_n | INFO |
| `agsdk.exit` | packet_id, exit_code, timed_out, duration_ms, stdout_bytes, stderr_bytes | INFO |
| `agsdk.record.write` | packet_id, path, ok | DEBUG |

`agsdk.worker.stderr` requires changing `AntigravityWorkerAdapter.ts:283-284` to stream stderr line by line to the logger while still buffering it for the existing `tail()` error path.

**F. Policy, preflight, credentials.**

| Event | Fields | Level |
|---|---|---|
| `policy.load` | policy_name, resolved_path, source, version, model_count, rule_count | INFO |
| `policy.adapter.deprecated` | adapter_id_seen, canonical | WARN |
| `policy.select` | slot, chosen, overridden, unreachable_models | DEBUG |
| `preflight.model` | model_id, adapter, ok, error_class, classification (blocking, warning, not_selected) | INFO |
| `preflight.result` | ok, halt_reason, warnings_n, backend, project, location | INFO |
| `credential.discover` | provider, source, key_env_name (**never the value**), found | DEBUG |
| `env.legacy_name` / `env.placeholder.strip` | names | WARN |

**G. Write contract and provenance** — existing output, moved onto the prefix.

| Event | Fields | Level |
|---|---|---|
| `write.allow` | run_id, path, matched_rule | DEBUG |
| `write.deny` | run_id, path, matched_off_limits_rule, strict | WARN |
| `provenance.before` / `.after` / `.finalize` | run_id, path, tracked_in_git, backup_path, sha16 | DEBUG |

## 6. Out of scope

### 6.1 Deferred

- **`.sdlc/` → `.mmo/`.** A data migration, not a rename (MMO-D6). Would need a dual-read shim across `session-hydrate`, `revert`, `write-contract-check`, and `off-limits`, plus a migration script and coverage for the mixed state where a repo has both directories.
- **`/sdlc:*` deprecation aliases.** See MMO-D7.
- **Renaming `/mmo:pass`.** See MMO-D3.
- **`/mmo:support-bundle`.** `plan.md` §14.11 specifies it; it is a separate deliverable from the log stream itself.
- **Structured JSONL twin of the log.** The logfmt line is greppable and parseable; a second machine format can wait for a consumer that needs it.

### 6.2 Explicitly never

- Logging prompt text, file contents, model output, or diff bodies at any level, including `TRACE`.
- Logging environment variable values, under any circumstance. Names only.
- Writing anything to stdout from the MCP server.

## 7. Sub-task breakdown

Three commits on one branch, in this order. Reviewing a mechanical rename mixed with new logic is how a dead tool binding slips through unnoticed.

### 7.1 Commit 1 — the rename

1. Three `git mv` operations (§5.1).
2. Ordered token replacement across the tracked, non-historical file set.
3. Both manifests: name, version, MCP server key, `args` path, env whitelist.
4. The two compatibility shims (MMO-D8).
5. New `tools/test/namespace.test.mjs`.
6. Dated notes on the two historical directories.

### 7.2 Commit 2 — the job commands

1. `plugin/config/intents.json`.
2. Extract `plugin/skills/brownfield-guide/SKILL.md` with the conditional step 4.
3. Fix the `auth_mode` / `code_dir` / `output_dir` handover, and the orchestrator's brownfield advertisement.
4. Rewrite `plugin/commands/brownfield.md` as a thin caller.
5. Seven command files.
6. New `tools/test/intent-commands.test.mjs`.
7. Docs: the README command table moves from six commands to thirteen.

### 7.3 Commit 3 — the logging

1. `src/log.ts`, `plugin/scripts/lib/log.mjs`, `plugin/scripts/lib/env.mjs`, `plugin/scripts/mmo-log.mjs`.
2. Instrument taxonomy A–G.
3. Stream the AG SDK worker's stderr instead of discarding it.
4. `docs/logging.md`, plus the `docs/methodology.md` entry CONTRIBUTING requires.
5. New `tools/test/logging.test.mjs` and `plugin/mcp/model-dispatch/test/log.test.mjs`.

## 8. Files to create

| Path | Contents |
|---|---|
| `plugin/config/intents.json` | The seven-intent registry |
| `plugin/skills/brownfield-guide/SKILL.md` | The shared seven-step manual |
| `plugin/commands/{docs,bugfix,feature-extend,feature-new,refactor,test,deps}.md` | The seven job commands |
| `plugin/mcp/model-dispatch/src/log.ts` | Server-side logger |
| `plugin/scripts/lib/log.mjs` | Script-side twin |
| `plugin/scripts/lib/env.mjs` | The central env reader the brownfield plan's D4 specified and nobody built |
| `plugin/scripts/mmo-log.mjs` | CLI wrapper for taxonomy A and B; fail-open, matching `write-provenance.mjs` |
| `docs/logging.md` | Format, levels, taxonomy, enablement, redaction |
| `tools/test/namespace.test.mjs` | Rename guards, both directions |
| `tools/test/intent-commands.test.mjs` | Registry ↔ commands ↔ matrix ↔ README |
| `tools/test/logging.test.mjs` | Format, levels, redaction, rotation, stdout purity |
| `plugin/mcp/model-dispatch/test/log.test.mjs` | Level resolution order, logfmt encoding |

## 9. Files to edit

### 9.1 The four sites that fail silently

Claude Code builds MCP tool names from the plugin name. Miss one of these and the tool binds to nothing rather than erroring — invisible to every test that only reads strings. This exact failure is dated 2026-08-04 in the comments of `tools/test/command.test.mjs`: nothing bound, the orchestrator fell back to driving compiled modules over Bash, and the test of the day passed green through the whole failure.

| File | Change |
|---|---|
| `plugin/agents/orchestrator.md:5` | The granted `tools:` list — eight names |
| `plugin/agents/orchestrator.md:30-52` | The install-route explainer table |
| `plugin/hooks/hooks.json:20` | Matcher becomes `mcp__(plugin_mmo_)?model-dispatch__execute_with_model` |
| `tools/test/command.test.mjs:218,307` | The assertions naming both spellings |

Plus `tools/setup.mjs` and `plugin/scripts/verify-setup.mjs`, which write and read the `.mcp.json` server key.

### 9.2 Everything else

Both manifests; all six existing command bodies; five agent files; both skills; `plugin/scripts/*.mjs`; `plugin/policy-console/{index.html,policy-server.mjs,README.md}`; `tools/{setup,report,test-mcp}.mjs`; `.gitignore`; `CONTRIBUTING.md`; and the docs listed below.

| Doc | Change |
|---|---|
| `README.md` | 22 references; "Six commands" becomes thirteen; new job-command table; both Mermaid diagrams |
| `SETUP.md` | 11 references including the next-steps banner `setup.test.mjs` reads |
| `docs/architecture.md` | 19 server references; command inventory gains the new rows, both skills, and the logging layer |
| `docs/running.md` | 13 references; the verbose flag and the `MMO_*` variables |
| `docs/troubleshooting.md` | 12 references; "turn on verbose logging" in the first-commands table |
| `docs/brownfield.md` | 10 references; job types link to their commands |
| `docs/README.md` | Add `docs/logging.md` to the Reference table |
| `docs/understanding-output.md` | `orchestrator.log` in the artifact table |
| `docs/methodology.md` | What the log records and how it differs from telemetry — required by CONTRIBUTING |

## 10. Verification plan

Unit tests can only read strings. They cannot prove the plugin binds.

### 10.1 Automated

```bash
npm test
```

- No shipped file outside the historical directories contains `/sdlc:`, `plugin_sdlc_`, `run-ai-sdlc`, or `gemini-flash-server` used as a path or server name.
- The reverse: nothing renamed `.sdlc/` or `AI-SDLC`, and `OFF_LIMITS_DEFAULT` still lists `.sdlc/**`.
- Registry ids equal the Intent-matrix rows equal the command files equal the README rows.
- Each command names its own intent and no other.
- Every `${CLAUDE_PLUGIN_ROOT}` path referenced resolves under `plugin/`.
- Logger: prefix on every line, `DEBUG` suppressed at default level, secrets redacted, rotation keeps one previous file, **nothing on stdout** (asserted against a subprocess's captured stdout).
- Both logger implementations emit byte-identical lines for the same input.

### 10.2 Live, because the above cannot cover it

```bash
npm run verify
```

Then, in a **new** Claude Code session, since commands and MCP servers register only at session start:

- `/help` lists thirteen `/mmo:*` commands and zero `/sdlc:*`.
- `/mmo:setup` reports `model-dispatch` as bound.
- `/mmo:bugfix` reaches Gate 0 with the intent pre-set; `/mmo:bugfix <description>` also shows the seeded brief; both still refuse to write before Gate 0 is approved.

A JSON-RPC `initialize` + `tools/list` against `dist/server.js` must return `model-dispatch` with all five tools and produce zero non-JSON bytes on stdout.

### 10.3 Logging, on a real run

```bash
grep "MMO:" .sdlc/runs/*/orchestrator.log | head -50
```

Expect `run.start` → `policy.load` → `preflight.*` → `phase.start` → `route.decide` → `dispatch.start` / `.end` → `gate.open` / `.resolved` → `run.end`. On an install using the agent door, also `agsdk.spawn`, `agsdk.sidecar`, `agsdk.diff`, `agsdk.exit`.

Redaction check, which must return nothing:

```bash
grep -iE "sk-ant-|AIza|BEGIN PRIVATE KEY|api[_-]?key=[^ ]" .sdlc/runs/*/orchestrator.log .sdlc/local/debug.log
```

### 10.4 Compatibility drills

- A policy using `mcp:gemini-flash-server` still resolves, and warns.
- An install exporting only `SDLC_SELECT` still routes, and warns.

## 11. Definition of done

- [ ] `npm test` green, with the new suites included.
- [ ] A fresh install in a new session lists thirteen `/mmo:*` commands, and `/mmo:setup` reports the server bound.
- [ ] All seven job commands reach Gate 0 with the intent pre-set, and refuse to write before approval.
- [ ] A real brownfield run produces an `orchestrator.log` containing every taxonomy group the run exercised.
- [ ] The redaction grep returns nothing.
- [ ] Both compatibility drills pass with a warning.
- [ ] `npm run report` still renders (CONTRIBUTING step 5).
- [ ] `docs/methodology.md` carries the telemetry-surface entry.
- [ ] No `Co-Authored-By:` trailer (CONTRIBUTING:29); no `CHANGELOG.md` (`publish.test.mjs:64`).

## 12. Risks and open questions

### 12.1 Conflict with the brownfield ticket's D5

`docs/brownfield-v1-planning/plan.md:1078-1080` (§23, decision **D5**) locks "everything folds into the two existing entry points," and §12 of that ticket names commands deliberately not shipped.

Two commands — `/sdlc:setup` and `/sdlc:policy` — were added after that lock (commits `3f03ce8`, `e7e0081`), so it has already been relaxed for setup-class commands. The line D5 actually draws is against a second *task* command.

This ticket keeps that substance: the seven job commands are aliases into the same entry point. Each pre-sets `intent` and then runs the identical manual, the identical Gate 0, and the identical write contract. Nothing branches, and there is no second pipeline.

**Action:** CONTRIBUTING requires an issue before a change of this size. Open one covering the D5 relaxation before commit 2.

### 12.2 Two deviations from the tech lead's wording

Both are called out here rather than discovered in review.

| Asked for | Shipping | Why |
|---|---|---|
| `mmt-bugfix`, `mmt-refactor`, `mmt-doc-gen` | `/mmo:bugfix`, `/mmo:refactor`, `/mmo:docs` | The namespace already disambiguates, and the command stem then equals the `intent` value in the matrix, so no mapping table exists to drift. The `T` in `MMT` is unexplained by "Multi-Model Orchestrator." |
| Log prefix `MM Orchestrator:` | `MMO:` | One token across commands, logs, and variables. The prefix is a single constant overridable by `MMO_LOG_PREFIX`, so reverting is a one-line change. The original wording was given as an example ("e.g."). |

### 12.3 Pre-existing test failures

Two tests in `tools/test/publish.test.mjs` fail on any machine with leftover git worktrees under `.claude/` or a populated `src/` sandbox, because they walk the working tree without honoring `.gitignore`. Both flagged paths are untracked and cannot ship. Unrelated to this work; tracked separately.

Baseline on `main` is **312 tests, 310 pass, 2 fail** — root suite 205/207 plus server suite 107/107. This ticket does not change it.

**Trap when checking that number.** `npm test` chains two commands and only the first prints the summary most readers copy. When `plugin/mcp/gemini-flash-server/node_modules` is absent, `tools/test-mcp.mjs` prints a NOT RUN banner and **exits 0**, so all 107 server tests disappear from a run that still looks green. Install the server's dependencies before trusting any count.

### 12.4 Open question — the `/mmo:pass` name

`pass` is the one word in the surface a newcomer provably cannot guess. Alternatives considered: `unattended`, `auto`, `no-prompts`, `flags`, `headless`. Held at `pass` for now (MMO-D3). Worth revisiting once the rest lands.

## 13. Non-goals for this ticket

Distinct from §6, which lists work that is deferred. These are things this ticket is not, and will not become:

- **Not a behavior change.** After all three commits, the pipeline does the same work in the same order for the same cost. Names change, seven aliases appear, and a log stream starts. No phase, gate, routing rule, or write-contract semantic moves.
- **Not a telemetry change.** `telemetry.jsonl`, `manifest.json`, and the cost report keep their current schemas. The log stream sits alongside them and never replaces them; §5.3 exists because cost accounting is not a log.
- **Not a policy change.** The shipped policies keep their routing. Only the adapter id string is renamed, with the old one still accepted.
- **Not a fix for the two failing tests.** They pre-date this work and are tracked separately (§12.3).

## 14. References

Everything this ticket draws on. Line numbers are against `main` at the time of writing.

| Source | Relevance |
|---|---|
| `docs/brownfield-v1-planning/plan.md:573` (§14.11) | The debug-mode design this ticket implements: `.sdlc/local/debug.log`, `run_id` + `phase` tagging, 5 MB rotation |
| `docs/brownfield-v1-planning/plan.md:1454` (D4) | The central env reader at `plugin/scripts/env.mjs`, specified and never built |
| `docs/brownfield-v1-planning/plan.md:1078-1080` (§23, D5) | The two-prompt UX lock this ticket must not violate — see §12.1 |
| `docs/brownfield-v1-planning/BROWNFIELD-MODE-V1-TICKET.md` | Format precedent for this document; §12 lists the commands v1 deliberately withheld |
| `plugin/skills/run-ai-sdlc/SKILL.md:255` | The 7×5 Intent matrix — the authority for which intents exist |
| `plugin/agents/orchestrator.md:143-148` | Rule 6, which aborts the run when `auth_mode` is missing (§5.2) |
| `plugin/agents/orchestrator.md:92-96` | Why run evidence is anchored to the telemetry path (§5.3 sinks) |
| `plugin/mcp/gemini-flash-server/src/envBootstrap.ts:13-15` | The stdout rule: stdout is the JSON-RPC transport, so logs go to stderr |
| `plugin/scripts/dispatch-sanitize.mjs` | The tested secret-pattern registry the logger reuses for redaction |
| `docs/brownfield-privacy.md` | What currently leaves the machine — the bound logging must not widen |
| `CONTRIBUTING.md` | One topic per PR; no `Co-Authored-By` trailers; reporting/telemetry changes need a `docs/methodology.md` entry |
| `CLAUDE.md` | Writing conventions enforced by `tools/test/style.test.mjs` |
| Commits `3f03ce8`, `e7e0081` | `/sdlc:setup` and `/sdlc:policy`, added after the D5 lock (§12.1) |
| Commit `bf6e94d` | The `multi-model-orchestrator` → `sdlc` rename this ticket reverses |
| Commit `6e6b6a6` | Reference implementation of §5.1, on the unpushed branch `feat/mmo-rename-code-wip` |
