# Running

**If you installed the plugin rather than cloning the repo, you do not need this
page to start.** Type `/sdlc-run` in a new session — slash commands register when
a session starts, so the session that installed the plugin does not offer it yet.
It takes no arguments, asks for whatever it
needs, and picks the settings described below on your behalf. This page is the
reference for `/run-sdlc-pass`, the same run with every setting exposed as a
flag — useful for repeat runs, for scripting, and for understanding what
`/sdlc-run` chose for you.

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

## Running a pass — two modes

### Interactive mode (default)

Best when you want to see the phases fly by, approve HITL gates yourself, and read the model's outputs as they land.

```bash
claude --permission-mode acceptEdits
```

`--permission-mode acceptEdits` auto-approves the file reads and edits the orchestrator needs during the run, so it only stops at the four HITL gates. Without it, Claude Code prompts you for each file access, which turns a 1–1.5 hour run into many small approvals.

Then, at the prompt:

```
/run-sdlc-pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md
```

Or with the multi-model policy:

```
/run-sdlc-pass --auth=vendor --policy=opus-plus-flash --run-id=pass2 examples/workforce-ops/brief.md
```

The session pauses at each HITL gate; approve or redirect at each one.

### Headless mode (unattended / CI / logging)

Best when you want to script the run, redirect all output to a file, or run overnight without babysitting.

```bash
claude --print "/run-sdlc-pass --auth=vendor --policy=opus-only --run-id=pass1 examples/workforce-ops/brief.md" \
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

- `--auth=<vendor|estimated>` — **required**. `vendor` dispatches every LLM call via the MCP server so telemetry carries real vendor-reported tokens (needs `ANTHROPIC_API_KEY`); `estimated` uses a char-count heuristic for direct-tier calls (works on a Claude Code subscription without an API key). See [setup.md](setup.md#anthropic-claude-authentication) and [methodology.md](methodology.md).
- `--policy=<name>` — routing policy. Defaults to `opus-only`. Available: `opus-only`, `opus-plus-flash`.
- `--study=<id>` — case-study identifier. Defaults to `workforce-ops`. Change this whenever you run the pipeline on a brief other than the shipped one, so telemetry and packets stay grouped by project. Output lands in `examples/<study-id>/passes/<run-id>/`.
- `--run-id=<id>` — becomes the pass's directory name under `examples/<study-id>/passes/`. Any string works. Defaults to `pass1`.
- The remaining positional argument is the path to the brief. Use `examples/workforce-ops/brief.md` to reproduce the Workforce Ops case, or point at any other markdown file — see [Bring your own brief](#bring-your-own-brief) below.

## Bring your own brief

The shipped `examples/workforce-ops/brief.md` is the Workforce Ops case. `/run-sdlc-pass` reads whatever markdown file it is given as a positional argument; substituting a different brief runs the orchestrator against that brief.

Steps:

1. Copy [brief-template.md](brief-template.md) and fill in the sections. The template lists the headings the requirements phase and the `architect` subagent expect.
2. Pick a `--study` id distinct from `workforce-ops`; output lands in `examples/<study-id>/passes/<run-id>/`, so telemetry, packets, and manifests for the new project are grouped separately from the shipped case.
3. Pick a `--run-id` for this pass. Interactive form:

   ```
   /run-sdlc-pass --auth=vendor --study=my-project --run-id=pass1 my-brief.md
   ```

   Or headless:

   ```bash
   claude --print "/run-sdlc-pass --auth=vendor --study=my-project --run-id=pass1 my-brief.md" \
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
claude --print "/run-sdlc-pass --auth=vendor --policy=opus-only --run-id=baseline examples/workforce-ops/brief.md" \
  --output-format stream-json --verbose > examples/workforce-ops/passes/baseline/live-run.log

claude --print "/run-sdlc-pass --auth=vendor --policy=opus-plus-flash --run-id=multi-model examples/workforce-ops/brief.md" \
  --output-format stream-json --verbose > examples/workforce-ops/passes/multi-model/live-run.log

node tools/report.mjs examples/workforce-ops/passes/baseline
node tools/report.mjs examples/workforce-ops/passes/multi-model
```

Different `--run-id`s never collide. Reusing an id overwrites the prior run's directory.

## Resuming a partial run

The orchestrator writes telemetry incrementally, so a run interrupted mid-way leaves valid partial state in its pass directory. Re-running with the same `--run-id` starts fresh (overwriting). Use a new id to keep the partial data.
