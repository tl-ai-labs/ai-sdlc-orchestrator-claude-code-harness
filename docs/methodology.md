# Methodology

> **For:** understanding how tokens and costs are counted; choosing between vendor-authoritative and estimated modes. **Also see:** [understanding-output.md](understanding-output.md) · [two-gemini-paths.md](two-gemini-paths.md) · [architecture.md](architecture.md).

How the tokens and costs on the report are derived, in plain terms.

## The `MMO:` log stream is not telemetry

`telemetry.jsonl` and the `MMO:`-prefixed log stream ([docs/logging.md](logging.md)) record
different things and neither replaces the other.

`telemetry.jsonl` is cost accounting: one `TelemetryEvent` per dispatch attempt, written once
that attempt completes, carrying exactly the fields the report ([understanding-output.md](understanding-output.md))
sums into dollars and tokens — `input_tokens`, `output_tokens`, `cost_usd`, `provenance`, and so
on. It says nothing about whether a call was *attempted*, which model routing chose and why, or
what an Antigravity SDK worker did while it held the working directory.

The log stream is an event trace: every phase and gate boundary, every subagent hand-off, every
model dispatch's routing decision, every vendor API request/response, every AG SDK worker spawn
and exit — `MMO: <timestamp> <LEVEL> <event> key=value…`, one line per event, to stderr and to
`<output_dir>/orchestrator.log`. It carries no dollar figures and is not summed into anything; it
exists to answer "what did this run actually do," which a cost ledger cannot.

The two are written independently and can diverge in count: a dispatch that fails before a vendor
call completes emits `dispatch.error` on the log stream but no `TelemetryEvent` (nothing to bill).
Cross-referencing the two by `run_id` (log) and `pass` (telemetry) reconstructs the full picture —
what ran, in what order, and what it cost.

## The mode determines everything

Every telemetry event carries a `provenance` field: `"vendor"` or `"estimated"` (a third value, `"transcript"`, is reserved for events reconstructed post-run from session transcripts). The report labels the whole run according to what's on those events. The stamp is applied where the numbers are actually measured: the dispatch server stamps `"vendor"` on every `execute_with_model` event server-side (in both auth modes — a dispatched call always returns the vendor's own usage block), and `log_telemetry` defaults direct-tier events to `"estimated"` as it normalizes them, so a model that forgets the stamp cannot produce an unlabeled event. Events written before the stamp existed lack the field; the report treats absence as "unknown" and disowns the run's cost label rather than guessing. The mode is chosen per run via the required `--auth=vendor|estimated` flag on `/mmo:pass`. The orchestrator reads the flag at startup and follows that path for every event; if the flag is missing the run aborts. Mode is not inferred from `ANTHROPIC_API_KEY` presence — the flag is the sole source of truth, so identical commands produce identical modes regardless of the shell's env-var state.

### Vendor-authoritative mode — `--auth=vendor`

The orchestrator (per [rule 6 in orchestrator.md](../plugin/agents/orchestrator.md)) dispatches **every** LLM call — including its own tier's calls — through the MCP server. The MCP server hits the vendor API directly, receives the vendor's own `usage` block in the response, and writes those exact numbers into the event:

