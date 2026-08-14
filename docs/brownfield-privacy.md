# Brownfield mode — data, privacy, compliance

> **For:** compliance officers and regulated environments (SOC2, HIPAA, PCI). What leaves the machine per phase; on-prem routing; audit trail. **Also see:** [brownfield.md](brownfield.md) · [brownfield-write-contract.md](brownfield-write-contract.md) · [methodology.md](methodology.md).

## What data leaves the machine

The plugin's per-phase data-exit profile:

| Phase | What's dispatched to a model | Notes |
|---|---|---|
| Discovery | **Nothing.** Local `Read`/`Glob`/`Grep` only | Zero data exit |
| Requirements / architecture / packet planning / senior review / security review | Intent brief + relevant source slices + prior phase artifact | Slices, not full files, unless necessary |
| Codegen packets | Design fragment + a few source slices | Slices only |
| Test execution | **Nothing.** `Bash` runs your test command locally | Zero data exit |

**Never sent, regardless of phase:**

- `.env` values (only key NAMES are ever seen, per discovery)
- Any file matching known secret patterns (private-key headers, `AWS_SECRET_ACCESS_KEY=…`
  assignments, GitHub / Anthropic / OpenAI / Slack / Stripe tokens, JWTs, bearer
  authorization values, high-signal env-var assignments)
- Files in the run's `off_limits` list
- File contents from paths matched by `.gitignore` (unless you explicitly moved them into
  the allowlist at Gate 0)

Enforcement: `plugin/scripts/dispatch-sanitize.mjs` runs a regex sweep on **every** dispatch
input before it leaves the machine. Detected patterns → dispatch is refused, the orchestrator
surfaces the finding in the run report. See the script for the 13 patterns it checks (all with
very-low false-positive rates: known vendor prefixes, PEM key blocks, JWTs, etc.). It
deliberately does NOT do broad "high-entropy string" matching — that would flag legitimate
hashes and IDs, produce false alarms, and train users to bypass.

## Never sent, ever

- **Prompt content** — telemetry records model + phase + token counts + cost + timing. Not
  the prompt itself.
- **Response content** — same. Telemetry never captures what a model returned.
- **File paths beyond `artifact_path`** — telemetry records the path the packet wrote to;
  it doesn't record every file the model saw as input.

The support bundle (a v1.5 feature) further redacts: env-key names only (no values), no file
contents, only allowlist/off-limits paths (not their contents).

## On-prem / private-cloud routing

The plugin's routing is policy-driven. You can point it at private endpoints instead of
public model providers:

- **AWS Bedrock** — configure a Bedrock-specific policy YAML (`bedrock-claude-only.yaml`
  ships in v1.5) mapping the plugin's tier names to Bedrock model IDs.
- **Gemini Enterprise Agent Platform, formerly Vertex AI (Google Cloud)** — same, via a
  `vertex-*.yaml` policy pointing at your GCP project's endpoint.
- **Self-hosted models** — any provider the plugin's adapters know about. Adding a new
  adapter is a plugin-level extension.

Drop your policy YAML at `.sdlc/policy.yaml` (project scope) or at repo root as
`routing-policy.yaml`. The policy loader picks it up automatically; Gate 0 surfaces which
policy is active before the run starts.

**No fallback to public models.** Once your policy names a private endpoint, the plugin
refuses to fall back to a public one when that endpoint is unavailable. The `preflight_dispatch`
check runs before the first paid call; if a private endpoint isn't reachable, the run halts
cleanly rather than silently using a public alternative.

## PII in source

The plugin does **not** try to detect PII in your source code (out of scope; false-positive
risk too high, and there's no widely-agreed definition of "PII in code"). If your codebase
contains PII in comments, fixtures, or test data, that content may reach a model when a
packet includes it as input.

If you're in a regulated environment (SOC2, GDPR, HIPAA, PCI, etc.):

- **Prefer on-prem routing.** See above — configure a policy pointing at your regulated-
  cloud endpoint (BAA-covered Bedrock, PHI-eligible Vertex, etc.).
- **Off-limits your regulated data folders.** At Gate 0, move any directory containing PII
  into the run's `off_limits` list. The write contract will refuse writes there AND
  discovery will not read files from there. (Gate 0's proposal already off-limits `.env*`,
  `.cursor/`, etc. — add your PII folders manually.)
- **The plugin surfaces a Gate 0 warning** if it detects a `SECURITY.md`, `PRIVACY.md`, or a
  path segment like `SOC2/`, `HIPAA/`, `PCI/`, or `regulated/`:
  > *"This repo appears regulated. Confirm the active policy uses only compliant endpoints,
  > and that off-limits protects your regulated data folders."*

## Audit trail

Every run produces:

- **`provenance.json`** — per-file record: `path`, `sha_before`, `sha_after`, `model`,
  `phase`, `tokens_in`, `tokens_out`, `cost_usd`, `git_sha_at_write`, `plugin_version`,
  `packet_id`, `written_at`.
- **`telemetry.jsonl`** — one line per model call: `ts`, `model`, `phase`, `task_id`,
  `tokens_*`, `cost_usd`, `latency_ms`, `success`.
- **`ledger.json` / `ledger.md`** — one row per run: timestamp, intent, branch, HEAD before /
  after, packet count, files touched, gates passed, outcome, spend, plugin version.
- **Gate answers** logged with each run.

These are what a compliance officer asks for: "what data went where, when, at whose
direction." `/sdlc:audit` (v1.5) exports these into a single `.sdlc/audit-export.md` +
`.json` suitable for ingestion into your compliance tooling.

## Data locality guarantees

- All plugin state is local — under your repo (`.sdlc/`) or your home directory
  (`~/.claude/projects/`). No plugin-owned cloud storage.
- Model calls go to whatever endpoint the active policy names.
- **No call-home. No usage tracking. No analytics. Ever.**

The plugin has no license-server ping, no anonymous telemetry, no crash reporting. If
you disconnect from the network, it fails at the first model dispatch and does nothing else.

## Model input isolation across intents

Different intents have different read footprints. Compliance officers should know:

| Intent | Read footprint | Typical files sent to models |
|---|---|---|
| `docs` | **Wide read, narrow write.** The docs intent reads a lot of source to summarize it. | Every file in the allowlist gets slice-sampled during Phase 1 requirements. |
| `bugfix` | **Narrow read, narrow write.** | The failing test + relevant module. |
| `feature-extend` | Medium. | The extended file + adjacent module files. |
| `feature-new` | Medium-wide (planner needs to know the surrounding architecture). | Same as feature-extend, plus architecture-adjacent files. |
| `refactor` | **Wide read.** Call sites for the refactor target must be found. | Every file matching a `Grep` pattern derived from the refactor scope. |
| `test` | Narrow read (only the file being tested), narrow write. | The target module + adjacent test files. |
| `deps` | Very narrow. | `package.json` + files that import the affected dep. |

If your compliance policy bounds which intents may run against which repos, bracket
accordingly.
