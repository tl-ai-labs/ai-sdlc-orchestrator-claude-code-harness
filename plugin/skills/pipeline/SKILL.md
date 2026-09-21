---
name: pipeline
description: The end-to-end AI-SDLC workflow definition consumed by the orchestrator subagent. Defines the state machine, TaskPacket schema, HITL gates, telemetry contract, and the prompts/templates for each phase. The orchestrator reads this skill to know exactly what to do at each step.
---

# AI-SDLC Workflow — Orchestrator Playbook

This skill is the source of truth for the orchestrator. When invoked under `/mmo:pass`, the orchestrator follows the state machine below.

---

## State machine

```
-1. preflight_dispatch              → prove every model this run dispatches to is reachable (free, no API call)
0. read_brief
1. requirements_analysis           → requirements.md
   ── GATE 1 ─────────────────────────────────────
2. architecture_design (subagent: architect) → design.md
   ── GATE 2 ─────────────────────────────────────
3. (mixed policy only) cache_project_header  → prime the mechanical-tier model's cache
4. plan_task_packets                  → packets.json (list of TaskPackets)
5. execute_packets                    → for each: route → execute → validate → integrate → retry on failure
6. senior_code_review (subagent: senior-reviewer) → review.json + refinement packets
   re-execute refinement packets
7. test_run                           → npm install && npm test; debug failures (route via policy)
8. security_review (subagent: security-reviewer) → security_review.md
   ── GATE 3 ─────────────────────────────────────
9. generate_final_report              → updates manifest.json with artifacts + rollups,
                                        then collect-orchestrator-usage.mjs → true total (fail-open)
   ── GATE 4 (final acceptance) ───────────────────
```

---

## Phase -1 — preflight_dispatch (MANDATORY, before anything else)

Call `preflight_dispatch` with the run's `auth_mode` and the same `policy_name` / `project_root` /
`policy_path` you will use for the run, and **read the result before doing anything else**.

`auth_mode` is required and is the mode already resolved for this run (rule 6) — do not omit it, do not
guess it. It changes the answer: it is what tells pre-flight which models this run actually dispatches
through the server.

**If `ok` is false, STOP.** Print the `halt_reason` verbatim, print the failing model's `error`, and end
the run. Do not read the brief, do not start phase 1, do not "try the mechanical tier and see". A policy
whose cheap tier cannot be reached does not degrade into a slightly-more-expensive run — every packet
falls back to the premium tier, and the result costs *more* than a single-model baseline while appearing
to succeed. That is the one outcome this plugin exists to disprove, so it is worth refusing to start.

**If `warnings` is non-empty, print each one and keep going.** A warning is a model this run will not
dispatch to, so its failure cannot affect this run — under `estimated` that is the direct tier, which
runs inside your own session and never touches the server or its credentials. Print them because they
are true and the operator should know the same policy would not start in `vendor` mode. Do not treat a
warning as a halt: refusing to start a viable run is not the safe error, it is the one that teaches the
operator to override a gate that exists to protect them.

**`ok: false` can also be about price.** Stop exactly as for a credential failure when `halt_reason`
says `Cannot price N of M models`: a model this run can route to has no price on the dated price list
for today, so work sent to it would be refused at dispatch, and your own estimates for it would have
no rate (rule 6).

**If `price_warnings` is non-empty, print each one and keep going.** Each names a policy `pricing:`
block that differs from the dated price list. The server bills the list, not the block, so the run's
numbers stay right; the fix belongs in the policy file, not in this run.

**`not_selected` is not a warning and not a problem.** A policy may hold more than one way of reaching a
tier — `opus-plus-flash` reaches its mechanical tier either as a Gemini model call or as an Antigravity
agent — and only the one this install selected can be dispatched to. The other is listed here, unchecked,
because its prerequisites are irrelevant to a run that will never call it. Do not report it as a failure,
do not try to "fix" it, and do not offer to install anything on its behalf.

**If `ok` is true**, report the configuration to the user in one line before phase 1 — the policy name,
each model, and on the Google Cloud path the resolved project and region — then continue. This is the only point in
the run where the operator can see what is about to be billed and to which project, while it is still
free to stop.

This call constructs each adapter, which is where credential discovery happens and where a missing or
unusable credential throws. It makes no model call and costs nothing. It exists because that
construction used to happen lazily at the first mechanical packet — phase 4 of 9, after the premium
phases were already billed — which is the worst possible moment to discover a setup problem.

**Escalation to the direct tier under `estimated` stays in-session.** `opus-plus-flash` escalates a
`debug` packet to the premium model after two mechanical-tier retries (`retry_count: { gte: 2 }`). In
`estimated` mode that escalated packet is yours to handle in your own conversation, with char-count
estimation and `provenance: "estimated"`, exactly like every other direct-tier phase — do not dispatch
it via `execute_with_model`, and do not conclude from a pre-flight warning about that model that the
escalation path is broken. The routing decision is unchanged; only the transport differs.

---

## Phase-by-phase prompts

### Phase 1 — requirements_analysis

Read `<brief.md>` (passed in $ARGUMENTS) and produce `<output_dir>/requirements.md` with sections:

