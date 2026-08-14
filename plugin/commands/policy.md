---
description: "Show or change this project's active model policy. Bare: prints the current default_policy from .sdlc/project.json plus when it was set. `change`: opens the policy console in the browser (same page setup uses) to pick or author a new policy. `--policy=<name>`: silent set, no browser."
argument-hint: "[change | --policy=<name>]"
---

Show or change the project's active model policy.

**Arguments:** $ARGUMENTS

Three shapes, one script (`plugin/scripts/setup-policy.mjs`) does all three:

# Shape 1 — no args: print the current policy

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --print-only --project-root "$(pwd)"
```

This reads `.sdlc/project.json.default_policy` and prints the policy name (or an empty line if
none is set). Also read `.sdlc/project.json.last_updated_at` and include it in the message:

- If a policy is set: `Current policy: <name>   (set <last_updated_at>, change with /sdlc:policy change)`.
- If no policy is set: `No policy set yet — run /sdlc:policy change to pick one, or /sdlc:setup
  --policy=<name>.`

Do not open the browser here. Do not error. This shape is purely read.

# Shape 2 — `change`: open the console

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --project-root "$(pwd)"
```

Same script setup uses. Starts the local policy console on the first free port ≥3000, opens the
browser, watches `plugin/config/policies/` via `fs.watch`. When the user clicks Save in the
browser, the newly-written YAML fires a filesystem event and the script auto-detects it — no
need to return to the terminal to press anything. The chosen name (bare stem, no `.yaml`) then
lands in `.sdlc/project.json.default_policy` and control returns here.

Do not paraphrase or offer to skip. `change` means "open the console." If the user wants to
skip, they close the browser without saving and the script exits cleanly after a 10-minute
idle timeout with "no save detected" — nothing gets written to `.sdlc/project.json`.

# Shape 3 — `--policy=<name>`: silent set

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<name> --project-root "$(pwd)"
```

No browser. The script validates `<name>` against files in `plugin/config/policies/`, writes it to
`.sdlc/project.json.default_policy`, and exits. Fails if `<name>` doesn't exist on disk — offer
`/sdlc:policy change` to author it, or list the shipped presets (`opus-only`, `opus-plus-flash`).

# Notes

- The change is per-project. Once written to `.sdlc/project.json`, every subsequent `/sdlc:run` or
  `/sdlc:brownfield` in this folder uses the new policy. Prior runs' `provenance.json` records the
  policy that was in effect at run time — those don't get rewritten.
- To change the policy for a single ticket without touching the project's default:
  - **Interactive** (`/sdlc:brownfield`): type a different policy name at Gate 0's Policy bullet
    when reviewing the discovery summary. Accepted for that run only.
  - **Headless** (`/sdlc:pass`): pass `--policy <name>` on the command line. Same one-run scope.
  Neither path writes to `.sdlc/project.json`.
- The browser opens exactly one place in the whole flow: the `change` sub-command (and the same
  underlying script during first-time `/sdlc:setup`).
