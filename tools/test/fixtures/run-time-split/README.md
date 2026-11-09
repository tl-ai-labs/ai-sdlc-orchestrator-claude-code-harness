# run-time-split fixtures

Three real brownfield runs, reduced to what the cost collector and the run-time split read. The consuming suite is `plugin/mcp/model-dispatch/test/collectOrchestratorUsageTimeSplit.test.mjs`.

| Fixture | Run | Job | Session and helpers | Handed out | Window (run.start to the last run.end or gate.resolved) | Size |
|---|---|---|---|---|---|---:|
| `gemini-led-bugfix` | `20261106-bugfix-eyedropper-dark-theme` (Claude Code 2.1.318, plugin 0.10.1) | bugfix | Opus 5.5 session, 2 helpers (discovery, brownfield orchestrator) | Gemini 4 Argon (judgment phases), Gemini 3.8 Flash | 08:38:53.132 to 10:37:37.979 UTC, 7,124.847 s | 456 KB |
| `claude-led-feature-new` | `20261109-120000-feature-new-text-styling` (same versions) | feature-new | Opus 5.5 session, 6 helpers (discovery, orchestrator, two architects, two reviewers) | Gemini 3.8 Flash, Opus 5.5 typist | 07:56:09.338 to 09:02:10.170 UTC, 3,960.832 s | 728 KB |
| `claude-led-feature-extend` | `20261109-131655-feature-extend-arrowhead-size` (same versions) | feature-extend | Opus 5.5 session, 5 helpers (discovery, orchestrator, architect, two reviewers) | Gemini 3.8 Flash, Opus 5.5 typist | 07:54:30.128 to 08:54:36.757 UTC, 3,606.629 s | 728 KB |

Each fixture holds:

| Path | What it is |
|---|---|
| `run/manifest.json` | The run's manifest, unchanged. |
| `run/telemetry.jsonl` | Every telemetry line, reduced to identity, phase, model, provenance, door, tier, tokens, cost, `latency_ms`, outcome, and `routing` reduced to the policy name, version and rule index. |
| `run/orchestrator.log` | Every log line, reduced to its time, level and event. `run.start`, `run.end`, `gate.open` and `gate.resolved` also keep `run_id`, `mode`, `intent`, `gate`, `title`, `response`, `outcome` and `reason`. |
| `transcripts/<session>.jsonl` | Claude Code's history file for the run's session, reduced (below). |
| `transcripts/<session>/subagents/agent-<id>.jsonl`, `.meta.json` | Each helper's history file, reduced the same way, and its `agentType`, `toolUseId`, `parentAgentId` and `spawnDepth`. |
| `before-time-split/manifest.json`, `telemetry.jsonl` | What the collector at develop `958d7f0` (before `time_split` existed) wrote for the fixture. The manifest is byte for byte the run's own manifest. |

`opus55-plus-flash38-agsdk.yaml` is written for the two claude-led fixtures: the runs used a policy of that name that the plugin does not ship. It names their two models (`opus` and `flash`, as their telemetry does) with no pricing blocks, so the collector prices every message from the price list.

## What was kept from the history files

Every line that carries a timestamp, with its `type`, `timestamp`, `uuid`, `parentUuid`, `isSidechain`, `sessionId` and `agentId`, and:

| Line | Kept |
|---|---|
| `assistant` | `message.{id, type, role, model, stop_reason}`, `usage` reduced to the token counts, the `cache_creation` 5-minute and 1-hour split, `service_tier`, `speed` and `inference_geo`; content blocks as `{type}`, with `{id, name}` for a `tool_use` (`input` is `{}`, except a `Skill` call's `skill` and its `--run-id`); `requestRef` |
| `user` | `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `origin.kind`, `promptSource`, `turnOrigin`, `toolUseResult` (as `{}`, `""` or `[]`, and `{agentId}` on an `Agent` or `Task` result); content blocks as `{type}`, with `tool_use_id` and `is_error` for a `tool_result`; a slash command's name and `--run-id`; the `agentId: <id>` line of an `Agent` or `Task` result |
| `system`, `attachment`, `queue-operation`, `api-request` | `subtype`, `attachment.type`, `operation`, `id` |

Every text, prompt, thinking block, tool input and output, path, working directory, version, account and request field is removed. Lines without a timestamp (titles, account, mode and permission records, request bodies, file snapshots, cost state) are left out. The run's command turn keeps only its command tags.

## Rebuilding

`build.mjs` made every file here except the policy and this README. From the repository root, with the run's folder and Claude Code's history folder for its project:

```
node tools/test/fixtures/run-time-split/build.mjs --run <project>/.sdlc/runs/20261106-bugfix-eyedropper-dark-theme \
  --history ~/.claude/projects/<project hash> --session fdf1cec7-1923-4c9a-a8af-948f2e847a07 \
  --out tools/test/fixtures/run-time-split/gemini-led-bugfix
node tools/test/fixtures/run-time-split/build.mjs --run <project>/.sdlc/runs/20261109-120000-feature-new-text-styling \
  --history ~/.claude/projects/<project hash> --session 543b41f9-da42-45ab-a98b-3deb13f4ade4 \
  --out tools/test/fixtures/run-time-split/claude-led-feature-new
node tools/test/fixtures/run-time-split/build.mjs --run <project>/.sdlc/runs/20261109-131655-feature-extend-arrowhead-size \
  --history ~/.claude/projects/<project hash> --session 57903073-7737-49b7-aa91-51c947adcec0 \
  --out tools/test/fixtures/run-time-split/claude-led-feature-extend
```

`<project hash>` is the project folder's absolute path with every character that is not a letter or digit replaced by `-`. The `before-time-split/` records come from a checkout of `958d7f0`:

```
node tools/test/fixtures/run-time-split/build.mjs --before tools/test/fixtures/run-time-split/gemini-led-bugfix \
  --collector <958d7f0 checkout>/plugin/scripts/collect-orchestrator-usage.mjs
node tools/test/fixtures/run-time-split/build.mjs --before tools/test/fixtures/run-time-split/claude-led-feature-new \
  --collector <958d7f0 checkout>/plugin/scripts/collect-orchestrator-usage.mjs \
  --policy-path tools/test/fixtures/run-time-split/opus55-plus-flash38-agsdk.yaml
```

(and the same for `claude-led-feature-extend`).

## Checked

The collector writes the same figures (`orchestrator_overhead`, `true_total_cost_usd`, `phase_breakdown` and its telemetry event, all but the event's write time) from each fixture as from the original files, and from each fixture it writes the run's own manifest byte for byte.
