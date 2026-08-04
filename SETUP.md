# Setup instructions

This file is written for Claude Code to follow. A user who says

> Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness

expects the setup to happen for them. Work through the steps below in order and report the
result. The user should not have to type any command.

Requirements: Node 20 or newer, and the Claude Code CLI. Step 4 checks both and says what to do
if either is missing.

---

## 1. Register the marketplace

```
/plugin marketplace add https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness.git
```

Use the full `.git` URL rather than the `owner/repo` shorthand. Shorthand sources clone over SSH
by default, which fails for anyone without a GitHub SSH key loaded — a public repo does not need
one, so do not introduce the requirement.

The marketplace registers under the name `tilicho-ai-labs`.

## 2. Install the plugin

```
/plugin install multi-model-orchestrator@tilicho-ai-labs
```

Then reload so the command becomes available in the current session:

```
/reload-plugins
```

## 3. Build the bundled model server

**This step is required. Skipping it produces a plugin that installs cleanly and then fails
partway through the first run.**

The plugin dispatches mechanical phases to a cost-efficient model through a bundled MCP server.
The plugin manifest points at that server's build output, which is not tracked in git — a fresh
install carries the source but neither the dependencies nor the build. Until this step runs, the
configured server path does not exist.

Locate the installed plugin and run its setup script:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)" --fix
```

`--fix` installs the server's dependencies and builds it. The script re-checks afterwards and
exits non-zero if the plugin still cannot run.

## 4. Read the result and tell the user where they stand

The script reports three kinds of finding:

- **`✗` blocking** — the plugin cannot run. Node older than 20, a missing Claude Code CLI, or a
  server build that failed. Each carries the command that fixes it. Resolve these before
  continuing.
- **`!` warning** — the plugin runs, but some policies will not. Missing credentials are
  reported here, never written on the user's behalf. Ask the user for whichever they need:
  - `ANTHROPIC_API_KEY` — required for vendor-billed runs, where reported costs reconcile
    against the Anthropic console. Not required when the user is signed in to a Claude Code
    subscription and runs under subscription auth.
  - Gemini access — required by any policy that routes mechanical phases to Gemini. The
    Claude-only policy does not need it. There are two ways in, and either satisfies the check:
    `gcloud auth application-default login` for Vertex AI on a Google Cloud project, which uses
    no key at all; or `GEMINI_API_KEY` for the AI Studio path. Offer the Vertex option first to
    anyone who already has a Google Cloud project — it bills that project and needs no secret
    on disk.
- **`✓`** — setup is complete.

## 5. Hand over

State plainly what is installed, which policies are available given the credentials present, and
that the next step is a single prompt:

```
/sdlc-run
```

It takes no arguments. It asks for whatever it needs — including the project brief, which it will
write from a description if the user does not have one.

---

## Verifying later

The same script, without `--fix`, re-checks an existing install and changes nothing:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)"
```

Run it after `/plugin update`. An update re-copies the plugin from source, which removes the
build produced in step 3; re-running with `--fix` restores it.

Working from a git clone instead of an install:

```bash
npm run verify --prefix /path/to/ai-sdlc-orchestrator-claude-code-harness
```
