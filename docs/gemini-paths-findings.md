# Gemini as a model, Gemini as an agent — what two runs showed

**Tilicho AI Labs · 5 August 2026**

---

We have shipped the Antigravity SDK integration into our AI-SDLC pipeline, run the same brief down both Gemini paths on the same machine, and published both run records. The agent path costs **2.6× the money for 23× the tokens** and produces something the model path cannot: a per-packet audit trail. The friction we hit is in the last section, and that is the part worth your time.

---

## What we shipped

Gemini now drives the mechanical phases of the pipeline — codegen, tests, docs — two ways:

- **As a model** — called through Gemini Enterprise Agent Platform (formerly Vertex AI). Claude reads the files, sends the text, writes the answer back.
- **As an agent** — through the **Antigravity SDK**. Gemini opens the working folder itself, runs commands and edits files; Claude reviews the result.

Both are in the published plugin on `main`. Either is one flag away at setup, and the setup checker only offers the agent path where it can actually work.

---

## We ran both, on the same work

Same brief, same policy, same machine, same four human approval gates. The only variable is how Gemini is reached.

| | Model path | Agent path (Antigravity SDK) |
|---|---|---|
| Input tokens | 43,027 | 1,714,495 (1,038,870 cached) |
| Output tokens | 33,647 | 72,727 |
| Recorded cost | $0.84 | $2.18 |
| Packets dispatched | 5 | 5 |
| Delegation evidence files | — | 15 |
| Tests | 2/2 green | 3/3 green |
| Human gates | 4/4 approved | 4/4 approved |
| Elapsed | 28 min | 63 min |

**23× the tokens for 2.6× the cost.** Context caching is doing that work — over a million of the agent path's input tokens were cache reads. Without it the volume would have been prohibitive.

Two things to read carefully:

- **Elapsed time is not a system measurement.** Both runs stop at four human approval gates, so the clock includes however long the reviewer took to read and approve. It measures the operator as much as the pipeline. Tokens and cost are machine-recorded; those are the numbers to weigh. (Both figures are first-to-last timestamp in the run's own `manifest.json`. The model-path walkthrough quotes 55 minutes because it counts from the very first prompt and includes the one-time plugin install.)
- **Costs are recorded in estimated mode, not vendor-billed.** Treat them as the shape of the trade, not an invoice.

This is one run of one small brief and we are not generalising from it. It is published so the trade is a number rather than a claim, and so anyone evaluating the agent path can see what it costs before spending anything.

---

## What the agent path produces that the model path cannot

Both runs dispatched the same five packets of mechanical work. Only the agent path leaves a record of them.

Each delegated packet writes three files to disk: the task brief the worker was handed, a delegation record of what it did, and the vendor usage receipt for it. Five packets, fifteen files.

That is the difference that matters to us. The agent path is **auditable** — we can answer *"what exactly was this worker asked to do, what did it touch, and what did it cost"* for any packet, after the fact, from disk, without re-running anything. On the model path the same question has no answer beyond the run-level aggregate.

---

## What worked well

- The SDK ran the full mechanical tier with no hand-holding, and the output passed our senior review and security review gates unmodified.
- Context caching materially changed the economics, as above.
- Per-packet usage reporting was good enough to reconcile the run against the bill.

---

## Where we hit friction

The useful part of this update.

**1. The agent path is ADC-only.**
It signs with Application Default Credentials and has no API-key route, so it requires a Google Cloud project. For a team whose entry point was an AI Studio key, that is a real onboarding step and not an obvious one. Our setup checker now detects this and refuses to offer the agent path where it cannot work — because the failure mode otherwise is silent and expensive: the run dies at the first Gemini dispatch, *after* the premium phases have already been paid for.

**2. A project ID is not a credential, and it is easy to think it is.**
`GOOGLE_CLOUD_PROJECT` is the variable most tutorials mention first. Having it set with nothing behind it looks like success to a naive check, and it cost us a debugging session before we made the checker distinguish the two. Worth considering whether the SDK could fail faster and louder here.

**3. The runtime split.**
A Python 3.10+ worker alongside a Node plugin is two runtimes to provision on every machine. It works, but it is the single biggest thing standing between "install the plugin" and "use the agent path".

**4. Session caches cannot be shipped.**
The SDK writes session state as opaque SQLite containing absolute local paths. When we packaged our run as public evidence we had to exclude those files — they cannot be path-scrubbed without corrupting them, and they carry the recording machine's directory layout. A portable or scrubbable session format would let us publish complete evidence bundles instead of near-complete ones.

---

## Where everything is

All of it is already in the public repo, `tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness`:

| | |
|---|---|
| Both run records, delegation evidence included | `examples/quick-demo/passes/` |
| The two runs frame by frame | `docs/walkthroughs/` |
| Setup, credentials, both Gemini doors | `docs/setup.md` |
| How tokens and costs are recorded | `docs/methodology.md` |

---

## What is next

Scaling beyond a single small brief, and a full-dataset SWE-bench Pro run on the multi-model policy.
