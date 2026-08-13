# Policy console

A local web app for choosing and customizing an AI-SDLC routing policy — which model runs each
phase, and (new) thinking capacity per phase. Reads and writes real files in
[plugin/config/policies/](../config/policies/). See
[docs/specs/custom-policy-and-thinking-config.md](../../docs/specs/custom-policy-and-thinking-config.md)
for the full spec.

## Run it

```bash
cd plugin/policy-console
npm install
npm run dev
```

Open `http://localhost:3000`. Pick an existing policy to customize, or add a new one. The
thinking-tier picker sits next to each phase's model dropdown and only offers the tiers that
model's real vendor API supports — see below. Saving always writes a new named file — the two
shipped presets (`opus-only`, `opus-plus-flash`) are never modified.

## Thinking tiers are per model — two different real vendor parameters

Each phase's model dropdown and thinking-tier picker sit side by side, and the tier options change
with the model — grounded in the vendors' own docs, not SDK guesswork:

| Adapter | Picker shows | Real request field | Source |
|---|---|---|---|
| `mcp:gemini-flash-server` (`flash-completion`) | `off`, `minimal`, `low`, `medium`, `high` | `thinking.thinkingLevel`, written here as `reasoning.tier` | `@google/genai` (Node) / `google-genai` (Python) `ThinkingLevel` enum |
| `antigravity-worker` (`flash-agsdk-worker`) | `off`, `minimal`, `low`, `medium`, `high` | same as above | same enum, both packages agree |
| `builtin-anthropic` (`opus`) | `off`, `low`, `medium`, `high`, `xhigh`, `max` | `output_config.effort`, written here as `reasoning.effort` | [platform.claude.com/.../effort](https://platform.claude.com/docs/en/build-with-claude/effort) |

**Opus's range is `effort`, not `tier`, and it's a genuinely different request parameter — not two
names for the same setting.** `claude-opus-4-7` (this repo's pinned Opus model) rejects
`thinking: {type: "enabled", budget_tokens}` outright — [Anthropic's own
docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) say plainly: *"Claude
4.7 and later models do not support it and reject requests that use it, returning a 400 error."*
The real graded control for `claude-opus-4-7` is `output_config.effort`, a top-level field
independent of `thinking`: five documented levels (`low`/`medium`/`high`/`xhigh`/`max`, default
`high`), with Anthropic publishing per-model guidance for Opus 4.7 specifically — e.g. `xhigh` as
the recommended starting point for coding/agentic work. This console writes it as
`reasoning.effort` (not `reasoning.tier`) so a saved rule always names the field its target model's
adapter will eventually need to read.

This took three passes to get right, worth recording so it isn't re-litigated: an early draft
invented `effort: off/low/high/max` with no real backing; the fix at the time was showing "Not
available" for Opus because `@anthropic-ai/sdk`'s `ThinkingConfigParam` (the `thinking` object)
genuinely has no graded range; checking Anthropic's docs directly (rather than only the SDK's
`thinking` types) surfaced `output_config.effort` as a separate, real, five-level parameter that
was there all along. `minimal` is also a real, valid Gemini tier (confirmed by reading the
installed `types.py`/`node.d.ts`) — an even earlier draft wrongly claimed it crashed the
Antigravity worker.

## Known gap: thinking capacity isn't wired to any adapter yet

The console writes the chosen tier into the saved policy as `rules[].reasoning.tier` or
`rules[].reasoning.effort`, per the table above. Today that value has **no effect on a real run**
for two of the three routing options:

| Routing option | Adapter | Reads `reasoning`? |
|---|---|---|
| `opus` | `BuiltinAnthropicAdapter` | No — never read, never sent to the Anthropic API. The pinned `@anthropic-ai/sdk` (`0.32.1`) also predates `output_config.effort` entirely, so it couldn't send it even if wired |
| `flash-completion` | `GeminiFlashAdapter` | No — not read anywhere in that adapter or `geminiTransports.ts`, despite the vendor SDK supporting `thinkingLevel` |
| `flash-agsdk-worker` | `AntigravityWorkerAdapter` | Yes — the only adapter that reads `reasoning.tier` and passes it through |

So the tiers shown are honest about what each vendor's API allows, but only `flash-agsdk-worker`
actually acts on the choice today. Wiring `flash-completion` to send `thinkingLevel`, and bumping
`@anthropic-ai/sdk` to send `output_config.effort` for `opus`, are backend work, not console
changes — tracked as an open item, not fixed here since no policy from this console is driving a
real run yet.
