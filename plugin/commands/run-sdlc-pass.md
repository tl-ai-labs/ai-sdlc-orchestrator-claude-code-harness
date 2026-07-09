---
description: "Run the AI-SDLC workflow end-to-end. Reads a project brief and drives requirements, design, codegen, tests, docs, and reviews under the loaded policy. Premium-judgment phases stay on the subagent's own tier; mechanical phases dispatch to the policy's mechanical model. Configurable via --policy, --study, --run-id."
argument-hint: "[--policy=<name>] [--study=<study-id>] [--run-id=<run-id>] <path-to-brief.md>"
---

Invoke the `orchestrator` subagent to execute one full SDLC run.

**Arguments:** $ARGUMENTS

**Argument parsing (the orchestrator must do this):**
- `--policy=<name>` — routing policy name. Defaults to `opus-only`.
- `--study=<study-id>` — case-study identifier. Optional; defaults to `workforce-ops`.
- `--run-id=<run-id>` — run identifier within the study. Optional; defaults to `pass1`.
- The remaining positional argument is the path to the brief file.

**Output paths:**
- `pass_id`: `<run-id>`
- `output_dir`: `passes/<run-id>/`
- `telemetry_path`: `passes/<run-id>/telemetry.jsonl`
- `manifest_path`: `passes/<run-id>/manifest.json`
- `cache_context`: `<run-id>:<study-id>` (used to key the mechanical-tier prompt cache)

If `passes/<run-id>/` already exists, its contents will be overwritten. Use a new `--run-id` to preserve prior data.

**Single-model runs** — to author every phase with one model (e.g. an "Opus only" baseline), pass a policy whose `rules:` list has only a default rule routing to that model. The same command flow runs; the routing table just does not fork.

**Policy resolution:** the orchestrator loads the policy YAML from `plugin/config/policies/<policy>.yaml` and uses it for every routing decision in this run.

**Requirements before starting:**
- `GEMINI_API_KEY` env var must be set when the policy uses any Gemini model; if absent, abort with a clear message.
- `ANTHROPIC_API_KEY` env var must be set when the policy uses any Claude model. If you are signed in to a Claude Code subscription, Claude Code provides this for you and the variable does not need to be exported. It IS required for `claude --print` (headless) invocations.
- The MCP server `gemini-flash-server` must be registered (it is, via the plugin manifest).

**HITL gates active:** Gate 1 (requirements), Gate 2 (design), Gate 3 (security review), Gate 4 (final acceptance).

When invoked headlessly (e.g. via `claude --print "/run-sdlc-pass ..." --output-format stream-json --verbose`), all four HITL gates auto-approve so the session can complete end-to-end without prompts.

Begin now.
