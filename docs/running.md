# Running

This page is the reference for `/sdlc:pass` — the same run as `/sdlc:run` or `/sdlc:brownfield`, but with every setting exposed as a flag. Useful for repeat runs, for scripting, and for understanding what the interactive commands chose for you. If you installed the plugin, start with `/sdlc:run` (greenfield) or `/sdlc:brownfield` (existing repo) in a new session — Claude Code registers slash commands and starts plugin MCP servers only at session start, so the session that installed the plugin does not yet see them.

Two policies ship with this repository. Pick one to start.

## Policies

### `opus-only` — premium-ceiling baseline

Every phase of the SDLC runs on Claude Opus 4.7. There is no delegation and no cost-saving routing. The number this pass produces is the "what does it cost if I use one top-tier model for everything?" line.

**Wall-clock:** about 1 – 1.5 hours (depends on model latency and HITL redirections).

**When to pick it:** you want a clean baseline for comparison, or you don't have a Gemini key handy.

### `opus-plus-flash` — the multi-model pass

Opus handles phases that require judgment (requirements, design, senior code review, security review). High-volume mechanical phases (codegen, tests, docs) dispatch to Gemini 3.5 Flash via the bundled MCP server.

**Wall-clock:** about 1 – 1.5 hours.

**When to pick it:** you have both an Anthropic and a Gemini key set up and want the split-tier run for a cost comparison against the `opus-only` baseline.

Costs depend on model output length, prompt caching, and current vendor pricing.

