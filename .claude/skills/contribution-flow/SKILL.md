---
name: contribution-flow
description: Follow this repo's contribution rules — branching (main/develop, feat/fix/docs/chore branches), conventional commits, PR flow, squash-merge policy, post-merge develop sync, and Claude-alone guardrails. Invoke on "/contribution-flow", "before I commit", "before I push", "before I PR", "how do I merge this", or before any git operation that touches a branch, a shared commit, or a PR. When in doubt about branching or commit hygiene on this repo, load this skill.
---

This repo publishes an open-source Claude Code plugin to the marketplace. Every commit on `main` is pulled by end users the next time they run `/plugin marketplace update tilicho-ai-labs`. That's why the rules below matter: sloppy history on `main` is a shipped defect.

You are Claude working on this repo. Most contributors here drive their work through you; the rules below are the enforcement layer, not GitHub. Read the whole file before your first git action of a task, then act.

## Branching model

Two long-lived branches, one direction:

| Branch | Role | Accepts merges from |
|---|---|---|
| **`main`** | Release. Marketplace pulls this. Every commit is assumed to be a working release. | `develop` only, one PR per release cut. Never a feature branch directly. |
| **`develop`** | Integration. Point-in-time snapshots may be broken; that's what develop is for. | Any feature/fix/docs/chore branch. |

Feature branches:

| Prefix | Use for |
|---|---|
| `feat/<short-name>` | New features, new adapters, new policies. |
| `fix/<short-name>` | Bug fixes. |
| `docs/<short-name>` | Doc-only changes. |
| `chore/<short-name>` | Plumbing, tooling, refactors with no user impact. |

Names are kebab-case, short (2–4 words), descriptive of the change. `feat/policy-picker` — not `feat/PolicyPickerFinalV2Attempt3`.

Rules:

- Feature/fix/docs/chore branches always PR into **`develop`**, never `main` directly.
- The only PR that targets `main` is a `develop → main` promotion, opened by someone cutting a release.
- Never `git push` directly to `main` or `develop`. Every change to those branches arrives through a merged PR.
- Never `git push --force` on `main` or `develop`. Force-push on your own feature branch is fine before it's under review.
- Never skip commit hooks (`--no-verify`, `--no-gpg-sign`) unless the user has explicitly asked for it. Fix the underlying issue instead.

**Exception during branching-model rollout.** Until [CONTRIBUTING.md](CONTRIBUTING.md) merges the branching-model section (currently on the `docs/branching-model` PR), main is the only long-lived branch on the trunk. Confirm with the user which target to use for a given PR if you're unsure; do not assume.

## Conventional commits

Commit subjects and PR titles must match `type(scope): subject`. The `type` is one of:

| Type | Use for |
|---|---|
| `feat` | New feature or capability. |
| `fix` | Bug fix. |
| `docs` | Documentation-only change (README, docs/, CONTRIBUTING, CLAUDE.md). |
| `chore` | Plumbing, tooling, dependency bump, config, non-user-facing refactor. |
| `refactor` | Restructure code without changing behavior. |
| `test` | Add or fix tests only. |
| `perf` | Performance improvement. |
| `build` | Build system or packaging changes. |
| `ci` | CI configuration and scripts. |
| `style` | Formatting-only changes (no logic). |
| `revert` | Revert a previous commit. |

`scope` is optional but preferred: the module, area, or component being touched. Examples from this repo's history: `chore(house-style)`, `docs(contributing)`, `feat(policy)`, `feat(adapter)`, `refactor(rename)`.

Subject rules:

- Present tense, imperative mood: `add X`, `fix Y`, `document Z`. Not `added`, `adding`, `adds`.
- Lowercase first word (after the `type(scope):` prefix).
- No trailing period.
- ≤72 characters if you can. Break long stories into the body.
- Breaking change: append `!` to the type/scope — `refactor(rename)!: sdlc → mmo across commands`.

Body rules:

- Blank line after the subject.
- Explain *why*, not *what* (the diff shows what).
- Wrap at ~72 columns for readability in `git log`.
- Reference issues in the body (`Refs #123`, `Closes #456`), not the subject.

**No AI attribution trailers.** [CONTRIBUTING.md](CONTRIBUTING.md) forbids `Co-Authored-By: Claude <…>` and similar. Do not add them.

## PR flow

**Before opening a PR:**

1. `git status` — nothing accidentally staged.
2. `npm test` from the repo root. Must pass. The only currently-failing tests on `main` are the two `publish.test.mjs` cases (`no other organisation repository`, `no personal contact details`); confirm you are not adding to that count.
3. `git diff <target-branch>...HEAD` — read what's actually in the PR. Look especially for accidentally-staged secrets, `.env` files, or lockfile churn.

