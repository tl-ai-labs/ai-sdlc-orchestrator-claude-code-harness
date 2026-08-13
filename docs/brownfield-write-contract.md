# Brownfield write contract

The plugin's promise for brownfield mode is: **nothing outside a confirmed file-scope gets
touched.** This document explains how that promise is enforced and answers common "will this
touch X?" questions.

## The contract

**The orchestrator MAY NOT write to any path unless:**

- The path is in the run's `allowlist` (confirmed by you at Gate 0), OR
- The path did not exist at discovery time (a new file), OR
- You re-opened Gate 0 to explicitly expand scope.

**Off-limits paths are hard-rejected** at the tool boundary — before any file-system change
happens.

## Three enforcement layers

The contract is enforced at three layers. Each has different strength and different failure
modes.

| # | Layer | Strength | What it protects against |
|---|---|---|---|
| 1 | Orchestrator prompt gate | **Soft** — instruction to the AI | AI diligence (drops if the model drifts) |
| 2 | Packet validator | **Schema-level** — `TaskPacket.artifact_path` check | Planned writes with bad paths |
| 3 | PreToolUse hook | **HARD** — refused at the tool boundary | Everything, including ad-hoc writes |

Only layer 3 is unbreakable. If the AI ever tries to write outside the allowlist — via a
planned packet OR a spur-of-the-moment `Write` — the hook refuses it at the tool boundary.
Claude Code declines the tool call. The file system is never touched.

## The hook

Implemented in [`plugin/scripts/write-contract-check.mjs`](../plugin/scripts/write-contract-check.mjs).
Registered as a `PreToolUse` matcher on `Write|Edit` in
[`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json).

Behavior:

1. On every `Write` or `Edit` tool call, Claude Code invokes the hook.
2. The hook reads `.sdlc/local/write-contract.json` from an ancestor of the current directory.
3. If the file is missing or `active:false` → allow (greenfield mode or no active run — the
   hook silently no-ops so `/sdlc:run` in an empty folder is unaffected).
4. If active:
   - Check the target path against `off_limits` patterns — deny with reason if hit.
   - Check against `allowlist` patterns — allow if hit.
   - Otherwise (not in allowlist, not off-limits) — deny.
5. `contract.strict = false` (equivalent to `--strict-write=off`) downgrades every enforcement
   to a warning; the file is written but a warning is logged.

Fail-safe: any bug in the hook (parse failures, missing fields, resolvable path issues) → allow.
Better to permit a write than to wedge user work on a plugin bug. Denials only happen when the
contract parses cleanly AND is active AND the path fails the check.

## Merge semantics for sensitive files (deep-merge, never overwrite)

Even when a file is in the allowlist, the plugin uses deep-merge semantics for anything
sensitive:

| File | Rule |
|---|---|
| `package.json` | Add missing deps/scripts; never remove; never downgrade; new script names must not shadow existing |
| `.env` / `.env.example` | Append missing KEY names only; never rewrite values; **never `cp .env.test .env` when `.env` exists** |
| `CLAUDE.md` | Never touch (only append one `@import` line at first setup, via mini-gate with diff preview) |
| `.claude/settings.json` | Read → parse → deep-merge → write, with diff at mini-gate |
| `.mcp.json` | Same as `.claude/settings.json` |
| `routing-policy.yaml` | **Never touched if pre-existing** (surfaced at Gate 0 so you know it's active) |
| `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md` | Default off-limits; only editable if explicitly moved into allowlist at Gate 0 |

## Diff-preview mini-gate for pre-existing files

Any packet targeting a file that existed at discovery time triggers a diff-preview:

1. Packet dispatches → returns proposed content.
2. Orchestrator computes a unified diff between the current file and the proposed content.
3. Diff is shown to you inline.
4. Approve → write. Revise → dispatch again with your comments. Abort → skip this packet.

This is the concrete answer to "we don't know how you use Gemini / Cursor / your own tooling"
— even if discovery misclassified a file's role, you see the diff before it lands.

## FAQ

**Will this touch my `.env`?**
No. Ever. `.env*` is on the default off-limits list even in the allowlist for `docs` or
`feature-new` intents. If codegen introduces a new required env var, we append the KEY name
(not the value) to `.env.example` and print a mini-gate asking you to populate `.env` yourself
before Phase 7 tests run.

**Will this touch my Cursor rules?**
No, unless you moved `.cursor/` into the allowlist at Gate 0 by editing the proposal. The
default is off-limits.

**Will this touch my `package.json`?**
Only to add missing dependencies (deep-merge, append-only) and only when a codegen packet
explicitly requires it. Never to remove, downgrade, or shadow existing scripts.

**What if I have `commit_strategy: per-gate` set?**
Then the plugin also refuses to run on a dirty tree unless you pass `--allow-dirty`. This
prevents your uncommitted work from getting tangled with the plugin's commits. Defaults are
safe: `branch_strategy: current`, `commit_strategy: none`, `pr: off`.

**What if the AI tries to bypass the hook?**
It can't. The hook is a Claude Code `PreToolUse` matcher — refusals happen before the tool
executes. No prompt-level workaround reaches the file system. The only escape hatches are
`contract.strict = false` in `write-contract.json` (which you'd have to set explicitly) or
`--strict-write=off` (which you'd have to pass at run start).

**What if I want to override off-limits for one specific run?**
Re-open Gate 0 with `revise:` and move the specific path from `off_limits` to `allowlist`.
Ephemeral — applies to this run only. The default off-limits from `project.json` isn't
changed by this.

**What if my repo has files with characters that break the pattern matching?**
The hook uses glob-style pattern matching (`*`, `**`, `?`, literal `/`). It doesn't shell-out
or eval anything from the path. Unicode filenames, spaces, exotic characters all work.

**What if I run `git checkout` or `git reset --hard` mid-run?**
The plugin observes git state via `git status` between phases. If HEAD moved unexpectedly, it
halts with a clear message before continuing. No silent recovery — better to stop than to write
against a repo that changed under it.