- **In scope** (numbered, testable)
- **Out of scope** (numbered)
- **Functional requirements per module** (FR-1, FR-2, ...)
- **Non-functional requirements** (NFR-1, ...)
- **PII inventory** (table: field, sensitivity, protection)
- **Role matrix** (role × resource × action)
- **Acceptance criteria** (numbered, executable)
- **Open questions for HITL** (if any)

### Phase 2 — architecture_design (delegated to `architect` subagent)

The orchestrator invokes the `architect` subagent passing `<output_dir>/requirements.md`. Architect writes `<output_dir>/design.md` (see architect.md for content spec).

**Brownfield: scout the repo before the architect (multi-model policies).** The architect's cost is
mostly search — on the run this comes from it read 79 files (ten test files to choose one mirror, a
970-line `index.ts` in five chunks) for a 17-unit plan: 110 messages, $3.75. The search goes to the
mechanical tier; the architect reads what the scout found.

1. Candidates, no model:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/scout-candidates.mjs" --project-root "$(pwd)" \
     --requirements "<output_dir>/requirements.md" --brief "<output_dir>/intent_brief.md" \
     --out "<output_dir>/scout-candidates.json"
   ```
   It scores every tracked text file by requirement-term hits (path and content), the write-contract
   allowlist and test/kit adjacency, and keeps ≤ 40 files / ≤ 250 kB; a large file is offered as hit
   windows (`windows: [[from, to], …]`), not whole.
2. Skip the scout when the loaded policy has no rule matching `phase: discovery, task_type: repo_scout`
   (`load_policy` → `rules[].when`). A single-model policy has none; the architect works as before.
3. Otherwise dispatch **one** packet, apply form, before delegating the architect:

   | Field | Value |
   |---|---|
   | `id` / `phase` / `task_type` / `module` | `scout-1` / `discovery` / `repo_scout` / `cross` |
   | `instruction` | "You are scouting an existing repository for an architect who will write a change plan for the requirements. From the candidate files given — and only those — return, for each thing the requirements add or change: the existing file whose shape it should mirror (path + line range), the exact anchor lines where an edit goes (path, 1-based line, the line's text verbatim), and repo facts the architect needs (formatter and its limits, test runner and assertion style, route registration order, i18n rule). Cite only lines you were given. Do not design; do not write code. Return JSON {path, content} where content is the JSON document." |
   | `inputs` | `{path: "<output_dir>/requirements.md"}`, `{path: "<output_dir>/intent_brief.md"}`, then every candidate: `{path, reason: "candidate"}` for a whole file, `{path, lines: [from, to], reason: "candidate window"}` per window for a large one. No `content` anywhere — the server reads them. |
   | `artifact_path` | `<output_dir>/scout.json` (the server may write into the run's own folder under any contract) |
   | `apply` | `{ "write": true, "verify": ["node -e \"JSON.parse(require('fs').readFileSync('{path}','utf8'))\""] }` |
   | `budget` | `{ "maxInputTokens": 200000, "maxOutputTokens": 6000 }` |
   | `acceptance` | `["every mirror and anchor path is one of the candidates", "anchor text is verbatim", "no code in facts"]` |

   `scout.json` shape the instruction asks for:
   ```json
   { "mirrors": [{ "for": "api controller GET /public-profile/:id", "path": "…", "lines": [1, 21], "why": "…" }],
     "anchors": [{ "path": "apps/api/src/index.ts", "line": 248, "text": "  });", "why": "mount after publicProjectApi" }],
     "facts":   [{ "path": "biome.json", "lines": [1, 12], "fact": "2-space, double quotes, width 80" }],
     "not_found": ["…"] }
   ```
   Read the receipt only (STOP ON PASS). Pass the architect the path `<output_dir>/scout.json` in its
   delegation; it starts from the scout's mirrors and anchors and reads outside them only for a unit
   the scout missed (listed under `not_found`, or found wrong while planning).

**Brownfield: lint the plan before Gate 2.** `change_plan.md` is a spec the worker implements, not a
listing it copies (architect.md, "Per-unit sections"). When the architect returns, run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs" "<output_dir>/change_plan.md"
```

Exit 0: open Gate 2. Exit 1: re-delegate the architect **once** with the printed violation list
("shrink these sections to Exports / Behavior / Mirror"), lint again, and open Gate 2 whatever the
second result — but log `phase.end` with `plan_lint=failed` and say so in the gate prompt and in
SUMMARY.md, because the run's cost will show it. Never edit the plan yourself to pass the lint: the
sections are the worker's inputs, and a hand edit here is Opus re-typing the program, which is the
cost this gate exists to remove.

### Phase 4 — plan_task_packets

From `design.md`, emit `<output_dir>/packets.json` — a list of TaskPackets, one per file-sized unit of work.

Suggested packet types and one packet per:

