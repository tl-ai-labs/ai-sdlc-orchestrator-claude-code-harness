/**
 * One consent per repository and vendor, given by a person, before any file
 * content leaves the machine for a vendor other than the one already running
 * the chat. The chat itself sends the repository to the thinker's vendor, so a
 * worker at that same vendor needs no second consent; a worker somewhere else
 * does. No consent file, no job: the start tool refuses and names the consent
 * tool. Nothing in this module can create consent on a model's say-so alone;
 * the file is written only by the consent tool's handler.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, mmoHome } from "./paths.mjs";
import { repoKey } from "./repo-stats.mjs";

export function vendorOf(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("gemini") || m.includes("flash")) return "google";
  if (m.includes("claude") || m.includes("sonnet") || m.includes("haiku") || m.includes("opus")) return "anthropic";
  return "unknown";
}

function consentFile(repoRoot, vendor, env) {
  return join(mmoHome(env), "consent", `${repoKey(repoRoot)}.${vendor.replace(/[^a-z]/g, "")}.json`);
}

export function needsConsent(workerModel, thinkerModel) {
  const v = vendorOf(workerModel);
  return v === "unknown" || v !== vendorOf(thinkerModel);
}

export function hasConsent(repoRoot, vendor, env = process.env) {
  try { return JSON.parse(readFileSync(consentFile(repoRoot, vendor, env), "utf8")).agreed === true; } catch { return false; }
}

export function recordConsent(repoRoot, vendor, env = process.env) {
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "consent"));
  writeFileSync(consentFile(repoRoot, vendor, env), JSON.stringify({ agreed: true, vendor, repo_root: repoRoot, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function consentExists(repoRoot, vendor, env = process.env) {
  return existsSync(consentFile(repoRoot, vendor, env));
}
