# Brownfield Mode for the AI-SDLC Orchestrator Plugin

## TL;DR

- **What.** Extend this Claude Code plugin from "generates a new app from a brief in an empty folder" to "installs onto any existing repo and does one of seven kinds of work (docs / bugfix / feature-extend / feature-new / refactor / test / deps) safely, across many sessions, without touching anything the user didn't approve."
- **Why.** Every install doc today says "open Claude Code in an empty folder." Real users have real repos with real conventions, real AI tools already in place (Cursor / Aider / Copilot / their own MCP servers), real CI, real teammates. The plugin as it stands is a demo, not a product.
- **How.** A new `/sdlc:brownfield` command runs a tiered discovery (~10 s), presents one Gate 0 confirmation, then routes into an intent-conditional pipeline that reuses most of the existing machinery. A non-destructive write contract enforced at three layers (prompt / packet validator / PreToolUse hook) guarantees off-limits files (theirs and ours) are never touched. Multi-session machinery (ledger, provenance, resume, staleness detection) makes the second and Nth session on the same project safe and coherent.
- **All decisions locked.** V1 = 7 intents (no separate review command — review deferred to v2 as it's a different product category from safely-changing-code) + all §14 must-haves + **adaptive stack profile** (§21) + **pipeline pre-check with max-scope robustness** (§22) + **two-prompt UX contract** (§23) + **explicit model-per-task routing docs** (§24) + **setup shepherd behavior** (§25) + **credential discovery "check first, ask second"** (§26). Discovery = tiered (Tier 1 / Tier 2 at Gate 0 / Tier 2b adaptive profile / Tier 3 on-demand). Safety: write-contract hook **hard block by default**; git-dirty **blocks when `commit_strategy != none`**. Stack adapters: **generic + nest + python** as baselines, adaptive profile as primary quality mechanism. All 15 setup-time robustness issues handled ("handle ≠ solve" principle). Prompt 1 shepherds interactively (auto-do / pause-and-guide / verify); credentials discovered across shell env, gcloud, home dir configs, shell rc files, and repo scan before ever asking user to set up fresh; headless mode for CI exits with clear log on any guide-needed step.

---

## Contents

**Part I — Foundations**
- [Context — why brownfield](#context--why-brownfield)
- [The user journey](#the-user-journey)
- [End-to-end state machine](#end-to-end-state-machine)
- [V1 scope — locked](#v1-scope--locked)

**Part II — The one-run pipeline**
- [§1 Entry point & command shape](#1--entry-point--command-shape)
- [§2 Discovery — tiered model](#2--discovery--tiered-model)
- [§3 Gate 0 — discovery confirmation](#3--gate-0--discovery-confirmation)
- [§4 Non-destructive write contract](#4--non-destructive-write-contract-the-crown-jewel)
- [§5 Intent routing](#5--intent-routing)
- [§6 Adapted / new artifacts](#6--adapted--new-artifacts)
- [§7 Task-type expansion & stack-adapter layer](#7--task-type-expansion--stack-adapter-layer)
- [§15 File placement and layout](#15--file-placement-and-layout-in-a-brownfield-repo)
- [§8 Architect & reviewer changes](#8--architect--reviewer-changes)
- [§9 Testing changes](#9--testing-changes)
- [§11 Policy & telemetry](#11--policy--telemetry)

**Part III — Multi-session & Team (§14)**
- [Claude Code primitives we lean on](#claude-code-primitives-we-lean-on-from-session-mechanics-research)
- [§14.1 Project state model](#141--project-state-model)
- [§14.2 Multi-run layout + SDLC ledger](#142--multi-run-layout-and-the-sdlc-ledger)
- [§14.3 Session-start UX + CLAUDE.md](#143--session-start-ux-and-claudemd-updates)
- [§14.4 Staleness + incremental discovery](#144--staleness-detection-and-incremental-discovery)
- [§14.5 Git workflow contract](#145--git-workflow-contract)
- [§14.6 Rollback, resume, recovery](#146--rollback-resume-and-recovery)
- [§14.7 Headless / CI mode](#147--headless--ci-mode)
- [§14.8 Coexistence baseline](#148--coexistence-contract-with-other-tools)
- [§14.9 Provenance, audit, cost](#149--provenance-audit-and-cost-tracking)
- [§14.10 Versioning + state migration](#1410--plugin-versioning-and-state-migration)
- [§14.11 Observability + debugging](#1411--observability-and-debugging)

**Part IV — Cross-cutting concerns**
- [§16 Existing AI tooling coexistence (deep)](#16--existing-ai-tooling-coexistence-deep)
- [§17 Team & permissions model](#17--team--permissions-model)
- [§18 Failure & recovery scenarios](#18--failure--recovery-scenarios)
- [§19 Data, privacy, compliance](#19--data-privacy-compliance)

**Part V — Reference & backlog**
- [§13 Full use-case taxonomy](#13--brownfield-use-case-taxonomy-what-production-teams-actually-do)
- [§12 Docs & examples to ship](#12--docs--examples)
- [Files to change / add](#files-to-change--add--summary)
- [Verification plan](#verification-plan)
- [Consolidated backlog — v1 / v1.5 / v2](#consolidated-backlog--v1--v15--v2)

**[Open decisions](#open-questions--decisions-to-lock)**

---

# Part I — Foundations

## Context — why brownfield

The plugin today (`sdlc@tilicho-ai-labs`) runs a nine-phase greenfield pipeline that assumes an empty folder — it reads a `brief.md`, writes fresh code to `./src`, hard-codes NestJS+Prisma task types, and never inspects the target repo. Every install doc says "open Claude Code in an empty folder."

The new requirement is to install the plugin on an **existing** project — any stack, unknown pre-existing configuration (they may already use Claude Code, Gemini, Cursor, or a custom agent setup) — and use it for open-ended brownfield work: documentation, bug fixes, extending an existing feature, adding a new feature, or one-off tasks we haven't thought of yet.

Two hard constraints from the platform research (all sourced from code.claude.com/docs): Claude Code plugins coexist with user `.claude/` config and are namespaced, so we don't clobber anything by default. But the platform gives **no built-in diff-before-write, no backup, no rollback, no API to enumerate installed plugins/MCP servers**. Any brownfield safety is the plugin's own responsibility, enforced in prompts and optionally in a PreToolUse hook.

Intended outcome: a user can drop this plugin into a real repo, run `/sdlc:brownfield`, and get one of several work products (docs / bugfix / feature / refactor / test / deps) with a hard guarantee that nothing outside a confirmed file-scope was touched, and that their existing AI/tooling configuration was never modified without them re-opening a gate.

---

## The user journey

One command: `/sdlc:brownfield`. The wizard is the product surface; everything downstream is invisible. What the user sees:

1. **Setup check** — same `verify-setup.mjs` as greenfield, plus a git-clean check (brownfield needs a rollback anchor).
2. **Discovery** (~10 s with the tiered model, §2) — "reading your repo." Produces a one-page `discovery.md`.
3. **Gate 0 — Confirm discovery.** One prompt, five confirmations: stack, test command, existing-AI-setup coexistence (default: off-limits), intent, file scope. Approve / revise / abort.
4. **Intent brief** — the wizard writes a short `intent_brief.md` tailored to the chosen intent. Sections shrink or expand based on intent; a "docs" run doesn't ask for role matrices.
5. **The pipeline runs** — same gates 1–4 as greenfield, but many phases short-circuit for lighter intents (e.g. docs skips architect; security-review reads only changed files).
6. **Report** — same shape as today, plus a "files touched vs off-limits" section that proves the write contract held.

The user should be able to try this, hate it, `/plugin uninstall`, delete `.sdlc/`, and leave zero footprint elsewhere.

---

## End-to-end state machine

Insert two new states before the existing greenfield flow, gate them, then reuse most of what's already there:

```
-1. preflight_dispatch      (unchanged)
 0. discover_repo           → discovery.md + baseline pointers               [NEW]
    ── GATE 0 ──                                                              [NEW]
 0b. intent_router           → sets run.intent, gates downstream phases       [NEW]
 0c. read_intent_brief       (replaces read_brief on brownfield path)         [NEW/renamed]
 1.  requirements_analysis   (scoped by intent — docs & bugfix are terse)
    ── GATE 1 ──
 2.  architecture_design     (SKIPPED for docs & most bugfix; PRODUCES change_plan.md for feature-extend)
    ── GATE 2 ──             (SKIPPED when phase 2 skipped)
 3.  cache_project_header    (unchanged)
 4.  plan_task_packets       (uses stack-adapter layer + baseline to pick task types)
 5.  execute_packets         (write-contract enforced — see §4)
 6.  senior_code_review      (diffs against baseline SHAs, not full-module walk)
 7.  test_run                (uses discovered test_command, never overwrites .env)
 8.  security_review         (findings tagged origin: new | pre-existing)
    ── GATE 3 ──             (only "new" findings block by default)
 9.  generate_final_report   (adds files-touched vs off-limits proof)
    ── GATE 4 ──
```

Greenfield mode continues to work — the state machine picks the greenfield path when `mode: greenfield`.

---

## V1 scope — locked

Locked as of this design pass:

- **Intent count:** 7 (`docs, bugfix, feature-extend, feature-new, refactor, test, deps`). Covers ~70% of the §13 taxonomy. A read-only "review" capability is deferred to v2 (different product category — competes with existing code-review tools; not core to safely-changing-code).
- **§14 v1 must-haves:** all seven (project state model, ledger, staleness detection, git contract, provenance + `/sdlc:revert`, coexistence enforcement, versioned state). Without them, session 2 on the same project is dangerous.
- **Discovery model:** tiered (Tier 1 always ~10 s / Tier 2 confirm at Gate 0 / Tier 3 on-demand). Replaces the original 60–90 s pre-scan.

Still open (see [Open decisions](#open-questions--decisions-to-lock)):
- Safety defaults — hard block vs soft warning for file-write hook and git-dirty check.
- Stack adapters in v1 — generic + nest + python recommended.

Explicitly out of scope for v1:
- Codebase Q&A / explain (deferred to the existing `understand-anything` plugin).
- Performance-investigation intent (v2 — needs profiler integration).
- Large-migration intent (framework/runtime/monolith split — needs multi-pass state).
- Any per-machine database. File-based only, always.
- Call-home telemetry. Ever.

---

# Part II — The one-run pipeline

## §1 — Entry point & command shape

**One new `/sdlc:brownfield` command + a shared `mode: greenfield|brownfield` field on the orchestrator's inputs.** Not a `--mode` flag on `/sdlc:run` — the wizards diverge too much (`run.md:31-71` searches for `# Project Brief`-headed files in an empty folder, which is nonsense for a repo with a real README). Not per-intent commands (`/sdlc-doc`, `/sdlc-bugfix`) — the intent belongs *inside* the brownfield flow and duplicating pre-flight+discovery+gates across 4-5 commands is a maintenance trap.

**Mode detection guard on `/sdlc:run`** (A2 fix): the existing `/sdlc:run` command gains an early check — if `./src` exists OR `.git` exists with any tracked files, print *"This looks like an existing repo — did you mean `/sdlc:brownfield`? Pass `--force-greenfield` to proceed anyway (will only work in `./src` after your confirmation at Gate 0)."* and refuse until the user confirms. Prevents accidental greenfield-run on a real repo.

`/sdlc:pass` grows `--mode brownfield --intent <docs|bugfix|feature-extend|feature-new|refactor|test|deps>` for headless / CI use.

**Note on `/sdlc-review`:** an earlier design pass proposed a read-only PR/diff review command. **Dropped from v1** on the honest read that code review is a different product category from safely-changing-code (competes with CodeQL, Cursor review, GitHub Copilot review, etc.) and isn't core to the plugin's main value prop. Deferred to v2 alongside other review-oriented capabilities (threat model, architecture review). See §6 out-of-scope.

Files:
- New: [plugin/commands/brownfield.md](plugin/commands/brownfield.md)
- Edit: [plugin/commands/run.md](plugin/commands/run.md) — add mode-detection guard (A2)
- Edit: [plugin/commands/pass.md](plugin/commands/pass.md) — add mode/intent flags
- Edit: [plugin/.claude-plugin/plugin.json](plugin/.claude-plugin/plugin.json) — commands dir already loads by convention, no manifest change

---

## §2 — Discovery — tiered model

New subagent [plugin/agents/discovery.md](plugin/agents/discovery.md), tools: `Read, Glob, Grep, Bash`. Runs after preflight, before Gate 0. Uses the built-in `Read` tool so it can scan arbitrary files without per-file permission prompts (confirmed via Claude Code docs).

The heavy pre-discovery originally sketched was over-engineering. The tiered model gives the same safety guarantees with much lighter first-run cost.

**Precondition (A3 fix):** if `.git` doesn't exist at repo root, discovery refuses with a clear message: *"Brownfield mode needs git for rollback anchors. Run `git init && git add -A && git commit -m 'baseline'`, then re-run `/sdlc:brownfield`."* Not offering to auto-init — too destructive.

**Bash-permission (A9 fix):** discovery uses `Bash(git *)`. In interactive mode Claude Code prompts on first use; in CI mode users must pre-allow via `.claude/settings.json`: `{"permissions": {"allow": ["Bash(git *)"]}}`. Shipped `plugin/templates/settings-ci-fragment.json` provides this; `docs/brownfield-ci.md` documents it.

**Tier 1 — Minimum viable discovery (always runs, ~10 s):**
- `git rev-parse HEAD`, `git status -sb` — rollback anchor + dirty check.
- Read the stack manifest at repo root (`package.json`, `pyproject.toml`, `go.mod` — whichever exists).
- Read `CLAUDE.md` at repo root if present (users often put stack + conventions here).
- Read `.gitignore` (needed by the write contract).
- Grep for competing AI configs: `.cursor/`, `.mcp.json`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, existing `routing-policy.yaml`. **Presence detection only in v1** (per C7 cut) — no deep parse. Deep parsing (glob-intersection warnings for Cursor, auto-commit warning for Aider) is v1.5.
- Detect monorepo signals (see §15).
- Detect git submodules (from `.gitmodules`). Per B2: v1 treats submodules as opaque (never touched); warn at Gate 0.

**Tier 2 — Ask the user at Gate 0 (not scan):**
- Test command — surface what we detected in npm scripts / pyproject / Makefile; ask them to confirm/paste.
- File scope allowlist — propose based on intent brief + detected layout; let them edit.
- Off-limits confirmation — show competing AI configs we found (default OFF-LIMITS).
- Intent selection.
- Layout samples (see §15) — for docs, tests, and new-file placement, show a proposed location per intent-brief item; user confirms or adjusts.

**Tier 3 — On-demand during packets (not upfront):**
- File-level SHAs recorded only for files a packet is about to write to — `sha_before` at write time, `sha_after` after. Rollback (§14.6) uses these + git diff, no upfront hash pass.
- Deeper source topology (call sites, dep graph) discovered by the packet planner subagent via `Grep` when it needs them.
- Monorepo test-scope refinement — done by the first packet that needs it.

**Outputs (A1 naming fix):**
- `.sdlc/runs/<id>/discovery.md` — human-readable per-run snapshot, sections mirror Tier 1 read groups, plus `## Detected stacks`, `## Detected AI/agent setup`, `## Coexistence risks`, `## Proposed file-scope allowlist`.
- `.sdlc/runs/<id>/baseline.json` — per-run pointer snapshot (git_head, mtimes, monorepo layout, off-limits). No pre-computed SHAs.
- `.sdlc/baseline/current.json` — living project-wide baseline, updated by staleness detection (§14.4). Committed. Persists across runs.
- `.sdlc/baseline/discovery.md` — living human-readable baseline. Committed.

**Silent-policy-override risk (critical).** `plugin/mcp/gemini-flash-server/src/policy.ts:26-31` already respects a repo-local `routing-policy.yaml`. Brownfield repos may well have one, and today the plugin would silently honor it. Discovery must surface this at Gate 0: "This repo ships `routing-policy.yaml` at `<path>`; we will honor it. Confirm or override with `--policy <name>`."

**What we lose vs a heavy pre-scan:** the elegant "here's everything we know about your repo" Gate 0 dump. **What we gain:** ~10 s first-run discovery instead of 60–90 s, and much less code to maintain.

---

## §3 — Gate 0 — discovery confirmation

Template lives with the other gate templates in [plugin/skills/run-ai-sdlc/SKILL.md](plugin/skills/run-ai-sdlc/SKILL.md) near line 199. Shape:

> ⏸ **HITL Gate 0 — Discovery Confirmation**
> I read your repo and produced `discovery.md`. Confirm:
> - **Stack:** \<top-detected\> — correct? add/override?
> - **Test command:** `<detected or "unknown">` — enter to accept, or paste the command.
> - **Existing AI setup:** \<verbatim list from Tier 1\> — is any of this authoritative and off-limits? **(default: OFF-LIMITS, do not touch)**
> - **Intent:** `docs | bugfix | feature-extend | feature-new | refactor | test | deps | other:<free-text>`
> - **File scope:** proposed allowlist `<paths>` and off-limits `<paths>` — accept / edit / expand
> Reply: `approved`, `revise: <comments>`, or `abort`.

The gate output is the **authoritative source** for the write contract (§4) and task-type routing (§7). Nothing may write outside the confirmed allowlist without a new Gate 0 pass.

**Non-obvious risk:** default the AI-coexistence answer to "off-limits." A user who hits `approved` without reading must not accidentally authorize us to rewrite their `.cursor/rules` or their custom `routing-policy.yaml`.

**Subagent → main-loop bubble-up (A4 fix).** Orchestrator is a Claude Code subagent; subagents can't run interactive dialogs on their own. The gate rendering pattern is: the orchestrator returns a specifically-shaped message (fenced `⏸ HITL Gate` block, structured as above), the main-loop session displays it verbatim to the user and waits for input, then re-invokes the orchestrator subagent with `{gate_response: "approved" | "revise: <text>" | "abort"}` as an argument. The state machine's checkpoint (§14.6) is written *before* the message is emitted, so if the user quits or the session dies mid-gate, session-hydrate detects the pending gate and re-prompts on next session. Documented in `plugin/skills/run-ai-sdlc/SKILL.md` alongside the gate templates.

---

## §4 — Non-destructive write contract (the crown jewel)

**Rule:** the orchestrator may not write to any path unless (a) the path is in the confirmed allowlist, OR (b) the path did not exist at discovery time, OR (c) the user re-opened Gate 0 to expand scope. Off-limits paths are hard-rejected before any dispatch.

**Enforcement — three layers, honestly labeled (A6 fix):**

1. **Orchestrator prompt gate — SOFT.** [plugin/agents/orchestrator.md](plugin/agents/orchestrator.md) gains a "Write gate" section: before every `Write`/`Edit`, resolve target against `allowlist`/`off_limits`. Also: the orchestrator prompt is amended to *forbid raw `Write`/`Edit` calls outside a packet* — every write must originate from a validated packet. This is instruction-based; the AI may drift.
2. **Packet-validator — SCHEMA-LEVEL.** Packet planner in Phase 4 rejects any packet whose `artifact_path` is off-limits. Schema check in [plugin/mcp/gemini-flash-server/src/types.ts](plugin/mcp/gemini-flash-server/src/types.ts) validates `TaskPacket.artifact_path` against the manifest before dispatch. Catches planned writes; doesn't catch ad-hoc writes the orchestrator makes outside packets.
3. **PreToolUse hook — HARD (the only unbreakable layer).** [plugin/hooks/hooks.json](plugin/hooks/hooks.json) gains a `PreToolUse` matcher on `Write|Edit` that shells out to a small script checking the target against the confirmed allowlist. Claude Code merges hook results with `deny > defer > ask > allow` — this is the last line of defense that survives even if the orchestrator prompt drifts. **Recommend default-on for brownfield mode** (open decision).

**Merge semantics for sensitive files** (deep-merge, never overwrite):
- `package.json` — add missing deps/scripts, never remove or downgrade; new script names must not shadow existing.
- `.env` / `.env.example` — append missing keys only; never rewrite existing values; **never `cp .env.test .env` when `.env` exists** (bug in `SKILL.md:161` today).
- `CLAUDE.md`, `.claude/settings.json`, `.mcp.json` — read → parse → deep-merge → write, with the diff shown at a mini-gate.
- `routing-policy.yaml` — **never touched** if pre-existing (Gate 0 already surfaces this).
- `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md` — default off-limits; only editable if user explicitly moved them into allowlist at Gate 0.

**Diff-preview mini-gate.** Any packet targeting a file that existed at discovery time returns a unified diff; the orchestrator shows it inline and asks approve/revise before writing. This is the concrete answer to "we don't know how they use Gemini" — even if discovery misclassified their config, they see the diff before it lands.

---

## §5 — Intent routing

Not separate playbooks — the gates, telemetry, policy, and preflight are 90% identical across intents. An `intent` field on the run context selects which phases execute:

| Phase | docs | bugfix | feature-extend | feature-new | refactor | test | deps |
|---|---|---|---|---|---|---|---|
| requirements | scoped ("what docs?") | reproduce + diagnose | delta requirements | new-feature requirements | delta (what to preserve) | coverage target | upgrade target list |
| architecture (architect) | SKIP | SKIP unless design-affecting | delta `change_plan.md` | full design (subsystem) | delta refactor plan | SKIP | dep-swap plan |
| plan_task_packets | doc_addition / doc_update | bug_reproduce → bug_diagnose → bug_fix_apply | mixed edit+add | full mix | refactor_extract + patch_apply | test_backfill / test_add | dependency_add + regression |
| test_run | doc-lint only | regression + focused | affected suites | affected + new | full suite (invariants) | new tests + full | full + smoke |
| security_review | changed files only | changed files only | changed files only | changed files only | changed files only | test files only | dep-diff + advisory |

Add an `## Intent matrix` section to `SKILL.md`. The orchestrator branches on `intent` before Phase 2 and Phase 7.

**v1 realism (C6 cut):** the four "known" intents (`docs`, `bugfix`, `feature-extend`, `feature-new`) get fully-specified matrix cells derived from the existing greenfield behavior. The three "new" intents (`refactor`, `test`, `deps`) route to the closest-fitting known behavior in v1, with intent-specific prompt overrides in v1.5. This means v1 ships all seven intents (surface-complete) with the last three at 70% of full-specialized quality; v1.5 tightens them.

---

## §6 — Adapted / new artifacts

- **`intent_brief.md`** (replaces `brief.md` on the brownfield path). Written by the wizard. Heading contract:
  ```
  # Intent Brief — <intent> — <short title>
  ## Context
  ## Goal
  ## Files in scope (from Gate 0)
  ## Files off-limits (from Gate 0)
  ## Acceptance criteria
  ## Non-goals
  ```
- **`discovery.md`** — §2 output.
- **`baseline.json`** — §2 output. Consumed by architect, senior-reviewer, security-reviewer, packet validator.
- **`change_plan.md`** — replaces `design.md` for bugfix / feature-extend / refactor / deps. Delta document: modified files, added files, removed files, per-file rationale.
- **Final report** gains a `## Write-contract audit` section: files touched, files spared, files off-limits — provable via SHA compare against per-file `sha_before`/`sha_after` in provenance.

---

## §7 — Task-type expansion & stack-adapter layer

**Problem:** current NestJS-locked enum ([SKILL.md:105-127](plugin/skills/run-ai-sdlc/SKILL.md#L105)) breaks the moment we hit a Django or Go repo.

**A. Stack-agnostic base task types** (all stacks): `existing_file_edit`, `patch_apply`, `new_file_add`, `doc_addition`, `doc_update`, `test_backfill`, `test_add`, `bug_reproduce`, `bug_diagnose`, `bug_fix_apply`, `refactor_extract`, `dependency_add`. Policy rules match on these primitives, not on framework specifics.

**B. Stack-specific `subtype` field** on TaskPacket (e.g., `task_type: new_file_add, subtype: nest_controller`). Adapters live in `plugin/skills/run-ai-sdlc/stacks/{nest,django,fastapi,go,rails,generic}.md` — each is a prompt fragment loaded by the packet planner based on the discovered stack. Defaults to `generic.md` when unknown.

**C. Framework-owned wiring task types** (see §15): `module_wiring` (Nest), `url_registration` (Django), `router_wiring` (FastAPI) — one per framework where placement has a side-effect.

Files:
- New: `plugin/skills/run-ai-sdlc/stacks/*.md` (at least `generic.md`, `nest.md`, and per open decision `python.md` for v1)
- Edit: [plugin/mcp/gemini-flash-server/src/types.ts](plugin/mcp/gemini-flash-server/src/types.ts) — add optional `subtype?: string` to `TaskPacket` (backwards-compatible)
- Edit: [plugin/skills/run-ai-sdlc/SKILL.md](plugin/skills/run-ai-sdlc/SKILL.md) — rewrite the Phase 4 task-type table

---

## §15 — File placement and layout in a brownfield repo

The greenfield assumption (`code_dir = ./src`, everything lands there) breaks the moment we're in a real repo. Real repos have opinions about where new code lives, and those opinions vary by stack, by framework, by team convention, by monorepo tool, by domain layout. This section enumerates every placement decision the plugin must make in brownfield mode.

### The placement decision matrix

| Category | What we're deciding | How we decide it |
|---|---|---|
| **A. Where NEW source files go** | "The new controller for `payments` — which folder?" | Discovery detects the existing layout (`src/modules/*/`, `apps/api/src/`, `packages/*/src/`); packet planner proposes locations following the pattern; user confirms at Gate 0 as part of the file-scope allowlist. |
| **B. Framework-owned locations** | "Where does the router go in Django?" | Stack adapter (§7) encodes framework conventions — each adapter has a `## Placement rules` section. |
| **C. Naming & conformance** | "camelCase or snake_case? `.ts` or `.tsx`?" | Discovery samples existing files with a `Glob` on the target dir; stack adapter tells codegen to follow the sample. |
| **D. Off-limits placement** | Generated code, vendored deps, build artifacts | Auto-off-limits when discovery detects: `// GENERATED` / `# generated by` markers, `vendor/`, `third_party/`, `dist/`, `build/`, `.next/`, `target/`, `node_modules/`; also anything in `.gitignore`. |
| **E. Plugin's own output** | Where does `.sdlc/` live in a monorepo? | Always at repo root (the git root). Per-package runs record `scope: apps/api` in the run record but the `.sdlc/` directory is single and unified. |
| **F. Test file placement** | Co-located `foo.test.ts` vs `__tests__/foo.test.ts` vs `tests/test_foo.py` | Discovery samples existing test locations relative to sources; codegen mirrors the pattern. |
| **G. Doc file placement** | `docs/` at root vs per-package `README.md` vs `wiki/` vs external | Discovery samples existing doc placement; docs intent asks at Gate 0. |
| **H. Migration / schema placement** | Prisma vs Django vs Alembic vs Rails — each has different conventions | Detected by ORM presence; stack adapter has strict placement rules; migration numbering follows the detected scheme (timestamp vs sequential). |
| **I. Package manifest updates** | Which `package.json` / `pyproject.toml` gets the new dep in a monorepo? | Determined by which package's source is being modified; unclear cases raise a mini-gate. |
| **J. Env / config placement** | Repo root `.env` vs per-app `.env` vs external secrets manager | Never overwrite. Only append to `.env.example` at the discovered location. If external secrets manager detected (Doppler, Vault, AWS SM), skip `.env` work and print instructions for the operator. |

### Monorepo — the biggest complicator

Detection signals (during Tier 1 discovery):
- `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, `lerna.json`, `rush.json`
- Multiple `package.json` files at depth 2-3 outside `node_modules/`
- `apps/`, `packages/`, `services/`, `libs/` top-level folders with sub-packages

Behavior when detected:
- Gate 0 asks: "which package(s) is this intent scoped to?" (or "all packages" for cross-cutting work).
- File-scope allowlist scoped to those packages. Off-limits explicitly includes all other packages.
- Test command runs per-package (`pnpm --filter <pkg> test`, `nx test <pkg>`, `turbo run test --filter=<pkg>`), not root.
- `provenance.json` records `scope: [packages/x, apps/api]` for cross-package audits.
- Package manifest updates target the correct sub-package's manifest, not root.

### Framework-owned side effects

Some placements ARE the framework contract — you can't just drop a file:
- **Nest** — new controller must be added to a Module's `controllers: [...]`. Stack adapter includes a `module_wiring` task-type that patches the module file.
- **Django** — new view must be registered in `urls.py`. Stack adapter includes a `url_registration` task-type.
- **FastAPI** — new router must be `include_router`'d in the app. Stack adapter includes a `router_wiring` task-type.
- **Rails** — convention-over-configuration; naming = registration. Stack adapter enforces naming.
- **Next.js** — file location IS the route. Stack adapter maps intent to file location deterministically.

These become **paired packets** in the planner: `new_file_add` + `module_wiring` executed atomically. If the wiring fails, the new file is rolled back within the same packet.

### Sample Gate 0 placement preview

Real Gate 0 for a `feature-extend` intent on a Turborepo monorepo:

> **Detected layout:** Turborepo monorepo, 4 packages, TypeScript.
> **Intent scope:** `apps/api` — is this right? or expand?
> **Proposed new files:**
> - `apps/api/src/modules/webhooks/webhook.controller.ts`
> - `apps/api/src/modules/webhooks/webhook.service.ts`
> - `apps/api/src/modules/webhooks/webhook.module.ts`
>
> **Existing files to edit:** `apps/api/src/app.module.ts` (register the new module)
> **Test files:** `apps/api/src/modules/webhooks/__tests__/webhook.controller.spec.ts` (mirroring your existing pattern)
> **Off-limits:** `apps/web/**`, `packages/*/**` (unless expanded), `.env`, `apps/api/prisma/generated/**` (marked generated)
>
> Approve, revise, or abort.

### What "enforcement" means for placement (A7 fix)

Placement is a **codegen quality concern, not a safety concern**. The stack adapter's placement rules guide the packet planner toward good locations; the write contract (§4) then enforces the **allowlist** the user confirmed at Gate 0. **If the packet planner proposes a badly-placed path that's still inside the allowlist, the write contract will accept it** — placement isn't a safety guarantee, only the allowlist is. This split matters: placement failures (wrong folder, wrong naming) are quality regressions, not safety incidents. Users can catch them at Gate 0's placement preview or at the diff-preview mini-gate.

### From the three roles

**Claude Code architect:** don't invent a new placement DSL. Stack adapter's `## Placement rules` section is a small prompt fragment codegen reads. Packet planner proposes locations; codegen respects them; write contract enforces the allowlist (which contains those locations after Gate 0).

**Product engineer:** the Gate 0 preview above IS the whole placement UX. If the user says "no, put webhooks in `apps/api/src/webhooks/` instead," the plan uses their answer verbatim. Detect and follow, don't force.

**DevOps engineer:** placement decisions must not violate CODEOWNERS, must not write into `.gitignore`d paths, must not touch build/generated dirs, must respect branch protection rules. Every one of these is a Gate 0 or mini-gate concern; safety enforcement lives in the write-contract check (§4), not in placement rules.

---

## §8 — Architect & reviewer changes

- **[plugin/agents/architect.md](plugin/agents/architect.md):** add a `mode: greenfield|brownfield` input. In brownfield mode: consume `baseline.json` + `discovery.md` + `intent_brief.md`, produce `change_plan.md` instead of `design.md`. Replace NestJS-flavored spec at lines 12-16 with stack-parameterized language sourced from the stack adapter fragment.
- **[plugin/agents/senior-reviewer.md](plugin/agents/senior-reviewer.md):** brownfield invocation passes module dir *and* baseline SHAs (from Tier 3 on-demand hashing). Reviewer runs `git diff <baseline_sha> -- <files>` and only flags issues **introduced by the change**; pre-existing smells are "noted, out-of-scope." The env-fixture blocker at line 19 becomes conditional on `intent ∈ (feature-new, feature-extend)` and on the stack having a validating config module.
- **[plugin/agents/security-reviewer.md](plugin/agents/security-reviewer.md):** **v1 (per C5 cut):** review only files touched by this run — full-repo scan deferred. This alone prevents failing a bugfix run because of unrelated CVEs elsewhere. **v1.5:** add `origin: "new" | "pre-existing" | "unclear"` tagging for findings within touched files, so pre-existing smells inside touched files are advisory rather than blocking.

---

## §9 — Testing changes

Replace [SKILL.md:159-163](plugin/skills/run-ai-sdlc/SKILL.md#L159):

1. **Test command source of truth** — Gate-0-confirmed `test_command`. If unknown at Gate 0, orchestrator asks at a mini-gate before Phase 7.
2. **Working directory** — repo root by default, not `code_dir`. In monorepos, discovery emits `test_scopes: [...]` and Phase 7 runs only the scope covering changed files.
3. **Env reconciliation** — never `cp .env.test .env`. If `.env` exists → leave alone; if any *new* required keys were introduced, append them to `.env.example` and print the missing keys to the operator; operator populates `.env` before Phase 7 continues.
4. **Test-command probe (new Phase 0.5, optional).** Preflight proves the model is reachable; it doesn't prove the repo's deps are installed. A dry `--collect-only` / `--dry-run` invocation of `test_command` before spending on packets catches "missing dependency" cheaply.

---

## §11 — Policy & telemetry

- Add `"discovery"` and `"change_plan"` to the closed `Phase` union at [plugin/mcp/gemini-flash-server/src/types.ts:5-16](plugin/mcp/gemini-flash-server/src/types.ts#L5).
- Update shipped policies [opus-only.yaml](plugin/config/policies/opus-only.yaml) and [opus-plus-flash.yaml](plugin/config/policies/opus-plus-flash.yaml) with rules for both new phases. **Discovery is premium**, not mechanical — a wrong stack detection cascades into every downstream packet. The cost saving is not worth the risk.
- Packet planner input tokens balloon on large repos because it now consumes `baseline.json`. Add a manifest-summary step that ranks files by (intent-brief mentions + directory proximity to touched paths) and truncates.

---

# Part III — Multi-session & Team (§14)

Everything in Part I & II makes *one* brownfield run safe and coherent. Part III makes the plugin usable across **many sessions over weeks** on the same real project — with prior runs, team members, CI, existing tools, and an evolving codebase all in play. No state databases, no call-home telemetry, degrades to zero footprint on uninstall.

## Claude Code primitives we lean on (from session-mechanics research)

- **`SessionStart` and `Setup` hooks** fire when a new session opens or resumes — plugin can inject a "you have N prior runs" marker without spamming chat.
- **CLAUDE.md walks up ancestors** and concatenates; **`@path/to/file` imports** work up to 4 hops deep. This means we can own a `.sdlc/CLAUDE-SDLC.md` and have the user's `CLAUDE.md` `@import` it — we update our own file, never touch theirs.
- **Auto-memory** at `~/.claude/projects/<hash>/memory/MEMORY.md` (200 lines / 25KB per session, machine-local, not in git). Plugins can't officially write here — this is Claude's own journal.
- **Transcripts are NOT auto-loaded** across sessions — only `/resume` uses them. Cross-session state is entirely the plugin's responsibility.
- **No native git awareness** in Claude Code — the plugin must observe git state itself.
- **`claude --bare -p` + `--permission-mode auto`** for CI / headless.

## §14.1 — Project state model

All persistent state lives under `.sdlc/` (project-relative). Split by commit-worthiness:

**`.sdlc/` always lives at git repo root (D5 fix)**, even in monorepos. Never per-package.

**Committed (team-shared):**
- `.sdlc/project.json` — canonical project fingerprint: schema version, plugin version bounds, detected stacks, primary `test_command`, team off-limits list, policy override name. Team-authored subset of Gate 0 (§3).
- `.sdlc/policy.yaml` (optional) — team default policy override.
- `.sdlc/ledger.md` and `.sdlc/ledger.json` — append-only roll-up (§14.2).
- `.sdlc/runs/<UTC>-<intent>-<slug>/` — frozen per-run record (holds `baseline.json`, `discovery.md`, `intent_brief.md`, `packets.jsonl`, `provenance.json`, `final_report.md`).
- `.sdlc/baseline/current.json` + `.sdlc/baseline/discovery.md` — living project-wide baseline; refreshed incrementally (§14.4).
- `.sdlc/CLAUDE-SDLC.md` — the plugin-owned CLAUDE-scoped context (§14.3).

**Gitignored (personal, ephemeral):**
- `.sdlc/local/state.json` — live state machine for current/paused run.
- `.sdlc/local/user-policy.yaml` — personal override.
- `.sdlc/local/budget.json` — per-user cumulative spend.
- `.sdlc/local/cache/` — file SHAs, dep-graph snapshots, computed diffs.
- `.sdlc/local/debug.log`.

Every JSON carries `schema_version: N`. Every run stamps `plugin_version`. Uninstall footprint stays a single `rm -rf .sdlc/`. Shipped `.gitignore` fragment lives at `plugin/templates/gitignore-fragment` and is *offered*, not force-appended, at first-run Gate 0. Plugs into §4: `.sdlc/local/**` is auto-allowlisted; everything else in `.sdlc/` goes through the normal write gate.

## §14.2 — Multi-run layout and the SDLC ledger

Run directory naming: `runs/YYYYMMDD-HHMMSS-<intent>-<8char-slug>/` — sortable, collision-proof, self-describing. Each run holds `intent_brief.md`, `discovery-delta.md`, `change_plan.md`, `packets.jsonl`, `final_report.md`, `write-audit.json`, `provenance.json`, `telemetry.jsonl`.

**`.sdlc/ledger.md`** — append-only, human-readable table: timestamp, intent, branch, HEAD SHA before/after, packet count, files touched, gates passed, outcome, spend, plugin version. Never rewritten. Source for the "you have N prior runs" session summary (§14.3).

**`.sdlc/ledger.json`** — machine mirror consumed by `/sdlc-audit`, `/sdlc-resume`, `/sdlc:revert`.

**Commit split:** `runs/*`, `ledger.*`, `project.json` committed; `local/`, `baseline/` gitignored. Baseline is regenerated per-clone to avoid stale-baseline drift across machines.

**Risk:** `runs/` grows unbounded. **v1: not addressed** (even 100 runs at ~10KB each is 1MB). v1.5: `plugin/scripts/prune-runs.mjs` (keeps last N, default 20). v2: `runs/_archive.tar.gz` for older runs.

**Concurrent runs (C3 cut):** v1 uses a marker file `.sdlc/local/run.marker` with PID + start-time + mtime check; if newer than 10 min, print "another run may be in progress — check PID N, remove marker to override." v1.5 upgrades to a real lock (portable, not POSIX-flock, per B5 fix — likely the `proper-lockfile` npm package or an inline implementation).

## §14.3 — Session-start UX and CLAUDE.md updates

**Session-hydrate is a `SessionStart` hook, not skill-load (A8 fix).** Skills load per trigger word, not once per session — we can't rely on skill-load for the "you have N prior runs" summary. Instead: [plugin/hooks/hooks.json](plugin/hooks/hooks.json) registers `session-hydrate.mjs` on the `SessionStart` event. Hook reads `.sdlc/project.json` + last three `ledger.json` rows — cheap. Emits a single line via the hook's `additionalContext` mechanism: `SDLC: 3 prior runs (last: docs, 2d ago); baseline current; no open resume checkpoint.` No chat noise on plain sessions; no per-skill-trigger churn.

Hook is opt-in in v1 (`.sdlc/project.json` field `hooks.session_start: true`); user consents on the first successful `/sdlc:brownfield` run. Rationale: some users prefer no hooks; opt-in respects that.

On first `/sdlc-*` invocation per session, orchestrator prints a two-line summary; `--summary` expands it. This backup path works even when the hook is off.

**CLAUDE.md updates — the safe way.** Never modify the user's `CLAUDE.md` directly. Instead:
1. First successful run offers to append **one line** to project-root `CLAUDE.md`: `@.sdlc/CLAUDE-SDLC.md` (mini-gate, shown as diff).
2. **Hop-budget check (B6 fix):** session-hydrate walks CLAUDE.md's existing `@`-imports depth-first; if adding our line would push past the 4-hop limit, it prints an alternative: "Add `@.sdlc/CLAUDE-SDLC.md` manually to any CLAUDE.md file that has spare hop budget."
3. Plugin owns `.sdlc/CLAUDE-SDLC.md` entirely. Every subsequent run rewrites it with: canonical `test_command`, off-limits paths, link to `.sdlc/ledger.md`, one-paragraph project summary.
4. Because Claude Code walks `@`-imports up to 4 hops, future sessions (with or without the plugin installed) see the plugin-owned context via the user's CLAUDE.md.
5. **Uninstall (A11 fix):** `scripts/brownfield-cleanup.mjs` strips the `@.sdlc/CLAUDE-SDLC.md` line from CLAUDE.md (with diff preview + confirmation) so no broken import survives.

This flips the CLAUDE.md problem: we never merge into user-owned text; we own our own file and get imported.

## §14.4 — Staleness detection and incremental discovery

Before dispatching Phase 0 on the second and Nth run, [plugin/scripts/discovery-refresh.mjs](plugin/scripts/discovery-refresh.mjs) (invoked by the discovery agent) computes cheap staleness signals:
- `git rev-parse HEAD` vs `baseline.git_head`; `git diff --name-only baseline.git_head..HEAD` for the delta set.
- Stack-manifest mtimes (`package.json`, `pyproject.toml`, etc.) vs recorded values.
- Tracked-file count as a coarse drift indicator.

Incremental refresh re-hashes only the delta set. If a stack manifest changed, re-run only Tier 1 stack-manifest + test-script groups — other groups skipped. Full re-discovery only when: a new language appears, a new AI/agent config file lands, or `.sdlc/policy.yaml` changes.

Presented at Gate 0 as: "Baseline is 4 commits old. Refreshed 12 changed files. New file: `apps/api/src/routes/webhook.ts`. Approve refresh, or force full re-discover?"

**Risk:** git-based drift lies when working-tree changes are uncommitted. Mtime is the safety net — any allowlisted file whose mtime is newer than `baseline.built_at` gets re-hashed regardless of git state.

## §14.5 — Git workflow contract

**Default: work on the operator's current branch. Never auto-create a branch. Never auto-commit. Never auto-open PRs.** Brownfield users have opinions; branching without asking violates the "never touch off-limits" spirit at the workflow layer.

Configurable per-project in `.sdlc/project.json`:
```json
"git": {
  "branch_strategy": "current" | "per-run" | "per-intent",
  "commit_strategy": "none" | "per-gate" | "per-run",
  "pr": "off" | "draft-on-close"
}
```

When `commit_strategy != none`: commit message `sdlc(<intent>/<run-id>): <phase> — <summary>` with a `Sdlc-Run-Id:` trailer, feeding provenance (§14.9). Pre-commit hooks fire normally; plugin never passes `--no-verify`. `pr: draft-on-close` invokes `gh pr create --draft` only if `gh` is authenticated; plugin never authenticates on the user's behalf.

Refuses to run on a dirty tree when `commit_strategy != none` unless `--allow-dirty` — the §2 git-clean check upgrades from advisory to blocking under this configuration.

## §14.6 — Rollback, resume, and recovery

**Provenance per run** at `.sdlc/runs/<id>/provenance.json`: `{files_touched: [{path, existed_before, sha_before, sha_after, tracked_in_git, backup_path, packet_id}], git_head_before, git_head_after, commits: [sha]}`. Written incrementally on every successful `Write`/`Edit` — never held in memory only. SHAs come from Tier 3 on-demand hashing (§2).

**File-state cases (A10 fix) — the four rollback shapes:**

| Case | Signals | Revert action |
|---|---|---|
| Pre-existing, tracked, committed | `existed_before: true, tracked_in_git: true, sha_before: <sha>` | `git checkout <sha_before> -- <path>` |
| Pre-existing, tracked, uncommitted at run start | `existed_before: true, tracked_in_git: true, sha_before: null` | Restore from `backup_path` — `.sdlc/local/cache/<run-id>/<hash>.bak` (plugin copied at write time) |
| Pre-existing, untracked (in working tree but not git) | `existed_before: true, tracked_in_git: false` | Restore from `backup_path` |
| Newly created by this run | `existed_before: false` | `rm <path>` |

Provenance recording writes the `.bak` copy at Write time — before the destructive write happens — so uncommitted work can always be restored.

**`/sdlc:revert <run-id>`** (new [plugin/commands/revert.md](plugin/commands/revert.md)):
1. Read `provenance.json`.
2. Consult later ledger entries + `git log --follow -- <path>` per file to detect subsequent modifications.
3. Clean case → apply the per-case revert action from the table above.
4. Dirty case (subsequent runs touched the same file) → refuse auto-revert, print three-way diffs, hand off.

Same subagent → main-loop bubble-up pattern (§3 A4) applies for the revert confirmation gate.

**`/sdlc-resume`** (new [plugin/commands/sdlc-resume.md](plugin/commands/sdlc-resume.md)). State machine writes `.sdlc/local/state.json` after every phase transition, gate response, and packet. Session-hydrate (§14.3) detects a non-terminal `state.json` and offers resume. **Checkpoint boundaries:** Gate 0, Gate 1, Gate 2, and after every packet in Phase 5. Failed packet leaves state at "packet N, status: failed" — resume retries the same packet, restart advances past it.

## §14.7 — Headless / CI mode

Use Claude Code's `claude --bare -p "<prompt>" --permission-mode auto` for the runner. [plugin/commands/pass.md](plugin/commands/pass.md) grows:
- `--gates auto-approve|auto-abort|prompt` — Gate 0 defaults to `auto-abort` in CI (safer than auto-approve; forces the CI job to be explicit about scope).
- `--from-config .sdlc/project.json` — read gate answers from the committed project config; Gate 0 auto-approves only when the run's fingerprint matches (same stack, same off-limits). Drift → auto-abort with a clear diff.
- `--policy ci-strict.yaml` (new [plugin/config/policies/ci-strict.yaml](plugin/config/policies/ci-strict.yaml)) — no writes without `--allow-write`; security-review blocks on any new finding; hard dispatch caps.

Auth: service account key sourced from `SDLC_CI_KEY` env only, never persisted. `preflight_dispatch` fails fast in CI mode without one.

CI runs write to `.sdlc/runs-ci/` (separate root) and invoke `prune-runs.mjs --keep=5` at close so headless bots don't blow up the repo.

New files: `plugin/config/policies/ci-strict.yaml`, `docs/brownfield-ci.md`, edits to `pass.md` and `verify-setup.mjs`.

## §14.8 — Coexistence contract with other tools

(Baseline — deep coexistence in §16.)

Enshrined in `docs/brownfield-coexistence.md` and enforced in code:
- **`.gitignore` honored.** Discovery skips ignored paths (`git check-ignore` per candidate). Writes into ignored paths refused without explicit Gate 0 override.
- **Formatters / linters:** if the repo has `prettier`, `eslint`, `black`, `ruff`, `gofmt`, etc., plugin runs the *project's own* format command (discovered in Tier 1) on written files before packet close. Ships none of its own.
- **Pre-commit hooks** fire normally through `git commit` when `commit_strategy != none`; plugin never uses `--no-verify`.
- **CODEOWNERS:** discovery parses `.github/CODEOWNERS`; packets targeting files with owners outside the expected scope raise a mini-gate before write.
- **Competing AI configs** (Cursor, Aider, Copilot, competing MCP servers): default off-limits per §4 — surfaced at Gate 0, never touched by default.
- **Existing CI:** plugin never installs workflow files unless the intent asks for it; when it does, it deep-merges into existing files per §4, never replaces.

## §14.9 — Provenance, audit, and cost tracking

Extend `provenance.json` (§14.6) with per-file: `model, phase, tokens_in, tokens_out, cost_usd, git_sha_at_write, plugin_version`.

**`/sdlc-audit`** (new [plugin/commands/sdlc-audit.md](plugin/commands/sdlc-audit.md)) walks `.sdlc/runs/*/provenance.json` → `.sdlc/audit-export.md` + `.sdlc/audit-export.json`: file → runs that touched it → last-touched model → cost → SHAs.

**Cost roll-up.** [plugin/scripts/roll-up-costs.mjs](plugin/scripts/roll-up-costs.mjs) reads all runs → `.sdlc/costs.md`/`costs.json`; updated on every run close.

**Cost estimate at Gate 0 (C4 cut — simpler than a projection mini-gate).** At end of Gate 0, orchestrator prints a one-line estimate from a rough table keyed on (intent × baseline-size bucket): *"Typical cost for a bugfix run on a repo this size: $0.20–$0.80. Approve or abort."* No dedicated gate, no `estimate-cost.mjs` script, no `budget.json` per-user cap in v1. Both real per-user budgets and the cost-projection mini-gate move to v2 (already in backlog).

## §14.10 — Plugin versioning and state migration

**v1 ships the `schema_version` field only (C1 cut).** Every persisted JSON carries `schema_version: 1`. No migrator scaffold, no `plugin/scripts/migrations/` directory, no `migrate-state.mjs` wrapper. When v2 schema actually ships, we add the migrator then; premature scaffold with zero migrators to run adds surface area without value.

State readers do check `schema_version` at read time. If they see an unknown version (from a future plugin version we downgraded from), they refuse the command: *"state on disk is schema N, plugin only knows schema 1 — upgrade plugin or open a support bundle."* Pointer to `/sdlc-support-bundle` (§14.11).

Every run stamps `plugin_version` (read from `plugin/.claude-plugin/plugin.json`). `/sdlc-audit` surfaces version drift across a project's history. Downgrade support (`--downgrade-state`) is v2.

## §14.11 — Observability and debugging

Two levers.

**Debug mode.** `SDLC_DEBUG=1` env or `/sdlc-debug on` writes verbose traces to `.sdlc/local/debug.log`: discovery classification rationale ("classified as node/typescript because package.json.engines.node = 20"), packet planner reasoning, policy dispatch decisions, hook allow/deny outcomes. Every line tagged with `run_id` and `phase`. Rotates at 5 MB.

**Support-bundle export.** `/sdlc-support-bundle` (new [plugin/commands/sdlc-support-bundle.md](plugin/commands/sdlc-support-bundle.md), backed by [plugin/scripts/support-bundle.mjs](plugin/scripts/support-bundle.mjs)) assembles:
- last N runs' `final_report.md`, `write-audit.json`, `provenance.json`, `telemetry.jsonl`
- `project.json`, `policy.yaml`
- `debug.log` tail
- plugin version, Node version, `git log -5`, `git status -sb`

**Redacted**: only env-key names (no values); no file contents; only allowlist/off-limits paths (not their contents). Output: `.sdlc/support-bundle-<ts>.tar.gz`. Doc at `docs/brownfield-support.md`.

---

# Part IV — Cross-cutting concerns

## §16 — Existing AI tooling coexistence (deep)

Tier 1 discovery finds file presence; Gate 0 defaults them to off-limits. That's the surface. Below the surface, real coexistence has more edges.

**Types of coexistence:**
- **Adjacent (independent)** — user has Cursor rules for editor autocomplete, we handle SDLC. Zero conflict.
- **Overlapping (competing)** — user has Aider or a custom Claude-powered script that also generates code. Risk: they run in different sessions and produce diverging code.
- **Layered (nested)** — user's existing Claude Code setup already has MCP servers (e.g. their own Gemini adapter). Namespacing prevents tool-name collision (from the earlier platform research), but the user's routing policy might silently override ours (per the `policy.ts:26-31` precedence).
- **Configured (deep)** — user has a custom `routing-policy.yaml` at repo root. Our policy loader already picks it up. This is *silent override* today — we detect and surface it at Gate 0.

**v1: presence detection + default off-limits (C7 cut).** Discovery detects the presence of `.cursor/`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, `.mcp.json` entries, and `routing-policy.yaml`. Gate 0 lists them and defaults all to OFF-LIMITS. This alone gives the full safety guarantee — the write contract will refuse to touch them.

**v1.5: deep detection (beyond "file exists"):**
- **Cursor** — parse `.cursor/rules/*.mdc` for `globs` frontmatter; if any rule glob intersects the intent's file scope, warn at Gate 0.
- **Aider** — check `.aider.conf.yml` for `auto_commits: true`; if enabled, warn about tangled git history during a plugin run.
- **Copilot** — read `.github/copilot-instructions.md` for length + presence; note at Gate 0 that it will still influence any editor session running alongside.
- **Custom MCP** — read `.mcp.json` and enumerate registered server names; if any name suggests generation (`codegen`, `gemini`, `openai`, `codellama`, `code-`), flag as "possibly generation-capable" — remains off-limits by default.
- **Custom `routing-policy.yaml`** — v1 already surfaces + honors. v1.5 adds "diverges from ours by X" diff at preflight.

**Conflict resolution:**
- Never modify their configs. Ever. The §4 write-contract enforces this.
- If their `routing-policy.yaml` diverges from ours, print the divergence at preflight and let them pick: use theirs, use ours (`--policy=<name>`), or abort.
- If their competing tool would auto-run on our commits (Cursor auto-lint hooks, Aider auto-commit, existing pre-commit hooks that regenerate files), the coexistence doc explicitly warns and offers `--pause-competing` (a `docs/brownfield-coexistence.md` checklist, not an action the plugin performs).

**Sample discovery.md coexistence section:**
```
## Detected AI tooling coexistence
- Cursor rules at .cursor/rules/*.mdc (2 files, scope: src/**/*.ts) — overlapping our intent scope
- Aider config at .aider.conf.yml — auto_commits ENABLED — recommend disable during a run
- Custom MCP server "internal-gemini-adapter" in .mcp.json — off-limits
- routing-policy.yaml at repo root — WILL BE USED instead of shipped policy unless --policy overrides
```

**From the roles:**
- **Architect** — rely on Claude Code namespacing; never overwrite; always surface.
- **PM** — the "we don't know how they use Gemini" concern is fully answered by (detect → off-limits by default → surface at Gate 0).
- **DevOps** — the plugin is a guest in a house that may already have residents. Never rearrange the furniture.

---

## §17 — Team & permissions model

**Roles:**
- **Operator** — the developer running `/sdlc:brownfield` in their session.
- **Reviewer / gate approver** — same as operator in v1 (Claude Code sessions are single-user).
- **CODEOWNERS** — governs merge, surfaced during a run but not enforced.
- **CI / bot** — headless runs (§14.7).

**Who owns `.sdlc/`?**
- **Committed** (`ledger.md`, `runs/*`, `project.json`, `CLAUDE-SDLC.md`, `policy.yaml`) — team-shared, changed via normal PR review.
- **Gitignored** (`local/`) — per-developer, ephemeral.
- **No plugin-level ACL.** Every team member with repo access can run. Access control is delegated to the git host.

**Who can approve gates?**
- Interactive: the person in the session. Full stop.
- Async workflow (v1.5+): operator drafts `intent_brief.md` into `.sdlc/drafts/`, opens a PR, teammate reviews the brief, operator runs after merge. The plugin doesn't enforce; git+PR does.
- CI mode: gates auto-approve only when the run's fingerprint matches `.sdlc/project.json` (which required a human PR to change).

**CODEOWNERS interaction:**
- Discovery parses `.github/CODEOWNERS`.
- Any packet targeting a file with owners outside the operator's declared teams (optional field in `project.json.team_membership`) raises a mini-gate: *"This file is owned by @backend-team; you're on @web-team. Approve the write, or abort."*
- Merge governance stays with GitHub — the plugin surfaces, never enforces.

**Concurrent developers on the same repo:**
- Dev A runs in one worktree, Dev B in another. Each has their own `.sdlc/local/state.json`. `local/run.lock` (POSIX flock) prevents two runs in the same working tree.
- Dev B pulls Dev A's branch → sees `.sdlc/runs/*` and `.sdlc/ledger.md` update in the diff → session-hydrate shows the new prior runs at Dev B's next session. No conflict.
- Two devs running same intent on different branches → each has their own runs entries; merge can produce a natural conflict on the append-only `ledger.md`. Recommend: coordinate scope, or ledger becomes append-only-with-line-based-merge (accept both sides).

**Team-authored config:**
- `.sdlc/project.json` — committed team fingerprint (stack, test command, team off-limits, team policy). Change via PR.
- `.sdlc/policy.yaml` — optional team policy override. Same.
- CI gates auto-approve only when the current run's fingerprint matches these committed files (§14.7).

**From the roles:**
- **Architect** — don't build an ACL system. Git + PR review IS the permission model.
- **PM** — single-user interactive is fine for v1. Async collaboration is a v2 conversation.
- **DevOps** — CODEOWNERS surfaced, not enforced. CI gates use committed fingerprint. Enough for a v1.

---

## §18 — Failure & recovery scenarios

Every non-happy path — what's on disk, how the next session recovers. Contract: **the plugin never silently fixes state.** Every recovery is user-visible and user-approved.

| # | Scenario | On-disk state | Recovery |
|---|---|---|---|
| 1 | Crash mid-packet (Node dies, OS kills, Claude Code quits) | `local/state.json` last-written pre-crash; `runs/<id>/packets.jsonl` has partial log | `/sdlc-resume` detects `status: in_progress`; offers "retry packet N" or "skip and continue" |
| 2 | Model returns garbage / schema mismatch | Retry logic in `execute_with_model`: 2x mechanical → escalate premium → mark failed | User revises the packet's `instruction` at a mini-gate, or skips |
| 3 | Tests fail after codegen packet | Phase 7 parses failure, builds debug packet, retries; after 2 retries + premium fail, HALT with error | User picks: revise, fix by hand + resume, or abort. Nothing silently rolled back |
| 4 | Disk full mid-run | ENOSPC surfaces immediately; state.json may be truncated | Migrator (§14.10) detects malformed state, refuses to resume, prints `.bak` restore instructions |
| 5 | Network drop mid-dispatch | Adapter backs off, retries; full outage → packet marked `failed: network` | User retries same-run or resumes in later session |
| 6 | User quits Claude Code mid-gate | `state.json` says `gate_pending: N`; response never persisted | Next session detects unanswered gate; re-prompts |
| 7 | Git state changed between sessions (rebase, force-push, branch-switch) | `baseline.git_head` no longer matches / unreachable | If ancestor: offer baseline re-establish. If unreachable: refuse resume, force Gate 0 to rebuild baseline |
| 8 | `package.json` changed mid-run (external push) | Baseline mtime check catches it | Halt: "stack manifest changed since run started; packet plan may be invalid. Abort or force continue?" |
| 9 | Two packets write to same file | Planner enforces unique `artifact_path` per run | Runtime double-write fails second, surfaces as a plan bug + user gate |
| 10 | `.sdlc/` corrupted (invalid JSON, missing files) | Every reader wraps in try/catch → migrator → if migration fails, refuse | Message: "state is corrupt at `<path>`; run `/sdlc-support-bundle` for diagnostics" |
| 11 | Rollback fails (git-checkout error, subsequent work built on top) | `/sdlc:revert` refuses in dirty cases | Prints three-way diff; manual resolution expected |
| 12 | Concurrent run attempted in same worktree | `local/run.lock` (flock) held | Second run refused with "another run in progress, PID N, started at T" |
| 13 | Plugin version mismatch on state read | Schema-version check in every reader | Refuse command; suggest upgrade or `--downgrade-state` (v2) |

**From the roles:**
- **Architect** — every failure surface writes to a known field. No hidden state.
- **PM** — the recovery UX is "the plugin tells you what happened and what to do next." No mystery errors.
- **DevOps** — every failure is inspectable via `.sdlc/local/debug.log` (§14.11) + support-bundle export.

---

## §19 — Data, privacy, compliance

**What data leaves the machine per phase:**
- **Discovery** — nothing dispatched. Agent uses local Read/Glob/Grep. Zero data exit.
- **Requirements / architecture / packet planning / reviews** — the intent brief, relevant source slices (never full files unless necessary), and the previous phase's artifact go to Claude via `execute_with_model` or direct subagent.
- **Codegen packets** — packet inputs (design fragment + a few source slices) go to the mechanical tier (Claude or Gemini per policy).
- **Never sent** — `.env` values, secrets, files in off-limits, files matching known secret patterns (private-key headers, `AWS_SECRET_ACCESS_KEY=...` inline, high-entropy strings past a threshold). A regex sweep in `plugin/scripts/dispatch-sanitize.mjs` runs on every dispatch input before it leaves the machine.

**On-prem / private-cloud routing:**
- `routing-policy.yaml` already supports arbitrary model IDs and endpoints. Bedrock / Vertex / self-hosted users supply a policy mapping our tier names to their endpoints.
- Ship example policies: `plugin/config/policies/bedrock-claude-only.yaml`, `vertex-mixed.yaml`, `self-hosted-only.yaml`.
- Preflight verifies each endpoint answers before starting. **No fallback to public models** — if a private endpoint is down, run halts. This is enforced by an `allow_public_fallback: false` flag defaulted-true only in shipped policies that intentionally use public models.

**PII in source:**
- Discovery does NOT try to detect PII in source (out of scope; false-positive risk too high).
- Codegen packets that include user-authored source may include PII; that's user responsibility. Documented in `docs/brownfield-privacy.md`.
- The plugin never persists PII beyond what's already in the user's own repo — no cache, no telemetry, no bundle stores content.

**Telemetry redaction:**
- `telemetry.jsonl` fields: model, phase, tokens, cost, task_id, retry_count, success, latency. **Never**: prompt content, response content, source slices, file paths beyond `artifact_path`.
- Support bundle (§14.11) redacts: env-key names only (no values); no file contents; only allowlist/off-limits *paths*, not their content.

**Audit obligations (SOC2 / GDPR / regulated industries):**
- Requirement: what data went where, when, who authorized it.
- Answered by: `provenance.json` (per-file model + timestamp + git SHA), `telemetry.jsonl` (per-call metadata), `.sdlc/ledger.md` (per-run trail), Gate answers logged with run.
- `/sdlc-audit` (§14.9) exports `audit-export.md` and `.json` — one file suitable for compliance ingestion.

**Data locality guarantees:**
- All plugin state is local (repo or `~/.claude/projects/`). No plugin-owned cloud storage.
- Model calls go to whatever endpoint the policy names.
- **No call-home. No usage tracking. No analytics ever.**

**Regulated-repo Gate 0 warning:**
- If discovery finds `SECURITY.md`, `PRIVACY.md`, or an obvious compliance marker (`SOC2/`, `HIPAA/`, `PCI/`, `regulated/` in path names), Gate 0 appends:
  > "This repo appears regulated. Confirm the active policy uses only compliant endpoints, and that off-limits protects your regulated data folders."

**Model input isolation across intents:**
- `docs` intent — reads more, writes docs. Higher read footprint.
- `bugfix` — reads narrow, writes narrow.
- `refactor` — reads wide (call sites), writes narrow.
- Compliance officer should be told which intents have wide read footprints so they can bracket accordingly.

**From the roles:**
- **Architect** — data flow is a first-class concern; every dispatch has an explicit `sent_to` model in telemetry.
- **PM** — compliance is not an afterthought; `/sdlc-audit` is the first artifact a compliance officer asks for.
- **DevOps** — no call-home ever. Private endpoints via policy files. Regulated repos get a Gate 0 warning.

---

# Part V — Reference & backlog

## §13 — Brownfield use-case taxonomy (what production teams actually do)

The full taxonomy of SDLC work a production brownfield team does day-to-day, grouped by category and mapped to the seven-intent design.

### The taxonomy

| Category | Concrete use-case | Frequency in prod |
|---|---|---|
| **Feature work** | New feature (endpoint / screen / module) | High |
| | Extend existing feature (field / param / flag) | Very high |
| | Deprecate feature (flag-gated removal, migration path) | Medium |
| **Bug work** | Reproduce reported bug (write a failing test) | Very high |
| | Root-cause + fix + regression test | Very high |
| | Hotfix on release branch (urgency, narrow scope) | Medium |
| | Postmortem doc | Medium |
| **Refactoring** | Extract / consolidate / rename across many files | Very high |
| | Layer separation (business logic out of controllers) | Medium |
| | Library migration (moment→dayjs, axios→fetch, etc.) | Medium |
| | Type-safety improvements (add types to untyped code) | Medium |
| **Testing** | Backfill missing tests (coverage push) | Very high |
| | Fix flaky test | High |
| | Add integration / e2e / contract tests | Medium |
| | Test-infra upgrade (Jest→Vitest, etc.) | Low |
| **Documentation** | API docs (OpenAPI/Swagger) | High |
| | README (new or refresh) | Very high |
| | ADR (architecture decision record) | Medium |
| | Runbook / operations guide | Medium |
| | Onboarding / dev-setup guide | High |
| | Code comments / JSDoc / docstrings | High |
| | Architecture diagrams (mermaid) | Medium |
| | Changelog / migration guide | Medium |
| **Dependencies & security** | Dependency upgrade (patch / minor / major) | Very high |
| | CVE / vulnerability patch | High |
| | Deprecated API replacement | Medium |
| | SBOM / license audit | Low |
| **Performance** | Profile + optimize hot path | Medium |
| | N+1 query / index fix | High |
| | Bundle size / cold-start reduction | Medium |
| | Memory-leak diagnosis | Low |
| **Infra & DevOps** | Dockerize / docker-compose for local dev | Medium |
| | CI pipeline (GitHub Actions / GitLab CI) | High |
| | IaC module (Terraform / Pulumi) | Medium |
| | Observability (metrics / logs / traces) | Medium |
| | Env / secrets rearchitecture | Low |
| **Data & schema** | DB migration + backfill script | High |
| | Query / index tuning | Medium |
| | Schema documentation | Medium |
| **Reviews & analysis** | PR review (no writes — produces a review) | Very high |
| | Architecture review | Medium |
| | Threat model / security assessment | Medium |
| | Codebase Q&A ("how does auth work here?") | Very high |
| | Dead-code / cost / dependency-graph analysis | Medium |
| **Large migrations** | Framework upgrade (Nest v9→v10, Django 4→5) | Low but painful |
| | Runtime upgrade (Node 18→20, Python 3.9→3.12) | Low but painful |
| | Monolith → workspaces / cloud migration | Low but painful |
| **Chores & hygiene** | Lint / format config, pre-commit hooks | Medium |
| | .gitignore / editor config / license headers | Low |

### Coverage by the seven v1 intents

Legend: ✅ covered · ⚠️ forced through closest fit · ❌ genuine gap (v2 or out-of-scope)

| Use-case | v1 intent | Notes |
|---|---|---|
| New feature | ✅ `feature-new` | — |
| Extend feature | ✅ `feature-extend` | — |
| Deprecate feature | ⚠️ `feature-extend` | Needs deprecation-flow prompts |
| Reproduce / fix bug + regression test | ✅ `bugfix` | — |
| Hotfix on release branch | ⚠️ `bugfix` | Needs branch-awareness + urgency mode |
| Postmortem doc | ✅ `docs` | — |
| Refactor (rename, extract, consolidate, library migration) | ✅ `refactor` | — |
| Test backfill / coverage push | ✅ `test` | — |
| Flaky test fix | ⚠️ `bugfix` or `test` | Routes OK once identified |
| API docs / README / ADR / runbook / onboarding | ✅ `docs` | — |
| Docstrings / architecture diagrams | ✅ `docs` | — |
| Dependency upgrade / CVE patch | ✅ `deps` | — |
| Deprecated API replacement | ✅ `refactor` | — |
| SBOM / license audit | ⚠️ `docs` | Produces a report |
| Performance investigation | ❌ | v2 |
| N+1 / index fix | ⚠️ `bugfix` | Routes OK once identified |
| Dockerize / CI pipeline / IaC | ⚠️ `feature-new` | Fits but stretches; consider `infra` in v1.5 |
| Observability instrumentation | ⚠️ `feature-extend` | Fits |
| DB migration + backfill | ⚠️ `feature-extend` | Needs migration-preview sub-flow |
| Schema docs | ✅ `docs` | — |
| PR review (no writes) | ❌ deferred to v2 | Different product category; competes with CodeQL / Cursor review / etc. |
| Architecture / threat-model review | ⚠️ `docs` | Analysis report |
| Codebase Q&A / explain | ❌ | Deferred to `understand-anything` plugin |
| Dead-code / cost analysis | ⚠️ `docs` | Analysis report |
| Large migration | ❌ | v2 or later |
| Lint / format / hygiene setup | ⚠️ `feature-new` | Small; could route via `deps` or new `chores` |

Coverage: seven intents cover ~70% of production brownfield work. Review-oriented work (PR review, threat model, architecture review) deferred to v2.

---

## §12 — Docs & examples

- New: [docs/brownfield.md](docs/brownfield.md) — overview, gate walk-through, coexistence guarantees.
- New: [docs/brownfield-write-contract.md](docs/brownfield-write-contract.md) — the §4 contract exhaustively, with an FAQ ("Will this touch my Cursor rules?" "No, unless you moved them from off-limits at Gate 0.").
- New: [docs/brownfield-ci.md](docs/brownfield-ci.md) — headless mode (§14.7).
- New: [docs/brownfield-coexistence.md](docs/brownfield-coexistence.md) — deep coexistence (§16).
- New: [docs/brownfield-privacy.md](docs/brownfield-privacy.md) — data-flow / regulated repos (§19).
- New: [docs/brownfield-support.md](docs/brownfield-support.md) — support-bundle + debug (§14.11).
- New examples under `plugin/examples/`:
  - `brownfield-docs-gen/` — 3-file Express app + intent_brief asking for README + JSDoc
  - `brownfield-bugfix/` — sample with a seeded failing test
  - `brownfield-feature-extend/` — existing endpoint + brief asking to add a filter param
  - `brownfield-refactor/` — sample with duplicate code to consolidate
  - `brownfield-test-backfill/` — sample with untested service
  - `brownfield-deps-upgrade/` — sample with outdated dep + CVE
- Update root [README.md](README.md) and [SETUP.md](SETUP.md) with a "Greenfield vs Brownfield" section.
- Keep [plugin/commands/run.md](plugin/commands/run.md) as-is for greenfield — do not collapse the two commands.

---

## Files to change / add — summary

**New — v1:**
- `plugin/commands/brownfield.md`
- `plugin/commands/revert.md`
- `plugin/agents/discovery.md` (front-matter tools: `Read, Glob, Grep, Bash(git *)` — D6)
- `plugin/skills/run-ai-sdlc/stacks/{generic,nest,python}.md` (per open decision)
- `plugin/hooks/hooks.json` — PreToolUse Write/Edit matcher (hard block, per §4 A6); SessionStart hook (opt-in per A8)
- `plugin/scripts/write-contract-check.mjs` — PreToolUse hook body
- `plugin/scripts/session-hydrate.mjs` — SessionStart hook body (A8)
- `plugin/scripts/discovery-refresh.mjs`
- `plugin/scripts/roll-up-costs.mjs`
- `plugin/scripts/brownfield-cleanup.mjs` (also strips CLAUDE.md `@import` line per A11)
- `plugin/scripts/env.mjs` — central env-reader (D4: SDLC_DEBUG, SDLC_CI_KEY)
- `plugin/config/policies/ci-strict.yaml`
- `plugin/templates/gitignore-fragment`
- `plugin/templates/settings-ci-fragment.json` — pre-allow `Bash(git *)` for CI (A9)
- `plugin/examples/brownfield-{docs-gen,bugfix,feature-extend,refactor,test-backfill,deps-upgrade}/`
- `docs/brownfield*.md` (six files)

**New — v1.5 (deferred per cuts):**
- `plugin/commands/sdlc-resume.md` (§14.6)
- `plugin/commands/sdlc-audit.md` (§14.9)
- `plugin/commands/sdlc-support-bundle.md` (§14.11)
- `plugin/scripts/prune-runs.mjs` (§14.2)
- `plugin/scripts/acquire-run-lock.mjs` (portable lock, per B5)
- `plugin/scripts/support-bundle.mjs`
- `plugin/config/policies/bedrock-claude-only.yaml`, `vertex-mixed.yaml`, `self-hosted-only.yaml`

**Not shipping in v1 (cut per C1, C4):**
- ~~`plugin/scripts/estimate-cost.mjs`~~ — replaced by inline one-line estimate at Gate 0
- ~~`plugin/scripts/migrate-state.mjs` + migrations dir~~ — ship `schema_version` field only; migrator when v2 schema exists

**Edit:**
- `plugin/skills/run-ai-sdlc/SKILL.md` — insert Phase 0/0b/0c, Gate 0, gate-message bubble-up pattern (A4), intent matrix, new task-type table, fix env-copy bug at line 161
- `plugin/agents/orchestrator.md` — add mode/intent inputs, Write gate section, branching on intent, forbid raw Write/Edit outside packets (per §4 A6)
- `plugin/agents/architect.md` — add brownfield mode, change_plan.md output
- `plugin/agents/senior-reviewer.md` — review files touched this run only (per C5)
- `plugin/agents/security-reviewer.md` — v1: review files touched this run; v1.5 origin-tagging
- `plugin/mcp/gemini-flash-server/src/types.ts` — add `discovery`, `change_plan` to Phase enum; add optional `subtype` field to TaskPacket
- `plugin/mcp/gemini-flash-server/src/adapters/*.ts` — invoke `dispatch-sanitize.mjs` sweep before every provider call (D3)
- `plugin/config/policies/opus-only.yaml` and `opus-plus-flash.yaml` — rules for discovery + change_plan
- `plugin/commands/run.md` — mode-detection guard (A2)
- `plugin/commands/pass.md` — `--mode`, `--intent`, `--gates`, `--from-config`, `--policy` flags
- `plugin/scripts/verify-setup.mjs` — brownfield check + git-binary check (D1) + Read-permission smoke test (D2)
- `README.md`, `SETUP.md`

**Not touched:**
- `plugin/mcp/gemini-flash-server/src/policy.ts` (already handles project-root policy override correctly — we surface it at Gate 0)

---

## Verification plan

Cannot rely on unit tests alone — this is a workflow change verified by real runs.

1. **Unit / integration** — tests for write-contract validator (allow / off-limits / not-in-manifest), baseline reader, session-hydrate reader, dispatch-sanitize sweep, schema_version reader (rejects unknown). Extend MCP server tests for new Phase enum values. Verify-setup tests for git-binary check and Read-permission smoke test.
2. **Discovery agent dry-run** — run `/sdlc:brownfield` on this very repo, stop at Gate 0, inspect `discovery.md` by hand. Confirm: stack detected as node/typescript; `.mcp.json` and `plugin/config/policies/*.yaml` flagged in AI-setup group; env keys only, no values.
3. **Golden-path e2e per intent** — run each example under `plugin/examples/brownfield-*/` end-to-end. Assert: final report's write-contract audit matches expected file list; `git diff` shows no changes outside allowlist; `.env` never overwritten.
4. **Coexistence e2e** — temp repo pre-seeded with `.claude/settings.json`, `.mcp.json` (fake foreign MCP), `.cursor/rules`, competing `routing-policy.yaml`. Run brownfield. Assert none changed and Gate 0 named all of them.
5. **Rollback drill** — after a run, use `/sdlc:revert`; verify repo returns to `baseline.git_head`.
6. **Session-continuity e2e** — run three intents in three sessions; assert session 4 shows all three in the ledger, `@import` line in CLAUDE.md unchanged after first run, `.sdlc/CLAUDE-SDLC.md` updated per run.
7. **Failure-mode drills** — pick 5 rows from the §18 table (crash, disk full, network drop, quit mid-gate, rebase between sessions). Assert each recovery path.
7b. **Rollback drills across all four file-state cases (A10)** — pre-existing/committed, pre-existing/tracked-uncommitted, pre-existing/untracked, newly-created. Assert each case returns to the pre-run state exactly.
7c. **Mode-detection guard (A2)** — run `/sdlc:run` in a non-empty repo, assert refusal with the expected message.
7d. **Non-git-folder refusal (A3)** — run `/sdlc:brownfield` in a folder without `.git`, assert refusal with the expected message.
7e. **CLAUDE.md `@import` hop-budget (B6)** — pre-seed CLAUDE.md with 3 levels of imports, assert session-hydrate prints the fallback message and doesn't create a broken import.
8. **CI mode dry-run** — headless `run-sdlc-pass --mode brownfield --gates auto-abort` against a matching `project.json` and a drifted one. Assert auto-abort on drift.
9. **Cleanup** — `/plugin uninstall` then `scripts/brownfield-cleanup.mjs`. Confirm zero footprint outside expected paths.
10. **Regulated-repo warning** — temp repo with `SECURITY.md` and `HIPAA/` folder. Gate 0 must print the regulated-repo warning verbatim.

---

## Consolidated backlog — v1 / v1.5 / v2

**v1 must-have (ships with brownfield GA):**

*Pipeline (Part II):*
- §1 command surface (`/sdlc:brownfield` + `/sdlc:revert`)
- §2 tiered discovery
- §3 Gate 0
- §4 write contract (all three enforcement layers)
- §5 intent routing (7 intents)
- §6 artifacts (intent_brief, discovery, baseline, change_plan)
- §7 task-type primitives + stack adapters for {generic, nest, python} (per open decision)
- §8 architect / reviewer changes
- §9 testing changes (including env-copy bugfix)
- §11 policy + telemetry (discovery / change_plan phases)
- §15 placement (matrix, monorepo, framework side-effects)

*Multi-session (Part III):*
- §14.1 project state model
- §14.2 runs directory + ledger (no auto-prune)
- §14.4 baseline staleness (git + mtime, incremental refresh)
- §14.5 git contract (safe defaults: `current` / `none` / `off`)
- §14.6 provenance + `/sdlc:revert`
- §14.8 coexistence baseline (gitignore, formatters, pre-commit, CODEOWNERS)
- §14.10 versioned state + lazy migration harness

*Cross-cutting (Part IV):*
- §16 AI-tooling deep coexistence (detection + surface at Gate 0)
- §17 team model (`.sdlc/` split, CODEOWNERS surface, concurrent-run lock)
- §18 failure handling for rows 1-9 in the table
- §19 data-flow rules + `dispatch-sanitize.mjs` + regulated-repo Gate 0 warning

**v1.5 fast-follow:**
- §14.3 session-hydrate SessionStart hook + `@.sdlc/CLAUDE-SDLC.md` import (safe pattern; hop-budget check per B6)
- §14.6 `/sdlc-resume` + packet-level checkpoints
- §14.7 headless / CI mode (`--from-config`, `ci-strict.yaml`, auto-abort default)
- §14.9 `/sdlc-audit` (cost roll-up + audit export)
- §14.11 debug mode + `/sdlc-support-bundle`
- §18 failure handling for rows 10-13
- §14.2 portable run-lock (moved from v1 per C3)
- §8 security-reviewer origin-tagging (moved from v1 per C5)
- §16 deep AI-tool parsing (Cursor glob-intersect, Aider auto-commit warning, MCP name heuristics) — moved from v1 per C7
- §5 intent-matrix specialization for `refactor`, `test`, `deps` (moved from v1 per C6)
- On-prem policies: `bedrock-claude-only.yaml`, `vertex-mixed.yaml`, `self-hosted-only.yaml`
- Real B2 submodule support (v1 treats them as opaque)

**v2 later:**
- `compute_baseline_manifest` MCP tool (batch SHA in Node)
- §14.2 run pruning + archive tarball
- §14.5 `per-run` branch + `draft-on-close` PR strategies
- §14.9 per-user budgets + pre-run cost projection mini-gate (v1 uses inline estimate at Gate 0 per C4)
- §14.10 state migration harness with `plugin/scripts/migrations/` scaffold (v1 ships `schema_version` field only per C1); downgrade-state migration
- Concurrent-run lock UX and multi-branch conflict handling
- `perf` intent (needs profiler integration)
- Large-migration intent (framework/runtime/monolith — multi-pass, staged rollback)
- Async-review workflow (drafts + PR review of intent brief before run)
- Additional stack adapters (go, rails, java, etc.) as real users surface stacks

**Ordering rationale:** v1 items are what make the second, third, and Nth session on the same project *safe and coherent*. v1.5 makes it *pleasant*. v2 items are quality-of-life once real teams have used it for weeks.

---

## §21 — Adaptive stack profile (new, from architect-review pass)

**Locked decision (D1).** The pre-authored stack adapter fragments (`nest.md`, `python.md`, `generic.md`) are optional *baselines*, not the primary quality mechanism. The primary mechanism is a **learned stack profile** built at first run per project.

**When it runs:** first `/sdlc:brownfield` invocation per project — as a new **Tier 2b step in discovery**. Triggered when: (a) the detected stack has no matching adapter (would fall to `generic.md`), OR (b) CLAUDE.md declares a custom framework, OR (c) user passes `--adaptive-profile`. Otherwise skipped (well-known stack with a first-class adapter already gives good baseline).

**What it does:** the discovery agent samples 3–5 existing files of each detected "kind" (controllers, services, tests, config files, migrations) using local `Read` + `Grep`. Extracts conventions from what's actually there: file naming, decorators/annotations, import shapes, folder structure, test-runner patterns, config validator, ORM usage, framework-specific idioms.

**Output:** `.sdlc/baseline/stack-profile.md` — the learned profile for this specific repo, not a template. Persists across runs; refreshed by staleness detection (§14.4) when the stack manifest changes.

**How it's used:** codegen packets receive the stack profile *in addition to* any pre-authored adapter fragment. **The learned profile wins on conflict** — it reflects the actual repo, the fragment reflects the framework in general.

**Cost:** ~15–30 s discovery time, ~1–3 K premium tokens once per project. Cached in baseline; not re-run per intent.

**Files:** discovery agent gains a "profile" sub-step; `.sdlc/baseline/stack-profile.md` added to §14.1 committed state.

---

## §22 — Pipeline pre-check + setup-time robustness (new)

**Locked decision (D4, max scope + "handle ≠ solve" principle).** The current `preflight_dispatch` verifies models are reachable — a small slice of "will this run actually work on this repo?" A full pipeline pre-check is the missing piece.

### The pre-check — the six smoke steps

Runs automatically as **step 1 of `/sdlc:brownfield`**, before any real work. ~20 seconds, ~$0.02 total.

| # | Step | Purpose |
|---|---|---|
| 1 | Discovery smoke | Run Tier 1 + Tier 2b if needed. Assert no failures. |
| 2 | Test-command probe | Invoke discovered test command with `--help` / `--collect-only` / `--dry-run`. Verify it exists and can be invoked. |
| 3 | Dispatch smoke | Send one trivial "return the string 'OK'" packet to each policy tier. Verifies credentials + adapter + response validation end-to-end. |
| 4 | Write-contract smoke | Write to `.sdlc/pre-check/hello.txt`. Verify the write-contract check passed. Verify the PreToolUse hook fired. |
| 5 | Rollback smoke | Undo that write via the §14.6 rollback mechanism. Verify the file is gone. |
| 6 | Report | Pass/fail per step. If any fails, DON'T proceed to Gate 0. Print exact remediation. |

Results cached to `.sdlc/pre-check-status.json` — subsequent `/sdlc:brownfield` invocations skip steps whose inputs haven't changed (test command still the same, policy still the same, plugin version still the same).

### Setup-time issue inventory — max scope with "handle ≠ solve"

Every known risk gets **detection + clear-message handling**. We don't build elaborate solving infrastructure for each.

**Environment (verify-setup.mjs at plugin install / prompt 1):**
| Issue | Handling |
|---|---|
| Node version too old (< 20) | Detect, print required version + link to install, exit clean |
| Git binary missing or too old (< 2.30) | Same |
| MCP server `dist/` not built | Auto-build via `--fix` flag |
| Existing plugin conflict on command names | Detect, list conflicts, ask user to rename or uninstall the conflicting plugin |
| Filesystem write permission on `.sdlc/` denied | Detect, print permission fix, exit |

**Repo state (first-run inside `/sdlc:brownfield` pre-check + Gate 0):**
| Issue | Handling |
|---|---|
| No test infrastructure at all | Detect at pre-check step 2. Gate 0 warns: "No test command detected. Proceed without test phase? [y/n]" |
| Failing tests before we start | Run tests once at pre-check. If failing, Gate 0 warns: "Repo has N pre-existing failing tests. Our run won't cause these but may fail Phase 7 approval. Continue? [y/n]" |
| Encrypted secrets manager (Doppler, Vault, `.env.enc`) | Detect via file presence. Gate 0 note: "Secrets appear to be in `<X>`. Off-limits doesn't cover them, but we don't touch them either." No .env work in this run. |
| Git-LFS files | Detect from `.gitattributes`. Skip Read on LFS-marked files (would blow token budget). Gate 0 note lists what's skipped. |
| Git submodules | Detect `.gitmodules`. Treat submodules as opaque (never write). Gate 0 note lists them. |
| Squash-merged history | Detect via commit-count heuristic. Provenance uses tree-SHA fallback instead of `git log --follow`. |
| Aggressive .gitignore hiding source | Detect files matched by common source patterns that are ignored. Gate 0 warns. |
| Very large repo (>100K files) | Detect at Tier 1. Sample-based discovery instead of full walk. Gate 0 discloses sampling strategy. |
| Non-UTF8 files | Skip on Read failure, log to debug.log, continue. |

**Runtime resilience:**
| Issue | Handling |
|---|---|
| Provider outage mid-dispatch | Adapter backoff already exists. Add hard cap: 3 retries with exponential backoff, then fail packet cleanly. |
| Cost runaway (unexpectedly large repo) | Hard cost cap per run (default $50, configurable in policy). Abort with clear message when hit. No predictive modeling. |
| Model deprecation | Detect via provider error. Fail cleanly with "model `<X>` is deprecated by provider — update your policy to use `<Y>` (see release notes)." No automatic fallback. |
| Adaptive profile drift | Refresh triggers: stack manifest changed, N runs since last refresh (default 10), or user passes `--refresh-profile`. |
| Claude Code API contract breaks between plugin releases | Schema-version guard already in §14.10 catches this at read time. Print upgrade instructions. |

### Files touched (v1)

- New: `plugin/scripts/pre-check.mjs` (the six-step runner)
- New: `plugin/scripts/env-checks.mjs` (Node/git/plugin-conflict checks)
- New: `docs/brownfield-setup-issues.md` (the inventory + mitigations doc)
- Edit: `plugin/scripts/verify-setup.mjs` (invokes env-checks, prints credential status)
- Edit: `plugin/commands/brownfield.md` (pre-check as step 1, inline remediation UX)
- Edit: `plugin/config/policies/*.yaml` (add `hard_cost_cap_usd: 50` field)

---

## §23 — Two-prompt UX contract (locked D5, revised)

**Locked decision.** The README promises two prompts. Everything folds into the two existing entry points. **Prompt 1 completes ALL setup for this specific repo** (install + env + credentials + discovery + baseline + pre-check). Prompt 2 becomes lean: staleness-check + task.

Original design put discovery and inline remediation in prompt 2; that was technical thinking (install vs. task) leaking into UX. Corrected here.

### Prompt 1 — Setup (`Setup this plugin from this repo — <URL>`)

Runs when the user is in their project directory (the common case). Fully shepherded per §25 — auto-do / pause-and-guide / verify. Six ordered sections:

**Section 1 · Install (machine-level, always run):**
1. Register marketplace
2. Install plugin
3. Build MCP server dist (auto-fix if needed)

**Section 2 · Environment (machine-level, always run):**
4. Node ≥ 20 (guide upgrade if lower)
5. git ≥ 2.30 (guide upgrade if lower)
6. Plugin command-name conflict detection (ask user to rename/uninstall if conflict)
7. `~/.claude/` write permission (guide chmod fix if denied)

**Section 3 · Repo detection (branch point):**
8. Am I in a git repo? YES → continue all sections. NO → skip section 5, note deferred at section 6.

**Section 4 · Credentials (discover first, ask second — §26 shepherd):**
9. Anthropic (**required**): scan every location → if none found, hard-shepherd (can't skip; fallback to Claude Code subscription auth → `estimated` telemetry mode)
10. Gemini (**optional but default policy needs it**): scan every location for all three flavors → offer to set up OR switch to `opus-only` OR skip
11. Antigravity (**opt-in only**): check only if user's policy uses `flash-agsdk-worker`; otherwise noted-and-skipped

**Section 5 · Repo setup (only when in a git repo):**
12. `.sdlc/` write permission
13. Git-clean advisory (block if `commit_strategy` will be set later — see §14.5)
14. Discovery Tier 1 — git state, stack manifest, `.gitignore`, competing AI configs, monorepo signals, submodules, LFS
15. Adaptive stack profile (Tier 2b) — if Tier 1 detected unknown/custom stack, or user passed `--adaptive-profile`
16. Save baseline to `.sdlc/baseline/current.json`
17. Pipeline pre-check — 6 smoke steps (§22). Uses credentials from section 4 for dispatch smoke; uses test command from section 5.14 for test-command probe.
18. Save pre-check status to `.sdlc/pre-check-status.json`
19. Surface any repo-state risks detected in sections 5.14/17 (failing tests, LFS content, submodules, encrypted secrets) with user-facing confirmation for how to handle at first task

**Section 6 · Summary (always):**
20. Line-by-line status report of everything done + everything skipped (with consequences) + next-step guidance

### Not-in-a-repo path (section 5 skipped)

Section 6 summary reads:
```
Plugin installed and credentials set.
Discovery deferred — you're not in a git repo directory.
When you're in a project, cd in and run /sdlc:brownfield —
I'll finish repo setup then.
```
That first `/sdlc:brownfield` in a project directory then runs sections 5.12–19 inline before intent selection.

### Prompt 2 — `/sdlc:brownfield` (lean version)

Repo-aware. Runs per task invocation. In the common case, all setup work was done at prompt 1, so this is short:

1. **Setup-status check (FIRST — before anything else).** Read `.sdlc/local/setup-status.json`:
   - **Complete** → normal flow (staleness check + task).
   - **Incomplete** (session died mid-setup) → *"Setup was interrupted at section N — resuming from there..."* Run remaining shepherd sections inline. Then continue to intent selection.
   - **Missing** (setup never ran in this project — user ran prompt 1 outside a repo, or `.sdlc/` was cleaned) → run all sections 5.12–19 from prompt 1 inline before continuing. Same shepherd code path, different entry point.
2. **Staleness check on cached baseline.** Is `.sdlc/baseline/current.json` still fresh (git HEAD unchanged, stack manifest mtime unchanged, plugin version unchanged)? If yes → use it. If no → incremental refresh (5–10 s) or full re-discovery.
3. **Skip pre-check** unless baseline is stale OR plugin version changed OR user passed `--recheck`. Cached pre-check status covers the common case.
4. **Rare fallback: inline credential remediation.** If pre-check reveals credentials revoked between sessions (key expired, service account rotated), same shepherd dialog runs inline. Edge case, not default path.
5. **Intent brief interview** (§6).
6. **Gate 0** — confirming intent + scope. Stack, test command, and off-limits are already known from the baseline.
7. **Pipeline runs** — per §5 state machine.

### Graceful mid-setup recovery (new)

The shepherd writes progress to `.sdlc/local/setup-status.json` after **each section completes** — schema: `{sections_done: [1,2,3,4], sections_pending: [5,6], last_prompt_step: {...}, timestamp}`. If a session dies mid-section (Ctrl+C, network drop, machine sleep), the last completed section is recorded; the current section's partial state is discarded (safer to redo one section than to have a half-complete state).

On next `/sdlc:brownfield`:
- Read the file
- If any sections pending: print *"Setup was interrupted at section &lt;N&gt; (&lt;label&gt;) — resuming from there..."*
- Re-run all pending sections in order, still shepherded
- Once complete, mark status and continue to intent selection

No new commands. No user-visible failure mode. Same shepherd, different entry point.

### What we deliberately don't ship as v1 commands

- `/sdlc-precheck` — deferred to v1.5. Auto-run inside prompt 1 (with cached skip in prompt 2) covers the need.
- `/sdlc-doctor` — same rationale.
- `/sdlc-init-team-config` — deferred; `.sdlc/project.json` edited via PR review.

### Why this reorganization matters

- **Cleaner mental model.** "Setup is complete after prompt 1" matches how users think about installation.
- **Prompt 2 is fast.** Cached baseline + cached pre-check means most invocations skip straight to intent selection.
- **User-action work is up-front.** If you need to visit a browser for a Gemini key, that happens once at setup — never mid-task.
- **Repo-state risks surface early.** LFS, submodules, failing tests are noted at prompt 1, not surprising the user mid-task.

### Impact on plan

- README stays at two prompts; new work all folds inside
- SETUP.md rewritten as the shepherd contract Claude follows verbatim on prompt 1
- `docs/brownfield.md` documents the two-prompt flow with explicit ordering

---

## §26 — Credential discovery — "check first, ask second" (new, from D7)

**Locked decision.** The shepherd (§25) doesn't naively ask "do you have a Gemini key?" — it **scans multiple locations** for existing credentials first, reports what it found, and only asks the user to set up fresh if truly nothing exists anywhere.

### Providers and their auth flavors

**Anthropic** (premium tier for judgment work):
- `ANTHROPIC_API_KEY` env var — direct
- `~/.anthropic/credentials` (if it exists)
- Fallback: user is already authenticated via Claude Code subscription → `estimated` telemetry mode (judgment phases run in-session without vendor billing)

**Gemini (mechanical tier)** — three auth flavors:
1. **Google AI Studio** — `GEMINI_API_KEY` env var, simplest, free tier
2. **Vertex AI** — GCP project + auth via service account JSON or Application Default Credentials, production-grade
3. **Antigravity SDK** — sits on top of Vertex, reuses GCP auth, agent-based, higher per-task token cost

There is **no separate "Antigravity API key"** — it uses GCP credentials.

### Discovery locations (per provider, in order)

**Anthropic:**
1. `ANTHROPIC_API_KEY` in current shell env
2. `~/.anthropic/credentials`
3. Shell config: grep `~/.zshrc`, `~/.bashrc` for `export ANTHROPIC_API_KEY`
4. Repo `.env*` files: check for `ANTHROPIC_API_KEY=` (**names only, never values** — §19)
5. Fallback: Claude Code subscription auth → offer `estimated` mode

**Gemini:**
1. `GEMINI_API_KEY` / `GOOGLE_API_KEY` in current shell
2. `GOOGLE_APPLICATION_CREDENTIALS` env var → service account JSON path (Vertex AI)
3. `~/.config/gcloud/application_default_credentials.json` exists → ADC (Vertex AI)
4. `gcloud auth print-access-token` succeeds → gcloud is set up
5. `gcloud config get-value project` → active GCP project
6. `~/.gemini/*` config directory
7. Shell config files: grep for exports of Gemini/Google vars
8. Repo `.env*` files: check for env names (never values)
9. Repo scan for code references — `process.env.GEMINI_API_KEY`, `os.environ["GOOGLE_API_KEY"]`, etc.

**Antigravity (only when the user's chosen policy uses it, or `SDLC_SELECT=flash-agsdk-worker`):**
1. Reuses whatever Gemini/GCP credentials found above
2. `pip show google-antigravity-sdk` (or the actual package path) — is the SDK installed
3. GCP project entitlement check for Antigravity in the required region

### Repo-scan rules

Scan the current repo for env-var name references — always names only, never values. Signals that indicate the project already uses a provider:
- Code references (`process.env.X`, `os.environ["X"]`, etc.)
- `.env.example` / `.env.template` rows
- README / docs mentioning API keys
- `docker-compose.yml` / CI config passing keys through

Purpose: infer "you probably already have this configured for other project work" without ever reading actual `.env` values. Privacy hard-line preserved.

### Behavior shape

**Found-something (multiple options).** Report all sources, let user pick. Include a hint about which matches the repo's likely usage:
```
Found several possible Gemini sources:
  (a) GEMINI_API_KEY env var — matches Google AI Studio format
  (b) gcloud CLI authenticated to project 'my-startup-prod'
  (c) GOOGLE_APPLICATION_CREDENTIALS → ~/keys/service-account.json
  (d) Repo references GEMINI_API_KEY in src/services/ai.ts and .env.example
      (so you're probably already using option (a) for this app)

Which should the plugin use?
```

**Found-nothing.** Only when truly nothing exists anywhere. Offer the three provider paths with trade-offs:
```
Not found in: shell env, gcloud config, ~/.config, shell rc files, repo files.

Three ways to set up:
  (a) Google AI Studio API key (~2 min, free tier)
  (b) Vertex AI (needs GCP project)
  (c) Skip — use opus-only policy, ~10× cost
```

### What this changes vs. §25

§25 (setup shepherd) said "detect credential, guide if missing." This section makes discovery real: **discover across every plausible source before deciding "missing."** Guide-user is the last resort, not the default.

### Files touched (v1)

- `plugin/scripts/verify-setup.mjs` — extended with `scanCredentials()` that walks all discovery locations
- `plugin/scripts/credential-discovery.mjs` — new, provider-agnostic scanner (returns `{provider, sources: [{location, kind, hint}]}`)
- SETUP.md — rewritten to describe the discovery-first shepherd contract

---

## §25 — Setup shepherd behavior (new, from D6)

**Locked decision.** Prompt 1 doesn't just *check* — it *shepherds*. Auto-does what it can, pauses and guides when human action is required, verifies each fix worked before continuing.

### Behavior contract

1. **Sequential execution.** One step at a time, always clear where you are.
2. **Auto-do.** Steps Claude can complete alone — just do them. Report success in one line.
3. **Pause & guide.** Steps needing user action — pause execution, print exact command / URL, wait for user reply (`"done"` / `"skip"` / `"abort"`).
4. **Verify.** After user says "done," re-run the check. Never blindly trust. If still failing, more specific troubleshooting.
5. **Continue on the user's fix.** Once verified, proceed to next step. Never restart from scratch.
6. **Summary at end.** Line-by-line status of what was done, what user did, what was skipped with consequences noted.

### Every step, categorized

| Step | Actor | Behavior |
|---|---|---|
| Register marketplace | Claude | Auto |
| Install plugin | Claude | Auto |
| Build MCP server `dist/` | Claude | Auto (via `verify-setup --fix`) |
| Detect Node version | Claude | Auto; if < 20, guide user to install/upgrade, wait, verify |
| Detect git version | Claude | Same |
| Detect plugin conflicts | Claude | Auto; if conflict, ask user to rename/uninstall, verify |
| Detect Anthropic key | Claude | Auto; if missing, guide to obtain (link), wait, verify |
| Detect Gemini key (optional) | Claude | Auto; if missing, **NOT blocking** — note in summary, offer to guide or skip |
| Detect Antigravity SDK (optional) | Claude | Same as Gemini |
| Filesystem write permission on `.sdlc/` | Claude | Auto; if fail, guide to chmod, verify |
| `npm install` (rare, only if plugin needs deps) | Claude | Auto via Bash (permissioned) |

### Guide messages must be specific

Not "install Node 20" — give the actual commands, in order, with multiple platform options:
```
To upgrade Node, run one of:
  • nvm install 20 && nvm use 20  (if you have nvm)
  • brew install node@20  (macOS with brew)
  • Download from https://nodejs.org (any platform)
Reply "done" when Node is upgraded.
```

Not "get a Gemini key" — link to the exact page + verification steps:
```
Visit https://aistudio.google.com/app/apikey — sign in with Google, create key.
Add to environment: echo 'export GEMINI_API_KEY="<paste>"' >> ~/.zshrc
Reload: source ~/.zshrc
Reply "done" when set.
```

### Verification is mandatory

After every "done":
- Re-run the specific check.
- On pass: brief confirmation ("✓ Node 20.11 detected"), continue.
- On fail: more specific troubleshooting ("Node still shows 18.17 — is your shell pointing at the new install? Run `which node` and paste the output"), retry.
- After 3 verification failures: offer to skip that step (with consequences noted) or abort.

### Headless / CI exception

Shepherd behavior needs a human. In CI:
- `verify-setup.mjs --headless` mode
- All auto-do steps run normally
- Any guide-needed step: print instructions to logs, exit with non-zero
- CI operator sees log, fixes, re-runs
- No "wait for done" — that would hang the CI job indefinitely

### End-of-prompt-1 status summary

Always print a line-by-line summary before closing. Example when Gemini was skipped:
```
Setup complete.
  ✓ Plugin installed
  ✓ MCP server built  
  ✓ Node 20.11 · git 2.42 · no plugin conflicts
  ✓ Anthropic API key found
  ⚠ Gemini API key not set — default policy 'opus-plus-flash' needs it.
      First run of /sdlc:brownfield will offer 'opus-only' as alternative (~10× cost).
Ready. Run /sdlc:brownfield when you want to start.
```

The user knows exactly what state their setup is in, what will happen at first run, and what to do if they want to change any of it.

### Impact on plan

- §23 (two-prompt UX) already lists the prompt-1 steps; this section defines HOW those steps behave interactively.
- `plugin/scripts/verify-setup.mjs` gains `--headless` mode (for CI) and structured output so the SETUP.md prompt Claude follows can shepherd cleanly.
- SETUP.md (existing) rewritten to describe the shepherd behavior as Claude's contract — Claude follows SETUP.md verbatim on prompt 1.

---

## §24 — Model-per-task routing table (new, from D3)

**Locked decision.** Ship an explicit "which model does which work" table as first-class documentation, not buried in the policy YAML.

### The general rule (phase-based routing in the default `opus-plus-flash` policy)

| Kind of work | Tier | Model in default policy |
|---|---|---|
| **Judgment** — discovery, requirements, architecture/change plan, packet planning, senior review, security review | premium | Claude Opus |
| **Mechanical** — codegen packets, doc packets, test-code packets, debug packets | mechanical | Gemini Flash |
| **Escalation** — after 2 mechanical retries fail | premium | Claude Opus |
| **Test execution (running the actual test command)** | local | Bash on your machine — no model call |

### Per-intent, which phases fire and what tier they use

Only which phases fire changes per intent — the tier assignment is stable.

| Intent | Judgment phases (premium) | Mechanical phases (Flash) |
|---|---|---|
| docs | requirements, senior review, security review | doc_addition, doc_update packets |
| bugfix | requirements (reproduce+diagnose), senior review, security review | bug_reproduce, bug_diagnose, bug_fix_apply, test_add packets |
| feature-extend | requirements, architecture (change_plan), senior review, security review | mixed edit + add packets |
| feature-new | requirements, architecture (full subsystem design), senior review, security review | full codegen mix (schema, controller, service, test, docs) |
| refactor | requirements (delta), architecture (refactor plan), senior review, security review | refactor_extract + patch_apply |
| test | requirements (coverage target), senior review, security review | test_backfill / test_add |
| deps | requirements (upgrade list), architecture (dep-swap plan), senior review, security review | dependency_add + adjacent-code patches |

### Advanced per-task-type overrides (v1.5)

The policy YAML supports per-task-type rules for edge cases where a specific task inside a "mechanical" phase is really judgment. Example (not shipping in v1):
```yaml
- phase: execute_packets
  matches: { task_type: bug_diagnose }
  use: premium
  reason: "diagnosis is judgment, not pattern-matching"
```
Users on custom policies can add these themselves. Not needed in v1 — phase-level defaults are enough.

### Files

- New: `docs/brownfield-routing.md` — the tables above with commentary + how to override
- Referenced from `docs/brownfield.md`

---

## §20 — Self-review findings (RESOLVED — all applied)

Critical re-read of the plan looking for contradictions, gaps, over-engineering, and unclaimed assumptions. **Status: all Bucket A must-fixes applied to plan sections; all Bucket B should-fixes noted as v1 known limitations or v1.5 items; all Bucket C over-engineering cut from v1 (moved to v1.5 or v2 in the backlog); all Bucket D assumptions stated explicitly.** This section stays in the plan as the audit trail — showing what was reviewed and how it was resolved — but the plan sections themselves are now consistent with the decisions here.

### Bucket A — Must-fix before v1 (real blockers or genuine confusion)

| # | Finding | Fix |
|---|---|---|
| A1 | **Baseline file naming inconsistent.** §2 says `<output_dir>/baseline.json` (per-run snapshot). §14.1 says `.sdlc/baseline/manifest.json` (committed living baseline). §14.4 references `baseline.git_head`. Three names for two different things. | Rename: **`.sdlc/runs/<id>/baseline.json`** for per-run snapshot; **`.sdlc/baseline/current.json`** for the living project baseline. Update every reference. |
| A2 | **Mode-detection entry point missing.** State machine says "picks greenfield path when `mode: greenfield`" but doesn't say where `mode` is set. If a user runs `/sdlc:run` in an existing repo, what happens? | `/sdlc:run` gains a repo-empty check: if `./src` exists or `.git` exists with files, print "This looks like an existing repo — did you mean `/sdlc:brownfield`?" and refuse until confirmed. `/sdlc:brownfield` sets `mode: brownfield` unconditionally. |
| A3 | **Non-git-repo case unspecified.** Every Tier 1 step assumes `git`. What if user is in a folder without `.git`? | Discovery detects; if no git → refuse with clear message ("brownfield mode needs git for rollback anchors — run `git init && git add -A && git commit -m 'baseline'` first, then re-run"). Not offering to auto-init; too destructive. |
| A4 | **Gate prompts inside a subagent.** Orchestrator is a subagent; per platform research subagents can't run interactive dialogs. The gate template shows a `> ⏸ HITL Gate` block but doesn't say how it bubbles to the main-loop session. | Gate rendering is the subagent returning a specifically-shaped message to the main loop; the main loop (Claude Code session) displays it and awaits user input, then re-invokes the subagent with the answer. Document the message shape in `SKILL.md`. |
| A5 | **`/sdlc-review` command never specified.** ~~Add short spec~~ **SUPERSEDED — dropped from v1 in a later pass.** Code review is a different product category from safely-changing-code (competes with CodeQL, Cursor review, GitHub Copilot review) and isn't core to the plugin's main value prop. Deferred to v2. See §6 out-of-scope. |
| A6 | **The write contract's three layers include one that's soft.** Only the PreToolUse hook is an actual interception; the orchestrator "prompt gate" is soft (AI can drift) and the packet validator only catches planned writes, not ad-hoc `Write` calls the orchestrator makes outside a packet. | Be honest in §4: the *only* unbreakable layer is the hook. The prompt gate is best-effort. Recommend hook default-on for brownfield (open decision). Also: orchestrator prompt must forbid raw `Write`/`Edit` outside packets — all writes must go through a packet. |
| A7 | **Placement rules described as "enforced by the write contract" (§15) but they aren't.** The write contract enforces the allowlist; placement rules only shape what codegen produces. If codegen picks a bad path that's still in the allowlist, the contract accepts it. | Reword §15: placement is a codegen quality concern (adapters guide the packet planner), not a safety concern. Safety is the allowlist. |
| A8 | **Session-hydrate conflated with skill-load.** §14.3 says it "runs on plugin skill load" — but skills load per-trigger, not per-session. To fire once per session we need the `SessionStart` hook. | Move session-hydrate invocation to the `SessionStart` hook (which the plan already mentions as optional). Make it opt-in by default; recommend on in `.sdlc/project.json`. Don't rely on skill-load for once-per-session behavior. |
| A9 | **Bash permission for git commands not addressed.** Discovery uses `Bash` for `git rev-parse`, `git status`, `git diff`, `git check-ignore`. In CI mode with `--permission-mode auto`, every git command needs explicit allow. | Ship a `.claude/settings.json` fragment for CI: `{"permissions":{"allow":["Bash(git *)"]}}`. Document in `docs/brownfield-ci.md`. Discovery agent's front-matter must declare `Bash(git:*)` explicitly if the plugin conventions support subtool-level scoping. |
| A10 | **Rollback for uncommitted-file case.** `/sdlc:revert` says `git checkout <sha_before> -- <path>`. This fails when the file was created by the run and never committed (sha_before is null) — rollback is `rm <path>`. Fails also when file existed but was uncommitted at run start (no sha_before in git). | Provenance records `sha_before: null` for newly created files → revert = `rm`. For pre-existing uncommitted files, record their content SHA + a `.bak` copy in `.sdlc/local/cache/` at write time; revert restores from `.bak`. |
| A11 | **Uninstall doesn't remove the CLAUDE.md `@import` line.** §14.3 adds `@.sdlc/CLAUDE-SDLC.md` to CLAUDE.md; §13's user-journey promise ("delete `.sdlc/` and leave zero footprint") breaks — the import line becomes broken. | `scripts/brownfield-cleanup.mjs` also strips the `@.sdlc/CLAUDE-SDLC.md` line from CLAUDE.md (with diff preview + confirmation). Document in `docs/brownfield.md`. |

### Bucket B — Should-fix in v1 (real gaps, workable with a "known limitation" note)

| # | Finding | Fix or note |
|---|---|---|
| B1 | **Greenfield → brownfield handoff.** User runs `/sdlc:run` today, then wants `/sdlc:brownfield` next week. Does brownfield discover the greenfield `.sdlc/` cleanly? | Test explicitly. Likely works because §14.1 state model is additive. Add to verification plan. |
| B2 | **Git submodules.** Baseline SHAs, rollback, `git check-ignore` all get tangled with submodules. | v1: discovery detects submodules and warns "submodules are treated as opaque; runs won't touch them." v1.5: real submodule support. |
| B3 | **Gitignore enforcement for `.sdlc/local/`.** Offered at Gate 0, but if user declines, `local/` gets committed and floods PRs. | Refuse to run at Gate 0 if `.sdlc/local/` isn't gitignored, unless `--allow-uncovered-local` is passed. |
| B4 | **Intent brief authoring flow underspecified.** §6 says "wizard writes it" — from what inputs? | Spell out: wizard interviews user (2-4 questions per intent), fills in the heading template, shows the draft, asks to confirm/edit, then commits it to `.sdlc/runs/<id>/intent_brief.md`. |
| B5 | **POSIX flock is not cross-platform.** Windows without WSL breaks. | Use a lockfile-with-PID-and-expiry pattern (portable), not flock. Reference `proper-lockfile` npm package or implement inline. |
| B6 | **`@`-import 4-hop limit.** If user's CLAUDE.md already has 3 hops of imports, adding ours breaks. | Session-hydrate checks CLAUDE.md's existing imports depth-first before proposing the `@import` line; if we'd exceed 4 hops, print alternative "add manually to whichever file has spare hop budget." |
| B7 | **Preflight endpoint reachability.** §19 says "preflight verifies each endpoint answers" — but current `preflight_dispatch` only constructs adapters, doesn't ping. | Add optional `verify_reachable: bool` param to `preflight_dispatch`; when true, makes a zero-token OPTIONS or trivial completion. Default true in `ci-strict.yaml`. |
| B8 | **Monorepo per-package scope mapping.** §15/§9 say tests run per-package scope covering "changed files" but the mapping from a file path to a package isn't defined. | Discovery emits `packages: [{name, root, manifest, test_scope}]`. Each packet stamps its package. Test runner walks touched files → packages → scopes. Add to §15. |

### Bucket C — Over-engineering for v1 (cut or defer)

| # | Finding | Recommendation |
|---|---|---|
| C1 | **Migration harness with `plugin/scripts/migrations/NNN_*.mjs`** for a v1 that has no prior schema. | Ship `schema_version` field in every JSON. Skip the migrator scaffold; add a one-line note in `docs/brownfield-support.md` about how migration will work if we ever need it. Migrators arrive when a v2 schema actually ships. |
| C2 | **Run archive (`_archive.tar.gz`) mentioned inline** but marked v2 in the backlog. Misleading. | Remove the archive mention from §14.2 body; keep only in v2 backlog. |
| C3 | **Concurrent-run lock** (§17). In practice, single-user single-worktree; concurrent runs happen ~never. | Defer to v1.5. v1 just uses a marker file with mtime check and prints "another run may be in progress" advisory. |
| C4 | **Cost-projection mini-gate before Phase 0** (§14.9). Requires per-intent cost heuristics we don't have data for. | Replace: at end of Gate 0, print "typical cost for this intent + baseline size: ~$X-Y" from a rough table. No dedicated gate. |
| C5 | **Security-reviewer `origin: new \| pre-existing \| unclear` tagging** (§8) requires baseline SHA per file. | v1: reviewer just runs on files touched this run. v1.5: add origin tagging. |
| C6 | **Intent matrix has 35 cells** (7 intents × 5 phases). Each cell is a real distinct behavior. Realistic v1 nails docs/bugfix/feature-extend/feature-new (proven from greenfield). | v1: full matrix filled in for the four "known" intents; refactor/test/deps get "route through closest matching greenfield behavior" + a v1.5 fast-follow to specialize. |
| C7 | **Detection of every AI tool in §16** (Cursor .mdc parsing, Aider config parsing, Copilot instructions, custom MCP naming heuristics). | v1: presence detection only + "off-limits by default." Deep parsing (glob-intersection warnings, auto-commit warning) is v1.5. The "default off-limits" gives the safety guarantee without the parsing complexity. |

### Bucket D — Unclaimed assumptions to make explicit

| # | Assumption | Where to state |
|---|---|---|
| D1 | The user has a `git` binary on PATH and the plugin's Bash calls to it succeed. | `plugin/scripts/verify-setup.mjs` — add git version check. |
| D2 | The user's Claude Code settings don't restrict Read tool on the target repo. | `verify-setup.mjs` — do a test Read at repo root; if it errors with permission, explain. |
| D3 | The `dispatch-sanitize.mjs` sweep is invoked at the MCP server layer (before every `execute_with_model` call), not from user scripts. Currently the plan says "runs on every dispatch input" without specifying where the interception lives. | State plainly in §19: sweep lives in `plugin/mcp/gemini-flash-server/src/adapters/*.ts` — wraps every provider call. |
| D4 | `SDLC_DEBUG=1` is read by every plugin script AND the MCP server. | Central env-reader at `plugin/scripts/env.mjs`; MCP server reads at startup. |
| D5 | `.sdlc/` is at repo root (git root), even in monorepos. | Already in §14.1 and §15.E but not centrally stated. Repeat in the Project state model intro. |
| D6 | Discovery agent uses ONLY local tools (Read/Glob/Grep/Bash). Never WebFetch/WebSearch. | State in `plugin/agents/discovery.md` front-matter tools list. |

### Impact summary — what changes if these fixes land

- **Files to change list grows by:** `.claude/settings.json` fragment for CI (D1/D2/A9), `plugin/scripts/env.mjs` (D4), updates to `plugin/agents/discovery.md` and `plugin/agents/orchestrator.md` fronts.
- **Files to change list shrinks by:** `plugin/scripts/migrations/` scaffold (C1), `plugin/scripts/acquire-run-lock.mjs` (C3 → v1.5), the cost-projection mini-gate wiring (C4).
- **§14.3 restructured** — session-hydrate becomes SessionStart-only, not skill-load (A8).
- **§4 restructured** — three enforcement layers relabeled as "prompt (soft) / packet validator (schema-level) / hook (hard)"; the plan should be honest that the hook is the only unbreakable line (A6).
- **§15 reworded** — placement is codegen quality, not safety enforcement (A7).
- **§2 reworded** — Tier 1 discovery includes explicit git-check ("refuse if not a git repo") (A3).
- **§14.1 renamed files** — reconcile `baseline.json` naming across sections (A1).
- **`/sdlc:run` gains a "looks like existing repo" check** (A2).

None of these changes affects v1 scope size materially — they're clarifications and simplifications. The plan gets sharper, not bigger.

---

## Locked decisions (final)

**Scope:**
- V1 intent count: **7** (`docs, bugfix, feature-extend, feature-new, refactor, test, deps`). Review-oriented capabilities (PR review, threat model, architecture review) deferred to v2 — see §6.
- §14 v1 must-haves: **all seven** (state model, ledger, staleness, git contract, provenance + `/sdlc:revert`, coexistence enforcement, versioned state).
- Discovery model: **tiered** (Tier 1 always ~10 s / Tier 2 confirm at Gate 0 / Tier 3 on-demand).

**Safety defaults:**
- File-write PreToolUse hook: **hard block by default in brownfield mode**. Escape hatch: `--strict-write=off`.
- Git-dirty: **blocks when `commit_strategy != none`, advisory otherwise**. Escape hatch: `--allow-dirty`.

**Stack coverage:**
- V1 adapters: **`generic + nest + python`**. Nest is sunk cost from greenfield; Python covers the most common brownfield stack we don't already know. Go / Rails / others fall to generic in v1 and get first-class adapters in v1.5+ as real users surface them.

**Explicitly out of scope for v1 (recorded here so future contributors don't re-litigate):**
- **Codebase Q&A / explain** — deferred to existing `understand-anything` plugin; don't reinvent.
- **Performance-investigation intent** — v2, needs profiler integration.
- **Large-migration intent** — needs multi-pass state and staged rollback; v2 or later.
- **Per-machine database of any kind** — file-based only, always.
- **Call-home telemetry** — never.

**Ready to implement.** Start with the v1 must-have list in the [Consolidated backlog](#consolidated-backlog--v1--v15--v2). Recommend implementation order: §4 write contract (unblocks all safety guarantees) → §2 discovery → §3 Gate 0 → §14.1 state model → §14.6 provenance/revert → then intent-specific work.
