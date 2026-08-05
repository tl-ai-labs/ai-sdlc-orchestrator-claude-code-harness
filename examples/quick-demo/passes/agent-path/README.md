# Ping Service — the agent path

The same brief, the same policy, the same machine — with the mechanical tier
switched to Gemini **as an agent** through Google's Antigravity SDK. Gemini was
handed the working directory: it listed and read files itself, ran commands, and
wrote its own edits, and Claude reviewed what changed.

| | |
|---|---|
| Brief | [../../brief.md](../../brief.md) |
| Policy | `opus-plus-flash` with `SDLC_SELECT=gemini-flash=flash-agsdk-worker` |
| Auth mode | `estimated` |
| Wall-clock | 63 minutes |
| Model calls | 11, of which 5 were delegated to the agent worker |
| Tokens | 1,714,495 in (1,038,870 of them cached) / 72,727 out |
| Recorded cost | $2.18 |

## The comparison, which is the point of shipping both

| | [model path](../model-path/) | agent path |
|---|---|---|
| Wall-clock | 28 min | 63 min |
| Total tokens | 76,674 | 1,787,222 |
| Recorded cost | $0.84 | $2.18 |

Same brief, same policy, same four gates approved, both ending in a working
service. The agent path cost about 2.6× as much and took about 2.2× as long,
and the token column shows why: an agent re-sends the whole conversation on
every tool call, on top of a fixed preamble it carries every turn. 23× the
tokens for 2.6× the money is the cache doing its work — most of that input was
served from cache at a tenth of the fresh rate.

This is one run of one small brief, not a benchmark. It is here so the trade is
a number rather than a claim, and so the shape of the trade — much more traffic,
somewhat more money, meaningfully more time — is visible before anyone spends
anything.

## What is in here

Everything the model path record has, plus the evidence the agent path leaves
behind:

- `.sdlc/delegation/worker-task-*.md` — the brief each worker was handed.
- `.sdlc/delegation/worker-delegation-*.json` — what it did: every tool call,
  every file it touched.
- `.sdlc/delegation/worker-usage-*.json` — what the vendor billed for it.
- `.sdlc/review.json` — the senior review of what came back.

```bash
node tools/report.mjs examples/quick-demo/passes/agent-path
```

The report grows a **Delegated to an agent worker** section for a run like this
one.

## Three things about these files

**`auth_mode` is `estimated`**, so the premium tier's tokens are char-count
estimates rather than vendor-billed figures — see the note in the model path's
README. The delegated half is vendor-reported.

**The SDK's session caches are not here.** The Antigravity SDK writes SQLite
files under `_gemini_worker_save/`; they are opaque, 1.4 MB, and full of the
recording machine's absolute paths. Nothing in them is evidence that the JSON
receipts do not carry.

**Paths were rewritten before publishing.** The recording machine's home
directory reads `/home/user`, its working folder reads `/workspace/ping-service`,
and the Google Cloud project it billed reads `your-project-id`. Nothing else was
touched — no number, no model output, no timestamp.
