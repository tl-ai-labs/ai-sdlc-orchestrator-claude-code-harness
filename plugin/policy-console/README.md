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

## Thinking tiers are per model, and Opus doesn't have a graded range

Each phase's model dropdown and thinking-tier picker sit side by side, and the tier options change
with the model — grounded in the real vendor SDKs, not guessed:

| Adapter | Picker shows | Source |
|---|---|---|
| `mcp:gemini-flash-server` (`flash-completion`) | `off`, `minimal`, `low`, `medium`, `high` | `@google/genai` (Node) `ThinkingLevel` enum |
| `antigravity-worker` (`flash-agsdk-worker`) | `off`, `minimal`, `low`, `medium`, `high` | `google-genai` (Python) `ThinkingLevel` enum — same vendor enum, both packages agree |
| `builtin-anthropic` (`opus`) | **Not available** | See below |

**Opus genuinely supports thinking — it just isn't a graded range**, so there's nothing to put on
a level picker. `@anthropic-ai/sdk`'s `ThinkingConfigParam` (checked against the *current* `0.116.0`
release, not the repo's pinned `0.32.1`, which predates thinking entirely) has two real modes:
`enabled` with a numeric `budget_tokens` (a dial, not a level) and `adaptive` (Claude picks its own
depth per call, not a fixed point on a scale). Neither maps onto the same off→high shape as
Gemini's tiers, so this console shows "Not available" rather than a single non-rangeable "auto"
button — a product decision, not a technical limit. `minimal` is a real, valid tier on both Gemini
packages (confirmed by reading their installed `types.py`/`node.d.ts`) — an earlier draft of this
README incorrectly claimed it crashed the Antigravity worker; it doesn't. An even earlier draft
claimed Opus had no thinking ability at all; it does — that was checked against the wrong SDK
version, before this console settled on "no graded range" as the actual reason to show nothing.

## Known gap: thinking capacity isn't wired to any adapter yet

The console writes the chosen tier into the saved policy as `rules[].reasoning.tier`. Today that
value has **no effect on a real run** for two of the three routing options:

| Routing option | Adapter | Reads `reasoning`? |
|---|---|---|
| `opus` | `BuiltinAnthropicAdapter` | No — never read, never sent to the Anthropic API. Moot today anyway: the console offers no tier to set for it (see above), and the pinned SDK (`0.32.1`) predates thinking regardless |
| `flash-completion` | `GeminiFlashAdapter` | No — not read anywhere in that adapter or `geminiTransports.ts`, despite the vendor SDK supporting `thinkingLevel` |
| `flash-agsdk-worker` | `AntigravityWorkerAdapter` | Yes — the only adapter that reads `reasoning.tier` and passes it through |

So the tiers shown are honest about what each vendor's API allows, but only `flash-agsdk-worker`
actually acts on the choice today. Wiring `flash-completion` to send `thinkingLevel` is backend
work, not a console change — tracked as an open item, not fixed here since no policy from this
console is driving a real run yet.
