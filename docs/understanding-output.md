# Understanding the output

After a pass finishes, three things live under `passes/<run-id>/`:

- `telemetry.jsonl` — one JSON object per line, one line per LLM call. The raw data.
- `manifest.json` — a rollup of the telemetry into totals, per-phase breakdown, and metadata.
- Generated source under `app/` (or similar, per the phase-writer) — the actual code the run produced.

And the report emitted by `node tools/report.mjs passes/<run-id>` is a rendered view of the manifest.

## The report, section by section

### Header

Identifies the pass: name, policy, and start timestamp. A run invoked with `--run-id=foo` will show `foo` in the header.

### SDLC task run

A table with one row per SDLC phase. Columns:

- **Calls** — how many LLM calls occurred in that phase.
- **Tokens (in / out)** — sum of input tokens and output tokens across those calls.
- **Cost** — sum of the per-call `cost_usd` values in the telemetry.

The row order follows the SDLC state machine — requirements first, then design, planning, codegen, tests, docs, senior review, security review.

The **"SDLC task total"** at the bottom is the sum of the Cost column. This is what the study is measuring: the cost of doing the software development work.

### Run stats

- **Wall-clock** — end-to-end duration of the pass.
- **Model calls** — total count of LLM calls, all phases and overhead included.
- **Code files produced** — count of files under the pass's generated source tree.

### Costs

Three lines:

- **SDLC task cost** — the same number as "SDLC task total" above. Repeated here for the cost-focused reader.
- **Runner overhead** — the cost of phases that aren't SDLC-productive per se: the orchestrator's planning turns, file reads, debug loops, shell operations. These are legitimate work the orchestrator does, but they're distinct from the code-producing SDLC phases.
- **Total session cost** — SDLC + overhead. If the manifest has a session-level cost figure from Claude Code, that is used as the authoritative total; otherwise the total is the arithmetic sum.

The two-line breakdown exists so the total is not surprising. On a pass where the orchestrator does a lot of debugging (e.g., a test failure forces multiple retries), the overhead line can be a meaningful fraction of the total. That is real cost.

### Methodology

A short reminder of which numbers are vendor-reported and which are estimated. Full details in [methodology.md](methodology.md).

### Artifacts

Paths to the raw files, for direct inspection.

## The raw files

### `telemetry.jsonl`

One JSON object per line. Key fields:

```json
{
  "ts": "2026-07-09T14:22:03.123Z",
  "phase": "codegen",
  "task_type": "controller_handler",
  "task_id": "tp_codegen_012",
  "module": "auth",
  "model": "claude-opus-4-7",
  "input_tokens": 3421,
  "input_tokens_cached": 0,
  "output_tokens": 2103,
  "cost_usd": 0.069,
  "latency_ms": 8241,
  "success": true,
  "artifact_path": "src/auth/auth.controller.ts"
}
```

Fields the report reads: `phase`, `input_tokens`, `input_tokens_cached`, `output_tokens`, `cost_usd`, `success`. Everything else is available for downstream analysis.

To sum costs by phase using standard shell tools:

```bash
jq -r 'select(.phase=="codegen") | .cost_usd' passes/pass1/telemetry.jsonl \
  | awk '{s+=$1} END {print s}'
```

### `manifest.json`

Aggregated form of the telemetry. Useful fields:

- `total_cost_usd`, `total_input_tokens`, `total_output_tokens`
- `phase_breakdown`, `module_breakdown`, `task_type_breakdown` — sub-rollups
- `duration_sec`
- `pass`, `policy_name`

### The Claude Code session transcript

Claude Code writes a JSONL transcript of every session to `~/.claude/projects/<project-hash>/<session-id>.jsonl`, and per-subagent transcripts to `~/.claude/projects/<project-hash>/<session-id>/subagents/agent-<id>.jsonl`. These files are the underlying source of truth for what the subagent said and did.

For audits at that level of detail, the files are on disk. The `<session-id>` for a given run is printed at the top of the Claude Code session output.

## Other files that may appear

- **`.hook-logs/hook.jsonl`** — a one-line-per-invocation heartbeat log written by the plugin's PostToolUse hook. Records timestamp and payload size for every `execute_with_model` call the MCP server handled. Independent of `telemetry.jsonl`; useful only for cross-checking that the hook fired for each expected MCP call. Safe to delete after a run.
- **`.claude/`** — created by the setup wizard and by Claude Code itself. Holds the project-installed slash command, the orchestrator agent, and Claude Code's own project state. Not intended for git (already in `.gitignore`).
