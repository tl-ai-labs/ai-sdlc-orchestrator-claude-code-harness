---
description: "Re-verify or re-configure the SDLC plugin for this project. Runs the mechanical setup steps silently (MCP server build, environment check, credential probe), pauses only when a human decision is genuinely needed (missing credentials, Gemini door choice, policy pick). Idempotent — safe to re-run any time after `/plugin update` or when a credential changes."
argument-hint: "[--policy=<name>] [--gemini-door=enterprise|antigravity] [--user]"
---

Re-verify the SDLC plugin for this project. Auto-by-default: run the mechanical steps silently and
pause only when a human decision is genuinely required.

**Arguments:** $ARGUMENTS

**Argument parsing:**
- `--policy=<name>` — pre-answer the policy pick (skips the browser). Must match a file in
  `plugin/config/policies/<name>.yaml` (shipped presets: `opus-only`, `opus-plus-flash`).
- `--gemini-door=<enterprise|antigravity>` — pre-answer the Gemini door choice. `enterprise` is the
  API-key / ADC path (default); `antigravity` opens the Antigravity SDK worker (requires ADC).
- `--user` — write the Gemini-door selection to `~/.claude/settings.json` (all folders on this
  machine) instead of the project-local `.claude/settings.local.json`.

# Scope

This is the RE-VERIFY / RE-CONFIGURE command. First-time install (marketplace add + `/plugin
install`) still lives in [SETUP.md](../../SETUP.md) — the plugin has to exist before its slash
commands do. `/sdlc:setup` covers everything from step 3 of SETUP.md onward: MCP server build,
environment check, credential probe, Gemini door, policy pick, and the hand-over banner.

Every step below auto-runs unless it hits a genuine decision. Print one line per completed step,
so the user can see progress. Pause only when a step actually needs a human answer.

# 1. Build / rebuild the MCP server (silent)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-setup.mjs" --fix --project-root "$(pwd)"
```

`--fix` installs the MCP server's npm deps and TypeScript-compiles it. Idempotent — no-op if the
build is already current. Report the one-line result and continue.

If the script exits non-zero, print the error, its `fix:` field, and STOP. This is a blocking
issue (Node < 20, missing Claude Code CLI, a build error) and must be resolved before anything
downstream can work.

# 2. Read the verify result and pause only for missing credentials

The script reports three kinds of finding:

- `✗` **blocking** — already handled by step 1 above (STOP).
- `!` **warning** — usually a missing credential. **Pause here.** For each warning, print the
  finding and ask the user for the value. Do not fabricate; do not proceed to the next step until
  the credential is either supplied or explicitly skipped.
  - `ANTHROPIC_API_KEY` — required for vendor-billed runs. Not required under subscription auth.
  - Gemini access — required by any policy that routes mechanical phases to Gemini. Two doors,
    see step 3 below.
- `✓` **ok** — no action, continue.

Write supplied credentials to the `env` block of `~/.claude/settings.json` (or use
`gcloud auth application-default login` for the Google Cloud path — no env var involved). Never
write `SDLC_SELECT` by hand; step 3 handles it.

# 3. Gemini door — auto-pick if only one works, ask only if both are available

The mechanical tier has two doors to the same model:

- **Gemini Enterprise Agent Platform (API)** — signs with `GEMINI_API_KEY` or Google Cloud ADC.
  This is what an untouched install already uses. No flag needed.
- **Antigravity SDK worker** — signs with Google Cloud ADC only (no API-key door). Enables
  agentic delegation with a working directory.

Decision matrix:

| `--gemini-door=` supplied? | ADC present? | `GEMINI_API_KEY` present? | Action |
|---|---|---|---|
| yes | any | any | Honor the flag. If it can't work (`antigravity` without ADC), print why and STOP. |
| no | no | no | No Gemini creds at all. Print the one-liner from SETUP.md §5 explaining how to open either door, and continue — the policy pick in step 4 can still run against Anthropic-only. |
| no | no | yes | Silently use `enterprise` (the only door that works). Continue. |
| no | yes | no | Silently use `enterprise` still (default behavior; the user can flip to `antigravity` later by re-running with `--gemini-door=antigravity`). Continue. |
| no | yes | yes | Ambiguous — **ask** which door. Two options only, no descriptions: (a) Gemini Enterprise Agent Platform (API), (b) Antigravity SDK worker. |

When switching to Antigravity:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-setup.mjs" --enable-agent --project-root "$(pwd)"
```

Add `--user` if the caller passed `--user`. This writes `SDLC_SELECT=gemini-flash=flash-agsdk-worker`
to the settings file and builds the Python environment the agent path needs.

# 4. Policy pick

Read the current default: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --print-only
--project-root "$(pwd)"`. If it prints a policy name, the project already has one — print
`current policy: <name>` and skip to step 5.

If `--policy=<name>` was supplied, honor it silently — no prompt, no browser:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<name> --project-root "$(pwd)"
```

**Otherwise, ASK the user with these four options in this exact order.** Use whatever picker the
main-loop provides (`AskUserQuestion` is fine). The browser is the FIRST option — do not skip it
in favor of the two presets, and do not collapse this step into a two-preset picker.

1. **Open the browser to author or customize a policy (Recommended)** — the only path to a
   non-preset policy. Runs:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --project-root "$(pwd)"
   ```
   The script starts a local server, opens the browser, and detects the save automatically via
   filesystem watch — no need to switch back to the terminal.
2. **Use `opus-plus-flash`** — shipped preset: Claude Opus for judgment phases, Gemini Flash for
   mechanical. The cost-efficient default. Runs `setup-policy.mjs --policy=opus-plus-flash …`.
3. **Use `opus-only`** — shipped preset: Claude Opus for every phase. Highest cost, single-model
   baseline. Runs `setup-policy.mjs --policy=opus-only …`.
4. **Skip — set later with `/sdlc:policy change`** — leaves `default_policy` unset. Subsequent
   `/sdlc:run` and `/sdlc:brownfield` will refuse to start until a policy is picked.

Do not suggest "Type something" as a hidden fifth option — the user's typed name may not match a
shipped preset, which fails downstream. The four options above cover every real path.

# 5. Print the next-steps banner

The script from step 1 already prints this at the end of a successful run. If for any reason it
did not (e.g. the run stopped short earlier), print it explicitly:

```
✓ Setup complete for this project.

Try one of these in a NEW session in the same folder:

  /sdlc:run          — generate a new app from a brief (empty folder)
  /sdlc:brownfield   — work on this existing repo (docs, bugfix, feature, refactor, …)
  /sdlc:policy       — change this project's model policy
  /sdlc:pass         — headless/scripted run (for CI or replays)

Current policy: <policyName>   (change: /sdlc:policy change)
```

Say plainly why a NEW session is required: Claude Code builds the slash-command list and starts
plugin MCP servers at session boot. In this session the setup changes are on disk but not live.

# Idempotency

Every step is safe to re-run:
- The MCP build is a `tsc` no-op if nothing changed.
- The credential probe reads env / settings; it never writes.
- The Gemini-door flip is a plain settings write.
- The policy pick reads `.sdlc/project.json` first and skips the browser if a policy is already set.

Re-run `/sdlc:setup` after `/plugin update` (the update wipes `dist/`; `--fix` restores it), or
whenever a credential changes.
