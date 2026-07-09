---
name: run-ai-sdlc
description: The end-to-end AI-SDLC workflow definition consumed by the orchestrator subagent. Defines the state machine, TaskPacket schema, HITL gates, telemetry contract, and the prompts/templates for each phase. The orchestrator reads this skill to know exactly what to do at each step.
---

# AI-SDLC Workflow — Orchestrator Playbook

This skill is the source of truth for the orchestrator. When invoked under `/run-sdlc-pass`, the orchestrator follows the state machine below.

---

## State machine

```
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
9. generate_final_report              → updates manifest.json with artifacts + rollups
   ── GATE 4 (final acceptance) ───────────────────
```

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

### TaskPacket initial output-ceiling budgets

Set `budget.maxOutputTokens` per phase type. The adapter automatically doubles this ceiling on any attempt that terminates with the vendor's max-tokens stop reason (Anthropic `stop_reason: "max_tokens"`, Gemini `finishReason: "MAX_TOKENS"`), up to 3 doublings or the model's absolute output limit declared in the policy YAML (`max_output_tokens_absolute`), whichever comes first. Cached input keeps retry cost low.

- **Codegen packets:** `3000` (services, controllers, DTOs, tests). Most files fit first-shot; a few large service files double once or twice.
- **Premium packets (design, senior_code_review, security_review):** `5000`. Design and review artifacts are the ones that historically hit the ceiling.
- **Docs, ADR, README:** `3000`. Same doubling behavior.
- **Debug packets:** inherit from the packet they refine.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"` — all sharing the packet's `task_id`. The report collapses them into one row per packet.

### Phase 5 — execute_packets

For each packet, in dependency order:

**Direct-tier work (subagent handles it, no MCP dispatch):** the orchestrator (Opus) writes the file directly. Estimate tokens via `chars/3.8` heuristic for both inputs and outputs; source pricing constants from the loaded policy's `pricing:` block for this model; log a TelemetryEvent via `mcp__gemini-flash-server__log_telemetry`.

**Mechanical-tier work (routed to another model):** call `mcp__gemini-flash-server__execute_with_model` with the packet, `policy_name`, and `cache_context`. The server routes per policy. Validate the returned structured output against the schema; if invalid, construct a *refined* packet (new id, `retry_count+1`, with the validation error appended to instruction) and re-dispatch. After 2 mechanical-tier retries fail, the policy escalates to the subagent's own tier automatically (rule with `retry_count: { gte: 2 }`).

Write the returned file content to disk at the packet's stated `artifact_path`.

### Phase 6 — senior_code_review

Invoke `senior-reviewer` subagent for each module. Collect refinement packets. Re-dispatch them via Phase 5 mechanics.

### Phase 7 — test_run

Bootstrap the env fixture first — this is required for any app whose codegen produced a validating `ConfigModule` (or equivalent) at boot. The codegen phase is contractually required (see Phase 5 acceptance criteria and the senior-reviewer's env-fixture check) to emit `.env.example` (docs) and `.env.test` (fixture values that satisfy the declared schema).

```bash
cd <output_dir>
if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test .env; fi
npm install --silent && npm test
```

On failure:
- If the error is `Config validation error: "X" is required` or equivalent → the codegen phase missed keys in `.env.test`. Build a debug TaskPacket routed to codegen to add the missing keys with schema-valid values. Do NOT patch `.env` by hand.
- Any other failure → parse the output, build a `debug` TaskPacket with the failing test name + error + relevant source slice. Route via policy. Retry up to 2 cost-efficient tier attempts; escalate to Opus.

### Phase 8 — security_review

Invoke `security-reviewer` subagent. Writes `<output_dir>/security_review.md`.

### Phase 9 — generate_final_report

Read all events in `<telemetry_path>`. Build rollup manifest using the `buildManifest` shape (see `plugin/mcp/gemini-flash-server/src/telemetry.ts`). Write `<output_dir>/manifest.json`. Also write a brief `<output_dir>/SUMMARY.md` with: total cost, breakdown, links to key artifacts.

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
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },  // codegen initial; adapter doubles on max_tokens truncation up to 3× (see below)
  retry_count: 0,
  pass_id: "pass1" | "pass2"
}
```

---

## HITL gate prompt templates

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

Log via `mcp__gemini-flash-server__log_telemetry` with `telemetry_path` = `<output_dir>/telemetry.jsonl`. Event shape:

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

For direct-tier calls (no MCP dispatch), the orchestrator constructs this event itself using the char/3.8 token estimator. **Pricing constants come from the loaded policy YAML's `pricing:` block for the current model — never from the subagent's trained knowledge, never hardcoded.** If the policy's pricing block is missing, abort the run.
