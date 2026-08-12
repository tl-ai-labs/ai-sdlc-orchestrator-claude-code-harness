---
description: "Run the AI-SDLC pipeline against an existing repository. Extends the plugin from greenfield-only to any real project — pick one of seven job types (docs, bugfix, feature-extend, feature-new, refactor, test, deps), confirm scope at Gate 0, and run with a non-destructive write contract that guarantees off-limits files stay untouched."
argument-hint: ""
---

Brownfield entry point. This command takes no arguments. Everything it needs it asks for.

You are Claude Code, following this operating manual. Work through the steps in order. Do not skip
a step because the answer seems obvious. Do not begin the pipeline until Gate 0 is approved.

**Prerequisite check:** if the user has not yet run the plugin's setup (`plugin install` + build
+ credential check), refuse politely and point them at SETUP.md. This command is for the task work;
setup is one-time per machine and happens separately.

---

# 1. Setup-status check — resume or fresh

Before anything else, invoke:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/session-hydrate.mjs" --json
```

Read the JSON. Three cases:

- **`resume.pending: true` with `kind: "setup"`** — a previous session died mid-setup. Print
  something like *"Setup was interrupted at section &lt;N&gt; — resuming shepherd from there..."*
  and re-run the remaining setup sections (see §3 below). Do **not** start Gate 0 until setup
  completes.

- **`resume.pending: true` with `kind: "run"`** — a previous task run was interrupted at phase
  &lt;phase&gt;. Print *"A previous &lt;intent&gt; run (`&lt;run_id&gt;`) was interrupted at phase &lt;phase&gt;.
  Would you like to resume it, or start fresh?"* Accept `resume`, `discard`, or `abort`. If
  `resume`, follow the resume path in [plugin/skills/run-ai-sdlc/SKILL.md](/plugin/skills/run-ai-sdlc/SKILL.md).
  If `discard`, clear `.sdlc/local/state.json` and continue to step 2.

- **`resume.pending: null`** — normal flow. Print the one-line `marker` from the hydrate
  output (e.g. *"SDLC: 3 prior runs (last: docs, 2d ago); baseline at abc1234; no open resume
  checkpoint."*) so the user has context, then continue to step 2.

# 2. Pre-check the pipeline

Verify the machinery works on this specific repo before spending money on a real intent.

**On the first `/sdlc-brownfield` per project** OR when `.sdlc/pre-check-status.json` is missing
OR when the baseline hint from step 1 says the baseline is stale, run the full 6-step pre-check.
Otherwise (cached, fresh, plugin version unchanged), report *"pre-check cached from &lt;date&gt;,
all steps still valid"* and skip to step 3.

Script-side steps (2, 4, 5, 6) — you invoke via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-check.mjs" --run
```

Agent-side steps (1 = discovery smoke, 3 = dispatch smoke) — you run yourself:

1. **Discovery smoke.** Invoke the `discovery` subagent (see [plugin/agents/discovery.md](/plugin/agents/discovery.md))
   with `mode: first-time` (or `refresh` if a baseline exists). Watch for a non-git-repo refusal
   or any hard error. On pass, record it:
   ```bash
   echo '{"note":"Tier 1 completed cleanly"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-check.mjs" --record discovery pass
   ```

3. **Dispatch smoke.** Construct a trivial `{ id: "smoke-1", phase: "codegen", task_type:
   "smoke", instruction: "Return the literal string OK", ... }` TaskPacket and dispatch via
   `execute_with_model` to each policy tier the current policy uses (typically premium +
   mechanical for `opus-plus-flash`; just premium for `opus-only`). If both return their expected
   output within the timeout, record pass:
   ```bash
   echo '{"tiers_tested":["opus","gemini-flash"]}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/pre-check.mjs" --record dispatch pass
   ```

If any pre-check step fails, **do not proceed to Gate 0.** Print the reported remediation and
offer inline choices (fix now / switch policy / abort). Do not kick the user out to external
fixes.

# 3. Discovery — Tier 1 (with adaptive profile if triggered)

If not already done during step 2's smoke:

Invoke the `discovery` subagent. It reads the repo (git state, stack manifests, off-limits, monorepo
signals, submodules, LFS, competing AI configs — see [plugin/agents/discovery.md](/plugin/agents/discovery.md)
for the full read order) and writes:
- `.sdlc/runs/<run-id>/discovery.md` (per-run human-readable)
- `.sdlc/runs/<run-id>/baseline.json` (per-run pointer snapshot)
- `.sdlc/baseline/current.json` + `.sdlc/baseline/discovery.md` (living project baseline, on
  first-time or full refresh)
- `.sdlc/baseline/stack-profile.md` (Tier 2b, only when triggered — unknown stack, custom
  framework in CLAUDE.md, or `--adaptive-profile` passed)

Wait for discovery to finish. If it refuses (non-git repo), stop here — the shepherd already
printed the git-init guidance.

# 4. Intent brief — pick the intent and describe the job

Two things to collect from the user. Both go into `.sdlc/runs/<run-id>/intent_brief.md`.

**a. Intent.** Ask which job type. Show the seven options with one-line examples so the choice
is meaningful:

- `docs` — write API docs, README, ADRs, docstrings for the auth module
- `bugfix` — fix the /login endpoint returning 500 on missing password
- `feature-extend` — add a `?filter` param to the existing /users endpoint
- `feature-new` — add a webhooks module (endpoint, storage, retry loop)
- `refactor` — extract shared date logic into a util module and update all call sites
- `test` — backfill unit tests for src/payments to reach 80% line coverage
- `deps` — upgrade jest 28 → 29 (and adapt breaking changes)