| task_type | What |
|---|---|
| `prisma_schema` | full `schema.prisma` |
| `entity` | one Prisma model annotation set (if any custom) |
| `dto` | one DTO file (create/update/query DTOs grouped per resource) |
| `controller_handler` | one controller class (all routes for one resource) |
| `service_method` | one service class |
| `module_wiring` | one NestJS @Module file |
| `guard` | one guard class |
| `interceptor` | one interceptor (e.g. masking, logging) |
| `filter` | global exception filter |
| `migration` | initial migration (or `db push` script) |
| `seed_data` | seed.ts producing demo employees + roles |
| `test_unit` | unit tests per service |
| `test_integration` | integration tests per controller (Supertest) |
| `docstring` | TSDoc on public service methods |
| `readme_section` | one section of the project README |
| `adr_draft` | one ADR file |
| `env_docs` | `.env.example` — every required environment variable from `design.md` §6, no values |
| `env_test_fixture` | `.env.test` — every required environment variable with a value that satisfies the schema declared in `design.md` §6 (e.g., a 32-char string where the schema demands `min(32)`, `file:./test.db` for the DB URL, a hex-encoded fake KEK). This file is what the test runner copies to `.env` before `npm test`. |

When the app uses a validating `ConfigModule` (or Joi / Zod / envalid equivalent), packets for `env_docs` and `env_test_fixture` are **required** — omitting either is a senior-reviewer blocker. The two files must be internally consistent: every key listed in `.env.example` must appear in `.env.test` with a schema-valid value.

**Brownfield: derive the packets, do not write them.** After the plan passes the lint (Phase 2), run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-to-packets.mjs" "<output_dir>/change_plan.md" \
  --run-id <run-id> --intent <intent> --project-root "$(pwd)"
