# Ping Service — the model path

> **2026-08-18:** the plugin was renamed `sdlc` → `mmo` after this run was recorded. This is a
> shipped evidence record — commands, paths, and manifest data below are shown as they were at
> the time, not rewritten.

A complete run of the Ping Service brief with `opus-plus-flash`, mechanical
phases going to Gemini **as a model**: Claude reads the files, sends the text,
Gemini sends text back, Claude writes the result to disk. This is what an
untouched install does.

| | |
|---|---|
| Brief | [../../brief.md](../../brief.md) |
| Policy | `opus-plus-flash` (Claude Opus 4.7 for judgment, Gemini 3.5 Flash for mechanical) |
| Auth mode | `estimated` |
| Wall-clock | 28 minutes |
| Model calls | 11, of which 5 were dispatched packets (one retried) |
| Tokens | 43,027 in / 33,647 out |
| Recorded cost | $0.84 |

The same brief run down the other door is [../agent-path/](../agent-path/), and
the two READMEs are meant to be read together — that is the only reason both are
here.

## What is in here

- `.sdlc/` — the run record. `manifest.json` is the machine-readable summary the
  reporter reads; `requirements.md`, `design.md` and `security_review.md` are
  what the judgment phases produced; `telemetry.jsonl` is one line per model
  call; `packets.json` is the dispatch ledger.
- `src/` — the application the run generated, exactly as it was left.

Render the report from it with:

```bash
node tools/report.mjs examples/quick-demo/passes/model-path
```

## Two things to read the cost with

**`auth_mode` is `estimated`, so the dollar figure is an approximation.** Under
subscription auth the premium tier's tokens are counted by character estimate at
about 3.8 characters per token rather than billed and reported by the vendor. The
Gemini side is vendor-reported either way. A `--auth=vendor` run of the same brief
would reconcile against an Anthropic invoice; this one is honest arithmetic on an
estimate, which is why it is labelled.

**`node_modules/` and `package-lock.json` are not here.** Neither is pipeline
output — npm wrote both — and together they are 41 MB. `npm install` in `src/`
reproduces them.
