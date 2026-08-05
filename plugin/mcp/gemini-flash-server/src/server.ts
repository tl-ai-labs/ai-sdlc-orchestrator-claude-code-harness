#!/usr/bin/env node
/**
 * MCP server entrypoint — bundled inside the multi-model-orchestrator plugin.
 *
 * Tools exposed:
 *   execute_with_model   — run a TaskPacket against the model chosen by policy
 *   simulate_policy      — what-if recomputation for the dashboard
 *   log_telemetry        — append a TelemetryEvent to disk (used by hooks)
 *   load_policy          — return the active policy (debug/inspection)
 */

// MUST stay the first import. It strips environment variables that arrived as
// unexpanded `${VAR}` placeholders — which is what plugin.json's env pass-throughs
// hand us whenever the host never exported them — and ES module evaluation order is
// the only thing guaranteeing it happens before any SDK reads process.env. See
// envBootstrap.ts and env.ts for the full account of what this prevented.
import "./envBootstrap.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { existsSync } from "node:fs";

import { loadPolicy, loadPolicyFromPath, getModel } from "./policy.js";
import {
  pickModel,
  simulatePolicyCost,
  parseSelectOverrides,
  validateSelectOverrides,
  unreachableModelIds,
} from "./routing.js";
import { assessModels, parseAuthMode, type AuthMode } from "./preflight.js";
import { appendEvent, normalizeDirectTierEvent } from "./telemetry.js";
import { createAdapter } from "./adapters/index.js";
import {
  defaultAdcPath,
  selectGeminiBackend,
  resolveGcpProject,
  resolveGcpLocation,
} from "./adapters/geminiTransports.js";
import type { TaskPacket, TelemetryEvent, Policy, SelectOverrides } from "./types.js";

const SERVER_NAME = "gemini-flash-server";
const SERVER_VERSION = "0.1.0";

// Runtime state: loaded policies cached by name, adapters cached by model id.
const adapterCache = new Map<string, ReturnType<typeof createAdapter>>();
let activePolicy: Policy | null = null;
let activePolicyKey = "";

/**
 * The environment variable carrying this run's answers to the policy's select
 * slots, spelled `slot=option[,slot=option...]`.
 *
 * An environment variable rather than a tool argument because the choice is a
 * property of the INSTALL, not of any one dispatch: `npm run setup` asks the
 * question once and writes the answer into `.mcp.json` (clone route) or the
 * host environment (plugin route). Making it a per-call argument would put the
 * orchestrator subagent in charge of restating it on every packet, and a single
 * forgotten restatement would silently route that packet to the other tier.
 */
