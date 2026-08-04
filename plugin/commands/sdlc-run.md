---
description: "Run the AI-SDLC pipeline against a project brief. Takes no arguments — asks for whatever it needs, checks the setup before spending anything, and reports tokens and cost per phase when the run finishes."
argument-hint: ""
---

Run one full AI-SDLC pass. This command takes no arguments. Everything it needs it asks for.

Work through the steps in order. Do not skip a step because the answer seems obvious, and do not
start the run until step 5 is confirmed.

# 1. Check the setup before anything else

Run the setup check that ships with the plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-setup.mjs"
```

Read its exit code, not just its output.

- **Exit 1** — the plugin cannot run. Show the user the reported problems and their fixes. If the
  problem is a missing dependency or an unbuilt server, offer to run the same script with `--fix`,
  which repairs both. **Stop here.** Do not start a run that will fail partway through and bill the
  user for the phases before the failure.
- **Exit 0 with warnings** — the run can proceed, but some policies cannot. Carry the warnings into
  step 4, where they decide which models are actually reachable.
- **Exit 0, clean** — continue.

# 2. Find the brief, or write one

The pipeline builds what a brief describes. Look for one in this order and stop at the first hit.

**a. A brief in the current directory.** Search for markdown files whose first heading begins
`# Project Brief`. If exactly one exists, name it and ask the user to confirm it is the right one.
If several exist, list them and ask which.

**b. A brief the user names.** If the user has a brief elsewhere, ask for the path and read it.

**c. A brief that ships with the plugin.** Offer the three shipped examples, described in one line
each so the choice is meaningful. Say plainly how long each takes, because the difference is
minutes versus hours and the user is paying for it. All three paths are inside the installed
plugin, not the working directory — the user is typically standing in an empty folder, where no
repository file exists:
- `${CLAUDE_PLUGIN_ROOT}/examples/quick-demo/brief.md` — a one-endpoint ping service on Express,
  no database. The one to pick to see the pipeline end to end: minutes, not hours, and a fraction
  of the cost.
- `${CLAUDE_PLUGIN_ROOT}/examples/workforce-ops/brief.md` — HR and workforce operations: employees,
  time entries, leave approval, reporting, with encrypted PII and role-based masking. Five modules;
  expect an hour or more.
- `${CLAUDE_PLUGIN_ROOT}/examples/travel-ops/brief.md` — travel booking operations: fare rules,
  holds, cancellation and refund computation, an append-only ledger, with encrypted traveller PII.
  Five modules; expect an hour or more.

Copy the chosen file to `brief.md` in the current directory before running, so the run record sits
beside the brief it was built from and the user can edit it for a second pass.

**d. No brief anywhere — write one.** This is the normal case in an empty folder. Interview the
user and write the brief for them. Ask, in plain language and one at a time:
1. What are we building, and who uses it?
2. What are the main areas of functionality? Push for concrete capabilities, not categories —
   "approve a leave request and debit the balance" produces better work than "leave management".
3. What must be true everywhere — validation, logging, authentication, audit?
4. What technology stack, if the user has one in mind? If they do not, propose the stack the
   shipped examples use and let them accept it.
5. What is explicitly not in this build?
6. How will they know it worked? Push for checks someone can run.

Write the answers into the section layout below, save it as `brief.md` in the current directory,
show it to the user, and get their approval before continuing. The brief is the single input to
everything downstream — a vague brief produces vague software, and the user cannot tell the
difference until the run has finished and the money is spent.

The requirements phase and the `architect` subagent read these headings by name. The wording under
each is up to the author, but the set is fixed:

```
# Project Brief — <project name>
## One-line summary
## Business context
## Scope                        (one `### 1. <Module name>` per bounded slice, capabilities bulleted)
## Cross-cutting requirements
## Tech stack (fixed)
## Non-functional
## Explicitly OUT of scope
## Acceptance criteria
```

Either shipped example in step 2c is a filled-in instance of this layout; read one if a section's
expected depth is unclear.

# 3. Confirm where the output goes

Unless the user says otherwise:

- Generated application code → `./src`
- Run record — telemetry, manifest, packets, reports → `./.sdlc/`

Tell the user both paths. If `./src` already contains files, say so and ask before writing into it.

# 4. Show what will run

State the routing plainly, as fact. Read it from the policy rather than reciting it from memory:
the default policy is `opus-plus-flash`, loaded from
`${CLAUDE_PLUGIN_ROOT}/config/policies/opus-plus-flash.yaml`.

Report, in a short list:
- which model handles the judgment phases — requirements, design, task planning, senior review,
  security review
- which model handles the mechanical phases — codegen, tests, docs, debug
- the per-million input and output rates the policy declares for each, so the user can see where the
  cost difference comes from

This first version runs the default policy. It is not configurable from this command; a user who
needs different routing edits the policy file directly.

If step 1 reported missing Gemini credentials, say so here and explain the consequence in one
sentence: the mechanical phases cannot dispatch, so the run would fail at the first codegen packet.
Offer to continue on `opus-only` instead, which routes every phase to Claude and needs no Gemini
credentials — and say plainly that it costs more, because the cost saving comes precisely from the
phases that would have gone to the cheaper model.

# 5. Choose the telemetry mode, out loud

The run records tokens and cost in one of two modes. Present the choice; do not decide silently.

- **Vendor** — every call goes through the bundled server, and the numbers are the ones the vendor
  reports. Requires `ANTHROPIC_API_KEY`. Use this whenever the numbers will be shown to anyone.
- **Estimated** — the judgment-phase tokens are estimated from character counts. No API key needed;
  a Claude Code subscription covers the run. The mechanical-phase numbers are still vendor-reported.

If `ANTHROPIC_API_KEY` is set, recommend vendor and say why: the numbers reconcile against the
console. If it is absent, recommend estimated and say what is lost: the judgment-phase figures are
approximations, so do not publish them as measurements.

Then confirm the whole plan in one short summary — brief, output paths, policy, telemetry mode —
and get a yes before starting. This is the last free moment; everything after it costs money.

# 6. Run

Invoke the `orchestrator` subagent with the resolved settings from the steps above:

- `brief_path` — the confirmed brief
- `auth_mode` — `vendor` or `estimated`, as confirmed in step 5
- `policy` — `opus-plus-flash`, or `opus-only` if chosen in step 4
- `code_dir` — `./src`
- `output_dir` — `./.sdlc`

The orchestrator pauses at four approval gates: after requirements, after design, after the security
review, and before final acceptance. Relay each gate to the user as it arrives; do not answer them
on the user's behalf.

# 7. Report

When the run finishes, show:
- tokens per phase, split into cached input, fresh input, and output
- cost per phase and the run total
- which model each phase ran on, so the routing is visible rather than asserted
- where the generated code and the run record were written

Then stop. Do not propose follow-up runs.
