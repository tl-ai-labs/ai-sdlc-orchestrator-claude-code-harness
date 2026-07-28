# AI-SDLC Orchestrator — Claude Code Harness

**Requires:** Node 20+, [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), and either an Anthropic API key (`--auth=vendor`) or a Claude Code subscription (`--auth=estimated`).

## Overview

A Claude Code plugin that runs a multi-model AI-SDLC pipeline (requirements →
design → codegen → tests → senior review → security review) against a project
brief. Ships with the Workforce Operations brief under
[examples/workforce-ops/](examples/workforce-ops/) as the reference case.

The repo contains the plugin, the reference brief, a setup wizard, and a
reporter. Runs use your own Anthropic (and optionally Google) API keys.
Telemetry, generated code, and reports are written under the repo; nothing is
uploaded.

## Quickstart

```bash
git clone https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness.git
cd ai-sdlc-orchestrator-claude-code-harness
node tools/setup.mjs
```

The setup wizard checks prerequisites (Node, Claude Code CLI, API keys),
installs plugin dependencies, and registers the bundled MCP server.

Then, in your Claude Code session:

```bash
# --permission-mode acceptEdits keeps the run flowing so it only stops at
# the four HITL gates (not at every file read). See "Permission mode" below.
claude --permission-mode acceptEdits
```

```
# vendor mode (real vendor tokens; needs ANTHROPIC_API_KEY)
/run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md

# estimator mode (subscription auth; no API key required)
/run-sdlc-pass --auth=estimated --run-id=pass1 examples/workforce-ops/brief.md

# opus + Gemini Flash multi-model
/run-sdlc-pass --auth=vendor --policy=opus-plus-flash --run-id=pass2 examples/workforce-ops/brief.md
```

Prefer headless (unattended, CI-friendly):

```bash
claude --print "/run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  > examples/workforce-ops/passes/pass1/live-run.log
```

After a run:

```bash
node tools/report.mjs examples/workforce-ops/passes/pass1
```

Wall-clock per pass: about 1 – 1.5 hours, depending on model latency, prompt
size, and HITL redirections.

## Running the pipeline on a different brief

`/run-sdlc-pass` reads the brief path as a positional argument. Passing a
markdown file other than the shipped one runs the orchestrator against that
file instead.

```
/run-sdlc-pass --auth=vendor --study=my-project --run-id=pass1 path/to/my-brief.md
```

Output lands in `examples/<study-id>/passes/<run-id>/`, so `--study=my-project`
above writes to `examples/my-project/passes/pass1/`. `--run-id` keeps each
pass's outputs in its own subdirectory. The section layout the requirements
phase and architect subagent expect is in
[docs/brief-template.md](docs/brief-template.md);
[docs/running.md](docs/running.md#bring-your-own-brief) has the full workflow.

## Auth mode

`--auth` is required on every `/run-sdlc-pass` invocation. Two values:

- **`--auth=vendor`** — needs `ANTHROPIC_API_KEY`. Every LLM call is dispatched via the bundled MCP server and billed to your Anthropic account; the report's dollar totals match your `console.anthropic.com` dashboard for the run's time window.
- **`--auth=estimated`** — uses your Claude Code subscription for direct-tier work. No API key required. Direct-tier tokens are char-count estimated at ~3.8 chars/token; the report is an approximation and will not match a vendor-billed run exactly.

`--auth=vendor` gives numbers that reconcile against your Anthropic bill;
`--auth=estimated` works on a subscription without an API key. Details in
[docs/setup.md](docs/setup.md) and [docs/methodology.md](docs/methodology.md).

## Permission mode

The orchestrator reads several files under this repo during the run (brief, requirements.md, design.md, telemetry logs, and so on). Under Claude Code's default permission mode, each read triggers a prompt. Two ways to keep the run flowing:

- Pass `--permission-mode acceptEdits` at launch — auto-approves file reads and edits, but still stops at the four HITL gates (which use interactive prompts, not the permission system).
- Or, without the flag, approve each prompt when it appears.

Do **not** use `--permission-mode bypassPermissions` — that mode can skip the HITL gates, and the run depends on them.

## What each policy does

| Policy            | What it uses |
|-------------------|--------------|
| `opus-only`       | Claude Opus for every phase |
| `opus-plus-flash` | Opus for judgment phases; Gemini 3.5 Flash for mechanical (codegen, tests, docs) |

Cost depends on model output length, caching, and current vendor pricing. The
report at the end shows what the run spent.

## Documentation

- [docs/setup.md](docs/setup.md) — detailed setup and troubleshooting
- [docs/running.md](docs/running.md) — running the passes, choosing a policy, running the pipeline on a brief of your own
- [docs/brief-template.md](docs/brief-template.md) — the section layout the pipeline expects in a brief file
- [docs/understanding-output.md](docs/understanding-output.md) — reading the report and the raw files
- [docs/methodology.md](docs/methodology.md) — how tokens and costs are recorded, what is measured vs estimated
- [examples/workforce-ops/](examples/workforce-ops/) — the reference brief and any recorded passes

## License

MIT — see [LICENSE](LICENSE). Fork, modify, and use as you wish.

---

<p align="center">
  <a href="https://tilicho.in">
    <img src="https://tilicho.in/favicon.ico" alt="Tilicho" width="48" />
  </a>
  <br />
  Built and maintained by <a href="https://tilicho.in">Tilicho</a>.
</p>