const SELECT_ENV = "SDLC_SELECT";

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  const key = `${policyName ?? "opus-only"}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  const policy = policyPath
    ? loadPolicyFromPath(policyPath)
    : loadPolicy({ policyName, projectRoot });
  // Check the run's slot choices against THIS policy, once, here. Every policy
  // load goes through this function, so there is no path on which a bad choice
  // reaches routing unchecked — and failing at load means failing before the
  // first dispatch is paid for rather than partway through a phase.
  validateSelectOverrides(policy, selectOverrides());
  activePolicy = policy;
  activePolicyKey = key;
  return activePolicy;
}

/**
 * This run's slot choices, re-read from the environment on each call.
 *
 * Re-read rather than captured at module load so that a test can set the
 * variable and observe the effect without restarting the server, and so the
 * parse error for a malformed spec surfaces at the call that needed it, naming
 * the offending text. `envBootstrap` has already removed the value if it
 * arrived as an unexpanded `${SDLC_SELECT}` placeholder, so an absent variable
 * here genuinely means "no choices made".
 */
function selectOverrides(): SelectOverrides {
  return parseSelectOverrides(process.env[SELECT_ENV]);
}

function adapterFor(policy: Policy, modelId: string) {
  if (adapterCache.has(modelId)) return adapterCache.get(modelId)!;
  const model = getModel(policy, modelId);
  const adapter = createAdapter(model);
  adapterCache.set(modelId, adapter);
  return adapter;
}

/**
 * Prove every model in the policy can actually be dispatched to — before the run
 * spends anything.
 *
 * WHY THIS EXISTS
 *
 * Adapters are constructed lazily, on first dispatch. GeminiFlashAdapter's
 * constructor is where credential discovery happens and where it throws when no
 * door into Gemini is open — a deliberate design, because construction was meant
 * to happen "during setup validation, before any premium-tier phase has been
 * billed". Nothing ever called it that early. In practice the first construction
 * happened at the first mechanical packet, which is phase 4 of 9, roughly twenty
 * minutes and several dollars of premium-tier work into a run. The 2026-08-04
 * live run failed exactly there: every mechanical dispatch died, the orchestrator
 * fell back to the premium tier, and the run silently became the opposite of the
 * cost demonstration it exists to produce.
 *
 * Calling this first closes that gap. It constructs every adapter the loaded
 * policy names, which is the same code path a real dispatch takes, and reports
 * the resolved Gemini configuration. It makes no API call and costs nothing, so
 * there is no reason not to run it every time.
 *
 * Adapters land in the shared cache, so the first real dispatch reuses what this
 * built rather than paying for construction twice.
 *
 * WHY IT TAKES THE AUTH MODE
 *
 * Which models this server actually dispatches to is not a property of the policy
 * alone — it depends on the run's auth mode, so a check that ignores the mode gets
 * the answer wrong half the time. Under `estimated` the orchestrator runs its own
 * tier inside the Claude Code session and never constructs that adapter, so a missing
 * ANTHROPIC_API_KEY is inert; halting on it (which this did on 2026-08-04) is a false
 * positive on a gate the operator is told never to override. The classification lives
 * in preflight.ts, which is unit-testable without credentials; what stays here is the
 * environment probing that is not.
 */
function preflightDispatch(policy: Policy, authMode: AuthMode) {
  // A policy may now offer more than one way to reach a tier. Only the option
  // this run selected can be dispatched to, so only it is constructed — the
  // loser's prerequisites (a Python environment, a worker script) are not this
  // run's problem, and halting on them would be the same false positive the
  // auth-mode split above exists to remove.
  const notSelected = unreachableModelIds(policy, selectOverrides());
  const assessment = assessModels(
    policy.models.filter((m) => !notSelected.has(m.id)),
    authMode,
    (modelId) => adapterFor(policy, modelId),
  );

  // Report the resolved Gemini configuration alongside the pass/fail. On a
  // healthy setup this is the line that tells the operator which project and
  // region the run is about to bill, which is worth seeing before it starts and
  // not only afterwards in the telemetry.
  const adcPath = defaultAdcPath();
  const adcFileExists = existsSync(adcPath);
  let gemini: Record<string, unknown>;
  try {
    const keyEnvName =
      policy.models.find((m) => m.adapter === "mcp:gemini-flash-server")?.auth?.env ??
      "GEMINI_API_KEY";
    const choice = selectGeminiBackend({ env: process.env, keyEnvName, adcFileExists });
    gemini = {
      backend: choice.backend,
      reason: choice.reason,
      adc_file: adcFileExists ? adcPath : null,
      ...(choice.backend === "vertex-adc"
        ? {
            project: resolveGcpProject(process.env, adcPath),
            location: resolveGcpLocation(process.env),
          }
        : {}),
    };
  } catch (err: any) {
    gemini = { backend: null, error: err?.message ?? String(err), adc_file: adcFileExists ? adcPath : null };
  }

  return {
    ok: assessment.ok,
    auth_mode: authMode,
    policy: { name: policy.name, version: policy.version },
    models: assessment.models,
    // Named rather than silently omitted: "the agent leaf is not in this list
    // because you did not select it" is a different message from "the agent leaf
    // is not in this list because pre-flight forgot about it", and an operator
    // reading the output has no other way to tell them apart.
    not_selected: [...notSelected],
    gemini,
    halt_reason: assessment.halt_reason,
    // Failures on models this run will not dispatch to. Reported because they are
    // true and useful — the same policy in vendor mode would not start — but they
    // must never stop a run that was never going to touch them.
    warnings: assessment.warnings,
  };
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "execute_with_model",
      description:
        "Execute a TaskPacket. Routes to the model chosen by the policy. " +
        "Returns structured result + tokens + cost_usd + latency.",
      inputSchema: {
        type: "object",
        properties: {
          packet: { type: "object", description: "TaskPacket (see types.ts)" },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
          work_dir: {
            type: "string",
            description:
              "Directory a delegated agent worker may read, edit and run commands in — " +
              "normally the run's code_dir. Ignored by models that are called as models; " +
              "required by policy leaves that delegate to an agent (adapter: " +
              "antigravity-worker), which have no way to act without one. Defaults to " +
              "project_root.",
          },
          cache_context: { type: "string", description: "Key for explicit context cache (e.g. 'pass2:workforce-ops')" },
          telemetry_path: { type: "string", description: "JSONL file to append telemetry to" },
        },
        required: ["packet"],
      },
    },
    {
      name: "simulate_policy",
      description:
        "What-if: given a list of telemetry events from a real run, recompute total cost under a different policy. No LLM calls.",
      inputSchema: {
        type: "object",
        properties: {
          events: { type: "array" },
          policy_name: { type: "string" },
          policy_path: { type: "string" },
        },
        required: ["events"],
      },
    },
    {
      name: "log_telemetry",
      description: "Append a telemetry event to the pass JSONL log.",
      inputSchema: {
        type: "object",
        properties: { telemetry_path: { type: "string" }, event: { type: "object" } },
        required: ["telemetry_path", "event"],
      },
    },
    {
      name: "preflight_dispatch",
      description:
        "Prove every model this run will dispatch to can be reached, BEFORE the run spends " +
        "anything. Constructs each adapter (where credential discovery happens and fails) and " +
        "reports the resolved Gemini backend, project and region. Makes no API call and costs " +
        "nothing. Call this once at the start of every run and halt on ok:false — otherwise a " +
        "credential problem only surfaces at the first mechanical packet, after the premium " +
        "phases are billed. Requires auth_mode: under 'vendor' every model is dispatched through " +
        "this server and so every adapter must work, while under 'estimated' the orchestrator's " +
        "own tier runs in-session and its adapter is never constructed — failures there are " +
        "reported in `warnings` and do not halt.",
      inputSchema: {
        type: "object",
        properties: {
          auth_mode: {
            type: "string",
            enum: ["vendor", "estimated"],
            description: "The run's auth mode. Decides which models are actually dispatched here.",
          },
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
        required: ["auth_mode"],
      },
    },
    {
      name: "load_policy",
      description: "Return the policy that would be active for the given args (debug).",
      inputSchema: {
        type: "object",
        properties: {
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "execute_with_model": {
        const a = args as any;
        const packet = a.packet as TaskPacket;
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const decision = pickModel(
          {
            phase: packet.phase,
            task_type: packet.task_type,
            module: packet.module,
            retry_count: packet.retry_count ?? 0,
          },
          policy,
          selectOverrides()
        );
        const adapter = adapterFor(policy, decision.modelId);
        // Where the run is happening, as distinct from what it is asking for.
        // Passed on every dispatch rather than only when a worker is selected,
        // because the selection happens above by policy and this call site has
        // no business knowing which adapter came back. Completion adapters
        // ignore the argument entirely.
        const result = await adapter.execute(packet, a.cache_context, {
          project_root: a.project_root,
          work_dir: a.work_dir ?? a.project_root,
          telemetry_path: a.telemetry_path,
        });

        // If the adapter ran a doubling loop, emit one TelemetryEvent per
        // attempt, all sharing the packet's task_id. The report collapses
        // them into a single row per packet. If it didn't loop (single
        // attempt), we still emit exactly one event — same code path.
        const attempts = result.attempts ?? [
          {
            attempt_number: 1,
            ceiling_used: packet.budget.maxOutputTokens,
            hit_output_cap: false,
            tokens: result.tokens,
            cost_usd: result.cost_usd,
            latency_ms: result.latency_ms,
            success: result.success,
            error: result.error,
          },
        ];
        const modelName = getModel(policy, decision.modelId).model_name;
        const baseEvent = {
          ts: new Date().toISOString(),
          pass: packet.pass_id,
          phase: packet.phase,
          task_type: packet.task_type,
          task_id: packet.id,
          module: packet.module,
          model: modelName,
          routed_by: "orchestrator" as const,
          // The leaf id, alongside the vendor model name above. Two leaves can
          // share a model name and differ only in how it is reached, so this is
          // the only field that says which tier actually ran.
          model_id: decision.modelId,
          routing: {
            policy_name: policy.name,
            policy_version: policy.version,
            rule_index: decision.ruleIndex,
            rule_reason: decision.reason,
            // Undefined unless the matched rule named a slot; JSON.stringify
            // drops undefined keys, so events from unslotted policies are
            // byte-for-byte what they were before slots existed.
            select: decision.selection,
          },
          retry_count: packet.retry_count ?? 0,
        };
        const events: TelemetryEvent[] = attempts.map((att) => ({
          ...baseEvent,
          input_tokens: att.tokens.input,
          input_tokens_cached: att.tokens.input_cached,
          output_tokens: att.tokens.output,
          // Already counted inside output_tokens and billed at the output rate;
          // repeated here only so a reader can see how much of a delegation's
          // output was thinking rather than answer. Left undefined by adapters
          // that do not report it, and JSON.stringify drops undefined keys, so
          // events from the completion tiers are byte-for-byte unchanged.
          output_tokens_reasoning: att.tokens.output_reasoning,
          cost_usd: att.cost_usd,
          latency_ms: att.latency_ms,
          success: att.success,
          attempt_number: att.attempt_number,
          ceiling_used: att.ceiling_used,
          retry_reason: att.attempt_number > 1 ? "output_cap" : undefined,
          error: att.error,
        }));
        if (a.telemetry_path) for (const ev of events) appendEvent(a.telemetry_path, ev);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { decision, result, events, terminal_reason: result.terminal_reason },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "simulate_policy": {
        const a = args as any;
        const policy = ensurePolicy(a.policy_name, undefined, a.policy_path);
        // Simulated against the same slot choices the real run uses, so a
        // what-if on a slotted policy prices the tier this install would
        // actually dispatch to rather than the policy's default.
        const out = simulatePolicyCost(a.events, policy, selectOverrides());
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "log_telemetry": {
        const a = args as any;
        // The caller here is a model reporting a call it made itself (the direct tier),
        // so its `ts` and `latency_ms` are guesses, not measurements — overwrite both
        // server-side before persisting. See normalizeDirectTierEvent for the full why.
        appendEvent(a.telemetry_path, normalizeDirectTierEvent(a.event as TelemetryEvent));
        return { content: [{ type: "text", text: "ok" }] };
      }
      case "preflight_dispatch": {
        const a = args as any;
        // Parsed before the policy is loaded so a missing mode fails on the mode,
        // not on some downstream symptom of it. parseAuthMode throws rather than
        // defaulting — see preflight.ts for why neither default is safe.
        const authMode = parseAuthMode(a.auth_mode);
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const out = preflightDispatch(policy, authMode);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "load_policy": {
        const a = args as any;
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        return { content: [{ type: "text", text: JSON.stringify(policy, null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
