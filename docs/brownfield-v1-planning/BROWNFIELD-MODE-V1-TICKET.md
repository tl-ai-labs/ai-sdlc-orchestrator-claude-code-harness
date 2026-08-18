> **2026-08-18:** the plugin was renamed `sdlc` → `mmo` after this ticket was written (see
> `docs/mmo-v1-planning/MMO-V1-TICKET.md`). Commands, the MCP server, and env vars below are
> named as they were at the time — `/sdlc:*`, `gemini-flash-server`, `SDLC_SELECT` — a historical
> record, not current usage.

# Brownfield Mode for the AI-SDLC Orchestrator Plugin — v1

**Type:** Epic · **Priority:** High · **Estimate:** 2–3 weeks · **Depends on:** none (extends existing plugin)

**Design plan:** `~/.claude/plans/now-since-this-repo-cryptic-hartmanis.md` (26 sections, ~4,500 lines) — this ticket references sections as `§N` and is self-contained enough to implement without reading the plan cover-to-cover, but consult the plan for detailed rationale on any decision.

**Companion visuals (for onboarding new contributors):**
- Overview walkthrough
- Gate 0 / Pipeline / Report walkthrough
- Repos / Sessions / Orchestration walkthrough
- Setup / Pre-check / Robustness walkthrough
- Tech-lead executive proposal

---

## 1. Summary

Extend the existing `sdlc@tilicho-ai-labs` plugin from "generates a new app from a brief in an empty folder" to "installs onto any existing repo and does one of seven kinds of work (docs / bugfix / feature-extend / feature-new / refactor / test / deps) safely, across many sessions, without touching anything the user hasn't approved."

Ship as a new command `/sdlc:brownfield` (plus supporting `/sdlc:revert`), all setup folded into two prompts, with a non-destructive write contract enforced at three layers and multi-session machinery (baseline, ledger, provenance, rollback) that makes the second and Nth session on the same real project safe and coherent.

Greenfield mode continues to work unchanged.

---

## 2. Problem

The plugin today assumes an empty folder:
- Reads a `brief.md`, writes fresh code to `./src`, hard-codes NestJS+Prisma task types, never inspects the target repo.
- Every install doc says "open Claude Code in an empty folder."
- Real users have real repos: existing code, existing conventions, real secrets, other AI tools already in place (Cursor / Aider / Copilot / custom MCP), real CI, real teammates.
- Today's plugin is a demo — not a product they can use on production repos.

---

## 3. Solution (high level)

- **New entry command `/sdlc:brownfield`** — installs and runs against any existing repo.
- **Two-prompt UX contract** — prompt 1 does ALL setup (install, env, credentials, discovery, baseline, pre-check) in six shepherded sections; prompt 2 is lean (staleness check → intent brief → Gate 0 → pipeline).
- **Non-destructive write contract** — enforced at three layers (soft prompt gate / schema packet validator / HARD PreToolUse hook). Off-limits files are refused at the tool boundary.
- **Seven intents** covering ~80% of production brownfield work.
- **Multi-session machinery** (`.sdlc/`) — committed team-shared state (runs, ledger, project fingerprint) + gitignored personal state (local run state, budget, cache).
- **Adaptive stack profile** — learns conventions from actual repo files when the detected stack has no pre-authored adapter.
- **Setup shepherd** — sequential prompt-1 flow that auto-does what it can, pauses and guides the user for what it can't (with re-verification after every "done").

---

## 4. Locked architectural decisions (v1)

Seven architectural decisions have been locked. Each has a corresponding plan section for detailed rationale.

| # | Decision | Section |
|---|---|---|
| D1 | **Adaptive stack profile in discovery** — pre-authored adapters are optional baselines; learned profile from actual repo is primary quality mechanism | §21 |
| D2 | **Two-layer credential handling** — folded into shepherd; discovery at setup time; inline remediation as edge-case fallback in prompt 2 | §26 |
| D3 | **Explicit model-per-task routing docs** — first-class doc showing which model does which work | §24 |
| D4 | **Pipeline pre-check + max-scope robustness** — 6-step smoke test in prompt 1; every known risk gets detection + clear message (`"handle ≠ solve"`) | §22 |
| D5 | **Two-prompt UX contract** — no third command; prompt 1 does ALL setup, prompt 2 is task | §23 |
| D6 | **Setup shepherd behavior** — sequential, pause-and-guide, verify after every "done" | §25 |
| D7 | **Credential discovery — "check first, ask second"** — scan shell env, gcloud, home dir configs, shell rc files, repo files, code references before asking user to set up fresh | §26 |

**Plus these v1 commitments:**
- 7 intents (`docs, bugfix, feature-extend, feature-new, refactor, test, deps`). Review-oriented capabilities (PR review, threat model, architecture review) deferred to v2 — different product category (competes with CodeQL / Cursor review / etc.); not core to safely-changing-code.
- All §14 "must-have" multi-session items (§14.12 backlog)
- Discovery model: tiered (Tier 1 always / Tier 2 at Gate 0 / Tier 2b adaptive profile / Tier 3 on-demand)
- Safety defaults: write-contract PreToolUse hook **HARD-BLOCK by default** (escape hatch `--strict-write=off`); git-dirty **blocks when `commit_strategy != none`** (escape hatch `--allow-dirty`)
- Stack adapters shipped: **generic + nest + python** (Django + FastAPI)
- Graceful mid-setup recovery (setup-status.json persisted per section; next `/sdlc:brownfield` auto-resumes shepherd)

---

## 5. In scope for v1

### 5.1 Commands (new)
- `/sdlc:brownfield` — main entry point (six-section shepherd on first invocation per project)
- `/sdlc:revert <run-id>` — single-run rollback via provenance

### 5.2 Discovery (tiered)
- **Tier 1** (~10 s, always runs) — git state, stack manifest, `.gitignore`, competing AI configs, monorepo signals, submodules, LFS
- **Tier 2** — user confirmation at Gate 0 (test command, file scope, off-limits, intent, layout samples)
- **Tier 2b** — adaptive stack profile for unknown/custom stacks (samples 3–5 files per kind, extracts conventions to `.sdlc/baseline/stack-profile.md`)
- **Tier 3** — on-demand during packet execution (SHA-record at write time, deeper source topology via Grep)

### 5.3 Two-prompt UX — the six sections of prompt 1 (§23)

Prompt 1 runs when user is in a project directory (common case). Each section fully shepherded per §25.

