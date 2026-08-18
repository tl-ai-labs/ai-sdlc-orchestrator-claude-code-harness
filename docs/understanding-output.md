# Understanding the output

> **For:** reading `telemetry.jsonl`, `manifest.json`, `provenance.json`, and the cost report. **Also see:** [methodology.md](methodology.md) · [running.md](running.md).

After a pass finishes, three things live under the run's output directory — `examples/<study-id>/passes/<run-id>/` for greenfield (`/mmo:pass`, `/mmo:greenfield`), `.sdlc/runs/<YYYYMMDD-HHMMSS>-<intent>-<slug>/` for brownfield (`/mmo:brownfield`, `/mmo:pass --mode=brownfield`):

- `telemetry.jsonl` — one JSON object per line, one line per LLM call. The raw data.
- `manifest.json` — a rollup of the telemetry into totals, per-phase breakdown, and metadata.
- Generated source under `app/` (greenfield) or the files named at Gate 0 (brownfield) — the actual code the run produced.

A fourth appears only on runs that delegated to the agent worker — installs that chose the agent path, via `--enable-agent` on the verify script or the wizard's question ([setup.md](setup.md#gemini-as-an-agent--antigravity-sdk)):

- `delegation/` — three files per delegated packet: the brief the worker was given, the usage sidecar it wrote, and a receipt describing what it did. See [the delegation directory](#the-delegation-directory).

Brownfield runs add three more under `.sdlc/runs/<run-id>/`:

- `provenance.json` — every file this run created or modified, keyed by path. `/mmo:revert` reads this to undo the run.
- `intent_brief.md`, `discovery.md`, `change_plan.md`, `senior-review.md`, `security-review.md`, `final_report.md` — the per-phase artifacts.
- `packets.jsonl` — the TaskPacket stream the orchestrator dispatched, one per line.

And the report emitted by `node tools/report.mjs <output-dir>` is a rendered view of the manifest.

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

### Delegated to an agent worker

Printed only when the run delegated. On every other run the section is absent rather than empty — an all-Opus pass made no such distinction, and a table of zeroes would suggest it did.

It opens with the division of labour, because that is the one fact this mode changes and the one a reader is most likely to get wrong:

| Tag | Who |
|---|---|
| `[C]` | Claude Code — the harness. Plans, gates, integrates. Writes no shipped code. |
| `[C→G]` | the handoff — a brief written to disk, then a worker subprocess in the working directory. |
| `[G]` | the Antigravity SDK worker — an agent with tools, which writes the code. |

Then one row per delegated packet:

- **Tools** — how many tool calls the worker made. This is the number that shows an agent was really working rather than answering once; a trailing `+` means the worker's own recording cap was hit and the figure is a floor.
- **Files** — `+` added, `~` modified, `-` removed. See the caveat below.
- **Time** — wall-clock for that worker process.
- **Cost** — from telemetry, so it covers every attempt at the packet.

Three markers can follow a packet id. `*` — the packet was retried; the cost covers all attempts, but tools, files and time describe the last one, because a retry overwrites the receipt. `!` — the worker did not finish; it was still billed and may still have edited files. `?` — no telemetry event carries this task id, so the cost shown is the receipt's own figure.

The last two rows are the point: the delegated subtotal, and a `[C]` line for everything else in the run. They add up to the SDLC + overhead total.

**What "Files" does and does not claim.** The server takes a content digest of every file in the working directory immediately before the worker starts and again immediately after it exits, and compares them. Modification means the *content* changed — a formatter that rewrote a file byte-for-byte, or an `npm install` that rewrote a lockfile identically, does not count. `.git`, `node_modules`, `dist`, `.venv` and similar are not walked, and the worker's own output directory is excluded so a delegation cannot report its own evidence as a change.

That gives you what changed *while the worker held the directory*. It is not proof the worker was the only thing writing there, and it cannot attribute any one change to any one tool call. If you need that, read the receipt's tool-call list.

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
  "model_id": "opus",
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

`model` is the vendor's model name and `model_id` is the policy leaf that dispatched. They are usually redundant, and there is one case where they are not: a policy can offer two ways of reaching the same model — Gemini as a completion call or as an Antigravity agent — and both carry `"model": "gemini-3.5-flash"`. `model_id` (`flash-completion` or `flash-agsdk-worker`) is the only field that says which, and a `routing.select` object alongside it records the choice that led there. Group by `model_id`, not `model`, when the distinction matters. See [methodology.md](methodology.md#two-doors-to-the-mechanical-tier-and-how-the-report-tells-them-apart).

`latency_ms` is `null` on phases that ran on the direct tier — those execute inside Claude Code rather than being dispatched through the MCP server, so nothing ever timed them. `null` means "not measured", as distinct from a real measured `0`. Phases dispatched to a mechanical-tier model (Gemini) carry a real wall-clock figure. To compare tiers on speed, use the gaps between consecutive `ts` values, which are stamped server-side for every event.

To sum costs by phase using standard shell tools:

```bash
jq -r 'select(.phase=="codegen") | .cost_usd' examples/workforce-ops/passes/pass1/telemetry.jsonl \
  | awk '{s+=$1} END {print s}'
```

### `manifest.json`

Aggregated form of the telemetry. Useful fields:

- `total_cost_usd`, `total_input_tokens`, `total_output_tokens`
- `phase_breakdown`, `module_breakdown`, `task_type_breakdown` — sub-rollups
- `duration_sec`
- `pass`, `policy_name`

### The delegation directory

Present only on runs that delegated. Three files per delegated packet, all named after the packet's task id:

- **`worker-task-<packet>.md`** — the brief the worker was given, exactly as it was written to disk. This is the prompt: what the packet asked for, which files it excerpted, and the output contract. Nothing was added to it out of band.
- **`worker-usage-<packet>.json`** — written by the worker process itself, in its own words: the model it reached, the SDK version, the Google Cloud project and region, its token usage, and its tool calls.
- **`worker-delegation-<packet>.json`** — the receipt, written by the server. Joins the two above to what changed on disk.

The receipt carries `schema: "delegation-record/1"` and these fields:

| Field | Meaning |
|---|---|
| `task_id`, `phase`, `task_type`, `module` | the packet, and the join key back to `telemetry.jsonl` |
| `cable` | sdk, sdk_version, vertex_project, vertex_location, thinking — **copied from the worker's sidecar**, so it records what the run used rather than what it intended. All null if the worker died before writing one. |
| `duration_ms`, `success`, `error` | the worker process's outcome |
| `cost_usd`, `tokens` | this delegation's own spend |
| `tool_calls` | `count` (the full total), `truncated`, and `sample` (capped) |
| `files` | `added`, `modified`, `removed` as path lists, plus `unchanged`, `scanned`, `truncated`, `unreadable` |
| `artifacts` | filenames of the brief and the sidecar |

A receipt is written for failed delegations too — that is the case a reader most needs one for. Writing it can never fail the delegation: if the file cannot be written, the server warns on stderr and the run continues.

A retried packet overwrites all three files, so what survives describes the final attempt. The report marks those rows with `*`.

### The Claude Code session transcript

Claude Code writes a JSONL transcript of every session to `~/.claude/projects/<project-hash>/<session-id>.jsonl`, and per-subagent transcripts to `~/.claude/projects/<project-hash>/<session-id>/subagents/agent-<id>.jsonl`. These files are the underlying source of truth for what the subagent said and did.

For audits at that level of detail, the files are on disk. The `<session-id>` for a given run is printed at the top of the Claude Code session output.

## Other files that may appear

- **`.hook-logs/hook.jsonl`** — a one-line-per-invocation heartbeat log written by the plugin's PostToolUse hook. Records timestamp and payload size for every `execute_with_model` call the MCP server handled. Independent of `telemetry.jsonl`; useful only for cross-checking that the hook fired for each expected MCP call. Safe to delete after a run.
- **`.claude/`** — created by the setup wizard and by Claude Code itself. Holds the project-installed slash command, the orchestrator agent, and Claude Code's own project state. Not intended for git (already in `.gitignore`).
