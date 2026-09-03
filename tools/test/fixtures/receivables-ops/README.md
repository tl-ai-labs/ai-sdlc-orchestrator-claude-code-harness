# receivables-ops regression fixtures

Three real orchestrator runs, copied from `tl-ai-labs/ai-sdlc-multi-model-orchestration`
(`case-studies/receivables-ops/passes/pass1..3`, commit 379d6360, run 2026-08-16).

What is kept verbatim: every assistant line's `message.id`, `model`, `stop_reason`,
`usage` (including the `cache_creation` TTL split) and `timestamp`; the telemetry
events' token counts, cost and provenance; and Claude Code's own end-of-session
receipt (`claude-session.json`: `total_cost_usd`, `usage`, `modelUsage`).
What is removed: all message content. The collector never reads it.

`manifest.json` is NOT a copy: the source manifests are the orchestrator's own shape
(`pass_id`, `policy: {name}`, `totals.cost_usd`, no run window). Each fixture manifest is
re-authored into this plugin's shape — `pass`, `policy_name`, `totals.dispatched_cost_usd`
(= the source `totals.cost_usd`, the dispatched-only figure the bug reported), `totals.events`,
`totals.models_used` — with `started_at`/`ended_at` set to the transcript's first and last
timestamps. `telemetry.jsonl` keeps the source events' token counts, cost and provenance and
drops routing/notes/artifact paths. The source telemetry had already been rewritten by the
orchestrator repo's repair tool (each event carries an apportioned slice of the session total),
which is why the events do not sum to `dispatched_cost_usd` — the collector's consistency
guard is exercised by exactly that.

The fixtures live here, beside the repo-level test corpus, rather than inside `plugin/`
(which ships to users); the consuming suite is `plugin/mcp/model-dispatch/test/`.

| pass | policy | what it proves |
|---|---|---|
| pass1 | receivables-premium (Opus in-session) | 1h cache-write pricing; in-session dispatch is inside the transcript |
| pass2 | receivables-hybrid | NEGATIVE: the committed transcript is missing a subagent file — the receipt cross-check must fail loudly |
| pass3 | receivables-floor (Gemini-only policy, Opus driver) | the policy cannot yield a Claude driver model; the receipt prices the session anyway |

Policies are copied with `gemini-thinking` renamed to `mcp:gemini-flash-server`, an adapter this plugin knows.
