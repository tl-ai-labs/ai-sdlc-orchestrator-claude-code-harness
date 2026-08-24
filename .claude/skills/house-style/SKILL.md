---
name: house-style
description: Enforce this repo's writing conventions on docs prose and source comments. Invoke on "/house-style", "style sweep", "check docs style", "clean up comments", or after substantial edits to user-facing docs or to `plugin/**` / `tools/**` source. Sweeps the in-scope file set, applies the fixes, and confirms `npm test` still passes.
---

You are following this operating manual to bring the repo into compliance with its writing conventions. The conventions themselves live in [CLAUDE.md](CLAUDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md); the enforcement gate lives in [tools/test/style.test.mjs](tools/test/style.test.mjs). This skill turns the rules into an actionable sweep.

Work through the sections in order. Do not skip the baseline check or the final `npm test`.

## Scope

Two regimes. The rules differ per bucket.

| Regime | In-scope paths |
|---|---|
| **Docs prose** | `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/**/*.md` (recursive, including `docs/specs/`, `docs/planning/`, `docs/*-v1-planning/`) |
| **Source comments** | `plugin/**` and `tools/**` matching `\.(ts\|mjs\|py)$` |

Excluded — do not touch and do not scan:

- `SETUP.md`
- `plugin/{commands,agents,skills}/**` (Claude-instruction files where third-person `the user` is correct)
- `.claude/skills/**` (this skill itself and any sibling maintainer skills, same reason)
- `docs/walkthroughs/`, `docs/assets/`
- `examples/*/passes/`, `plugin/examples/`
- `.claude/` (aside from `.claude/skills/` above), `.sdlc/`, `src/`
- `node_modules/`, `dist/`, `.venv/`, `__pycache__/`
- `*.test.mjs`

## Docs prose rules

For every in-scope docs file:

**Second person, present tense.**

- Rewrite `the user should X` → `you X`.
- Rewrite `if user does X` → `if you do X` (missing article is also flagged by the test).
- Do not use `we`, `our`, or `let's` for the reader-facing voice. Statement of fact instead: `we found that…` → `X is…`. Restricted verbs the test catches: `we/our detect|tell|append|write|check|plan|see|found|do|read|run|wrote`.

**Banned slop terms** (verbatim from [tools/test/style.test.mjs](tools/test/style.test.mjs); case-insensitive, whole-word):

| Term | Replace with |
|---|---|
| `seamless`, `seamlessly` | Delete or name the specific mechanism (e.g., "no config required") |
| `powerful` | Delete or state what it actually does |
| `leverage`, `leverages`, `leveraging` | `use`, `uses`, `using` |
| `unlock`, `unlocks` | `enable`, or delete |
| `elegant`, `elegantly` | Delete |
| `production-grade` | Delete or state the specific property (e.g., "handles retries") |
| `battle-tested` | Delete or cite the actual usage evidence |
| `robust`, `robustly` | Delete or state the failure mode it handles |
| `thoughtful`, `thoughtfully` | Delete |
| `graceful`, `gracefully` | Delete or name the fallback |
| `as demonstrated` | Delete (throat-clearing) |
| `in summary` | Delete (throat-clearing) |

**No throat-clearing intros.** Not test-caught today but required by CLAUDE.md. Flag lines opening with:

- `^This (document|page|guide|section|README)`
- `^In this (document|section|guide)`
- `^Here('s| is) how`
- `^We('re| will|'ll)? (going to|now|about to)`

Rewrite by deleting the line and opening with the concrete claim, or by replacing the meta framing with what the reader gets. Example: `This page is the reference for /mmo:pass.` → `## /mmo:pass reference` (heading + table) or `Run` `/mmo:pass <brief>` `to…`.

**No trailing summaries.** Delete `## Summary`, `## In summary`, or paragraphs recapping what was just said.

**Tables over prose for reference material.** Config keys, env vars, failure modes, phases, CLI flags — table first. Prose only when a table can't carry the meaning.

**Copy-paste-runnable code.** Real paths, real commands, real env vars. `<placeholder>` is only allowed if labelled and explained.

## Source-comment rules

For every in-scope source file under `plugin/` and `tools/`:

**Default to no comment.** If the identifier and structure make the intent clear, delete the comment. This is the strongest rule.

**Comment only for non-obvious WHY.** Legitimate reasons:

- A hidden constraint the reader would violate (`must run before X sets the env var`).
- A subtle invariant (`caller holds the lock; do not acquire here`).
- A workaround for a specific bug (`Node 20.9 crashes on this pattern — see nodejs/node#…`).

**No essay-length block comments.** If a comment spans more than ~3 lines or reads as a narrative, one of:

- Compress to one WHY line.
- Move the reasoning to [docs/architecture.md](docs/architecture.md) and leave a one-line pointer.
- Delete if the WHY is obvious.

**No incident narratives.** `This broke on 2026-08-04 because…` belongs in the commit message and PR description, not in the code forever. Same for `Added for the X flow`, `Used by Y`, `Handles the case from issue #123` — those rot as the codebase evolves.

**Same slop-word ban.** All banned docs terms above are also banned in comments and docstrings; the test scans both.

## Sweep workflow

Run these steps in order. Do not batch or reorder.

**1. Baseline.** Run the style test alone to see the current state:

```bash
npm test -- --test-name-pattern='style'
```

Record the pass/fail count. Every fix you make must reduce failures or leave them unchanged; no new failures.

**2. Grep banned terms across docs and source.**

```bash
grep -rniE '\b(seamless(ly)?|powerful|leverage(s|ing)?|unlock(s)?|elegant(ly)?|production-grade|battle-tested|robust(ly)?|thoughtful(ly)?|graceful(ly)?|as demonstrated|in summary)\b' \
  README.md CONTRIBUTING.md CLAUDE.md CODE_OF_CONDUCT.md SECURITY.md \
  docs/ plugin/ tools/ \
  --include='*.md' --include='*.ts' --include='*.mjs' --include='*.py' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.venv --exclude-dir=__pycache__ \
  --exclude-dir=walkthroughs --exclude-dir=assets --exclude-dir=examples --exclude-dir=passes \
  --exclude-dir=commands --exclude-dir=agents --exclude-dir=skills \
  --exclude='*.test.mjs'
```

**3. Grep third-person and first-person plural in docs.**

```bash
grep -rniE "\bthe user\b|\bif user\b|\b(we|our)\s+(detect|tell|append|write|check|plan|see|found|do|read|run|wrote)\b" \
  README.md CONTRIBUTING.md CLAUDE.md CODE_OF_CONDUCT.md SECURITY.md docs/ \
  --include='*.md' --exclude-dir=walkthroughs --exclude-dir=assets
```

Note: `the user's` (possessive) and `the user-facing` (compound) are excluded by the test regex `(?!['-])` and are fine.

**4. Grep meta-intros.**

```bash
grep -rniE "^(This (document|page|guide|section|README)|In this (document|section|guide)|Here('s| is) how|We('re| will|'ll)? (going to|now|about to))" \
  README.md CONTRIBUTING.md CLAUDE.md CODE_OF_CONDUCT.md SECURITY.md docs/ \
  --include='*.md' --exclude-dir=walkthroughs
```

**5. Fix each hit.** For every line the greps surface:

- Read the surrounding paragraph (not just the line) so you understand what the sentence is trying to say.
- Apply the rewrite recipe from the tables above.
- Edit in place. Do not stack fixes across files without reading each one first.

**6. Scan source-comment density.** Not grep-friendly. Instead, list source files by comment line count and eyeball the top ~10:

```bash
for f in $(find plugin/ tools/ -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.py' \) \
  | grep -v node_modules | grep -v dist | grep -v .venv | grep -v __pycache__ \
  | grep -v /commands/ | grep -v /agents/ | grep -v /skills/ | grep -v /examples/ \
  | grep -v .test.mjs); do
  count=$(grep -cE '^\s*(//|#)' "$f")
  echo "$count $f"
done | sort -rn | head -20
```

For each of the top files, Read it and apply the source-comment rules: delete comments that state the WHAT, compress essay blocks, remove incident narratives.

**7. Re-run the full test.**

```bash
npm test
```

Every previously passing test must still pass. Style tests (`slop-in-docs`, `third-person-in-docs`, `slop-in-source-comments`) must be clean. Pre-existing unrelated failures (e.g., `publish.test.mjs` checks for org repository / personal contact details) are out of scope for this sweep — do not attempt to fix them here.

**8. Report.** Summarize per file: which lines you changed, which rule they violated. Flag anything you left alone with the reason (e.g., "hit is inside a fenced code block quoting an anti-example — inline-code stripping did not apply because it was a fenced block").

## Do not

- Do not touch `plugin/{commands,agents,skills}/**`, `SETUP.md`, `docs/walkthroughs/`, `examples/*/passes/`. Those are Claude-instruction or historical-record surfaces excluded by design.
- Do not widen the style-test globs in the same pass. If the sweep reveals the test should also cover `docs/**` recursively (currently only top-level `docs/*.md` is scanned), that is a separate PR.
- Do not remove comments you don't understand. If a comment names a bug, invariant, or workaround, keep it — even if terse. The rule bans essays, not signal.
- Do not `git commit` when the sweep finishes. Leave the diff for the maintainer to review.