**b. Source — describe the specific job.** Three ways to get it:
- **Interview (default)** — ask 2–4 short questions per intent, then draft the brief from the
  answers. Example for `bugfix`: *"Describe the bug in one sentence — observed behavior.
  Expected behavior. Any files you already know are involved (I'll grep otherwise). How will
  we know it's fixed?"* Show the draft back, ask to approve or edit.
- **Bring your own file** — if the user says they have a brief already, ask for the path.
  Read it, ask to confirm it's the right one.
- **Inline chat** — if the user just describes it in this message, capture their words
  verbatim into the brief.

Write the brief to `.sdlc/runs/<run-id>/intent_brief.md` with this heading contract:

```
# Intent Brief — <intent> — <short title>

## Context
## Goal
## Files in scope
## Files off-limits
## Acceptance criteria
## Non-goals
```

Fill in "Files in scope" and "Files off-limits" with your best guess based on discovery + intent
+ the user's description. These are proposals; Gate 0 lets the user adjust before commit.

# 5. Gate 0 — Discovery Confirmation

The one confirmation moment before real work begins. Print the gate template from
[plugin/skills/run-ai-sdlc/SKILL.md](/plugin/skills/run-ai-sdlc/SKILL.md) (search for "Gate 0"),
filling in:

- **Stack** — top-detected from `baseline.stacks`. Ask if it's right; accept overrides.
- **Test command** — `baseline.test_command_proposed`. Accept an override.
- **Existing AI setup** — verbatim list from `baseline.ai_configs_detected`. Default is
  **OFF-LIMITS** for all of them. User can move any into the allowlist by naming it explicitly.
- **Intent** — from step 4a. Re-confirm.
- **File scope** — the allowlist and off-limits proposed from step 4b. Let the user edit.

Reply options: `approved` / `revise: <comments>` / `abort`.

**Cost projection (single line at the bottom, before the reply prompt).** From a rough
per-intent × baseline-size table, print *"Typical cost for a &lt;intent&gt; run on a repo this size:
$X–$Y. Approve or abort."* No dedicated mini-gate; the projection is informational and part
of Gate 0's approve/revise/abort.

**Repo-state risks (surface here, don't defer).** If discovery found LFS, submodules,
encrypted secrets, failing tests before we started, or an aggressive .gitignore, list them as
extra confirmation lines with the plugin's default behavior. Example:
> ⚠ `.gitmodules` present — submodules will be treated as opaque; the plugin will never write
>   into them. Continue? [assumed yes unless you say otherwise]

On `approved`:
1. Freeze the confirmed allowlist + off-limits into `.sdlc/local/write-contract.json`
   ({ schema_version:1, active:true, mode:"brownfield", run_id, strict:true, allowlist,
   off_limits }). The PreToolUse hook (plugin/scripts/write-contract-check.mjs) reads this file
   before every Write/Edit and refuses off-limits or not-in-allowlist paths at the tool
   boundary.
2. Update `.sdlc/runs/<run-id>/intent_brief.md` with the final scope.
3. Continue to step 6.

On `revise: <comments>` — rewrite the affected parts and re-show Gate 0.

On `abort` — clear `.sdlc/local/write-contract.json` (set active:false), do not delete the
run directory (leave it as a partial record), and stop.

# 6. Run the pipeline

Delegate to the `orchestrator` subagent per [plugin/skills/run-ai-sdlc/SKILL.md](/plugin/skills/run-ai-sdlc/SKILL.md).
Pass:
- `mode: brownfield`
- `intent: <from Gate 0>`
- `run_id: <YYYYMMDD-HHMMSS-<intent>-<slug>>`
- `intent_brief_path: .sdlc/runs/<run-id>/intent_brief.md`
- `baseline_path: .sdlc/baseline/current.json`
- `policy: <default or user-selected>`

The orchestrator then drives phases 1 through 9 with gates 1, 2, 3, 4 as usual — but branched by
intent (see the Intent matrix in SKILL.md). At each gate, relay the gate prompt to the user; do
not answer on their behalf.

# 7. Close out

After the orchestrator emits the final report:

1. Append a row to `.sdlc/ledger.md` (human-readable) and `.sdlc/ledger.json` (machine mirror).
2. Update `.sdlc/CLAUDE-SDLC.md` with the latest project fingerprint + a link to the ledger.
3. Clear the write-contract state: set `.sdlc/local/write-contract.json` active:false.
4. Print the report to the user with cost breakdown, files touched, and (if applicable) the
   `git reset` command the report provides as the escape hatch.

Do not propose a follow-up run.

# Flag surface (headless / repeat runs)

`/run-sdlc-pass` is the flag-driven twin of this command for scripted / CI invocations:

```
--mode brownfield --intent <docs|bugfix|feature-extend|feature-new|refactor|test|deps>
--gates auto-approve | auto-abort | prompt   (default prompt; auto-abort recommended in CI)
--from-config .sdlc/project.json              (auto-approve Gate 0 only when fingerprint matches)
--policy <name>                                (override the default routing policy)
--strict-write=off                             (downgrade write-contract hook to warnings)
--allow-dirty                                  (bypass git-dirty block if commit_strategy != none)
--recheck                                      (force pre-check re-run even when cache is valid)
--adaptive-profile                             (force Tier 2b even when a matching adapter exists)
--refresh-profile                              (force stack-profile re-scan)
```

See [plugin/commands/run-sdlc-pass.md](/plugin/commands/run-sdlc-pass.md) for the full flag contract.
