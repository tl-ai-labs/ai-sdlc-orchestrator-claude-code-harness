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

**If it answers that the marketplace is already declared, that command did nothing — and the
next step will install a stale version.** Claude Code caches the marketplace's clone on disk and
keys the install off it, so re-adding an already-registered marketplace is a no-op that leaves
the cached copy exactly as it was, however old. Someone who set this up weeks ago and re-runs the
two prompts today gets the version from weeks ago, with none of the fixes since, and nothing in
the output says so. Refresh it explicitly before installing:

```
/plugin marketplace update tilicho-ai-labs
```

That re-fetches from GitHub. Run it whenever the add reports an existing marketplace — it is
harmless when the cache is already current.

## 2. Install the plugin

```
/plugin install multi-model-orchestrator@tilicho-ai-labs
```

Check the version it reports against `.claude-plugin/marketplace.json` on the repo's default
branch. If they differ, the refresh above was skipped; run it and install again.

The plugin's files are in place from here on, but neither its slash commands nor its bundled model
server are live in this session, and no reload makes them so: Claude Code builds the command list
and starts plugin MCP servers when a session starts. Do not go looking for a reload command —
`/reload-plugins` does not exist in the desktop app, and running it wastes the user's turn on an
error. Step 5 says what to tell them instead, and why running the pipeline here would produce a
wrong answer rather than merely an inconvenient one.

Continue with the build below. It runs as a shell command and does not need the plugin's slash
commands to exist.

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

**Where a credential is set matters as much as whether it is set.** Claude Code launched from the
desktop app does not inherit a login shell, so a variable exported in `~/.zshrc` or typed into a
terminal is invisible to it. There are two places that do work:

- **Nowhere — the Vertex path.** `gcloud auth application-default login` writes a credentials file
  to a fixed path that the plugin reads directly, and takes the Google Cloud project from that
  file's quota project. No environment variable is involved, which is why this is the option to
  offer first.
- **The `env` block of `~/.claude/settings.json`**, for anything that genuinely must be a variable
  — `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` on the AI Studio path. Claude Code reads that file at
  startup and passes the values through to the plugin's model server.

If the check reports `env-placeholders`, the variables are declared but were never set anywhere
Claude Code could see, and the server received the literal text `${GEMINI_API_KEY}` instead of a
value. The plugin now discards those and falls back to the credentials file, so the run is not
silently wrong — but the credential the user thought they had set is not in play.

**Do not offer the Antigravity agent path here.** The multi-model policy can route its mechanical
phases to Gemini as an *agent* — working in the folder directly, running commands and editing
files — instead of as a model. It needs Python 3.10 or newer and costs several times more per
task, and it is deliberately off unless someone asks for it by name. Set up the default path,
finish the handover, and point anyone who raises it at
[docs/setup.md](docs/setup.md#gemini-as-a-model-or-gemini-as-an-agent). If the user has already
set `SDLC_SELECT` themselves, the `--fix` in step 3 builds that environment as part of its normal
work and reports `agent-worker-python` or `agent-worker-sdk` if it could not. In that case the
script also ends by offering `scripts/probe-agent-worker.mjs` — pass that on as it is written.
Everything step 3 checks is offline, and the agent path's commonest failures are not missing files
but a missing Model Garden entitlement or a region that does not serve the model; both first appear
at the run's first delegated packet, once the premium phases are already billed. The probe is one
trivial delegation, about two cents, and it is the only thing here that settles them.

## 5. Hand over

State plainly what is installed, which policies are available given the credentials present, and
that the next step is a single prompt:

```
/sdlc-run
```

It takes no arguments. It asks for whatever it needs — including the project brief, which it will
write from a description if the user does not have one.

**Say this in the same breath: the command is not available in this session.** Claude Code builds
its list of slash commands when a session starts, and nothing written to disk afterwards can add
one to a session already running. The install is complete and correct; `/sdlc-run` simply arrives
one session late. Tell the user to open a new session in the same folder and type it there, where
it will be in the menu.

This boundary is not merely about the menu, and it is worth being firm about it. A session also
starts each plugin's MCP servers at startup, so in the session that performed the install, the
bundled model server is not connected either. Every dispatch to the cost-efficient tier goes
through that server. A run started here would not fail — it would quietly execute all nine phases
on the premium model and hand back a cost figure several times what the policy promises, which is
the one outcome this plugin exists to avoid. One new session is the whole remedy, and it is a
requirement, not a nicety.

Do not send the user to `/reload-plugins`. It does not exist in the Claude Code desktop app, so on
the surface where this is most likely to be read it produces a flat "isn't available in this
environment" and leaves the user with a working install and no way forward — a worse dead end than
the restart it was meant to save.

---

## Verifying later

The same script, without `--fix`, re-checks an existing install and changes nothing:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/multi-model-orchestrator/*/scripts/verify-setup.mjs | tail -1)"
```

Run it after `/plugin update`. An update re-copies the plugin from source, which removes the
build produced in step 3; re-running with `--fix` restores it.

Refresh the marketplace before updating, for the reason given in step 1 — an update reads the
cached clone, so without `/plugin marketplace update tilicho-ai-labs` it can reinstall the same
version it already has and report success:

```
/plugin marketplace update tilicho-ai-labs
```

Working from a git clone instead of an install:

```bash
npm run verify --prefix /path/to/ai-sdlc-orchestrator-claude-code-harness
```
