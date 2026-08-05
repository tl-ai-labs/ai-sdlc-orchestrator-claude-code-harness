# AI-SDLC Orchestrator — Claude Code Harness

**Requires:** Node 20+, [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), and either an Anthropic API key or a Claude Code subscription. Gemini access — either Gemini Enterprise Agent Platform (formerly Vertex AI) on a Google Cloud project, which needs no key, or an AI Studio API key — is needed only by the multi-model policy.

## Overview

A Claude Code plugin that runs a multi-model AI-SDLC pipeline (requirements →
design → codegen → tests → senior review → security review) against a project
brief. Three briefs ship with the repo. Ping Service under
[examples/quick-demo/](examples/quick-demo/) is one endpoint on Express with no
database — the one to run first, because it exercises every phase in minutes
rather than hours. Workforce Operations under
[examples/workforce-ops/](examples/workforce-ops/) is the reference case, and
Travel Booking Operations under [examples/travel-ops/](examples/travel-ops/) is
a second domain — booking, cancellation and refund handling. Both of those
describe five modules, so expect a run of an hour or more.

The repo contains the plugin, the reference brief, a setup wizard, and a
reporter. Runs use your own Anthropic (and optionally Google) API keys.
Telemetry, generated code, and reports are written under the repo; nothing is
uploaded.

## Install

Two prompts, in an empty folder, with Claude Code open. Nothing to clone and no
commands to type.

```
Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness
```

Claude Code follows [SETUP.md](SETUP.md): it registers the marketplace, installs
the plugin, builds the bundled model server, and reports what is ready and what
is missing. The build step is not optional — the plugin manifest points at build
output that no clone carries, so an install that skips it registers a command
whose model dispatch fails partway through the first run.

```
/sdlc-run
```

**Type it in a new session.** Claude Code registers a plugin's slash commands
*and* starts its MCP servers when a session starts, so the session that just ran
the install has neither. The command arrives one session late, and so does the
bundled model server that every cost-efficient dispatch goes through — a run
started in the install session would put all nine phases on the premium model.
Open a new session in the same folder and both are there.

`/sdlc-run` takes no arguments. It checks the install, finds a brief in the
folder or offers the shipped examples — or writes a brief from your description
if you do not have one — shows which model each phase will run on, confirms the
plan, and only then starts spending. Generated code lands in `./src`; the run
record, including telemetry and the cost report, lands in `./.sdlc/`.

To check an existing install at any time, or to repair one after
`/plugin update` replaces the plugin files:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)" --fix
```

## Quickstart

Working from a clone instead, with the full flag surface:

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

`/sdlc-run` handles this by asking — point it at your file, or let it write one
from a description. The rest of this section covers the same thing through
`/run-sdlc-pass`, which takes the brief path as a positional argument.

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

Every run records tokens in one of two modes. `/sdlc-run` puts the choice to you
and recommends one based on the credentials it finds; `/run-sdlc-pass` requires
`--auth` on every invocation. Two values:

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

`opus-plus-flash` can reach that mechanical tier two ways. By default Gemini is
a **model**: Claude reads the files, sends the text, and writes the answer back.
It can instead be an **agent**, through Google's Antigravity SDK — Gemini opens
the working folder itself, runs commands and edits files, and Claude reviews the
result. The agent path needs Google Cloud credentials and Python 3.10+, and costs
several times more per task, so it is off unless you ask for it. Both installation routes ask, and
either way the answer is one command — `npm run verify -- --enable-agent`, or
the same flag on the installed plugin's verify script, which records the choice
and builds what it needs. A run that took the agent path leaves the evidence
for it: a **Delegated to an agent worker** section on the report, and a
`delegation/` directory holding the brief each worker was given and a receipt
for what it did. See
[docs/setup.md](docs/setup.md#gemini-as-a-model-or-gemini-as-an-agent).

## Documentation

- [docs/setup.md](docs/setup.md) — detailed setup and troubleshooting
- [docs/running.md](docs/running.md) — running the passes, choosing a policy, running the pipeline on a brief of your own
- [docs/brief-template.md](docs/brief-template.md) — the section layout the pipeline expects in a brief file
- [docs/understanding-output.md](docs/understanding-output.md) — reading the report and the raw files
- [docs/methodology.md](docs/methodology.md) — how tokens and costs are recorded, what is measured vs estimated
- [docs/gemini-paths-findings.md](docs/gemini-paths-findings.md) — the two Gemini doors compared on the same brief: tokens, cost, what the delegation evidence gives you, and where the agent path is awkward
- [docs/walkthroughs/](docs/walkthroughs/) — the same two runs frame by frame: [model-path.html](docs/walkthroughs/model-path.html), [agent-path.html](docs/walkthroughs/agent-path.html). Open them in a browser; each is self-contained.
- [examples/quick-demo/](examples/quick-demo/) — the smallest brief: one endpoint, no database, minutes to run. Two complete runs of it are recorded under `passes/` — [model-path](examples/quick-demo/passes/model-path/) and [agent-path](examples/quick-demo/passes/agent-path/) — the same brief down each Gemini door, so the cost and time difference is a number rather than a claim.
- [examples/workforce-ops/](examples/workforce-ops/) — the reference brief and any recorded passes
- [examples/travel-ops/](examples/travel-ops/) — a second brief: booking, cancellation and refund handling

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
