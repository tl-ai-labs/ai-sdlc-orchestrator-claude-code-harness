# Changelog

## Unreleased

### Breaking

- **Repo renamed** from `ai-study-workforce-ops` to `ai-sdlc-orchestrator-claude-code-harness`. Update the `git clone` URL in any scripts.
- **Layout: reference case moved under `examples/`.** `brief.md` and `passes/` at the repo root have moved to `examples/workforce-ops/brief.md` and `examples/workforce-ops/passes/`. The root `passes/` directory no longer exists.
- **Pass outputs now land under `examples/<study-id>/passes/<run-id>/`** rather than `passes/<run-id>/`. `--study` (default `workforce-ops`) picks the subdirectory under `examples/`.
- **`--auth=vendor|estimated` is now a required flag on `/run-sdlc-pass`.** It replaces the `.workforce-ops-mode` file, which has been deleted. `tools/setup.mjs` no longer persists a mode choice; it prints example invocations for both modes and lets the user pick per run.
- **`.workforce-ops-mode` removed** from the repo and from `.gitignore`. The orchestrator aborts with a clear message if `--auth` is missing on `/run-sdlc-pass`.

### Migration

- Existing `passes/pass1/`, `passes/pass2/` local outputs should be moved to `examples/workforce-ops/passes/` if you want to keep them; new runs write there by default.
- Any local `.workforce-ops-mode` file is safe to delete — it is no longer read.
- Existing invocations must add `--auth=vendor` or `--auth=estimated`:
  - was: `/run-sdlc-pass --run-id=pass1 brief.md`
  - now: `/run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md`
