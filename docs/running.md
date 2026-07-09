# Running the study

Two policies ship with this repository. Pick one to start.

## Policies

### `opus-only` — premium-ceiling baseline

Every phase of the SDLC runs on Claude Opus 4.7. There is no delegation and no cost-saving routing. The number this pass produces is the "what does it cost if I use one top-tier model for everything?" line.

**Estimated wall-clock:** 1 – 1.5 hours (depends on model latency and how many redirections you make at HITL gates).

**When to pick it:** you want a clean baseline for comparison, or you don't have a Gemini key handy.

### `opus-plus-flash` — the multi-model pass

Opus handles phases that require judgment (requirements, design, senior code review, security review). High-volume mechanical phases (codegen, tests, docs) dispatch to Gemini 3.5 Flash via the bundled MCP server.

**Estimated wall-clock:** 1 – 1.5 hours.

**When to pick it:** you have both an Anthropic and a Gemini key set up, and you want to see the study's actual value proposition.

Actual costs depend on model output length, prompt caching, and current vendor pricing — the numbers above are indicative, not guaranteed.

## Running a pass — two modes

There are two ways to invoke a run. Pick whichever suits your situation.

### Interactive mode (default)

Best when you want to see the phases fly by, approve HITL gates yourself, and read the model's outputs as they land.

```bash
claude --permission-mode acceptEdits
```

`--permission-mode acceptEdits` auto-approves the file reads and edits the orchestrator needs during the run, so it only stops at the four HITL gates. Without it, Claude Code prompts you for each file access, which turns a 1–1.5 hour run into many small approvals.

Then, at the prompt:

```
/run-sdlc-pass --run-id=pass1 brief.md
```

Or explicitly:

```
/run-sdlc-pass --policy=opus-plus-flash --run-id=pass2 brief.md
```

The session pauses at each HITL gate; you approve or redirect at each one.

### Headless mode (unattended / CI / logging)

Best when you want to script the run, redirect all output to a file, or run overnight without babysitting.

```bash
claude --print "/run-sdlc-pass --policy=opus-only --run-id=pass1 brief.md" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose \
  > passes/pass1/live-run.log
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

- `--policy=<name>` — routing policy. Defaults to `opus-only`. Available: `opus-only`, `opus-plus-flash`.
- `--study=<id>` — case-study identifier. Defaults to `workforce-ops`.
- `--run-id=<id>` — becomes the pass's directory name under `passes/`. Any string works. Defaults to `pass1`.
- The remaining positional argument is the path to the brief. Use `brief.md` at the repo root, or point at a different file.

The bundled MCP server is registered via `.mcp.json` at the repo root (written by `tools/setup.mjs`), so plain `claude` discovers it without any `--plugin-dir` flag.

**Existing `passes/<run-id>/` directories are overwritten by re-running the same id.** Use a different `--run-id` to preserve prior data.

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
node tools/report.mjs passes/pass1
```

For a Markdown-formatted version suitable for pasting into a report or issue:

```bash
node tools/report.mjs passes/pass1 --markdown
```

The report's structure and what each number means is documented in [understanding-output.md](understanding-output.md).

## Running additional passes

Each pass writes to a separate directory under `passes/`. To compare two configurations, run twice with different `--run-id` values (any string):

```bash
# headless form
claude --print "/run-sdlc-pass --policy=opus-only --run-id=baseline brief.md" \
  --plugin-dir ./plugin --output-format stream-json --verbose > passes/baseline/live-run.log

claude --print "/run-sdlc-pass --policy=opus-plus-flash --run-id=multi-model brief.md" \
  --plugin-dir ./plugin --output-format stream-json --verbose > passes/multi-model/live-run.log

node tools/report.mjs passes/baseline
node tools/report.mjs passes/multi-model
```

Different `--run-id`s never collide. Reusing an id overwrites the prior run's directory.

## Resuming a partial run

The orchestrator writes telemetry incrementally, so a run interrupted mid-way leaves valid partial state in its pass directory. Re-running with the same `--run-id` starts fresh (overwriting). Use a new id if you want to keep the partial data.
