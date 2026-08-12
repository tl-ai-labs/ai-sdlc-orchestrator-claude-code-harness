"use server";

import { writeFileSync } from "node:fs";
import { revalidatePath } from "next/cache";
import { KNOWN_ADAPTERS, PHASES, codegenTaskTypes, debugEscalationRule, fallbackRule, thinkingSupport } from "@/lib/policySchema";
import { listPolicyIds, policyFilePath, readPolicy } from "@/lib/policies";
import { buildCustomPolicy, renderPolicyYaml, type CustomizeInput } from "@/lib/buildPolicy";

export interface SaveResult {
  ok: boolean;
  errors: string[];
  path?: string;
  yaml?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validates and writes a new policy file. Re-reads the base policy from
 * disk rather than trusting anything the client sent about it, so the only
 * client input that reaches the file is the phase→model / phase→effort
 * choices and the chosen name. `wx` refuses to write over an existing file
 * even if a race slipped past the pre-check below.
 */
export async function savePolicy(input: CustomizeInput): Promise<SaveResult> {
  const errors: string[] = [];
  const name = input.name.trim();

  if (!name) errors.push("Name is required.");
  else if (!NAME_PATTERN.test(name)) {
    errors.push("Name must be lowercase, filesystem-safe (letters, digits, hyphens), starting with a letter or digit.");
  }

  const existing = listPolicyIds();
  if (name && existing.includes(name)) {
    errors.push(`Name "${name}" already exists — pick a name that isn't ${existing.join(", ")}.`);
  }
  if (!existing.includes(input.baseId)) {
    errors.push(`Base policy "${input.baseId}" no longer exists on disk. Reload and pick again.`);
  }
  if (errors.length) return { ok: false, errors };

  const base = readPolicy(input.baseId);

  // Validate the draft's full model list — base models plus whatever was
  // added this session — not just what the base policy originally declared.
  const seenIds = new Set<string>();
  for (const m of input.models) {
    if (!m.id || seenIds.has(m.id)) {
      errors.push(`Model id "${m.id}" is missing or duplicated in this policy's model list.`);
    }
    seenIds.add(m.id);
    if (!(KNOWN_ADAPTERS as readonly string[]).includes(m.adapter)) {
      errors.push(`Model "${m.id}" names adapter "${m.adapter}", which has no real implementation. Known: ${KNOWN_ADAPTERS.join(", ")}.`);
    }
    if (!m.model_name?.trim()) {
      errors.push(`Model "${m.id}" is missing a model_name.`);
    }
    for (const k of ["input", "input_cached", "output"] as const) {
      if (typeof m.pricing?.[k] !== "number" || m.pricing[k] < 0) {
        errors.push(`Model "${m.id}": pricing.${k} must be a number ≥ 0.`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const modelIds = new Set(input.models.map((m) => m.id));
  for (const phase of PHASES) {
    const chosen = input.routing[phase.id];
    if (!chosen || !modelIds.has(chosen)) {
      errors.push(`Phase "${phase.id}" is routed to "${chosen}", which isn't in this policy's model list.`);
    }
  }

  if (errors.length) return { ok: false, errors };

  for (const phase of PHASES) {
    const tier = input.thinking[phase.id];
    if (!tier || tier === "off") continue;
    const model = input.models.find((m) => m.id === input.routing[phase.id]);
    const supported = model ? thinkingSupport(model) : [];
    if (!supported.includes(tier)) {
      errors.push(`Phase "${phase.id}" sets thinking tier "${tier}", which "${model?.id}" doesn't support.`);
    }
  }

  if (errors.length) return { ok: false, errors };

  const policy = buildCustomPolicy(
    {
      version: base.version,
      select: base.select,
      structural: {
        codegenTaskTypes: codegenTaskTypes(base),
        debugEscalation: debugEscalationRule(base),
        fallback: fallbackRule(base),
      },
    },
    { ...input, name }
  );
  const yamlText = renderPolicyYaml(policy, input.baseId);
  const path = policyFilePath(name);

  try {
    // wx: fail if the file already exists — belt-and-braces on top of the
    // name-collision check above, which reads a moment earlier.
    writeFileSync(path, yamlText, { encoding: "utf-8", flag: "wx" });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return { ok: false, errors: [`Name "${name}" already exists — pick a different name.`] };
    }
    return { ok: false, errors: [`Could not write policy file: ${err?.message ?? String(err)}`] };
  }

  revalidatePath("/");
  return { ok: true, errors: [], path, yaml: yamlText };
}
