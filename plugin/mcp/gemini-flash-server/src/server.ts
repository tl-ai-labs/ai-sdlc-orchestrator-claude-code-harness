#!/usr/bin/env node
/**
 * MCP server entrypoint. Tools:
 *   execute_with_model   — run a TaskPacket against the model chosen by policy
 *   simulate_policy      — recompute cost from telemetry against another policy
 *   log_telemetry        — append a direct-tier event to disk
 *   preflight_dispatch   — construct every adapter this run will use (no API call)
 *   load_policy          — return the active policy (debug)
 */

// MUST stay the first import — strips `${NAME}` placeholder env vars before
// any SDK reads process.env. See envBootstrap.ts.
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

/** Slot choices, spelled `slot=option[,slot=option...]`. Property of the install. */
const SELECT_ENV = "SDLC_SELECT";

function ensurePolicy(policyName?: string, projectRoot?: string, policyPath?: string): Policy {
  const key = `${policyName ?? "opus-only"}|${projectRoot ?? ""}|${policyPath ?? ""}`;
  if (activePolicy && activePolicyKey === key) return activePolicy;
  const policy = policyPath
    ? loadPolicyFromPath(policyPath)
    : loadPolicy({ policyName, projectRoot });
  // Every policy load goes through here, so a bad slot choice fails at load
  // rather than partway through a paid phase.
  validateSelectOverrides(policy, selectOverrides());
  activePolicy = policy;
  activePolicyKey = key;
  return activePolicy;
}

/** Re-read on every call — a test can set the variable without restarting. */
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
 * Construct every adapter the loaded policy names, before the run spends
 * anything. Adapters are otherwise built lazily on first dispatch, where a
 * credential problem would surface after premium-tier phases had already been
 * billed. No API call — construction is where credential discovery happens.
 * Adapters land in the shared cache, so the first real dispatch reuses them.
 *
 * Takes authMode because only models this run actually dispatches to matter:
 * under `estimated` the orchestrator runs its own tier in-session and never
 * constructs `builtin-anthropic`, so an unset ANTHROPIC_API_KEY is inert.
 * Classification lives in preflight.ts.
 */
function preflightDispatch(policy: Policy, authMode: AuthMode) {
  // Losing options of `select:` slots are excluded: their prerequisites
  // (Python venv, worker script) are not this run's problem.
  const notSelected = unreachableModelIds(policy, selectOverrides());
  const assessment = assessModels(
    policy.models.filter((m) => !notSelected.has(m.id)),
    authMode,
    (modelId) => adapterFor(policy, modelId),
  );

  // Resolved Gemini configuration — the project and region the run will bill.
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
    // Named so "you did not select it" stays distinguishable from
    // "pre-flight forgot about it".
    not_selected: [...notSelected],
    gemini,
    halt_reason: assessment.halt_reason,
    // Failures on models this run will not dispatch to — informational,
    // never blocking.
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
        // Passed on every dispatch; completion adapters ignore it.
        const result = await adapter.execute(packet, a.cache_context, {
          project_root: a.project_root,
          work_dir: a.work_dir ?? a.project_root,
          telemetry_path: a.telemetry_path,
        });

        // One TelemetryEvent per attempt, all sharing the packet's task_id.
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
          // Leaf id; the only field that distinguishes two leaves that share
          // a vendor model name (e.g. flash-completion vs flash-agsdk-worker).
          model_id: decision.modelId,
          routing: {
            policy_name: policy.name,
            policy_version: policy.version,
            rule_index: decision.ruleIndex,
            rule_reason: decision.reason,
            // Undefined unless the rule went through a slot; JSON.stringify
            // drops undefined keys, so unslotted policies produce identical
            // events to before slots existed.
            select: decision.selection,
          },
          retry_count: packet.retry_count ?? 0,
        };
        const events: TelemetryEvent[] = attempts.map((att) => ({
          ...baseEvent,
          input_tokens: att.tokens.input,
          input_tokens_cached: att.tokens.input_cached,
          output_tokens: att.tokens.output,
          // Already counted in output_tokens and billed at the output rate;
          // surfaced only so a reader can see how much of a delegation's
          // output was thinking. Undefined on adapters that don't report it.
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
        // Replay against the same slot choices the real run uses.
        const out = simulatePolicyCost(a.events, policy, selectOverrides());
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      case "log_telemetry": {
        const a = args as any;
        // Direct-tier caller is a model with no clock — normalize overwrites
        // its `ts` and nulls `latency_ms`.
        appendEvent(a.telemetry_path, normalizeDirectTierEvent(a.event as TelemetryEvent));
        return { content: [{ type: "text", text: "ok" }] };
      }
      case "preflight_dispatch": {
        const a = args as any;
        // Parse before the policy loads so a missing mode fails on the mode.
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