- `input_tokens`, `input_tokens_cached`, `output_tokens` — Anthropic-reported (or Google-reported for Gemini calls under `opus-plus-flash`)
- `cost_usd` — (vendor tokens × the policy YAML's `pricing:` block) / 1M
- `provenance: "vendor"`

These numbers reconcile to the Anthropic and Google dashboards for the API key and time window the run used. An independent run under vendor-authoritative mode should land within a few percent of the published figures; residual variance is LLM non-determinism in packet decomposition, not measurement drift.

### Estimator mode — `--auth=estimated`

Claude Code handles auth via a Pro / Team / Enterprise subscription. Direct-tier calls (the judgment phases, under any policy) run inside the subagent's conversation loop, which doesn't expose per-call `usage` to the subagent. The orchestrator therefore estimates tokens using a character-count heuristic:

```
tokens ≈ characters / 3.8
```

- `input_tokens`, `output_tokens` — char-count estimated
- `cost_usd` — (estimated tokens × the policy YAML's `pricing:` block) / 1M
- `provenance: "estimated"`

MCP-dispatched calls in this mode (Gemini under `opus-plus-flash`) still carry vendor tokens; only the direct-tier events are estimated. The report labels the whole run "Mixed" in that case.

Which model that direct-tier work *executes* on is a separate question from how it is priced, and the two must be the same model for the estimate to mean anything. Execution is decided by Claude Code from the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable, exported before the `claude` process launches; pricing comes from the policy's driver `model_name`. The orchestrator verifies they agree at run start via `plugin/scripts/driver-model-check.mjs` — the script derives the driver model by routing every judgment phase through the loaded policy with the same compiled routing the dispatch server uses, and stops the run (printing the exact export line) on unset or mismatch. The driver agent files carry no `model:` frontmatter pin, because a pin silently overrides the policy: the run executes the pinned model while the report prices the policy's.

The 3.8 midpoint is fine for order-of-magnitude reasoning; it will not exactly match an Anthropic bill.

## Which mode were the published numbers produced in?

The numbers on this repo's public README were produced under **vendor-authoritative mode** — the run used `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (for the `opus-plus-flash` variant). Every published cost line is Anthropic- or Google-billed. Material divergence on a same-mode reproduction can be filed as an issue.

## Trade-off between the modes

| | Vendor-authoritative | Estimator |
|---|---|---|
| API key needed | Yes — Anthropic (and Gemini for opus-plus-flash) | No — Claude Code subscription handles direct-tier auth |
| Cost per run | Higher — no free automatic prompt caching from Claude Code; caching handled via explicit `cache_control` in the MCP adapter (~10% input rate on hits) | Lower — Claude Code applies its own caching under the hood |
| Numbers on report | Match the Anthropic and Google dashboards for the API key used | Order-of-magnitude approximation of a vendor-billed run |
| Recommended for | Publishing, cross-checking against the bill, Google-style audit | Casual runs, exploring the tool without an API key |

## Cross-checking against the Anthropic dashboard

To verify the report against reality:

1. Note the timestamps at which the pass started and ended.
2. Open [console.anthropic.com/settings/usage](https://console.anthropic.com/settings/usage).
3. Filter to the API key and time window matching the run.
4. Compare Anthropic's charge to the report's "Total session cost" line.

The two should match to within a few cents. Larger divergences can be filed as issues.

## Output-ceiling doubling

Every TaskPacket carries a `budget.maxOutputTokens` — the initial output-token ceiling the adapter dispatches under. When the vendor terminates a response with the max-tokens signal (Anthropic `stop_reason: "max_tokens"` or Gemini `finishReason: "MAX_TOKENS"`), the adapter re-dispatches the identical packet with 2× the previous ceiling, up to 3 doublings or the model's absolute output limit (declared in the policy YAML as `max_output_tokens_absolute`), whichever comes first. Input caching (Anthropic ephemeral / Gemini Context Cache) is warm across the retries, so re-input is billed at the cache-read rate; only the extra output tokens accrue full cost.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"`, all sharing the packet's `task_id`. The report collapses them into one row per packet under **Packets that needed output-ceiling doublings** — the raw JSONL preserves the full attempt chain for full audit at that level.

**Why doubling instead of raising the ceiling unilaterally.** Under a well-chosen initial ceiling, most packets fit first-shot and pay nothing extra; only the packets that actually need the room double. Under a uniformly-raised ceiling, every packet pays the higher rate. For SDLC codegen — where the file-size distribution is heavily skewed toward small files with a few large outliers — doubling wins in aggregate. It costs roughly 1.75× a perfectly-tuned unilateral raise on the specific packets that need multiple doublings.

**Detection is strict.** Only the vendor's explicit max-tokens signal triggers doubling. Anything else (semantic completion, safety filter, recitation guard) is treated as a genuine termination and the response is accepted as-is. This avoids retries that would have returned identical output.

**Terminal states.** A packet's ExecutionResult carries `terminal_reason`:
- `success` — an attempt returned without hitting the max-tokens signal.
- `output_cap_doubling_budget_exhausted` — every attempt terminated at max-tokens, but the model still had headroom under its declared absolute ceiling. The doubling loop simply ran out of retries. Actionable: raise the packet's initial `budget.maxOutputTokens`, or lift the doubling cap for this phase.
- `output_cap_at_model_absolute` — the loop reached the model's declared absolute output limit and the response was still truncated. The packet is genuinely too big for this model under this prompt; raising the initial ceiling won't help. Actionable: split the packet, use a model with a larger absolute ceiling, or accept the truncated deliverable.
- `vendor_error` — a non-4xx error interrupted the chain; the packet fails.

## Where the numbers come from

- **Token counts pass through unchanged from the source.** In vendor mode, the numbers on every event are exactly what the vendor's `usage` block returned. In estimated mode, they're exactly what the char/3.8 heuristic computed at the moment of the call. Report totals are those per-event counts summed — nothing between measurement and display.
- **Cost is computed and written at the moment of each call.** Each event's `cost_usd` is (that event's tokens × the loaded policy YAML's `pricing:` block) / 1M, stamped into `telemetry.jsonl` at write time. The report's totals are those per-event costs summed.
- **The report shows what the run produced.** Every figure on the report comes from summing that run's own telemetry events.

To verify any of these, walk `telemetry.jsonl` by hand — every line is inspectable.

## How Gemini's token counts are read

Google's `usageMetadata` has two fields that look alike and behave in opposite ways. Both are handled explicitly, because getting either wrong moves the headline number.

**`cachedContentTokenCount` is a *subset* of `promptTokenCount`.** The prompt count is the whole prompt, cached portion included. Cost is computed on disjoint counts — fresh input at the full rate, cached input at the read rate — so the cached count is subtracted from the prompt count before pricing. Skipping that subtraction bills the cached tokens twice and makes an effective cache look more expensive than no cache at all.

**`thoughtsTokenCount` is a *sibling* of `candidatesTokenCount`.** Gemini 3.x reasons before it answers, and Google bills that reasoning at the output rate — but reports it outside the candidate count. Billed output is therefore `candidatesTokenCount + thoughtsTokenCount`. This is not a rounding correction: a single-token answer from `gemini-3.5-flash` can come with ~100 thinking tokens. Reading the candidate count alone would report 1 output token where Google bills ~100, at the output tier's $9/M — understating precisely the model whose lower cost the multi-model pass exists to demonstrate.

Two consequences worth knowing when reading a report:

- **Thinking tokens count against the packet's output ceiling.** A packet can spend its whole ceiling reasoning and return no text, which the vendor reports as `MAX_TOKENS`. That is a genuine truncation and the doubling loop handles it as one — the attempt is billed, because the reasoning happened.
- **Gemini also caches implicitly, without being asked.** A packet resembling one sent minutes earlier can come back with a non-zero cached count under no explicit cache. Costs stay correct either way, since the cached count is read from the response rather than inferred from whether a cache was requested. But it means a cold-vs-warm pair measured back to back understates the gap: the "cold" call may already be partly warm.

## Two doors to the mechanical tier, and how the report tells them apart

`opus-plus-flash` declares two ways of reaching Gemini 3.5 Flash. The default calls it as a **model**: one request per packet, with the orchestrator reading the files and writing the answer back. The alternative runs it as an **agent** through the Antigravity SDK, working in the directory itself. Which one an install uses is chosen once, outside the policy file, by the setup wizard or by `--enable-agent` on the verify script — see [setup.md](setup.md#gemini-as-an-agent--antigravity-sdk).

Both leaves declare the same `pricing:` block, because they reach the same model at the same published rates. That is deliberate, and it is the reason the vendor model name alone cannot tell you which one ran — `gemini-3.5-flash` appears on both. Two fields on every event carry the distinction:

- **`model_id`** — the policy leaf that executed: `flash-completion` or `flash-agsdk-worker`. This is the field to group by when comparing the two.
- **`routing.select`** — the slot that resolved, what it resolved to, and whether the run asked (`overridden: true`) or inherited the default. Absent entirely on policies that declare no slots, so events from `opus-only` are byte-for-byte what they were before slots existed.

Those two fields are for querying. For reading, `node tools/report.mjs` renders a **Delegated to an agent worker** section on any run that used the agent door — one row per delegated packet with its tool-call count, its wall-clock, and what changed in the working directory while it held it, against a `[C]` line for everything the harness did itself. The section is absent on runs that did not delegate. Its inputs are the per-delegation receipts under `delegation/`, described in [understanding-output.md](understanding-output.md#the-delegation-directory).

**Identical rates do not mean identical cost, and the difference is not small.** An agent re-sends the accumulated conversation on every tool call, and each of its turns carries the SDK's own multi-thousand-token instruction preamble. A packet that a single completion call answers in one request can cost an agent several times as much for the same deliverable — entirely in token volume, at unchanged rates. The costs on the report are still exact: an agent dispatch is priced from the token counts the Antigravity SDK's `usage_metadata` reports, read through the same disjoint cached/fresh arithmetic described above, with the same `provenance: "vendor"`. A run comparing the two doors is measuring how many tokens each approach needs, which is the honest question.

## Pricing table provenance

The rates that turn tokens into dollars live in the `pricing:` block of each policy YAML under `plugin/config/policies/`. Each block also carries:

- `pricing_source:` — the vendor URL these rates were taken from
- `pricing_last_verified:` — the ISO date the maintainer last checked the source page

Before publishing a study that relies on these numbers, check both fields against the current vendor page. If the vendor changed rates and this repo hasn't caught up, submit a PR updating the YAML — the report will then compute costs at the correct schedule automatically.

The orchestrator subagent is instructed (via `plugin/agents/orchestrator.md` rule 6) to read pricing constants ONLY from the loaded policy YAML, never from its own trained knowledge. If the policy's pricing block is missing or malformed, the run aborts rather than guessing.