1. **Install** — register marketplace, install plugin, build MCP dist
2. **Environment** — Node ≥ 20, git ≥ 2.30, plugin command-name conflicts, `~/.claude/` write perm
3. **Repo detection** — am I in a git repo? Branches the flow
4. **Credentials** (discover first, ask second per §26) — Anthropic (required, hard shepherd), Gemini (optional, 3 flavors, soft shepherd), Antigravity (opt-in only)
5. **Repo setup** (only if in a git repo) — `.sdlc/` write perm, git-clean advisory, Tier 1 discovery, Tier 2b adaptive profile if triggered, save baseline, pipeline pre-check (6 smoke steps), save pre-check status, surface repo-state risks
6. **Summary** — line-by-line status + next-step guidance

Prompt 2 (lean):
- Setup-status check first (resume shepherd if incomplete)
- Staleness check on baseline (use cached or 5–10 s incremental refresh)
- Skip pre-check unless stale or plugin version changed
- Intent brief interview
- Gate 0 (confirm intent + scope; stack/off-limits already known)
- Pipeline runs

### 5.4 Write contract (§4) — three enforcement layers

1. **Orchestrator prompt gate** — SOFT. Prompt forbids raw `Write`/`Edit` outside packets; resolves target against allowlist. Can drift.
2. **Packet validator** — SCHEMA-LEVEL. `TaskPacket.artifact_path` validated against baseline manifest before dispatch.
3. **PreToolUse hook** — HARD. Every `Write`/`Edit` refused at tool boundary if outside allowlist. **On by default** in brownfield mode.

Merge semantics for sensitive files (`package.json`, `.env*`, `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`, `routing-policy.yaml`, `.cursor/rules`, etc.) — deep-merge, never overwrite. Diff-preview mini-gate for any packet targeting a file that existed at discovery time.

### 5.5 Intent routing (§5)

One linear state machine with intent-conditional phase execution. `intent` field on run context selects which phases execute.

| Intent | Judgment (premium) | Mechanical (Flash) |
|---|---|---|
| docs | requirements, senior review, security review | doc_addition, doc_update |
| bugfix | requirements (reproduce+diagnose), senior review, security review | bug_reproduce, bug_diagnose, bug_fix_apply, test_add |
| feature-extend | requirements, architecture (change_plan), senior review, security review | mixed edit+add |
| feature-new | requirements, architecture (full subsystem), senior review, security review | full codegen mix |
| refactor | requirements (delta), architecture (refactor plan), senior review, security review | refactor_extract, patch_apply |
| test | requirements (coverage target), senior review, security review | test_backfill, test_add |
| deps | requirements (upgrade list), architecture (dep-swap plan), senior review, security review | dependency_add + adjacent patches |

**V1 specialization:** matrix fully specified for `docs / bugfix / feature-extend / feature-new` (proven from greenfield). `refactor / test / deps` route to closest fit in v1; v1.5 specializes.

### 5.6 Multi-session machinery — all §14 must-haves