```

It writes `<output_dir>/packets.json` from the plan's unit sections with no model call: one packet per
`## An — <path>` unit in plan order, `new_file` → apply packet returning the file, `edit` → apply packet in
`edits` mode with the Edit-anchor windows as inputs, `tooling` → a shell step, test paths → the `tests`
phase; `task_type` from the path (override with a `- **Packet** task_type=…, module=…` bullet in the
unit); `inputs` = unit section + `House style` + Mirror slices; `verify` from the Verify bullet;
`depends_on` from Depends on. It also checks the plan against the repo: a mirror file that does not exist
or a line past its end is a **warning** on stderr, an edit to a missing file or a mirror outside the repo
is an **error** (exit 1). On exit 1 the plan is wrong, not the script — re-delegate the architect with
the error lines, as for a lint failure. On exit 0, read the summary line and the warnings; adjust a
packet only when a warning names it (a dropped mirror the worker needs, a wrong `task_type` for the
policy's routing) and log the `plan_task_packets` event with the tokens you actually spent — on the run
this comes from, hand-writing the same 17 packets cost $1.03 and 9 turns. Greenfield still plans by
hand from `design.md`, as below.

Two more things the derived packets carry: an edit with more than five anchor sites is split into
chunk packets (`tp_codegen_004-a`, `-b`, …) chained by `depends_on` — dispatch them in order, they
edit the same file; and a package-wide verify command (`typecheck`, the full suite) is on the packet
as `verify_deferred`, not in `apply.verify`. **Run every `verify_deferred` command once, after the
last packet of the phase**, and treat a failure as a debug packet against the file whose error it
reports — a per-packet package check fails on other packets' unfinished work (measured: a
route-tree edit was retried twice for another packet's import errors).

### Brownfield-mode task types (v1)

The table above is greenfield-Nest-centric. In brownfield mode (`mode: brownfield`), packets use a **stack-agnostic** base set of primitives plus an optional `subtype` hint that the loaded stack adapter (`plugin/skills/pipeline/stacks/*.md`) resolves to concrete codegen guidance.

| task_type | Purpose | Common `subtype` values |
|---|---|---|
| `new_file_add` | Create a file that didn't exist at discovery time | `nest_controller` · `nest_service` · `django_view` · `fastapi_router` · `test` (see adapter) |
| `existing_file_edit` | Modify a file that already existed | `module_wiring` · `url_registration` · `router_wiring` · `django_settings` |
| `patch_apply` | Apply a specific unified diff | (rare — usually `existing_file_edit` is enough) |
| `doc_addition` | New doc under docs/ or module README | `readme` · `adr` · `runbook` · `api` |
| `doc_update` | Update an existing doc | — |
| `test_add` | New test file for new source | `unit` · `integration` · `e2e` |
| `test_backfill` | Add tests for existing untested code | Same as `test_add` |
| `bug_reproduce` | Failing test that captures the bug | — |
| `bug_diagnose` | Root-cause analysis — emit a note, not code | — |
| `bug_fix_apply` | Apply the fix identified by `bug_diagnose` | — |
| `refactor_extract` | Extract shared logic into a new utility | — |
| `dependency_add` | Add a dep + adjacent-code adjustments | `patch` · `minor` · `major` |

**Framework-owned wiring** — new controllers/routes/views usually need a corresponding
registration edit in a wiring file (Nest module, Django urls.py, FastAPI main.py's
include_router). Emit these as **paired packets** with the same `pass_id` — atomic per-pair:
if the wiring edit fails, roll back the new-file packet within the same pair.

**Every brownfield packet MUST set `artifact_path`** (§7.1) so the write-contract validator can
reject off-limits paths at dispatch time. Missing `artifact_path` is a planner bug.

**`doc_addition` vs `doc_update` — read from the brief, don't infer.** When `intent_brief.md`
carries a "## Task type" heading (only present when the chosen intent declares `task_types` in
`intents.json` — currently just `docs`), every packet you plan for this run uses that exact
`task_type` value. Do not infer `doc_addition` vs `doc_update` from file existence or context —
the user already chose it at brief-collection time (`brownfield-guide/SKILL.md` step 4b), and a
per-project policy may route the two differently (an update is a smaller edit than fresh
authoring, and might reasonably go to a cheaper model). When the heading is absent — every
non-docs intent, and `docs` runs from before this existed — infer as before.

### TaskPacket initial output-ceiling budgets

Set `budget.maxOutputTokens` per phase type. The adapter automatically doubles this ceiling on any attempt that terminates with the vendor's max-tokens stop reason (Anthropic `stop_reason: "max_tokens"`, Gemini `finishReason: "MAX_TOKENS"`), up to 3 doublings or the model's absolute output limit declared in the policy YAML (`max_output_tokens_absolute`), whichever comes first. Cached input keeps retry cost low.

- **Codegen and test packets:** `6000` (services, controllers, DTOs, React components, test files). A ceiling is a cap, not a spend — an unused ceiling costs nothing, while every doubling re-bills the whole attempt and returns a second full copy into your context. At `3000`, one feature-extend run doubled 4 of 14 codegen packets; at `6000` none of them would have.
- **Premium packets (design, senior_code_review, security_review):** `8000`. Design and review artifacts are the ones that historically hit the ceiling.
- **Docs, ADR, README:** `3000`. Same doubling behavior.
- **Debug packets:** inherit from the packet they refine.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"` — all sharing the packet's `task_id`. The report collapses them into one row per packet.

### Phase 5 — execute_packets

Emit `phase.start` before the first packet and `phase.end` after the last — see "Run logging" in
orchestrator.md. This is the phase with the most silence between pre-flight and Gate 1 otherwise:
every dispatch inside the loop below already logs itself via the MCP server (`route.decide`,
`dispatch.start`/`.end`), but nothing marks the loop's own boundaries without this call.

For each packet, in dependency order:

**Direct-tier work (subagent handles it, no MCP dispatch):** the orchestrator (Opus) writes the file directly. Estimate tokens via `chars/3.8` heuristic for both inputs and outputs; take pricing constants from this model's `effective_price.rates` in the `load_policy` result (the dated price list's card for the day, or the policy's block only under `pricing_override: true`: the price the server and the post-run collector bill at; see orchestrator rule 6); log a TelemetryEvent via `log_telemetry`.

**Mechanical-tier work (routed to another model):** call `execute_with_model` with the packet, `policy_name`, `project_root: $(pwd)`, and `cache_context`. The server routes per policy. Pass `project_root` on every dispatch, exactly as pre-flight received it: it is what lets the loader prefer a repo-local `routing-policy.yaml` over the shipped preset, and omitting it is the historical bug — the preview named the user's policy while the billed calls quietly routed under a different one. Validate the returned structured output against the schema; if invalid, construct a *refined* packet (new id, `retry_count+1`, with the validation error appended to instruction) and re-dispatch. After 2 mechanical-tier retries fail, the policy escalates to the subagent's own tier automatically (rule with `retry_count: { gte: 2 }`).

Write the returned file content to disk at the packet's stated `artifact_path` — **only for packets without `apply`**. Every brownfield codegen, tests, docs and debug packet that produces a file uses the apply form below instead.

**Apply form (brownfield, every file-producing mechanical packet).** The server writes the file, runs the verify commands, retries on the mechanical tier with the failure appended, and returns a receipt. Your side of the contract:

| Field | Value |
|---|---|
| `inputs[]` | Paths only — no `content`. Narrow with `section: "<heading>"` (a `change_plan.md` section such as `"A1"`) or `lines: [from, to]`. The server reads them; you never paste file text into a packet. **The standard set for a codegen / test packet is three:** the unit section (`change_plan.md` § `An — …`), the plan's `House style` section, and the unit's **Mirror** slice (`path` + `lines` from the section — the existing file whose shape the new one copies). Add the **Edit anchor** lines for an edit. Nothing else: the worker does not need the whole plan, the requirements, or the repo facts. |
| `instruction` | Names the section and says *implement*, not *reproduce*: "Implement `<artifact_path>` from change_plan section `An`: satisfy every Exports signature and Behavior rule; copy the shape of the Mirror input for imports, errors and structure; follow House style. Return JSON {path, content}." Do not restate the section's content in the instruction — the section is the input. |
| `outputSchema` | Omit it. The server supplies `{path, content}`. |
| `apply` | `{ "write": true, "mode": "content" | "edits", "verify": [<commands>], "max_retries": 2 }`. `mode: "edits"` (edits to an existing file): the worker returns `{edits: [{line, anchor, position: "after" | "before" | "replace", text}]}` instead of the file and the server splices them in — an anchor that is not found, or matches more than one line without a `line`, is a retry with that reason; the file must exist. `plan-to-packets.mjs` picks the mode from the unit's Action. Verify commands come from `baseline.json` (the package's lint / typecheck / test commands), scoped to the file where the tool allows it: `{path}` is replaced by `artifact_path`. Typical: `["npx biome check {path}"]` for a source file, `["npx biome check {path}", "npx vitest run {path}"]` for a test file. Leave `verify` out only when no cheap check exists. |
| `run_id` (tool argument, beside `packet`) | The run id, so the server records provenance for the write under `.sdlc/runs/<run_id>/` and `/mmo:revert` still works. Do not run `write-provenance.mjs --before/--after` yourself for an applied packet. |

