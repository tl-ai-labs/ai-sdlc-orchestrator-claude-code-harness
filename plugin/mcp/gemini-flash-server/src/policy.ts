/**
 * Policy loader & validator. Supports per-run override via:
 *   1. CLI flag (--policy=<name>) handled upstream
 *   2. Project-root routing-policy.yaml (wins over plugin default)
 *   3. Plugin default in plugin/config/policies/<name>.yaml
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Policy, ModelConfig } from "./types.js";

const PLUGIN_POLICY_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "config",
  "policies"
);

export function loadPolicy(opts: {
  policyName?: string;          // e.g. "opus-only"
  projectRoot?: string;         // for project-level override
}): Policy {
  // 1. Project override
  if (opts.projectRoot) {
    const override = join(opts.projectRoot, "routing-policy.yaml");
    if (existsSync(override)) {
      return validatePolicy(parseYaml(readFileSync(override, "utf-8")));
    }
  }
  // 2. Named preset
  const name = opts.policyName ?? "opus-only";
  const presetPath = join(PLUGIN_POLICY_DIR, `${name}.yaml`);
  if (!existsSync(presetPath)) {
    throw new Error(
      `Policy '${name}' not found at ${presetPath}. ` +
        `Available: opus-only, opus-plus-flash. ` +
        `Add your own by dropping a YAML in ${PLUGIN_POLICY_DIR}.`
    );
  }
  return validatePolicy(parseYaml(readFileSync(presetPath, "utf-8")));
}

export function loadPolicyFromPath(path: string): Policy {
  if (!existsSync(path)) throw new Error(`Policy file not found: ${path}`);
  return validatePolicy(parseYaml(readFileSync(path, "utf-8")));
}

function validatePolicy(raw: any): Policy {
  if (!raw || typeof raw !== "object") {
    throw new Error("Policy: root must be an object");
  }
  if (typeof raw.version !== "number") {
    throw new Error("Policy: 'version' (number) required");
  }
  if (typeof raw.name !== "string") {
    throw new Error("Policy: 'name' (string) required");
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error("Policy: 'models' (non-empty array) required");
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error("Policy: 'rules' (non-empty array) required");
  }
  for (const m of raw.models) validateModel(m);
  // Cross-check: every rule references a known model id
  const modelIds = new Set(raw.models.map((m: ModelConfig) => m.id));
  raw.rules.forEach((r: any, i: number) => {
    const used = r.use ?? r.default;
    if (!used) throw new Error(`Policy rule ${i}: needs 'use' or 'default'`);
    if (!modelIds.has(used)) {
      throw new Error(
        `Policy rule ${i}: references unknown model id '${used}'. Known: ${Array.from(modelIds).join(", ")}`
      );
    }
  });
  return raw as Policy;
}

function validateModel(m: any) {
  for (const key of ["id", "adapter", "model_name", "pricing"]) {
    if (!(key in m)) throw new Error(`Policy model: missing '${key}'`);
  }
  for (const k of ["input", "input_cached", "output"]) {
    if (typeof m.pricing[k] !== "number") {
      throw new Error(`Policy model '${m.id}': pricing.${k} must be number`);
    }
  }
}

export function getModel(policy: Policy, modelId: string): ModelConfig {
  const m = policy.models.find((x) => x.id === modelId);
  if (!m) throw new Error(`Model id '${modelId}' not found in policy '${policy.name}'`);
  return m;
}