**Opening the PR:**

- **Target branch is `develop`** for `feat/`, `fix/`, `docs/`, `chore/` branches. Only release cuts target `main`.
- **PR title = the future squash-merge commit subject.** It must be a valid conventional-commit subject. If it isn't, GitHub will accept the PR but the merged commit on the target branch will be malformed. Get this right at PR-open time.
- **PR body** uses two sections:
  ```markdown
  ## Summary
  - One to three bullets: what changed and why.

  ## Test plan
  - [x] `npm test` at baseline.
  - [x] Manually verified <specific behavior>.
  ```
- One topic per PR. If your work touches two unrelated areas, split.

**During review:**

- Push follow-up commits to the same branch; do not rebase-and-force-push after a review has started. Reviewers lose their comment anchors.
- Resolve conversations only after acting on them (edit the code, or reply explaining why not).

## Squash-merge policy

**All PRs merge via "Squash and merge" — one clean commit per PR on the target branch.**

- Never "Create a merge commit" — pollutes `git log` with a merge node and per-commit noise from the feature branch.
- Never "Rebase and merge" — spreads the PR's history across the target branch's log; loses the PR boundary.
- Squash-merge uses the PR title as the commit subject. This is why the PR title must be a valid conventional commit — the resulting commit on `main` or `develop` inherits it verbatim.

The GitHub repo currently allows all three merge options (not yet configured to squash-only). Regardless, always pick "Squash and merge" — or use `gh` when merging via CLI:

```bash
gh pr merge <number> --squash --delete-branch
```

`--delete-branch` deletes the source branch after merge. Do this unless there's a reason to keep the branch around.

## Post-merge cleanup

**Every merge:**

- Delete the source branch (either via `--delete-branch` on `gh pr merge`, or the "Delete branch" button on the merged PR page).
- Locally: `git checkout develop && git pull` to move off the now-deleted branch.

**When a `develop → main` release cut merges:**

Sync `develop` back to the new `main` tip so future feature branches start from an up-to-date base:

```bash
git checkout develop
git fetch origin
git merge --ff-only origin/main
git push origin develop
```

Fast-forward only — `--ff-only` refuses to create a merge commit. If it fails, someone pushed to `develop` between the release cut and now; investigate before forcing.

## Claude-alone guardrails

Most work on this repo goes through Claude. That means Claude is the enforcement layer for the rules above — GitHub is not (yet) configured to reject them. Before any action that touches shared state:

- **`git push origin <branch>`** — confirm the branch name follows the prefix rules; confirm you are pushing your own feature branch, not `main` or `develop`.
- **`gh pr create`** — confirm the target branch (`--base develop` for feature work; `--base main` only for release cuts, and only when the user has said so); confirm the title is conventional-commit-shaped.
- **`gh pr merge`** — confirm `--squash --delete-branch`; confirm the merge is authorized by the user for this specific PR (a prior "yes" does not carry to a new PR).
- **`git push --force`** — refuse on `main`/`develop`. On a feature branch, only when the user has asked, and only when no review has started.
- **`git reset --hard`, `git clean -fd`, `rm -rf` in the repo** — run `git status` first; stash (with `-u` for untracked) anything present.

Never do any of these silently as part of another task:

- Delete branches (local or remote)
- Merge PRs
- Push to `main` or `develop`
- Amend or force-push a branch under review
- Commit files matching `.env`, `*.pem`, `id_rsa*`, `credentials*`, or anything that looks like a secret — even if the user staged them. Ask.

## Common flows — copy-paste recipes

**Start a new task:**

```bash
git checkout develop
git pull origin develop
git checkout -b <type>/<short-name>
```

**Open the PR (after committing and pushing):**

```bash
gh pr create --base develop \
  --title "<type>(<scope>): <subject>" \
  --body "$(cat <<'EOF'
## Summary
- <bullet>

## Test plan
- [x] npm test
EOF
)"
```

**Merge your own PR (with user confirmation):**

```bash
gh pr merge <number> --squash --delete-branch
```

**Release cut (`develop → main`):**

```bash
git checkout develop
git pull origin develop
gh pr create --base main --head develop \
  --title "release: <version-or-summary>" \
  --body "..."
# After merge:
git checkout develop && git fetch origin && git merge --ff-only origin/main && git push origin develop
```

## Related

- [CONTRIBUTING.md](CONTRIBUTING.md) — the human-readable version of these rules (branching section lands with the `docs/branching-model` PR).
- [.claude/skills/house-style/SKILL.md](.claude/skills/house-style/SKILL.md) — sibling maintainer skill for writing conventions.
- `tools/test/style.test.mjs` — enforces the house style at test time. Run via `npm test`.