Read the receipt's `status`:

| `status` | What happened | What you do |
|---|---|---|
| `applied` | Written, verify passed (or no verify) | **STOP ON PASS.** Nothing. Do not `cat` the file, do not re-run the verify command, do not read the packet result back. Move to the next packet. `apply.path`, `apply.sha16`, `apply.lines` are the record. |
| `escalate` | Verify failed `escalate.retry_count` times on the mechanical tier and the policy routes the next attempt to `escalate.model_id` | Handle the retry exactly as an escalated packet today: under `estimated` in your own conversation with `provenance: "estimated"`, under `vendor` via `execute_with_model` with `retry_count: escalate.retry_count`. `escalate.failure` is the last verify output. In `content` mode the last attempt is on disk at `artifact_path`; in `edits` mode the file is back to its pre-packet state (every attempt splices into the original, and a failed one is undone), so the escalated packet redoes the edit. |
| `verify_failed` | `max_retries` spent and the policy never re-routed | Same as `escalate`: the failure is in `attempts[].failure`. |
| `refused` | `artifact_path` is outside the write contract | Planner bug. Fix the packet's `artifact_path` or the allowlist decision; never work around it. |
| `dispatch_failed` | The vendor call failed (network, no price, cap) | As today for a failed dispatch. |
| `no_content` | The model never returned a `content` string within `max_retries` | Rewrite the instruction to demand JSON `{path, content}`; re-dispatch. |

The receipt is small by design (≤ 2 kB; verify output tailed to 1,500 characters). One `execute_with_model` call per file is the whole cost of a mechanical packet in your context: the packet (paths + instruction, ~150 tokens) and the receipt (~80 tokens). On the run this contract comes from, the previous form put ≈ 62k tokens of file text through the orchestrator's context for 24 packets, against 8k when the same files were written inline.

`telemetry.jsonl` gets one event per attempt as before (`events_written` says how many); the events are not echoed in the receipt when `telemetry_path` is set.

### Phase 6 — senior_code_review

Invoke `senior-reviewer` subagent for each module. Collect refinement packets. Re-dispatch them via Phase 5 mechanics.

In brownfield the delegation carries paths only — `change_plan.md` (or `requirements.md`) and
`provenance.json` — per orchestrator.md rule 9; the reviewer reads diffs against
`git_head_before`, not whole files.

### Phase 7 — test_run

