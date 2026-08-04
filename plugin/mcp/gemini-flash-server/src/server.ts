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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadPolicy, loadPolicyFromPath, getModel } from "./policy.js";
import { pickModel, simulatePolicyCost } from "./routing.js";
import { appendEvent, normalizeDirectTierEvent } from "./telemetry.js";
import { createAdapter } from "./adapters/index.js";
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
