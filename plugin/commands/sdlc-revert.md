---
description: "Revert the file changes made by a specific brownfield run. Reads .sdlc/runs/<run-id>/provenance.json and restores each touched file to its pre-run state, using git for tracked-committed files and a per-run backup for uncommitted ones. Refuses in dirty cases (subsequent runs touched the same files); prints a three-way diff for manual resolution instead."
argument-hint: "<run-id>"
---

Revert a specific brownfield run. Takes one required argument: the `run-id` (matches the
directory name under `.sdlc/runs/`, e.g. `20260812-193020-bugfix-a7f3c1`).

This command is destructive — it removes files this run created and restores files it edited.
Always confirm with the user before executing. Never assume `--force`.

# 1. Locate the run

Find `.sdlc/runs/<run-id>/`. If it doesn't exist, print the available run IDs (from
`.sdlc/ledger.json` or `ls .sdlc/runs/`) and exit.

Read `.sdlc/runs/<run-id>/provenance.json` — this is the authoritative record of what the run
touched. Schema (§14.6 in the plan):

```json
{
  "schema_version": 1,
  "run_id": "20260812-193020-bugfix-a7f3c1",
  "intent": "bugfix",
  "git_head_before": "abc1234...",
  "git_head_after": "def5678...",
  "commits": ["def5678..."],
  "files_touched": [
    {
      "path": "src/auth/login.ts",
      "existed_before": true,
      "sha_before": "sha256:...",
      "sha_after": "sha256:...",
      "tracked_in_git": true,
      "backup_path": null,
      "packet_id": "tp_codegen_bugfix_apply_1",
      "written_at": "2026-08-12T19:32:15Z"
    },
    {
      "path": "src/auth/login.spec.ts",
      "existed_before": false,
      "sha_before": null,
      "sha_after": "sha256:...",
      "tracked_in_git": false,
      "backup_path": null,
      "packet_id": "tp_codegen_test_add_1",
      "written_at": "2026-08-12T19:32:20Z"
    }
  ]
}
```

If provenance.json is missing or malformed, refuse cleanly: *"Cannot revert run
&lt;run-id&gt;: provenance.json is missing or unreadable. Manual revert via git-diff is the
only option."*

# 2. Check for dirty-case conflicts

Before touching anything, verify no subsequent run has modified the same files. For each file in
`files_touched`:

1. Walk `.sdlc/ledger.json` for runs AFTER this one.
2. For each later run, read its `provenance.json` and check if `path` appears in `files_touched`.
3. If yes → this is a **dirty case**. Do not proceed for this file.

Also check the working-tree state:
```bash
git status --porcelain -- <path>
```

If any listed file has uncommitted changes NOT recorded in this run's provenance
(compare `sha_after` to the current on-disk content SHA — if they differ, someone edited it
manually), that's also a dirty case.

**On any dirty case**, print a three-way diff to the user and stop before making changes:
```
File src/auth/login.ts is dirty:
  · This run wrote it (sha_after: abc...)
  · Later run 20260813-... also wrote it
  · Current on-disk content differs from both
Cannot safely auto-revert. Options:
  1. Revert the LATER run first, then re-run this command.
  2. Manually restore src/auth/login.ts to sha_before via git checkout, and continue.
  3. Skip this file — revert only the clean files (`--skip-dirty`).
Reply with 1, 2, 3, or `abort`.
```

# 3. Revert the clean files — four cases per file

For each file that passed the dirty check, apply the case per §14.6:

| Case | Signals | Revert |
|---|---|---|
| **Pre-existing, tracked, committed** | `existed_before:true, tracked_in_git:true, sha_before:<sha>` | `git checkout <baseline-sha> -- <path>` |
| **Pre-existing, tracked, uncommitted at run start** | `existed_before:true, tracked_in_git:true, sha_before:null` | Restore from `backup_path` — copy back into place |
| **Pre-existing, untracked** | `existed_before:true, tracked_in_git:false` | Restore from `backup_path` |
| **Newly created by this run** | `existed_before:false` | `rm <path>` |

The `<baseline-sha>` is `git_head_before` from provenance for the initial revert. If
`commit_strategy` was `per-gate` (recorded in the run's config), use `git revert <commit>`
instead — that produces a clean reverse-commit rather than a working-tree edit.

Run all reverts within a single "revert transaction" — collect the shell commands to run first,
show them to the user for approval, then execute them together. Print each command's result. If
any fails, halt and print what succeeded vs. what still needs manual attention.

# 4. Backup file cleanup

After a successful revert, the per-run backup copies at `.sdlc/local/cache/<run-id>/*.bak`
become obsolete. Ask the user before deleting: *"Revert complete. Delete backup copies at
.sdlc/local/cache/&lt;run-id&gt;/? Reply `yes` to delete, `no` to keep."*

Default to KEEP if user just presses enter — keeping backups is cheap and undoing an accidental
delete is expensive.

# 5. Ledger entry

Append a new row to `.sdlc/ledger.md` and `.sdlc/ledger.json`:

```
| <timestamp> | revert | — | -N files reverted (originally from run <run-id>) |
```

Include a `revert_of: <run-id>` field in the ledger.json entry. This links reverts to their
targets so future `/sdlc-audit` runs can trace them.

# 6. Do NOT

- **Do NOT** call `git reset --hard` or `git clean -fd` — those are too broad and would blow
  away unrelated work.
- **Do NOT** modify files not listed in this run's `provenance.json`, even if you suspect they
  were affected. Provenance is the authoritative record; anything outside it is not this
  run's territory.
- **Do NOT** delete the run directory `.sdlc/runs/<run-id>/`. Keep it as a record that a revert
  happened. Downstream `/sdlc-audit` needs it.
- **Do NOT** proceed if any of the four cases can't be satisfied (e.g., backup_path is null on
  an uncommitted-file case — that means backup-at-write-time failed for that file). Print
  clearly what can't be reverted and let the user decide.

# 7. Flag surface

```
/sdlc-revert <run-id>                       # interactive; confirms before every destructive step
/sdlc-revert <run-id> --skip-dirty          # revert clean files only; leave dirty ones alone
/sdlc-revert <run-id> --dry-run             # print what WOULD be done; don't execute
/sdlc-revert <run-id> --keep-backups        # skip the backup-cleanup prompt
```

No `--force`. If the user needs to override the dirty check for a specific file, they use
`git checkout <sha> -- <path>` themselves. The plugin's job is to prevent losing work
accidentally; a --force flag would defeat that.
