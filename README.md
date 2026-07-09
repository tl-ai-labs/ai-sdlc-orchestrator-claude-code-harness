<!-- Logo placeholder — replace docs/assets/logo.svg before publish -->
<p align="center">
  <img src="docs/assets/logo.svg" alt="Workforce Ops Study" width="120" />
</p>

# Workforce Ops — A Self-Runnable AI-SDLC Case Study

Run a full software project through a multi-model AI development pipeline on
your own machine, against your own API keys, and see for yourself what it
costs and what it produces.

This repository contains everything you need: the project brief, the
orchestration plugin, and a small set of tools that check your environment,
kick off the run, and print a clear report at the end. No dashboards, no
telemetry uploads — every artifact stays local.

## Quickstart

```bash
git clone https://github.com/tl-ai-labs/ai-study-workforce-ops.git
cd ai-study-workforce-ops
node tools/setup.mjs
```

The setup wizard walks you through prerequisites (Node, Claude Code CLI, API
keys), asks you to pick an **auth mode** for the run, installs plugin
dependencies, and confirms you are ready.

Then, in your Claude Code session:

```bash
# --permission-mode acceptEdits keeps the run flowing so it only stops at
# the four HITL gates (not at every file read). See "Permission mode" below.
claude --permission-mode acceptEdits
```

```
# simplest — defaults to the opus-only policy
/run-sdlc-pass brief.md

# explicit
/run-sdlc-pass --policy=opus-only       --run-id=pass1 brief.md
/run-sdlc-pass --policy=opus-plus-flash --run-id=pass2 brief.md
```

Prefer headless (unattended, CI-friendly):

```bash
claude --print "/run-sdlc-pass --policy=opus-only --run-id=pass1 brief.md" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  > passes/pass1/live-run.log
```

After a run:

```bash
node tools/report.mjs passes/pass1
```

**Expected wall-clock per pass: 1 – 1.5 hours.** Actual time depends on model latency, prompt size, and how many redirections you make at HITL gates.

## Auth mode — pick your billing story

The setup wizard asks explicitly (no auto-detection based on which env vars happen to be exported):

- **Vendor-authoritative** — needs an Anthropic API key. Every LLM call is billed to your Anthropic account; the report's dollar totals match your `console.anthropic.com` dashboard for the run's time window.
- **Estimator** — uses your Claude Code subscription for direct-tier work. No API key needed. Direct-tier tokens are char-count estimated at ~3.8 chars/token, so the report is a good approximation but will not match a vendor-billed run exactly.

Both are legitimate. Pick based on what you need — reproducibility against your Anthropic bill, or a subscription-friendly run. Details in [docs/setup.md](docs/setup.md) and [docs/methodology.md](docs/methodology.md).

## Permission mode

The orchestrator reads several files under this repo during the run (brief, requirements.md, design.md, telemetry logs, and so on). Under Claude Code's default permission mode, each read triggers a prompt. Two ways to keep the run flowing:

- Pass `--permission-mode acceptEdits` at launch — auto-approves file reads and edits, but still stops at the four HITL gates (which use interactive prompts, not the permission system).
- Or, without the flag, approve each prompt when it appears.

Do **not** use `--permission-mode bypassPermissions` for this study — that mode can skip the HITL gates, which are the entire point of the "human in the loop" story.

## What each policy does

| Policy            | What it uses |
|-------------------|--------------|
| `opus-only`       | Claude Opus for every phase |
| `opus-plus-flash` | Opus for judgment phases; Gemini 3.5 Flash for mechanical (codegen, tests, docs) |

Your run's cost depends on model output length, caching, and current vendor
pricing. The report at the end shows what your run actually spent — no upfront
promises.

## Documentation

- [docs/setup.md](docs/setup.md) — detailed setup and troubleshooting
- [docs/running.md](docs/running.md) — running the passes, choosing a policy
- [docs/understanding-output.md](docs/understanding-output.md) — reading the report and the raw files
- [docs/methodology.md](docs/methodology.md) — how tokens and costs are recorded, what is measured vs estimated

## License

MIT — see [LICENSE](LICENSE). Fork, modify, and use as you wish.
