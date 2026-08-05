# Gemini as a model, Gemini as an agent — what two runs showed

**Tilicho AI Labs · 5 August 2026**

---

We have shipped the Antigravity SDK integration into our AI-SDLC pipeline, run the same brief down both Gemini paths on the same machine, and published both run records. The agent path costs **2.6× the money for 23× the tokens** and produces something the model path cannot: a per-packet audit trail. We hit four points of friction getting there, all four are handled in what shipped, and two of them carry a suggestion back to you — that section is the part worth your time.

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

## Where we hit friction, and how we resolved it

Four things cost us real time. All four are handled in what we shipped; two carry a suggestion back to you.

**1. The agent path is ADC-only.**
It signs with Application Default Credentials and has no API-key route, so it requires a Google Cloud project. For a team whose entry point was an AI Studio key, that is a real onboarding step and not an obvious one. Left alone, the failure is silent and expensive: the run dies at the first Gemini dispatch, *after* the premium phases have already been billed.

*Resolved.* The setup checker now determines up front whether Google Cloud credentials exist, and only offers the agent path where it can actually work. On an install without them, the plugin runs the model path and says why. Nobody pays for a run that cannot finish.

**2. A project ID is not a credential, though it looks like one.**
`GOOGLE_CLOUD_PROJECT` is the variable most tutorials mention first. Set on its own, with no credential behind it, it satisfies a naive check and everything looks green.

*Resolved.* The checker treats it as its own state — it reports that the project ID says *where to bill*, not *who is asking*, and names the one cheap probe that settles whether the install can really reach Gemini. It is a warning rather than a hard block, deliberately: inside Google Cloud the credential arrives from the metadata server and such a setup is perfectly valid, and nothing offline can tell that apart from a laptop.

*Suggestion:* the SDK itself could fail faster and louder on this. It is the single easiest way for a new user to think they are configured when they are not.

**3. The runtime split.**
A Python 3.10+ worker alongside a Node plugin is two runtimes to provision on every machine — the biggest single step between "install the plugin" and "use the agent path".

*Resolved.* Provisioning it is one command, `verify-setup --enable-agent`, which records the choice and builds the worker environment. The same checker then reports whether the worker is importable, so a half-finished setup is visible before a run rather than during one.

**4. Session caches cannot be shipped.**
The SDK writes session state as opaque SQLite containing absolute local paths. They cannot be path-scrubbed without corrupting them, and they carry the recording machine's directory layout.

*Resolved.* We excluded them from the published evidence and ship the JSON delegation records and usage receipts instead, which carry everything an auditor needs — the brief, the actions, the cost. Nothing material is lost.

*Suggestion:* a portable or scrubbable session format would let us publish the session state too, which is the one part of the trail we currently have to withhold.

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

## Trying it yourself

Two steps. The first is free.

### 1. Check the setup — offline, read-only, no cost

```
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)"
```

Works in any state — no credentials at all, an AI Studio key, `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account key, or just `GOOGLE_CLOUD_PROJECT` set. It reads the machine and reports what is ready, what is missing, and the exact command to fix each thing. It makes no network calls, writes nothing, and costs nothing.

If what it reports does not match your actual setup, we would like to know.

### 2. Run the pipeline end to end

There is no unattended mode — it is two prompts by hand, because four of the phases stop for human approval.

Make an **empty folder** and open Claude Code in it:

```
claude --permission-mode acceptEdits
```

Without that flag the orchestrator prompts on every file read. It still stops at the four approval gates either way; those are not part of the permission system.

Paste this as the first prompt:

```
Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness
```

That registers the marketplace, installs the plugin, builds the bundled model server, and reports what is ready and what is missing.

Then **start a new session in the same folder** and type:

```
/sdlc-run
```

The new session matters. Claude Code registers a plugin's slash commands and starts its MCP servers only when a session begins, so in the install session neither exists yet — and a run started there would route every phase to the premium model.

`/sdlc-run` takes no arguments. It checks the install, offers the shipped briefs, shows which model each phase will use, confirms the plan, and only then starts spending. **Pick Ping Service** — one endpoint, no database; it is the brief used in both runs above, it exercises every phase in minutes rather than hours, and it costs roughly **$0.84** on the model path. Generated code lands in `./src` and the run record in `./.sdlc/`.

This spends real money and needs credentials.

---

## What is next

Scaling beyond a single small brief, and a full-dataset SWE-bench Pro run on the multi-model policy.
