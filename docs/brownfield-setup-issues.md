# Brownfield setup-time issue inventory

Every known risk that hits real users installing the plugin on real repos. Each gets
**detection + clear message + inline choice** — the "handle ≠ solve" principle from the design
plan (§22). We detect the problem, tell the user, offer the best available option; we don't
build elaborate solving infrastructure when a good detection suffices.

The table's "handled by" column names the script or subagent that owns each issue's detection.

## Environment (detected in prompt 1)

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 1 | Node too old (< 20) | `env-checks.mjs` | Detect, print required version + install/upgrade instructions (nvm / brew / nodejs.org), exit clean. Cannot auto-upgrade — needs user action. |
| 2 | Git missing or too old (< 2.30) | `env-checks.mjs` | Same — detect, print install instructions per-platform. |
| 3 | MCP server `dist/` not built | `verify-setup.mjs` | Auto-build via `verify-setup.mjs --fix`. |
| 4 | Plugin command-name conflict | `env-checks.mjs` | Detect (best-effort scan of `~/.claude/plugins/*/plugin.json`), list conflicts, ask user to rename or uninstall the conflicting plugin. |
| 5 | Filesystem write permission denied on `~/.claude/` | `env-checks.mjs` | Detect, print `sudo chown -R $USER ~/.claude` (with $USER expanded), exit. |
| 5b | Filesystem write permission denied on `.sdlc/local/` | `env-checks.mjs` | Same shape — clear chmod fix. Deferred if not in a git repo. |

## Repo state (detected in prompt 1 section 5 or pre-check)

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 6 | No test infrastructure detected | `discovery` + `pre-check.mjs` | Discovery notes `test_command_proposed: "unknown"`; Gate 0 warns *"proceed without test phase? [y/n]"*. If yes, Phase 7 is skipped. |
| 7 | Failing tests before we start | `pre-check.mjs` step 2 | Test-command probe uses `--collect-only`/`--dry-run` so it doesn't run the suite. But if user runs the full suite first and it fails, Gate 0 shows a warning: *"Repo has N pre-existing failing tests. Our run won't cause these, but Phase 7 may fail approval on them. Continue? [y/n]"* |
| 8 | Encrypted secrets manager (Vault, Doppler, `.env.enc`) | `discovery` | Detect the marker file. Gate 0 notes: *"Secrets appear to be in `<X>`. Off-limits doesn't cover them, but the plugin doesn't touch them either. No `.env` work in this run."* |
| 9 | Git-LFS files | `discovery` | Detect from `.gitattributes` (`filter=lfs` / `diff=lfs` / `merge=lfs`). Skip `Read` on LFS-marked patterns (would blow token budget). Gate 0 lists what's skipped. |
| 10 | Git submodules | `discovery` | Detect `.gitmodules`. Treat as opaque — write contract never targets them. Gate 0 note. |
| 11 | Squash-merged history | (runtime) | If provenance rollback fails via `git log --follow`, fall back to tree-SHA. Not detected upfront in v1 — recovered at revert time. |
| 12 | Aggressive `.gitignore` hiding source | `discovery` | Detect ignored files matching common source patterns (`src/**/*.ts` etc.). Gate 0 warns which likely-source files are ignored. |
| 13 | Very large repo (> 100K tracked files) | `discovery` | Sample-based discovery instead of full walk. Gate 0 discloses sampling strategy. |
| 14 | Non-UTF8 files | `discovery` | Skip on `Read` failure. Log to `.sdlc/local/debug.log`. Continue. |

## Runtime resilience

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 15 | Provider outage mid-dispatch | MCP server adapters | 3 retries with exponential backoff. Full outage → packet marked `failed: network`. Orchestrator asks user (retry / skip / abort). |
| 16 | Cost runaway on unexpectedly large repo | MCP server + policy | Hard `hard_cost_cap_usd` cap in policy (default $50). When accumulated cost across the run exceeds it, orchestrator aborts with clear message showing per-phase spend. |
| 17 | Model deprecation mid-project | Adapter provider-error handling | Detect via provider error. Fail cleanly: *"model `<X>` is deprecated by provider — update your policy YAML to use `<Y>` (see release notes)."* No auto-fallback — you decide. |

## What we deliberately DON'T do

- **Auto-fix things you should decide.** Missing Node? We tell you the commands; we
  don't run them.
- **Auto-elevate permissions.** Filesystem or chmod issues → we print the fix; you run
  it.
- **Auto-commit / auto-push.** Ever. Default git strategy is `commit_strategy: none`.
- **Auto-upgrade dependencies during setup.** Setup checks are read-only except for building
  the MCP server dist (which the plugin owns).
- **Silently reroute to public models when a private endpoint fails.** Halt cleanly instead.

## How to run just the brownfield checks

```bash
node ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs --brownfield-check
```

Or run them independently:

```bash
# All env checks
node .../plugin/scripts/env-checks.mjs
node .../plugin/scripts/env-checks.mjs --json

# Credential discovery only (never reads secret values)
node .../plugin/scripts/credential-discovery.mjs
node .../plugin/scripts/credential-discovery.mjs --include-antigravity

# Session state / cache introspection
node .../plugin/scripts/session-hydrate.mjs
node .../plugin/scripts/pre-check.mjs --report
```

## For issues not on this list

If you hit a problem that isn't described here, capture it in a support bundle (v1.5 — the
`/sdlc-support-bundle` command) and file an issue. The bundle redacts secrets and includes
enough context (versions, git status, last few runs) for us to diagnose.