**Greenfield mode.** Bootstrap the env fixture first — this is required for any app whose codegen produced a validating `ConfigModule` (or equivalent) at boot. The codegen phase is contractually required (see Phase 5 acceptance criteria and the senior-reviewer's env-fixture check) to emit `.env.example` (docs) and `.env.test` (fixture values that satisfy the declared schema).

```bash
cd <output_dir>
# Only copy .env.test → .env when neither exists. Never overwrite an existing .env —
# a real .env holds real secrets and belongs to the user.
if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test .env; fi
npm install --silent && npm test
```

**Brownfield mode.** The greenfield env-copy above is refused entirely — the repo already has an `.env` (or an equivalent secrets manager) that the user manages, and copying a codegen-produced fixture would either overwrite real secrets or drop the run into a schema-invalid state. Instead:

```bash
cd <repo-root>   # NOT <output_dir> — the app-under-test is the user's actual repo
# Do NOT touch .env under any circumstances. Do NOT copy .env.test → .env.
```

If codegen introduced new required env vars (via `existing_file_edit` on `.env.example`):
1. Append the new keys to `.env.example` (this IS a permitted write — .env.example is in the allowlist by default and holds no values, only key names).
2. Print the list of new keys to the operator with a mini-gate: *"Codegen introduced N new required env vars: X, Y, Z. Populate them in your .env before Phase 7 continues, or say `skip` to run Phase 7 anyway (tests requiring these keys will fail)."*
3. Wait for the user's response before invoking the test command.

The test command in brownfield is `baseline.test_command` (confirmed at Gate 0), not hardcoded `npm test`. Working directory is the repo root (not `<output_dir>`); in monorepos, use the per-package scope from `baseline.monorepo.packages[].test_command` for whichever package the changed files belong to.

**Both modes:**

On failure:
- If the error is `Config validation error: "X" is required` or equivalent → the codegen phase missed keys. In greenfield build a debug TaskPacket routed to codegen to add the missing keys with schema-valid values. In brownfield, ask the user via the mini-gate above; do NOT patch `.env` from the plugin.
- Any other failure → parse the output, build a `debug` TaskPacket with the failing test name + error + relevant source slice (as `inputs[]` paths with `lines`, not pasted text). Route via policy. In brownfield use the apply form with `verify` set to the failing test command scoped to the file, so the mechanical-tier retries and the check happen in the server; you see the receipt. Retry up to 2 cost-efficient tier attempts; escalate to Opus.

**Test-command probe (optional Phase 0.5 in brownfield).** The pipeline pre-check (§7.4) already ran the discovered test command with `--collect-only` / `--dry-run` at prompt 1 to prove deps are installed. If pre-check step 2 failed for this run, Phase 7 halts with the recorded error rather than attempting the real run.

### Phase 8 — security_review

Invoke `security-reviewer` subagent. Writes `<output_dir>/security_review.md`.

**Brownfield: pick `form: full` or `form: light` from the touched set, then delegate.** Read the
`files` list in `provenance.json` and match each path against the security surface below. Any
match → `full`. No match → `light`, and the reviewer runs only the secrets and dependency checks.
Log the phase with `--form=<full|light>` so the report shows which one ran.

| Surface | Path or content signal |
|---|---|
| Auth and authz | path contains `auth`, `guard`, `session`, `permission`, `role`, `middleware`, `policy` |
| Route registration | new or edited controller, router, `urls.py`, `routes/`, `index.ts` that registers handlers, `include_router` |
| Data layer | `migration`, `schema`, `prisma`, `models.py`, `entity`, `repository`, `db/` |
| Serialization of user data | `dto`, `serializer`, `interceptor`, `transform`, `mask` |
| Config and secrets | `.env*`, `config/`, `settings.py`, `package.json`, lockfiles, `Dockerfile`, CI workflow files |
| Audit | `audit`, `log` in a path under the API or server tree |

A pure presentation change — a React component, a stylesheet, an i18n file, a docs page, a test file for existing code — matches none of these. A run that adds an unauthenticated endpoint matches *Route registration* and gets the full checklist. When in doubt, `full`; the light form is for the case where there is nothing for the checklist to find.

### Phase 9 — generate_final_report

Read all events in `<telemetry_path>`. Build rollup manifest using the `buildManifest` shape (see `plugin/mcp/model-dispatch/src/telemetry.ts`). Write `<output_dir>/manifest.json`. Also write a brief `<output_dir>/SUMMARY.md` with: total cost, breakdown, links to key artifacts.

Then, **after** the manifest is on disk, run the orchestrator-overhead collector — telemetry holds dispatched work only, and this session's own loop is invisible to it in both auth modes:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/collect-orchestrator-usage.mjs" <output_dir> --project-root "$(pwd)"
```

`--project-root` must be the same directory the run's `mmo-log.mjs` calls used: the collector reads this run's `run.start` and `run.end` lines from `<project-root>/.sdlc/runs/<run-id>/orchestrator.log` to find the run's own command turn in the session transcript, which is where its window opens (the manifest's `started_at` is only the first dispatched event, after the driver's own setup work; without the log the window is approximate and labelled so). On success it appends one `tier: "orchestrator"` event and patches the manifest with `orchestrator_overhead` + `true_total_cost_usd`; quote the **true total** in SUMMARY.md and label the dispatched figure as such. The figure is **provisional** — you run the collector from inside a session that has not ended, so it misses this session's own tail. Print the command with `<output_dir>` and `$(pwd)` resolved to real paths, in your final message and in SUMMARY.md, under **Provisional — re-run after closing this session**. On failure (non-zero exit), do not block the run: label every cost in SUMMARY.md *dispatched work only — excludes orchestrator overhead* and note the collector command. Never blend the two figures. Keep the run's `claude -p --output-format json` result beside the manifest as `claude-session.json` when you have it: the collector checks itself against it model by model, books the receipt's token counts at the price list when the window is provably the invocation the receipt billed (reporting the share Claude Code billed but never logged), and exits 3 (nothing written) otherwise.

---

## TaskPacket schema (canonical)

```ts
{
  id: "tp_<phase>_<seq>",
  phase: "codegen" | "tests" | "docs" | "debug" | "refactor" | ...,
  task_type: "controller_handler" | "service_method" | ...,
  module: "employees" | "leave" | ...,
  instruction: "<imperative, <300 tokens>",
  inputs: [ { path, content, reason } ],  // SLICED — never full files unless necessary
  outputSchema: { /* JSON schema */ },
  acceptance: ["<testable bullet>", ...],
  budget: { maxInputTokens: 4000, maxOutputTokens: 6000 },  // codegen initial; adapter doubles on max_tokens truncation up to 3× (see below)
  retry_count: 0,
  pass_id: "pass1" | "pass2",
  intent: "docs" | "bugfix" | "feature-extend" | "feature-new" | "refactor" | "test" | "deps"  // brownfield only — omit entirely on greenfield packets
}
```

**Set `intent` on every brownfield packet, from the confirmed value in `intent_brief.md`.** A
policy may route the same `phase` differently per intent (e.g. `refactor`'s Tests phase to a
different model than `docs`'s) via a rule matching on both `phase` and `intent` — the router
falls back to the phase's blanket rule when no intent-specific one exists. Omitting `intent`
silently drops the packet out of every intent-scoped rule and back onto the blanket rule, which
is exactly greenfield's existing behavior — so this is safe to skip on greenfield packets, but
never skip it on brownfield.

---

## Intent matrix — brownfield only

**Applies only when `mode: brownfield`.** Greenfield (`/mmo:greenfield`) runs the full pipeline
described above with no matrix-based branching.

In brownfield, one state machine handles seven intents. Which phases fire — and what shape their
outputs take — depends on the intent picked at Gate 0. Tier assignment (which model runs each
phase) does NOT change per intent; that's fixed by the loaded policy (§11).

| Intent | Phase 1 · requirements | Phase 2 · architecture | Phase 4 · packet plan | Phase 7 · tests | Phase 8 · security review |
|---|---|---|---|---|---|
| **docs** | scoped ("what docs?") | **SKIP** | `doc_addition` / `doc_update` packets | doc-lint only | changed files only, `light` unless the surface table matches |
| **bugfix** | reproduce + diagnose | **SKIP** unless design-affecting | `bug_reproduce` → `bug_diagnose` → `bug_fix_apply` → `test_add` | regression + focused suite | changed files only |
| **feature-extend** | delta requirements | delta `change_plan.md` | mixed `existing_file_edit` + `new_file_add` | affected suites | changed files only; `full` or `light` per the Phase 8 surface table |
| **feature-new** | new-feature requirements | full subsystem design (`change_plan.md`) | full mix (`new_file_add`, `test_add`, `doc_addition`, wiring) | affected + new | changed files only |
| **refactor** | delta (what to preserve) | delta refactor plan | `refactor_extract` + `patch_apply` | **full suite** (invariants) | changed files only; `full` or `light` per the Phase 8 surface table |
| **test** | coverage target | **SKIP** | `test_backfill` / `test_add` | new tests + full suite | test files only, `light` |
| **deps** | upgrade target list | dep-swap plan | `dependency_add` + adjacent-code patches | full suite + smoke | dep-diff + advisory |

**v1 specialization scope (per C6 cut).** Matrix cells are fully specified for the four "known"
intents (docs, bugfix, feature-extend, feature-new) because they map cleanly to the greenfield
behavior we already have. The three "new" intents (refactor, test, deps) route to the closest-
fitting known behavior in v1, with intent-specific prompt overrides landing in v1.5. This means
v1 ships all seven intents (surface-complete) with the last three at ~70% of full-specialized
quality; v1.5 tightens them.

**How the orchestrator branches.** After Gate 0 approval (which sets `intent` on the run
context), the orchestrator consults this table before each phase to decide: SKIP the phase, run
its default form, or run its intent-specific form. Skipped phases still emit a TelemetryEvent
with `phase: <name>, task_type: "skipped"` so downstream summaries stay complete.

**Skip semantics.**
- SKIP means the phase does not run at all — no packet dispatched, no artifact written, no gate
  fires for that phase. The gate immediately after a skipped phase is also skipped.
- Docs intent example: Phase 2 (architecture) skips → Gate 2 also skips → orchestrator goes
  straight from Gate 1 (requirements) to Phase 4 (packet planning).

---

## HITL gate prompt templates

**Subagent → main-loop bubble-up (all gates).** The orchestrator is a Claude Code subagent —
subagents don't run interactive dialogs. Every gate is delivered by the subagent returning a
message shaped as a fenced `> ⏸ **HITL Gate <N> — <Title>**` block (see templates below) that the
main-loop Claude Code session displays verbatim and waits for user input on. The user's reply
comes back to the subagent as a `{ gate_response: "approved" | "revise: <text>" | "abort" }`
argument on the next invocation. **Persist the gate-pending state to `.sdlc/local/state.json`
before emitting the message** — if the session dies mid-gate, session-hydrate detects a
non-terminal state and re-prompts on next `/mmo:brownfield` invocation. No new command needed.

### Gate 0 — Brownfield only, before Gate 1

> ⏸ **HITL Gate 0 — Discovery Confirmation**
>
> I read your repo and produced `<sdlc_root>/runs/<run-id>/discovery.md`. Confirm:
>
> - **Stack:** `<top-detected stacks>` — correct? add/override?
> - **Test command:** `<detected>` — enter to accept, or paste the command.
> - **Policy:** `<the default_policy field setup wrote to .sdlc/project.json>` — accept, or
>   name another on-disk policy for this run only (e.g. `opus-only`). To change the project's
>   persistent default, re-run setup (`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs"`
>   — this is the one command that opens a browser; every other setup step is terminal-only).
> - **Existing AI setup:** `<verbatim list from Tier 1 group 6>` — is any of this
>   authoritative and off-limits? **(default: OFF-LIMITS, do not touch)**
> - **Intent:** `<intent picked in step 4a of /mmo:brownfield>`
> - **File scope:**
>   - allowlist: `<paths proposed by the intent brief>` — accept / edit
>   - off-limits: **project defaults from `.sdlc/project.json.off_limits_default`** apply
>     (`.env*`, `.mcp.json`, `node_modules/**`, `.cursor/rules/**`, `.claude/settings.local.json`,
>     `dist/**`, `.sdlc/**`, `.git/**`) — add anything else this ticket must not touch
>   - AI configs detected in the repo are added on top (see previous bullet)
> - **Repo-state risks (if any):** `<LFS / submodules / failing tests / encrypted secrets>`
> - **Regulated-repo warning (when `baseline.regulated_repo_warning_required`):** *"This repo appears regulated (signals: `<kinds>`). Confirm the active policy uses only compliant endpoints, and that off-limits protects your regulated data folders."*
> - **`.gitignore` needs `.sdlc/` entry (when `baseline.gitignore_covers_sdlc: false`):** *"Your .gitignore doesn't cover .sdlc/. Add `.sdlc/` to .gitignore as part of this run? [Y/n]"*  On yes, add `.gitignore` to the allowlist so the codegen phase can create-or-append it (a codegen packet or a small helper write, per intent). On no, note in the final report so the user gets the same follow-up prompt that surfaced in the docs-gen v1 run.
>
> Typical cost for a `<intent>` run on a repo this size: `$X.XX–$Y.YY`.
>
> Reply: `approved`, `revise: <comments>`, or `abort`.

