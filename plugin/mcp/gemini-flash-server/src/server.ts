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
import { pickModel, simulatePolicyCost } from "./routing.js";
import { appendEvent, normalizeDirectTierEvent } from "./telemetry.js";
import { createAdapter } from "./adapters/index.js";
import {
  defaultAdcPath,
  selectGeminiBackend,
  resolveGcpProject,
  resolveGcpLocation,
} from "./adapters/geminiTransports.js";
import type { TaskPacket, TelemetryEvent, Policy } from "./types.js";

const SERVER_NAME = "gemini-flash-server";
const SERVER_VERSION = "0.1.0";

// Runtime state: loaded policies cached by name, adapters cached by model id.
const adapterCache = new Map<string, ReturnType<typeof createAdapter>>();
let activePolicy: Policy | null = null;
let activePolicyKey = "";

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  const key = `${policyName ?? "opus-only"}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  activePolicy = policyPath
    ? loadPolicyFromPath(policyPath)
    : loadPolicy({ policyName, projectRoot });
  activePolicyKey = key;
  return activePolicy;
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
 */
function preflightDispatch(policy: Policy) {
  const models = policy.models.map((m) => {
    try {
      adapterFor(policy, m.id);
      return { id: m.id, model_name: m.model_name, adapter: m.adapter, ok: true as const };
    } catch (err: any) {
      return {
        id: m.id,
        model_name: m.model_name,
        adapter: m.adapter,
        ok: false as const,
        error: err?.message ?? String(err),
      };
    }
  });

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

  const failed = models.filter((m) => !m.ok);
  return {
    ok: failed.length === 0,
    policy: { name: policy.name, version: policy.version },
    models,
    gemini,
    // Spelled out rather than left to the caller to phrase, so the halt message
    // an operator sees is the same one whichever model is driving the run.
    halt_reason:
      failed.length === 0
        ? null
        : `Cannot dispatch to ${failed.length} of ${models.length} models in policy '${policy.name}': ` +
          failed.map((f) => `${f.id} (${f.error})`).join("; ") +
          ". Do not start the run — every packet routed to these models would fall back to the premium " +
          "tier, producing a run that costs more than a single-model baseline. Fix credentials first, " +
          "then re-run this check.",
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
        "Prove every model in the policy can be dispatched to, BEFORE the run spends anything. " +
        "Constructs each adapter (where credential discovery happens and fails) and reports the " +
        "resolved Gemini backend, project and region. Makes no API call and costs nothing. " +
        "Call this once at the start of every run and halt on ok:false — otherwise a credential " +
        "problem only surfaces at the first mechanical packet, after the premium phases are billed.",
      inputSchema: {
        type: "object",
        properties: {
          policy_name: { type: "string" },
          project_root: { type: "string" },
          policy_path: { type: "string" },
        },
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
          policy
        );
        const adapter = adapterFor(policy, decision.modelId);
        const result = await adapter.execute(packet, a.cache_context);

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
          routing: {
            policy_name: policy.name,
            policy_version: policy.version,
            rule_index: decision.ruleIndex,
            rule_reason: decision.reason,
          },
          retry_count: packet.retry_count ?? 0,
        };
        const events: TelemetryEvent[] = attempts.map((att) => ({
          ...baseEvent,
          input_tokens: att.tokens.input,
          input_tokens_cached: att.tokens.input_cached,
          output_tokens: att.tokens.output,
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
        const out = simulatePolicyCost(a.events, policy);
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
        const policy = ensurePolicy(a.policy_name, a.project_root, a.policy_path);
        const out = preflightDispatch(policy);
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
