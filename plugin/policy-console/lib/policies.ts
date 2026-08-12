// Server-only: reads the real policy files this app is configuring. Never
// imported from a "use client" component.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  extractHeaderComment,
  summarizePolicy,
  type Policy,
  type PolicySummary,
} from "./policySchema";

export const POLICIES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "policies"
);

export function policyFilePath(id: string): string {
  return join(POLICIES_DIR, `${id}.yaml`);
}

export function listPolicyIds(): string[] {
  if (!existsSync(POLICIES_DIR)) return [];
  return readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort((a, b) => (a === "opus-only" ? -1 : a === "opus-plus-flash" && b !== "opus-only" ? -1 : a.localeCompare(b)));
}

export function readPolicyRaw(id: string): string {
  return readFileSync(policyFilePath(id), "utf-8");
}

export function readPolicy(id: string): Policy {
  return parseYaml(readPolicyRaw(id)) as Policy;
}

export function loadAllPolicySummaries(): PolicySummary[] {
  return listPolicyIds().map((id) => {
    const raw = readPolicyRaw(id);
    const policy = parseYaml(raw) as Policy;
    return summarizePolicy(id, policy, extractHeaderComment(raw));
  });
}