On `approved`, freeze the write contract to `.sdlc/local/write-contract.json`
(schema: `{schema_version:1, active:true, mode:"brownfield", run_id, strict:true, allowlist,
off_limits}`). Build `off_limits` by concatenating `.sdlc/project.json.off_limits_default`
(the project-level constants — `.env*`, `.mcp.json`, `node_modules/**`, etc., written by setup)
with the AI-configs from `baseline.ai_configs_detected` and any ticket-specific paths the user
added at Gate 0. The PreToolUse hook and the packet validator both read the merged list — the
UX shrinks (Gate 0 doesn't re-ask about constants each ticket), the enforcement is unchanged.
See `plugin/scripts/write-contract-check.mjs` for the hook.

**Default the AI-coexistence answer to OFF-LIMITS.** A user who hits `approved` without reading
must not accidentally authorize the plugin to rewrite their `.cursor/rules` or their custom
`routing-policy.yaml`. If the user wants a competing AI config in scope, they must move it
explicitly.

### Gate 1
> ⏸ **HITL Gate 1 — Requirements Approval**
> I've written `<output_dir>/requirements.md`. Please review and reply with one of:
> - `approved` — proceed to architecture
> - `revise: <comments>` — I'll revise the requirements file based on your comments
> - `abort` — stop the run

### Gate 2
> ⏸ **HITL Gate 2 — Architecture Approval**
> I've written `<output_dir>/design.md`. Same options as Gate 1.

### Gate 3
> ⏸ **HITL Gate 3 — Security Review**
> Security review at `<output_dir>/security_review.md`. Reply `approved`, `revise: <comments>`, or `abort`.

### Gate 4
> ⏸ **HITL Gate 4 — Final Acceptance**
> The full SDLC pass is complete.
> Total cost: $X.XX  ·  Files: N  ·  Tests: passing/total
> Reply `accept` to finalize the manifest, or `reject: <comments>` to revise.

---

## Telemetry contract (every LLM call)

Log via `log_telemetry` with `telemetry_path` = `<output_dir>/telemetry.jsonl`. Event shape:

```json
{
  "ts": "ISO-8601",
  "pass": "pass1|pass2",
  "phase": "<state>",
  "task_type": "<from packet>",
  "task_id": "<from packet>",
  "module": "<from packet>",
  "model": "<canonical model_name>",
  "routed_by": "orchestrator|fallback|manual",
  "routing": { "policy_name": "...", "policy_version": 1, "rule_index": 3, "rule_reason": "..." },
  "input_tokens": 1840,
  "input_tokens_cached": 1420,
  "output_tokens": 612,
  "cost_usd": 0.00234,
  "latency_ms": 1850,
  "success": true,
  "retry_count": 0,
  "artifact_path": "src/leave/leave.controller.ts"
}
```

For direct-tier calls (no MCP dispatch), the orchestrator constructs this event itself using the char/3.8 token estimator. **Do not populate `ts` or `latency_ms` for these — `log_telemetry` overwrites both server-side.** You have no clock and no stopwatch, so any value you supply is a guess; the server stamps the real arrival time and records `latency_ms: null`, meaning "not measured". A `0` would be read downstream as "returned instantly", and an invented `ts` corrupts the run duration in the manifest, which is derived by sorting events on `ts`. **Pricing constants come from the current model's `effective_price.rates` in the `load_policy` result — never from a policy file's `pricing:` block, never from the subagent's trained knowledge, never hardcoded.** If that model has no `effective_price.rates`, abort the run (pre-flight already halts a run with a model that has no price). `effective_price` is the price the server bills `execute_with_model` events at (the dated price list, or the block only under `pricing_override: true`), and the post-run collector prices this session's transcript the same way, so estimates and billing use the same numbers; a block is documentation unless `pricing_override` is true.
