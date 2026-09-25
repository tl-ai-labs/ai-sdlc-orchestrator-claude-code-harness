#!/usr/bin/env node
/**
 * One-time setup for ambient mode. It never changes anything unless told to.
 *
 *   node setup.mjs                       show what WOULD change (the default)
 *   node setup.mjs --apply=all           apply every proposal
 *   node setup.mjs --apply=mode,cache    apply only the named groups
 *   node setup.mjs --mode=observe|on|off which mode the `mode` group writes (default observe)
 *   node setup.mjs --receipt <project>   trust that project's .sdlc/ambient.json as it is now
 *   node setup.mjs --status [project]    the effective mode and where it comes from
 *
 * Groups: mode (the plugin's own ~/.mmo-ambient/ambient.json), cache, bash,
 * model (three keys of Claude Code's user settings file). Full workflows need
 * nothing here: their helpers name their model in the plugin's own agent files
 * (v0.8.3, 25 Sep), so the "routing" group that added CLAUDE_CODE_SUBAGENT_MODEL
 * to this file's env block was removed, and setup never touches that entry.
 *
 * Every setting name below was checked in the Claude Code 2.1.270 program text:
 *   promptCacheTtl, subagentPromptCacheTtl  "5m" | "1h"
 *   bashOutputMaxChars                       whole number, clamped 4000-128000
 *   model                                    a model id
 * The settings file is MERGED, never replaced, and a timestamped copy is
 * written beside it first. A file that does not parse is left untouched.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, sha256 } from "./lib/config.mjs";
import { ensureDir, mmoHome } from "./lib/paths.mjs";

export function proposals(config, mode = "observe") {
  return {
    mode: { file: "ambient", set: { mode }, why: `turns ambient mode to "${mode}" for this account (observe records what each rule would do and changes nothing)` },
    cache: { file: "claude", set: { promptCacheTtl: "1h", subagentPromptCacheTtl: "1h" }, why: "a pause longer than five minutes otherwise re-writes the whole context at the cache-write price; on a subscription the main chat already gets one hour, this also covers metered logins and subagents. One-hour writes cost more per token, so keep this only if the on/off numbers say it pays" },
    bash: { file: "claude", set: { bashOutputMaxChars: 12000 }, why: "Claude Code's own cap on command output kept inline (default 30000); past it the model gets a preview and a file path" },
    model: { file: "claude", set: { model: config.thinker }, why: `new sessions start on the policy's thinker model (${config.thinker})` },
  };
}

function readJsonOrNull(file) {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Returns the list of changes; writes only when `apply` names the group. */
export function plan({ env = process.env, apply = [], mode = "observe", now = new Date() } = {}) {
  const home = env.HOME ?? homedir();
  const files = { claude: join(home, ".claude", "settings.json"), ambient: join(mmoHome(env), "ambient.json") };
  const { config } = loadConfig({ env });
  const out = [];
  const pending = {};
  for (const [group, p] of Object.entries(proposals(config, mode))) {
    const file = files[p.file];
    const current = readJsonOrNull(file);
    if (current === null) { out.push({ group, file, status: "skipped", why: "the file exists but is not valid JSON; it was left untouched" }); continue; }
    const set = p.set;
    const changes = Object.entries(set).filter(([k, v]) => JSON.stringify(current[k]) !== JSON.stringify(v)).map(([k, v]) => ({ key: k, from: current[k] ?? null, to: v }));
    const wanted = apply.includes("all") || apply.includes(group);
    out.push({ group, file, why: p.why, changes, status: changes.length === 0 ? "already-set" : wanted ? "applied" : "would-change" });
    if (wanted && changes.length) (pending[file] ??= { current, set: {} }).set = { ...pending[file].set, ...set };
  }
  for (const [file, { current, set }] of Object.entries(pending)) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) copyFileSync(file, `${file}.before-mmo-${now.toISOString().replace(/[:.]/g, "-")}`);
    writeFileSync(file, JSON.stringify({ ...current, ...set }, null, 2) + "\n", { mode: 0o600 });
  }
  return out;
}

export function addReceipt(projectDir, env = process.env) {
  const file = join(projectDir, ".sdlc", "ambient.json");
  if (!existsSync(file)) return { ok: false, reason: `${file} does not exist` };
  const hash = sha256(readFileSync(file, "utf8"));
  ensureDir(mmoHome(env));
  const receipts = join(mmoHome(env), "receipts.json");
  const current = readJsonOrNull(receipts) ?? {};
  const policies = Array.isArray(current.policies) ? current.policies : [];
  if (!policies.some((p) => p.sha256 === hash)) policies.push({ sha256: hash, project: projectDir, at: new Date().toISOString() });
  writeFileSync(receipts, JSON.stringify({ ...current, policies }, null, 2) + "\n", { mode: 0o600 });
  return { ok: true, sha256: hash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const after = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--status")) {
    const project = after("status");
    const { config, sources } = loadConfig({ projectDir: project && !project.startsWith("--") ? project : process.cwd() });
    console.log(`mode: ${config.mode}   from: ${sources.join(" > ")}   thinker: ${config.thinker}   lock_model: ${config.lock_model}`);
  } else if (args.includes("--receipt")) {
    console.log(JSON.stringify(addReceipt(after("receipt") ?? process.cwd()), null, 2));
  } else {
    const mode = ["off", "observe", "on"].includes(value("mode")) ? value("mode") : "observe";
    const apply = (value("apply") ?? "").split(",").filter(Boolean);
    for (const r of plan({ apply, mode })) {
      console.log(`\n[${r.group}] ${r.status}   ${r.file}`);
      if (r.why) console.log(`  ${r.why}`);
      for (const c of r.changes ?? []) console.log(`  ${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
    }
    if (!apply.length) console.log("\nNothing was changed. Re-run with --apply=all or --apply=<groups> to write.");
  }
}
