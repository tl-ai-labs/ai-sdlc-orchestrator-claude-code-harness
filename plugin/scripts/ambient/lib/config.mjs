/**
 * Layered ambient settings for the hook path. Plain JSON on purpose: hooks
 * run on machines that installed the plugin with /plugin install and have no
 * node_modules, so the YAML policy cannot be parsed here.
 *
 * Order, weakest to strongest:
 *   1. plugin/config/ambient.default.json          shipped defaults (mode "off")
 *   2. <MMO_HOME>/ambient.json                      the developer's own file
 *   3. <project>/.sdlc/ambient.json                 governed project file
 *   4. MMO_AMBIENT=off|observe|on                   one-run override
 *
 * A project file is attacker input: anyone who can land a commit can edit it.
 * It is applied in full only when its sha256 is listed in
 * <MMO_HOME>/receipts.json, a user-level file a repository cannot write.
 * Without a receipt it may only TIGHTEN: lower the mode, close cells, add
 * never-delegate paths, switch a valve off, switch workflow routing off or
 * back to asking. Every other key is ignored.
 *
 * Routing (docs/ambient-mode.md, "Routing"): `routing` on|off starts the
 * /mmo: workflow a chat message asks for; `routing_unsure` ask|auto says what
 * happens when Opus, not the rules, recognises one; `routing_defaults` holds
 * the policy and cost mode a routed workflow starts with.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mmoHome } from "./paths.mjs";

export const MODES = ["off", "observe", "on"];
export const ROUTING = ["off", "on"];
export const ROUTING_UNSURE = ["ask", "auto"];
/** A policy name as the plugin ships them: it is passed to a script as one argument. */
const POLICY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, "..", "..", "..", "config", "ambient.default.json");

function readJsonSafe(file) {
  try {
    if (!existsSync(file) || statSync(file).size > MAX_CONFIG_BYTES) return null;
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { parsed, text } : null;
  } catch {
    return null;
  }
}

function isPlain(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for trusted layers. Arrays replace; unknown top-level keys are dropped. */
function mergeTrusted(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    if (isPlain(v) && isPlain(base[k])) out[k] = mergeTrustedLoose(base[k], v);
    else if (typeof v === typeof base[k] && Array.isArray(v) === Array.isArray(base[k])) out[k] = v;
  }
  return out;
}

/** Nested objects (valves, cost, prices) accept new keys, same type rule otherwise. */
function mergeTrustedLoose(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (isPlain(v) && isPlain(base[k])) out[k] = mergeTrustedLoose(base[k], v);
    else if (!(k in base) || typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

function lowerMode(a, b) {
  const ia = MODES.indexOf(a);
  const ib = MODES.indexOf(b);
  if (ib < 0) return a;
  return MODES[Math.min(ia, ib)];
}

function uniqueStrings(list) {
  return [...new Set(list.filter((s) => typeof s === "string" && s.length > 0 && s.length <= 300))];
}

/** Apply an unverified project file: only changes that make the plugin do LESS. */
export function applyTightenOnly(base, project) {
  const out = structuredClone(base);
  if (typeof project.mode === "string") out.mode = lowerMode(out.mode, project.mode);
  if (project.lock_model === true) out.lock_model = true;
  // Cheaper-model jobs OFF is a tightening (the reading rules stay on): the like-for-like plain side of a pair.
  if (project.delegation === "off") out.delegation = "off";
  // Routing can only be switched off, or from starting at once back to asking: a repository never starts
  // a paid workflow on someone's machine by itself.
  if (project.routing === "off") out.routing = "off";
  if (project.routing_unsure === "ask") out.routing_unsure = "ask";
  if (Array.isArray(project.closed_cells)) {
    out.closed_cells = uniqueStrings([...out.closed_cells, ...project.closed_cells]);
  }
  if (Array.isArray(project.never_delegate_paths)) {
    out.never_delegate_paths = uniqueStrings([...out.never_delegate_paths, ...project.never_delegate_paths]);
  }
  if (isPlain(project.valves)) {
    for (const name of Object.keys(out.valves)) {
      if (isPlain(project.valves[name]) && project.valves[name].enabled === false) out.valves[name].enabled = false;
    }
  }
  return out;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function receiptListed(home, hash) {
  const r = readJsonSafe(join(home, "receipts.json"));
  const list = r && Array.isArray(r.parsed.policies) ? r.parsed.policies : [];
  return list.some((entry) => entry && entry.sha256 === hash);
}

/**
 * Returns the effective settings plus `sources`, a short list of which layers
 * applied and how, so a report can say why a session ran in the mode it did.
 * Never throws: any unreadable layer is skipped.
 */
export function loadConfig({ projectDir, env = process.env, defaultFile = DEFAULT_FILE } = {}) {
  const shipped = readJsonSafe(defaultFile);
  if (!shipped) return { config: { mode: "off" }, sources: ["defaults-unreadable"] };
  let config = shipped.parsed;
  const sources = ["defaults"];
  const home = mmoHome(env);

  const user = readJsonSafe(join(home, "ambient.json"));
  if (user) { config = mergeTrusted(config, user.parsed); sources.push("user"); }

  if (projectDir) {
    const project = readJsonSafe(join(projectDir, ".sdlc", "ambient.json"));
    if (project) {
      if (receiptListed(home, sha256(project.text))) {
        config = mergeTrusted(config, project.parsed);
        sources.push("project-verified");
      } else {
        config = applyTightenOnly(config, project.parsed);
        sources.push("project-tighten-only");
      }
    }
  }

  if (typeof env.MMO_AMBIENT === "string" && MODES.includes(env.MMO_AMBIENT)) {
    config.mode = env.MMO_AMBIENT;
    sources.push("env");
  }
  if (!MODES.includes(config.mode)) config.mode = "off";
  // A value the plugin does not know means the safe default, never a guess.
  if (!ROUTING.includes(config.routing)) config.routing = "off";
  if (!ROUTING_UNSURE.includes(config.routing_unsure)) config.routing_unsure = "ask";
  if (!isPlain(config.routing_defaults)) config.routing_defaults = {};
  if (!POLICY_NAME.test(String(config.routing_defaults.policy ?? ""))) config.routing_defaults.policy = "opus-plus-flash-v38";
  if (!["estimated", "vendor"].includes(config.routing_defaults.auth)) config.routing_defaults.auth = "estimated";
  return { config, sources };
}
