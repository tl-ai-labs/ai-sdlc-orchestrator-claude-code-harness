import { stringify as stringifyYaml } from "yaml";
import {
  PHASES,
  type ModelConfig,
  type Policy,
  type Rule,
  type SelectSlot,
  type StructuralParts,
  type Tier,
} from "./policySchema";

export interface CustomizeInput {
  baseId: string;
  name: string;
  models: ModelConfig[];
  routing: Record<string, string>;
  thinking: Record<string, Tier>;
}

/**
 * A new policy: `input.models` — the base's models plus whatever was added
 * in this session — and the base's `select` block unchanged, a fresh rules
 * array reflecting the phase-level routing/thinking choices. Structural
 * rules (debug's retry escalation, codegen's task_type scope, the trailing
 * default) carry through unedited — see
 * docs/specs/custom-policy-and-thinking-config.md non-goals for why editing
 * those is out of scope for this console. Takes the structural pieces
 * explicitly (rather than a full base `Policy`) so the client-side preview
 * and the server-side save build the identical shape from the same data.
 */
export function buildCustomPolicy(
  base: { version: number; select?: Record<string, SelectSlot>; structural: StructuralParts },
  input: CustomizeInput
): Policy {
  const { select, structural } = base;
  const { models } = input;
  const rules: Rule[] = [];

  for (const phase of PHASES) {
    if (phase.id === "debug" && structural.debugEscalation) rules.push(structural.debugEscalation);

    const rule: Rule & { when: any } = {
      when:
        phase.id === "codegen" && structural.codegenTaskTypes
          ? { phase: phase.id, task_type: structural.codegenTaskTypes }
          : { phase: phase.id },
      use: input.routing[phase.id],
    };
    const tier = input.thinking[phase.id];
    if (tier && tier !== "off") rule.reasoning = { tier };
    rules.push(rule);
  }

  rules.push(structural.fallback ?? { default: models[0]?.id ?? input.routing[PHASES[0].id] });

  return {
    version: base.version,
    name: input.name,
    models,
    ...(select ? { select } : {}),
    rules,
  };
}

export function renderPolicyYaml(policy: Policy, baseId: string): string {
  const header = `# Customized from ${baseId} via the policy console — ${new Date().toISOString().slice(0, 10)}.\n`;
  return header + stringifyYaml(policy, { lineWidth: 0 });
}
