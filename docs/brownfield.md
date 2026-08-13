# Brownfield mode — overview

The AI-SDLC Orchestrator plugin ships in two modes:

- **Greenfield** (`/sdlc:run`) — generates a whole new application from a project brief into an
  empty folder. This is what the plugin was originally built for.
- **Brownfield** (`/sdlc:brownfield`) — extends an existing repository. Pick one of seven job
  types (docs, bugfix, feature-extend, feature-new, refactor, test, deps), confirm scope at
  one Gate 0 confirmation screen, run the pipeline with a non-destructive write contract that
  guarantees off-limits files stay untouched.

Both modes share the same install (SETUP.md), same policies (`opus-only` / `opus-plus-flash`),
same MCP dispatch layer. What differs is what happens after the setup check completes.

This doc walks brownfield end-to-end. For the greenfield equivalent see [/sdlc:run's operating
manual](../plugin/commands/run.md).

---

## The 20-second version

```
$ claude
  (opens Claude Code in your project directory)

/sdlc:brownfield
  1. Session-hydrate — shows prior runs, checks for resume state
  2. Pipeline pre-check (first time / when baseline stale) — 6 smoke steps
  3. Discovery — reads your repo (Tier 1, ~10s; Tier 2b adaptive if custom stack)
  4. Intent brief interview — pick a job type + describe it
  5. Gate 0 — one confirmation: stack, test command, off-limits, intent, scope
  6. Pipeline — requirements → (architecture) → packet plan → execute → review → tests → security → report
```

Two prompts total from installation to done: `Setup this plugin from…` then `/sdlc:brownfield`.
That's the whole contract. Every setup step (env checks, credential shepherd, discovery, pre-
check, baseline save) folds into those two — no `/sdlc-precheck`, `/sdlc-doctor`, or other
sub-commands to remember.

---

## Gate 0 walkthrough

Gate 0 is the one confirmation between "we read your repo" and "we start doing work." It shows
you five things — you approve, revise, or abort:

- **Stack** — what we detected. Confirm or override.
- **Test command** — what we detected from your `package.json` scripts / `pytest.ini` / etc.
  Accept or paste your own.
- **Existing AI setup** — verbatim list of Cursor rules / `.mcp.json` / competing configs we
  found. **Default is OFF-LIMITS** for all of them — the plugin will not touch these unless
  you explicitly move them into scope.
- **Intent** — which of the seven job types.
- **File scope** — the allowlist (paths we'll edit) and off-limits (paths we absolutely
  won't). Edit either.

Approve → the plugin freezes this into `.sdlc/local/write-contract.json` and the PreToolUse
hook uses it to refuse any write outside the confirmed allowlist. See
[brownfield-write-contract.md](brownfield-write-contract.md) for the enforcement details.

Revise → tell the plugin what to change, it re-shows Gate 0.

Abort → clean exit. The run directory stays as a partial record but no files in your source
tree are touched.

---

## Coexistence guarantees

The plugin will **never**:

- Modify your `.env` or any file matching `.env.*` (values are yours; the plugin only appends
  new required-key NAMES to `.env.example`).
- Modify a `routing-policy.yaml` that already exists at repo root (it silently uses yours;
  Gate 0 always shows you when this happens).
- Modify `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, or any
  file inside `.mcp.json` unless you explicitly moved them into the allowlist at Gate 0.
- Modify submodules, files marked by `.gitattributes` as LFS, or anything gitignored by your
  `.gitignore`.
- Run other developers' tools on your behalf (`prettier --write`, `eslint --fix`, etc.) — we
  run the project's own format command only on files we wrote, and only right after writing
  them. Never on your unmodified code.
- Commit or push git changes unless you configured `commit_strategy` explicitly in
  `.sdlc/project.json` (defaults: no commits, no PRs, work on current branch).

See [brownfield-coexistence.md](brownfield-coexistence.md) for how these guarantees are enforced.

---

## What lives in `.sdlc/`

The plugin's per-project state. Split into committed (team-shared) and gitignored (personal):

```
.sdlc/
├── project.json          — canonical fingerprint (committed; team edits via PR)
├── policy.yaml           — optional team policy override (committed)
├── ledger.md             — append-only human-readable run history (committed)
├── ledger.json           — machine mirror of the ledger (committed)
├── CLAUDE-SDLC.md        — plugin-owned CLAUDE-scoped context (committed)
├── runs/                 — per-run frozen records (committed)
│   └── <YYYYMMDD-HHMMSS-<intent>-<slug>>/
│       ├── intent_brief.md
│       ├── discovery.md
│       ├── baseline.json
│       ├── requirements.md
│       ├── change_plan.md
│       ├── packets.jsonl
│       ├── provenance.json
│       ├── telemetry.jsonl
│       ├── senior-review.md
│       ├── security-review.md
│       └── final_report.md
├── baseline/             — living project baseline (committed)
│   ├── current.json
│   ├── discovery.md
│   └── stack-profile.md  — only when adaptive profile ran
└── local/                — gitignored: personal per-developer state
    ├── state.json        — live state machine
    ├── setup-status.json — shepherd resume state
    ├── write-contract.json — active run's allowlist/off-limits
    ├── user-policy.yaml  — personal policy override
    ├── cache/            — per-run backup copies for /sdlc:revert
    └── debug.log
```

Uninstalling the plugin is `rm -rf .sdlc/` plus removing the one `@import` line from your
`CLAUDE.md` (the cleanup script does both).

---

## Where to go next

- **Understand the write contract** → [brownfield-write-contract.md](brownfield-write-contract.md)
- **Coexistence with your other AI tools** → [brownfield-coexistence.md](brownfield-coexistence.md)
- **Data flow, privacy, regulated repos** → [brownfield-privacy.md](brownfield-privacy.md)
- **Setup-time issue inventory (all 17 known risks)** → [brownfield-setup-issues.md](brownfield-setup-issues.md)
- **Model-per-task routing** → [brownfield-routing.md](brownfield-routing.md)
- **Full engineering design (26 sections)** → [brownfield-v1-planning/plan.md](brownfield-v1-planning/plan.md)