- `.sdlc/` at git repo root; **committed** subset (project.json, policy.yaml, ledger.md, ledger.json, runs/*, baseline/, CLAUDE-SDLC.md) and **gitignored** subset (local/state.json, local/user-policy.yaml, local/budget.json, local/cache/, local/debug.log, local/setup-status.json)
- Every JSON: `schema_version: 1` field (no migrator scaffold in v1 per C1 cut — added when v2 schema ships)
- Uninstall footprint: single `rm -rf .sdlc/`
- Run directories: `runs/YYYYMMDD-HHMMSS-<intent>-<slug>/` — sortable, self-describing
- **Append-only ledger** — `.sdlc/ledger.md` (human) + `.sdlc/ledger.json` (machine) with one row per run
- **Baseline staleness detection** (§14.4) — git-diff + mtime; incremental refresh in ~5–10 s
- **Git workflow contract** (§14.5) — SAFE DEFAULTS: `branch_strategy: current`, `commit_strategy: none`, `pr: off`. Never `--no-verify`. Configurable in `.sdlc/project.json`
- **Provenance + /sdlc:revert** (§14.6) — per-file `existed_before / sha_before / sha_after / tracked_in_git / backup_path / packet_id`. Backup copy at write time. Four file-state cases handled (see §7.3)
- **Coexistence enforcement** (§14.8) — honor `.gitignore`, run project's own formatters, never `--no-verify`, parse CODEOWNERS (surface, not enforce), competing AI configs default off-limits

### 5.7 Cross-cutting concerns

- **Credential discovery** (§26) — provider-agnostic scanner walks: shell env → home dir configs (`~/.anthropic/`, `~/.config/gcloud/`, `~/.gemini/`) → shell rc files → repo `.env*` (names only) → repo code references
- **Setup shepherd** (§25) — sequential, pause-and-guide, verify on every "done." Re-verify with actual check, not trust user. 3 verification failures → offer skip (with consequence) or abort
- **Graceful mid-setup recovery** — shepherd writes to `.sdlc/local/setup-status.json` per section; next `/sdlc:brownfield` reads it and resumes from where left off
- **Pipeline pre-check** (§22) — 6 smoke steps (discovery, test-command probe, dispatch smoke to each tier, write-contract smoke, rollback smoke, report). Cached to `.sdlc/pre-check-status.json`
- **Setup-time robustness** (§22) — 17-issue inventory, all handled with detection + clear message (per "handle ≠ solve" principle):
  - Env: Node/git version, MCP dist not built, plugin conflicts, filesystem permissions
  - Repo state: no test infra, failing tests, encrypted secrets, git-LFS, submodules, squash-merged history, aggressive .gitignore, very-large repo, non-UTF8
  - Runtime: provider outage, cost runaway (hard cap $50 default), model deprecation
- **File placement matrix** (§15) — 10-category placement decisions; monorepo detection at Tier 1 with per-package test/write scoping; framework-owned wiring (`module_wiring` for Nest, `url_registration` for Django, `router_wiring` for FastAPI) as paired packets

### 5.8 Stack adapters (v1)

Pre-authored fragments (`plugin/skills/run-ai-sdlc/stacks/`):
- `generic.md` — fallback for unknown stacks (works with adaptive profile)
- `nest.md` — carries over greenfield expertise
- `python.md` — Django + FastAPI conventions

Each adapter has a `## Placement rules` section (§15).

### 5.9 Docs (v1)

- `docs/brownfield.md` — overview, gate walkthrough, coexistence guarantees
- `docs/brownfield-write-contract.md` — the §4 contract exhaustively, with FAQ
- `docs/brownfield-coexistence.md` — deep coexistence (§16)
- `docs/brownfield-privacy.md` — data flow + regulated repos (§19)
- `docs/brownfield-setup-issues.md` — the 17-issue robustness inventory + mitigations
- `docs/brownfield-routing.md` — explicit model-per-task routing table (§24)

### 5.10 Example repositories (v1)

Under `plugin/examples/`:
- `brownfield-docs-gen/` — 3-file Express app + intent asking for README + JSDoc
- `brownfield-bugfix/` — sample with a seeded failing test
- `brownfield-feature-extend/` — existing endpoint + brief asking to add a filter param
- `brownfield-refactor/` — sample with duplicate code to consolidate
- `brownfield-test-backfill/` — sample with untested service
- `brownfield-deps-upgrade/` — sample with outdated dep + CVE

### 5.11 Policy + telemetry updates

- Add `"discovery"` and `"change_plan"` to closed `Phase` union at `plugin/mcp/gemini-flash-server/src/types.ts:5-16`
- Update shipped policies `opus-only.yaml` and `opus-plus-flash.yaml` with rules for both new phases — **discovery is premium** (a wrong stack detection cascades)
- Add `hard_cost_cap_usd: 50` field to shipped policies (default cap)
- `dispatch-sanitize.mjs` regex sweep invoked from `plugin/mcp/gemini-flash-server/src/adapters/*.ts` before every provider call

---

## 6. Out of scope for v1

### 6.1 Deferred to v1.5 (fast-follow)
- Session-hydrate `SessionStart` hook + `@.sdlc/CLAUDE-SDLC.md` import into user's CLAUDE.md
- `/sdlc-resume` + packet-level checkpoints
- `/sdlc-audit` + per-project cost roll-up
- `/sdlc-support-bundle` + debug mode (`SDLC_DEBUG=1`)
- Headless / CI mode (`--gates auto-abort`, `--from-config`, `ci-strict.yaml`)
- Portable run-lock (replacing simple marker file)
- Security-reviewer origin-tagging (`origin: new | pre-existing | unclear`)
- Deep AI-tool parsing (Cursor `.mdc` glob-intersect warnings, Aider auto-commit warnings, MCP name heuristics)
- Intent matrix specialization for `refactor / test / deps`
- On-prem policies: `bedrock-claude-only.yaml`, `vertex-mixed.yaml`, `self-hosted-only.yaml`
- Additional stack adapters: `react.md`, `nextjs.md`
- Real submodule support (v1 treats them as opaque)
- Failure-mode rows 10–13 from §18 (state corruption recovery, rollback conflict UX, concurrent-run lock UX, plugin version-mismatch recovery)

### 6.2 Deferred to v2+
- **Review-oriented capabilities** — PR / diff review command, threat model, architecture review, dead-code/dependency analysis reports. Different product category from safely-changing-code; competes with existing tools (CodeQL, Cursor review, GitHub Copilot review). Ship if real users ask for it.
- `compute_baseline_manifest` MCP tool (batch SHA in Node)
- Run archive tarball + pruning
- `per-run` branch strategy + `draft-on-close` PR
- Per-user budgets + pre-run cost-projection mini-gate
- State-schema `--downgrade-state` migration
- Migration harness scaffold (v1 ships `schema_version` field only, no migrator scaffold)
- Additional stack adapters: `go.md`, `rails.md`, `java.md`, `vue.md`, `svelte.md`, `angular.md`
- `perf` intent (needs profiler integration)
- Large-migration intent (framework/runtime/monolith split — needs multi-pass state)
- Async-review workflow (drafts + PR review of intent brief before run)

### 6.3 Explicitly never
- Codebase Q&A / explain (deferred to existing `understand-anything` plugin — don't reinvent)
- Per-machine database of any kind — file-based only, always
- Call-home telemetry — nothing leaves the machine except model calls per policy

---

## 7. Sub-task breakdown (in implementation order)

Recommended order — write contract is the safety foundation, so build it first so every subsequent piece can rely on the guarantees.

### 7.0 Sub-task dependency map

Blocks / blocked-by relationships. Implement in order below unless you can parallelize independently.

| Sub-task | Depends on | Blocks |
|---|---|---|
| 7.1 Write contract | — | 7.4 (pre-check step 4), 7.7 (Gate 0 authoritative source), 7.15 (revert relies on provenance which relies on write hook) |
| 7.2 Discovery + baseline | — | 7.3, 7.4 (pre-check step 1), 7.7 (Gate 0 confirms discovery), 7.10, 7.14 |
| 7.3 Adaptive stack profile | 7.2 | 7.9 (adapters consume profile), 7.10 |
| 7.4 Pipeline pre-check | 7.1, 7.2, 7.5, 7.13 | 7.6 (shepherd section 5.17), 7.7 |
| 7.5 Credential discovery | — | 7.4 (dispatch smoke), 7.6 (shepherd section 4), 7.13 (dispatch needs credentials) |
| 7.6 Setup shepherd | 7.1, 7.2, 7.3, 7.4, 7.5, 7.19 | 7.7 (must show a completed setup before task can start) |
| 7.7 Gate 0 + intent brief | 7.2, 7.6 | 7.8 |
| 7.8 Intent routing + phase matrix | 7.7 | 7.9, 7.11, 7.12 |
| 7.9 Stack adapters + task types | 7.3, 7.8 | 7.11 |
| 7.10 File placement (§15) | 7.2, 7.9 | 7.11 |
| 7.11 Architect + reviewer changes | 7.8, 7.9, 7.10 | — |
| 7.12 Testing changes | 7.8 | — |
| 7.13 Policy + telemetry | — | 7.4 (pre-check dispatch smoke), 7.9 |
| 7.14 Multi-session state model + ledger | 7.2 | 7.6 (setup-status.json), 7.15 |
| 7.15 Provenance + `/sdlc:revert` | 7.1, 7.14 | — |
| 7.16 Coexistence enforcement | 7.2 | — |
| 7.17 Robustness handling | 7.6, 7.14 | — |
| 7.18 Docs + examples | ALL implementation done | — |
| 7.19 `verify-setup.mjs` orchestration | 7.5 | 7.6 |

**Critical path:** 7.1 → 7.2 → 7.3 → 7.5 → 7.13 → 7.14 → 7.19 → 7.4 → 7.6 → 7.7 → 7.8 → 7.9 → 7.10 → 7.11.

**Parallelizable pairs:** 7.12 (testing) and 7.15 (provenance) can proceed in parallel with 7.11. 7.16 (coexistence) can start as soon as 7.2 is done. 7.17 (robustness) accumulates across the whole build — treat as horizontal work, not a single sub-task.

### 7.1 Write contract foundation (§4)

**Files to create:**
- `plugin/hooks/hooks.json` — PreToolUse Write/Edit matcher
- `plugin/scripts/write-contract-check.mjs` — hook body

**Files to edit:**
- `plugin/mcp/gemini-flash-server/src/types.ts` — add write-contract validation to `TaskPacket.artifact_path`
- `plugin/agents/orchestrator.md` — add "Write gate" section; forbid raw `Write`/`Edit` outside packets; branch on `intent`

**Acceptance criteria:**
- Hook on by default in brownfield mode; off in greenfield
- Off-limits writes refused at tool boundary
- Escape hatch `--strict-write=off` works
- Packet validator rejects packets with off-limits `artifact_path`
- Orchestrator prompt forbids raw `Write`/`Edit` outside packets
- Merge semantics for sensitive files documented and enforced

### 7.2 Discovery (tiered) + baseline (§2, §14.4)

**Files to create:**
- `plugin/agents/discovery.md` (front-matter tools: `Read, Glob, Grep, Bash(git *)`)
- `plugin/scripts/discovery-refresh.mjs` — staleness detection + incremental refresh

**Files to edit:**
- `plugin/scripts/verify-setup.mjs` — add git-binary check + Read-permission smoke test

**Outputs (per run):** `.sdlc/runs/<id>/discovery.md`, `.sdlc/runs/<id>/baseline.json`
**Outputs (project-wide):** `.sdlc/baseline/current.json`, `.sdlc/baseline/discovery.md`

**Acceptance criteria:**
- Tier 1 runs in ~10 s
- Detects: stack manifest, `.gitignore`, competing AI configs (presence only in v1), monorepo signals (pnpm/nx/turbo/lerna/rush), submodules, LFS files
- **Refuses on non-git repos** with clear message (`"git init && git add -A && git commit -m 'baseline'"`)
- Records **key names only** for `.env*` files (never values — §19)
- Baseline saved with `schema_version: 1`
- Incremental refresh works via git-diff + mtime

### 7.3 Adaptive stack profile (Tier 2b — §21)

**Files to edit:**
- `plugin/agents/discovery.md` — add adaptive profile sub-step

**Outputs:** `.sdlc/baseline/stack-profile.md`

**Acceptance criteria:**
- Triggers only when: (a) detected stack has no matching adapter, (b) CLAUDE.md declares a custom framework, or (c) user passes `--adaptive-profile`
- Samples 3–5 files of each detected "kind" (controllers, services, tests, configs)
- Extracts: file naming, decorators/annotations, import shapes, folder structure, test-runner patterns, config validator, ORM usage
- Codegen packets receive it alongside pre-authored adapter fragment; profile wins on conflict
- Cached in baseline; refreshed on staleness (stack manifest changed / N runs / `--refresh-profile`)

### 7.4 Pipeline pre-check (§22)

**Files to create:**
- `plugin/scripts/pre-check.mjs` — 6-step smoke test runner

**Outputs:** `.sdlc/pre-check-status.json`

**Acceptance criteria:**
- Runs 6 steps: (1) discovery smoke, (2) test-command probe, (3) dispatch smoke to each policy tier, (4) write-contract smoke, (5) rollback smoke, (6) report
- Runs at end of prompt 1 section 5
- ~20 s total, ~$0.02 cost
- Fail-fast on any step; prints exact remediation with inline choice
- Cached; subsequent runs skip steps whose inputs haven't changed
- Invoked automatically at first `/sdlc:brownfield` per project

### 7.5 Credential discovery + shepherd (§26)

**Files to create:**
- `plugin/scripts/credential-discovery.mjs` — provider-agnostic scanner returning `{provider, sources: [{location, kind, hint}]}`

**Files to edit:**
- `plugin/scripts/verify-setup.mjs` — invoke discovery, print status report

**Acceptance criteria:**
- Anthropic scanned in: shell env (`ANTHROPIC_API_KEY`), `~/.anthropic/credentials`, shell rc files, repo `.env*` (names only). Fallback: Claude Code subscription → `estimated` mode
- Gemini scanned in: shell env (`GEMINI_API_KEY`/`GOOGLE_API_KEY`), `GOOGLE_APPLICATION_CREDENTIALS` env, ADC file (`~/.config/gcloud/application_default_credentials.json`), `gcloud auth print-access-token`, `gcloud config get-value project`, `~/.gemini/*`, shell rc files, repo `.env*`, repo code references
- Antigravity: only checked when policy uses `flash-agsdk-worker`; reuses GCP auth stack
- Never reads `.env` values; names only. Never reads shell rc secret values
- Found-something dialog presents options; hints at which matches repo usage
- Found-nothing dialog offers 3 provider paths + skip

### 7.6 Setup shepherd (prompt 1) (§25, §23)

**Files to create:**
- `plugin/scripts/env-checks.mjs` — Node/git version + plugin-conflict + filesystem permission checks
- `plugin/templates/gitignore-fragment` — offered at first setup

**Files to edit:**
- `SETUP.md` — rewrite as shepherd contract (Claude follows verbatim on prompt 1)

**Outputs:** `.sdlc/local/setup-status.json`

**Acceptance criteria:**
- Six sections run sequentially per §23
- Auto-do steps just do; guide steps pause, print exact commands with platform options, wait for `"done"` / `"skip"` / `"abort"`
- **Always re-verify** with the actual check after user says "done"
- 3 verification failures → offer skip (with consequence) or abort
- Never restart from scratch after a fix; continue from where you were
- Setup-status persisted after **each section completes** — schema `{sections_done, sections_pending, last_prompt_step, timestamp}`
- Prompt 2's first check reads setup-status.json; resumes shepherd if incomplete
- Final summary always printed with what was done / skipped / consequences

### 7.7 Gate 0 + intent brief (§3, §6)

**Files to create:**
- `plugin/commands/brownfield.md` — main command spec (includes pre-check + shepherd behavior)
- `plugin/commands/run.md` (edit) — add mode-detection guard (refuses if not empty; suggests `/sdlc:brownfield`)

**Files to edit:**
- `plugin/skills/run-ai-sdlc/SKILL.md` — insert Phase 0/0b/0c states, Gate 0 template, gate-message bubble-up pattern (subagent → main-loop message shape), intent matrix section, task-type table rewrite

**Acceptance criteria:**
- Gate 0 covers: stack, test command, existing AI setup (default OFF-LIMITS), intent, file scope
- Reply options: `approved` / `revise: <comments>` / `abort`
- Repo-state risks (LFS, submodules, failing tests, encrypted secrets) surfaced at Gate 0
- **Cost projection printed at end of Gate 0** — one-line estimate from a rough table keyed on `(intent × baseline-size bucket)`: *"Typical cost for a bugfix run on a repo this size: $0.20–$0.80. Approve or abort."* No dedicated mini-gate (per §14.9 C4 cut)
- Intent brief interview writes `intent_brief.md` with the 6-section heading template
- Gate messages bubble up from orchestrator subagent to main-loop Claude Code session via specifically-shaped fenced message
- Mode-detection guard on `/sdlc:run` refuses in a non-empty repo

### 7.8 Intent routing + phase matrix (§5)

**Files to edit:**
- `plugin/skills/run-ai-sdlc/SKILL.md` — add `## Intent matrix` section
- `plugin/agents/orchestrator.md` — branch on `intent` before Phase 2 and Phase 7

**Acceptance criteria:**
- 7 intents route through same state machine with phase-conditional execution
- Matrix fully specified for `docs / bugfix / feature-extend / feature-new`
- `refactor / test / deps` route to closest fit in v1 (specialization in v1.5)
- SKIP behaviors work (docs skips architect; docs test-run is doc-lint only; etc.)

### 7.9 Stack adapters + task types (§7)

**Files to create:**
- `plugin/skills/run-ai-sdlc/stacks/generic.md`
- `plugin/skills/run-ai-sdlc/stacks/nest.md`
- `plugin/skills/run-ai-sdlc/stacks/python.md` (Django + FastAPI)

**Files to edit:**
- `plugin/mcp/gemini-flash-server/src/types.ts` — add optional `subtype?: string` to `TaskPacket` (backwards-compat)
- `plugin/skills/run-ai-sdlc/SKILL.md` — rewrite Phase 4 task-type table with base primitives + subtype
- `plugin/config/policies/opus-only.yaml` + `opus-plus-flash.yaml` — rules for new phases

**Acceptance criteria:**
- Base task types stack-agnostic: `existing_file_edit`, `patch_apply`, `new_file_add`, `doc_addition`, `doc_update`, `test_backfill`, `test_add`, `bug_reproduce`, `bug_diagnose`, `bug_fix_apply`, `refactor_extract`, `dependency_add`
- Framework-owned wiring types work (paired packets, roll back atomically): `module_wiring` (Nest), `url_registration` (Django), `router_wiring` (FastAPI)
- Each adapter has `## Placement rules` section per §15
- Existing greenfield policy backwards-compatible

### 7.10 File placement (§15)

**Files to edit:**
- `plugin/skills/run-ai-sdlc/stacks/*.md` — add `## Placement rules` sections
- Monorepo detection integrated in Tier 1 (§7.2)

**Acceptance criteria:**
- 10-category placement matrix handled (A–J in §15)
- Monorepo: Gate 0 asks package scope; per-package test command (`pnpm --filter`, `nx test`, `turbo run --filter`); provenance `scope` field
- Framework-owned wiring runs as paired packets

### 7.11 Architect + reviewer changes (§8)

**Files to edit:**
- `plugin/agents/architect.md` — add `mode: greenfield|brownfield` input; consume `baseline.json` + `discovery.md` + `intent_brief.md`; produce `change_plan.md` in brownfield; replace NestJS-flavored lines 12–16 with stack-parameterized language
- `plugin/agents/senior-reviewer.md` — review only files touched by this run (v1 simplification per C5)
- `plugin/agents/security-reviewer.md` — review only files touched by this run (v1); v1.5 adds origin-tagging

**Acceptance criteria:**
- Architect skips or does delta based on intent per §5 matrix
- Senior reviewer scoped to touched files; pre-existing smells outside touched files not surfaced
- Security reviewer scoped to touched files; env-fixture blocker at line 19 conditional on `intent ∈ (feature-new, feature-extend)` and validating config module

### 7.12 Testing changes (§9)

**Files to edit:**
- `plugin/skills/run-ai-sdlc/SKILL.md` — replace env-copy bug at line 161

**Acceptance criteria:**
- Test command from Gate 0 (not hardcoded `npm test`)
- Working directory = repo root by default; per-package for monorepos
- **NEVER** `cp .env.test .env` when `.env` exists
- Missing keys append to `.env.example`, print, ask user to populate before Phase 7 continues
- Optional Phase 0.5 test-command probe (dry `--collect-only` or `--dry-run` before spending on packets)

### 7.13 Policy + telemetry updates (§11, §19)

**Files to edit:**
- `plugin/mcp/gemini-flash-server/src/types.ts` — add `"discovery"` and `"change_plan"` to closed `Phase` union
- `plugin/config/policies/opus-only.yaml` — rules for `discovery` (premium) + `change_plan` (premium)
- `plugin/config/policies/opus-plus-flash.yaml` — same; add `hard_cost_cap_usd: 50`

**Files to create:**
- `plugin/scripts/dispatch-sanitize.mjs` — regex sweep for secrets before dispatch (private-key headers, `AWS_SECRET_ACCESS_KEY=<value>` inline, high-entropy strings past threshold)

**Files to edit:**
- `plugin/mcp/gemini-flash-server/src/adapters/*.ts` — invoke `dispatch-sanitize` before every provider call

**Acceptance criteria:**
- Discovery + change_plan phases route to premium tier
- Sanitize sweep runs on every dispatch input; blocks if secrets detected
- Telemetry never records prompt content, response content, source slices, or file paths beyond `artifact_path`
- Hard cost cap enforced per run

### 7.14 Multi-session state model + ledger (§14.1, §14.2)

**Files to create:**
- `plugin/scripts/session-hydrate.mjs` — reads `.sdlc/project.json` + last 3 ledger.json rows; emits summary marker (v1: called at first `/sdlc:brownfield` invocation per session; v1.5: called from `SessionStart` hook)

**Outputs (structure):**
- `.sdlc/project.json` — canonical fingerprint (committed)
- `.sdlc/policy.yaml` (optional) — team policy override
- `.sdlc/ledger.md` + `.sdlc/ledger.json` — append-only rollups
- `.sdlc/runs/<UTC>-<intent>-<slug>/` — frozen per-run records
- `.sdlc/baseline/current.json` + `.sdlc/baseline/discovery.md` — living project baseline
- `.sdlc/CLAUDE-SDLC.md` — plugin-owned CLAUDE-scoped context
- `.sdlc/local/state.json` (gitignored)
- `.sdlc/local/setup-status.json` (gitignored, for shepherd resume)
- `.sdlc/local/user-policy.yaml`, `budget.json`, `cache/`, `debug.log` (all gitignored)

**Acceptance criteria:**
- Every JSON: `schema_version: 1`
- Every run stamps `plugin_version` (from `plugin/.claude-plugin/plugin.json`)
- `.gitignore` fragment offered (not force-appended) at first-run Gate 0
- Ledger appended per run — timestamp, intent, branch, HEAD before/after, packet count, files touched, gates passed, outcome, spend, plugin version
- Uninstall footprint: single `rm -rf .sdlc/`
- Concurrent runs: v1 uses `.sdlc/local/run.marker` (PID + start-time + mtime advisory); v1.5 upgrades to portable lock

### 7.15 Provenance + /sdlc:revert (§14.6)

**Files to create:**
- `plugin/commands/revert.md`

**Outputs (per run):** `.sdlc/runs/<id>/provenance.json` + backup copies at `.sdlc/local/cache/<run-id>/*.bak`

**Acceptance criteria:**
- Provenance records: `{files_touched: [{path, existed_before, sha_before, sha_after, tracked_in_git, backup_path, packet_id}], git_head_before, git_head_after, commits}`
- Written incrementally on every successful `Write`/`Edit` — never held in memory
- **Backup copy at write time** (not after) for uncommitted files that already existed
- Four file-state rollback cases (§14.6):
  - Pre-existing committed → `git checkout <sha_before> -- <path>`
  - Pre-existing tracked-uncommitted → restore from backup_path
  - Pre-existing untracked → restore from backup_path
  - Newly created by this run → `rm <path>`
- Dirty case (subsequent runs touched same file) → refuse auto-revert; print three-way diffs

### 7.16 Coexistence enforcement (§14.8, §16)

**Files to create:**
- `docs/brownfield-coexistence.md`

**Files to edit:**
- Various — see below

**Acceptance criteria:**
- Discovery respects `.gitignore` (skips via `git check-ignore` per candidate)
- Writes into `.gitignore`d paths refused without explicit Gate 0 override
- Project's own formatters (`prettier`, `eslint`, `black`, `ruff`, `gofmt`, etc.) run on written files before packet close
- Plugin ships no formatters of its own
- Pre-commit hooks fire normally; **plugin never uses `--no-verify`**
- `.github/CODEOWNERS` parsed; packets targeting files with owners outside operator's declared teams raise mini-gate (governance stays with GitHub — plugin surfaces, doesn't enforce)
- Competing AI configs (Cursor, Aider, Copilot, custom MCP) — presence detection + off-limits by default in v1 (deep parsing v1.5)

### 7.17 Robustness handling (§18, §22)

**Various edits across the codebase** for detection + clear-message handling of the 17 known issues.

**Files to create/edit:**
- `docs/brownfield-setup-issues.md` — the honest inventory with mitigations
- `plugin/templates/settings-ci-fragment.json` — pre-allow `Bash(git *)` for CI (ship template now; used in v1.5 CI mode)

**The 17 known issues, inventoried** (each gets detection + clear-message handling; nothing more elaborate):

**Environment (verify-setup.mjs at prompt 1):**
1. Node too old (< 20) — detect, print install/upgrade options, exit clean
2. Git missing or too old (< 2.30) — same
3. MCP server `dist/` not built — auto-build via `--fix`
4. Plugin command-name conflict — detect, list, ask user to rename/uninstall
5. Filesystem write permission on `.sdlc/` denied — detect, print chmod fix, exit

**Repo state (first-run inside prompt 1 sections 5 / pre-check):**
6. No test infrastructure at all — Gate 0 warns: "proceed without test phase?"
7. Failing tests before we start — Gate 0 warns: "N pre-existing failures — Phase 7 may fail approval"
8. Encrypted secrets manager (Vault/Doppler/.env.enc) — Gate 0 note: "secrets in `<X>` — untouched, no .env work"
9. Git-LFS files — skip Read on LFS-marked files, Gate 0 lists skipped
10. Git submodules — treat as opaque (never write), Gate 0 note
11. Squash-merged history — provenance uses tree-SHA fallback instead of `git log --follow`
12. Aggressive .gitignore hiding source — Gate 0 warns which likely-source files are ignored
13. Very large repo (>100K files) — sample-based discovery, Gate 0 discloses
14. Non-UTF8 files — skip on Read failure, log to debug.log, continue

**Runtime resilience:**
15. Provider outage mid-dispatch — 3 retries with exponential backoff, then fail packet cleanly
16. Cost runaway — hard cap per run (default $50 from policy), abort with clear message
17. Model deprecation — detect via provider error, fail cleanly: *"model `<X>` deprecated — update policy to `<Y>`"*

**Acceptance criteria:**
- Every one of the 17 issues detected with the handling above
- Cost cap enforced per run via `hard_cost_cap_usd` in policy YAML
- No hidden state; every failure user-visible per §18 contract

### 7.18 Docs + examples

**Files to create:**
- `docs/brownfield.md`
- `docs/brownfield-write-contract.md`
- `docs/brownfield-privacy.md`
- `docs/brownfield-setup-issues.md` (from §7.17)
- `docs/brownfield-routing.md` — model-per-task table (§24)
- `docs/brownfield-coexistence.md` (from §7.16)
- `plugin/examples/brownfield-{docs-gen,bugfix,feature-extend,refactor,test-backfill,deps-upgrade}/` — 6 folders with sample repos + intent briefs
- `plugin/scripts/brownfield-cleanup.mjs` — removes `.sdlc/` (v1); v1.5 also strips `@import` line from user's `CLAUDE.md`

**Files to edit:**
- `README.md` — add "Greenfield vs Brownfield" section
- `SETUP.md` — rewrite as shepherd contract Claude follows verbatim on prompt 1
- `plugin/commands/pass.md` — add `--mode`, `--intent`, `--gates`, `--from-config`, `--policy` flags (some flag consumers are v1.5; parser accepts all)

**Acceptance criteria:**
- All 6 docs present and complete
- 6 example repos runnable end-to-end (verification plan §8.3 exercises each)
- README has clear Greenfield vs Brownfield section pointing users to the right command
- Keep `plugin/commands/run.md` for greenfield — do NOT collapse the two commands

### 7.19 verify-setup.mjs orchestration

**Files to edit:**
- `plugin/scripts/verify-setup.mjs` — orchestrates env-checks + credential-discovery + shepherd flow; supports `--headless` (exit-on-guide-needed for CI, v1.5) and `--fix` (auto-build MCP dist)

**Acceptance criteria:**
- Non-interactive `--headless` prints instructions to logs and exits non-zero on any guide-needed step
- Interactive default mode runs full shepherd (§7.6)
- Exit 0 with warnings for optional gaps (e.g., Gemini missing but Anthropic present)
- Exit 1 for hard blockers (Node too old, git missing, plugin conflict)

---

## 8. Files to create (comprehensive list)

Group by directory. All net-new.

### 8.1 `plugin/commands/`
- `brownfield.md` (§7.7)
- `revert.md` (§7.15)

### 8.2 `plugin/agents/`
- `discovery.md` (§7.2)

### 8.3 `plugin/skills/run-ai-sdlc/stacks/`
- `generic.md` (§7.9)
- `nest.md` (§7.9)
- `python.md` (§7.9)

### 8.4 `plugin/hooks/`
- `hooks.json` — PreToolUse Write/Edit matcher (§7.1). SessionStart hook stub for v1.5.

### 8.5 `plugin/scripts/`
- `write-contract-check.mjs` (§7.1)
- `pre-check.mjs` (§7.4)
- `credential-discovery.mjs` (§7.5)
- `discovery-refresh.mjs` (§7.2)
- `session-hydrate.mjs` (§7.14 — v1 called on demand; v1.5 hooked to SessionStart)
- `env-checks.mjs` (§7.6)
- `dispatch-sanitize.mjs` (§7.13)
- `brownfield-cleanup.mjs` (§7.18)

### 8.6 `plugin/templates/`
- `gitignore-fragment` (§7.14)
- `settings-ci-fragment.json` (§7.17)

### 8.7 `plugin/examples/`
- `brownfield-docs-gen/`
- `brownfield-bugfix/`
- `brownfield-feature-extend/`
- `brownfield-refactor/`
- `brownfield-test-backfill/`
- `brownfield-deps-upgrade/`

### 8.8 `docs/`
- `brownfield.md`
- `brownfield-write-contract.md`
- `brownfield-coexistence.md`
- `brownfield-privacy.md`
- `brownfield-setup-issues.md`
- `brownfield-routing.md`

---

## 9. Files to edit (comprehensive list)

### 9.1 `plugin/skills/run-ai-sdlc/SKILL.md`
- Insert Phase 0 (`discover_repo`), 0b (`intent_router`), 0c (`read_intent_brief`) states
- Add Gate 0 prompt template + gate-message bubble-up pattern (subagent → main-loop message shape)
- Add `## Intent matrix` section (§5, §7.8)
- Rewrite Phase 4 task-type table with base primitives + optional `subtype` (§7.9)
- Fix env-copy bug at line 161 (`.env.test` → `.env` — never overwrite existing) (§7.12)
- Add cache_project_header brownfield mode (may skip when discovery already primed context)

### 9.2 `plugin/agents/orchestrator.md`
- Add `mode: greenfield|brownfield` and `intent: <7 values | review>` inputs
- Add "Write gate" section — forbid raw `Write`/`Edit` outside packets; resolve target against allowlist before every write
- Branch on `intent` before Phase 2 (architecture) and Phase 7 (tests)

### 9.3 `plugin/agents/architect.md`
- Add `mode: greenfield|brownfield` input
- In brownfield: consume `baseline.json` + `discovery.md` + `intent_brief.md`; produce `change_plan.md` instead of `design.md`
- Replace NestJS-flavored spec at lines 12–16 with stack-parameterized language sourced from the stack adapter fragment

### 9.4 `plugin/agents/senior-reviewer.md`
- Review only files touched by this run (v1 simplification)
- v1.5 will add baseline-diff mode with `git diff <baseline_sha> -- <files>`

### 9.5 `plugin/agents/security-reviewer.md`
- Review only files touched by this run (v1)
- Env-fixture blocker at line 19 becomes conditional on `intent ∈ (feature-new, feature-extend)` and stack having a validating config module
- v1.5 adds `origin: new | pre-existing | unclear` tagging

### 9.6 `plugin/mcp/gemini-flash-server/src/types.ts`
- Add `"discovery"` and `"change_plan"` to closed `Phase` union at lines 5-16
- Add optional `subtype?: string` to `TaskPacket` (backwards-compat)
- Extend `TaskPacket` schema-validate `artifact_path` against allowlist

### 9.7 `plugin/mcp/gemini-flash-server/src/adapters/*.ts`
- Invoke `dispatch-sanitize.mjs` before every provider call (§7.13, §19)

### 9.8 `plugin/config/policies/opus-only.yaml`
- Add rules for `discovery` + `change_plan` phases (premium tier)
- Add `hard_cost_cap_usd: 50` field

### 9.9 `plugin/config/policies/opus-plus-flash.yaml`
- Same — new phase rules + cost cap

### 9.10 `plugin/commands/run.md`
- Add mode-detection guard — refuses if `./src` non-empty or `.git` with tracked files exists; suggests `/sdlc:brownfield` (§7.7 A2 fix)

### 9.11 `plugin/commands/pass.md`
- Add `--mode brownfield --intent <7 values>` flags (v1)
- Add `--gates auto-approve|auto-abort|prompt`, `--from-config`, `--policy` flags (v1.5 consumers, parser accepts now)
- Add `--allow-dirty`, `--strict-write=off`, `--recheck`, `--adaptive-profile`, `--refresh-profile` flags

### 9.12 `plugin/scripts/verify-setup.mjs`
- Orchestrate env-checks + credential-discovery + shepherd flow
- Add git-binary version check (D1)
- Add Read-permission smoke test at repo root (D2)
- Support `--headless` (v1.5 CI) and `--fix` (auto-build MCP dist)

### 9.13 `README.md`
- Add "Greenfield vs Brownfield" section pointing users to the right command
- Preserve existing greenfield content

### 9.14 `SETUP.md`
- Rewrite as shepherd contract — describe the six sections of prompt 1 as Claude's contract to follow verbatim
- Preserve URL-based install pattern

---

## 10. Verification plan

Cannot rely on unit tests alone — workflow verified by real runs.

### 10.1 Unit / integration
- Write-contract validator (allow / off-limits / not-in-manifest cases)
- Baseline reader with `schema_version` rejection
- Session-hydrate reader
- `dispatch-sanitize.mjs` sweep (positive and negative cases for secrets patterns)
- Credential discovery parser for each provider
- `verify-setup.mjs` — git-binary check, Read-permission smoke test
- MCP server tests extended for new `Phase` enum values

### 10.2 Discovery agent dry-run
- Run `/sdlc:brownfield` on this very repo (worktree), stop at Gate 0
- Inspect `discovery.md` and `baseline.json` by hand
- Confirm: stack detected as node/typescript, `.mcp.json` and `plugin/config/policies/*.yaml` flagged in AI-setup group, env keys only (no values)

### 10.3 Per-intent golden-path e2e
For each of the 6 example repos, run end-to-end. Assert:
- Final report's write-contract audit matches expected file list
- `git diff` shows no changes outside allowlist
- `.env` was never overwritten
- Tests pass after packet execution (where applicable)

### 10.4 Coexistence e2e
Temp repo pre-seeded with `.claude/settings.json`, `.mcp.json` (fake foreign MCP), `.cursor/rules`, competing `routing-policy.yaml`. Run brownfield. Assert: none of these files changed; Gate 0 named all of them.

### 10.5 Rollback drills — all 4 file-state cases
- Pre-existing committed → assert restored via `git checkout <sha> -- <path>`
- Pre-existing tracked-uncommitted → assert restored from `backup_path`
- Pre-existing untracked → assert restored from `backup_path`
- Newly-created by run → assert `rm <path>` clears it
Each case returns to pre-run state exactly.

### 10.6 Session-continuity e2e
Run 3 different intents in 3 sessions on the same repo. Assert:
- Session 4 shows all 3 in `.sdlc/ledger.md`
- Baseline is refreshed (not recomputed from scratch) between sessions
- `.sdlc/CLAUDE-SDLC.md` reflects latest run

### 10.7 Setup shepherd drills
Force each condition and verify shepherd behavior:
- Missing Node (or Node < 20) → guide + verify path
- Missing git (or git < 2.30) → same
- Missing Anthropic key → hard shepherd (can't skip)
- Missing Gemini key → soft shepherd, 3 options offered
- Plugin conflict → detected and reported
- Filesystem write perm denied → guide chmod + verify

### 10.8 Failure-mode drills (pick 5 from §18 table)
- Crash mid-packet (Ctrl+C during Phase 5)
- Disk full (fill disk mid-run)
- Network drop mid-dispatch
- Quit Claude Code mid-gate
- Rebase between sessions

Assert each recovery path per §18 table.

### 10.9 Mid-setup interruption drill
- Kill Claude Code mid-prompt-1 at section 4 (credentials)
- Reopen, run `/sdlc:brownfield`
- Verify: shepherd resumes from section 4, completes remaining sections, then continues to task flow

### 10.10 Mode-detection guard
- Run `/sdlc:run` in a non-empty repo → assert refusal with expected message
- Run `/sdlc:brownfield` in an empty folder → assert works or clear-message defer

### 10.11 Non-git-folder refusal
- Run `/sdlc:brownfield` in a folder without `.git` → assert refusal with git-init guidance

### 10.12 CLAUDE.md `@import` hop-budget (B6)
- Pre-seed CLAUDE.md with 3 levels of imports
- Assert session-hydrate prints the fallback message; doesn't create a broken 5-hop chain

### 10.13 Regulated-repo warning
- Temp repo with `SECURITY.md` and `HIPAA/` folder
- Assert Gate 0 prints the regulated-repo warning verbatim

### 10.14 Cleanup
- `/plugin uninstall`
- `scripts/brownfield-cleanup.mjs`
- Confirm zero footprint outside expected paths (v1.5 also removes CLAUDE.md `@import` line)

---

## 11. Definition of Done

- All 19 sub-tasks (§7) complete
- All acceptance criteria per sub-task met
- Verification plan (§10, 14 items) passes
- All 8 files created + 14 files edited per §8 / §9
- 6 docs published under `docs/`
- 6 example repos runnable end-to-end
- Plan file self-review resolutions (§20 Bucket A must-fix) all applied — see plan for the 11-item list
- `README.md` updated with Greenfield vs Brownfield section
- `SETUP.md` rewritten as shepherd contract
- **Contract: no hidden state; every failure user-visible** (§18 principle)
- **Contract: `rm -rf .sdlc/` leaves zero plugin footprint** (uninstall clean)
- **Contract: no call-home telemetry ever** (§19)
- Greenfield mode continues to work unchanged (regression test the shipped `/sdlc:run` example)

---

## 12. Non-goals for this ticket

Every item in §6 (Out of scope). Break each into separate tickets when scheduled — v1.5 tickets should reference this one as parent.

Specifically: **do not** implement `/sdlc-precheck`, `/sdlc-doctor`, `/sdlc-init-team-config`, `/sdlc-resume`, `/sdlc-audit`, `/sdlc-support-bundle` in v1 — all deferred per D5 (two-prompt UX contract) or v1.5 (§14.12).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Write contract has a bug and a file gets overwritten | Three-layer defense (prompt / packet validator / hook); backup-at-write-time enables `/sdlc:revert` recovery |
| Adaptive stack profile misclassifies a custom framework | User confirms at Gate 0; profile refreshable; falls back to generic if no useful patterns found |
| Users have unusual credential setups we don't cover | Discovery scans 9+ locations per provider; shepherd offers 3 options; explicit skip path with clear consequence |
| Monorepo detection wrong → tests run on wrong package | User confirms package scope at Gate 0; per-package test command from discovery |
| Cost runaway on very large repo | Hard cap in policy YAML (default $50); aborts cleanly |
| Session dies mid-setup, next session hangs on incomplete state | Setup-status.json persisted per section; auto-resume shepherd on next command |
| Plugin conflict with another plugin using same command names | Detected at prompt 1 section 2; user resolves before proceeding |

---

## 14. References

- **Full engineering design:** `~/.claude/plans/now-since-this-repo-cryptic-hartmanis.md` (26 sections, ~4,500 lines)
- **Companion visual walkthroughs:** four HTMLs in `~/Downloads/brownfield-plugin-walkthroughs/` (01-overview, 02-gate0-pipeline-report, 03-repos-sessions-orchestration, 04-setup-precheck-robustness)
- **Tech-lead executive proposal:** `brownfield-tech-leads.html`
- **Claude Code platform research:** conducted mid-design via the `claude-code-guide` agent — findings integrated into §14 and §26 of the plan