**The mechanical tier has two doors, and the policy file does not choose between them.** By default Gemini is called as a model: Opus reads the files, sends the text, and writes the answer back. It can instead run as an agent that opens the working directory itself, runs commands and edits files, with Opus reviewing what changed. Which one a run uses is a property of the *install*, chosen once at setup time — deliberately, so the policy file stays a faithful record of how a run was priced and routed rather than something edited between runs. Both doors reach the same model at the same published rates, so the vendor model name on a telemetry event is the same either way; the `model_id` field on every event is what says which one ran. A delegated run says so more plainly than that: `node tools/report.mjs` grows a **Delegated to an agent worker** section naming every delegated packet, its tool calls, and what changed on disk while it ran — and the run leaves a `delegation/` directory holding the brief each worker was given and a receipt for what it did. See [understanding-output.md](understanding-output.md#delegated-to-an-agent-worker). Setting it up, and why the agent costs several times more per task, is in [setup.md](setup.md#gemini-as-an-agent--antigravity-sdk).

## Running a pass — two modes

### Interactive mode (default)

Best when you want to see the phases fly by, approve HITL gates yourself, and read the model's outputs as they land.

```bash
claude --permission-mode acceptEdits
```

`--permission-mode acceptEdits` auto-approves the file reads and edits the orchestrator needs during the run, so it only stops at the four HITL gates. Without it, Claude Code prompts you for each file access, which turns a 1–1.5 hour run into many small approvals.

Then, at the prompt:

```
/sdlc:pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md
```

Or with the multi-model policy:

```
/sdlc:pass --auth=vendor --policy=opus-plus-flash --run-id=pass2 examples/workforce-ops/brief.md
```

The session pauses at each HITL gate; approve or redirect at each one.

### Headless mode (unattended / CI / logging)

Best when you want to script the run, redirect all output to a file, or run overnight without babysitting.

```bash
claude --print "/sdlc:pass --auth=vendor --policy=opus-only --run-id=pass1 examples/workforce-ops/brief.md" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  > examples/workforce-ops/passes/pass1/live-run.log
```

Every HITL gate auto-approves. The full transcript lands in `live-run.log`.

### How to choose

| | Interactive | Headless |
|---|---|---|
| **HITL gates** | pause and prompt | auto-approve |
| **Output** | streamed to your terminal | captured to a file you specify |
| **When to pick** | first-time runs, iterating on the brief, seeing what the subagent decides | unattended runs, CI/CD, comparing configurations across many `--run-id`s |
| **Interrupt** | Ctrl-C stops mid-turn; you can resume manually | Ctrl-C stops the whole run |

### Arguments

- `--auth=<vendor|estimated>` — **required**. `vendor` dispatches every LLM call via the MCP server so telemetry carries real vendor-reported tokens (needs `ANTHROPIC_API_KEY`); `estimated` uses a char-count heuristic for direct-tier calls (works on a Claude Code subscription without an API key). See [setup.md](setup.md#anthropic) and [methodology.md](methodology.md).
- `--policy=<name>` — routing policy. Resolves in this order: the flag, then `.sdlc/project.json.default_policy` written by `/sdlc:setup` or `/sdlc:policy change`, then `opus-plus-flash`. Shipped presets: `opus-only`, `opus-plus-flash`. Any file under `plugin/config/policies/*.yaml` is a valid name.
- `--study=<id>` — case-study identifier. Defaults to `workforce-ops`. Change this whenever you run the pipeline on a brief other than the shipped one, so telemetry and packets stay grouped by project. Output lands in `examples/<study-id>/passes/<run-id>/`.
- `--run-id=<id>` — becomes the pass's directory name under `examples/<study-id>/passes/`. Any string works. Defaults to `pass1`.
- The remaining positional argument is the path to the brief. Use `examples/workforce-ops/brief.md` to reproduce the Workforce Ops case, or point at any other markdown file — see [Bring your own brief](#bring-your-own-brief) below.

## Brownfield mode

`/sdlc:brownfield` is the interactive entry point for running against an existing repository. The same pipeline exposed as `/sdlc:pass --mode=brownfield` for scripting and CI. Additional flags apply only in brownfield mode:

| Flag | Purpose |
|---|---|
| `--mode=brownfield` | Switch to brownfield. Default is greenfield. |
| `--intent=<docs\|bugfix\|feature-extend\|feature-new\|refactor\|test\|deps>` | Required in brownfield. The job type. Adds a Gate 0 before Gate 1. |
| `--brief=<path>` | Optional pre-written intent brief (replaces the interactive interview). Format is in [docs/brownfield.md](brownfield.md). |
| `--gates=<prompt\|auto-approve\|auto-abort>` | Gate behaviour. `prompt` (default) is interactive; `auto-approve` accepts every gate (headless); `auto-abort` (v1.5) approves only when the run's fingerprint matches `.sdlc/project.json`. |
| `--from-config=<path>` | (v1.5) Read gate answers from a committed team config file. Pair with `--gates=auto-abort` for CI. |
| `--strict-write=off` | Downgrade the write-contract PreToolUse hook from HARD-BLOCK to WARN. Every off-limits or not-in-allowlist write is logged but not refused. Defeats the plugin's main safety guarantee — use with care. |
| `--allow-dirty` | Bypass the git-clean check when `commit_strategy != none`. |
| `--recheck` | Force pre-check re-run even when the cached status is still valid. Useful after a plugin version bump. |
| `--adaptive-profile` | Force Tier 2b adaptive stack profile even when a matching pre-authored adapter exists. |
| `--refresh-profile` | Force stack-profile re-scan (implies `--recheck`). Use after a substantial repo restructure. |

Brownfield writes to `.sdlc/runs/<YYYYMMDD-HHMMSS>-<intent>-<slug>/` — `telemetry.jsonl`, `manifest.json`, `provenance.json`, `senior-review.md`, `security-review.md`, `final_report.md`. `provenance.json` is what `/sdlc:revert` reads to undo a run.

Full command surface for the interactive equivalent is in [plugin/commands/brownfield.md](../plugin/commands/brownfield.md).

## Bring your own brief

The shipped `examples/workforce-ops/brief.md` is the Workforce Ops case. `/sdlc:pass` reads whatever markdown file it is given as a positional argument; substituting a different brief runs the orchestrator against that brief.

Steps:

1. Copy [brief-template.md](brief-template.md) and fill in the sections. The template lists the headings the requirements phase and the `architect` subagent expect.
2. Pick a `--study` id distinct from `workforce-ops`; output lands in `examples/<study-id>/passes/<run-id>/`, so telemetry, packets, and manifests for the new project are grouped separately from the shipped case.
3. Pick a `--run-id` for this pass. Interactive form:

   ```
   /sdlc:pass --auth=vendor --study=my-project --run-id=pass1 my-brief.md
   ```

   Or headless:

   ```bash
   claude --print "/sdlc:pass --auth=vendor --study=my-project --run-id=pass1 my-brief.md" \
     --permission-mode acceptEdits \
     --output-format stream-json --verbose \
     > examples/my-project/passes/pass1/live-run.log
   ```

4. Report as usual:

   ```bash
   node tools/report.mjs examples/my-project/passes/pass1
   ```

HITL gates, telemetry, cost accounting, and `report.mjs` operate on whichever brief the run was invoked with; the report reflects that run's telemetry.

If the brief targets a stack other than NestJS + Prisma + SQLite, keep the "Tech stack (fixed)" section explicit — the pipeline uses it to constrain codegen. Ambiguity there surfaces at Gate 1 as an open question.

The bundled MCP server is registered via `.mcp.json` at the repo root (written by `tools/setup.mjs`), so plain `claude` discovers it without any `--plugin-dir` flag.

**Existing `examples/<study-id>/passes/<run-id>/` directories are overwritten by re-running the same ids.** Use a different `--run-id` (or `--study`) to preserve prior data.

## HITL gates

The orchestrator pauses at four points during the run:

- **Gate 1** — after `requirements.md` is written
- **Gate 2** — after `design.md` is written
- **Gate 3** — after `security_review.md` is written
- **Gate 4** — after the final report

In interactive mode each gate prints the artifact and waits for your input; approve to continue or provide direction to redirect the phase. In headless mode all four gates auto-approve.

## After the pass finishes

Print a summary of the results:

```bash
node tools/report.mjs examples/workforce-ops/passes/pass1
```

For a Markdown-formatted version suitable for pasting into a report or issue:

```bash
node tools/report.mjs examples/workforce-ops/passes/pass1 --markdown
```

The report's structure and what each number means is documented in [understanding-output.md](understanding-output.md).

## Running additional passes

Each pass writes to a separate directory under `examples/<study-id>/passes/`. To compare two configurations, run twice with different `--run-id` values (any string):

```bash
# headless form
claude --print "/sdlc:pass --auth=vendor --policy=opus-only --run-id=baseline examples/workforce-ops/brief.md" \
  --output-format stream-json --verbose > examples/workforce-ops/passes/baseline/live-run.log

claude --print "/sdlc:pass --auth=vendor --policy=opus-plus-flash --run-id=multi-model examples/workforce-ops/brief.md" \
  --output-format stream-json --verbose > examples/workforce-ops/passes/multi-model/live-run.log

node tools/report.mjs examples/workforce-ops/passes/baseline
node tools/report.mjs examples/workforce-ops/passes/multi-model
```

Different `--run-id`s never collide. Reusing an id overwrites the prior run's directory.

## Resuming a partial run

The orchestrator writes telemetry incrementally, so a run interrupted mid-way leaves valid partial state in its pass directory. Re-running with the same `--run-id` starts fresh (overwriting). Use a new id to keep the partial data.
