#!/usr/bin/env node
/**
 * Before a paid pair: the checks the unit tests reach around. Prints one line
 * per check and exits 1 on any FAIL. Nothing here changes anything.
 *
 *   node tools/ambient-preflight.mjs [--project <dir>] [--app-copy <dir>] [--port 8793] [--no-probe] [--probe-timeout <s>]
 *
 * 1. Every ambient tool is named by the before-hook matcher (a tool the code
 *    handles but the matcher does not name runs unstamped and invisible).
 * 2. The installed app copy equals this repository's plugin folder (a fix that
 *    was never copied reaches no chat).
 * 3. The board process listening on the port started after the board code
 *    last changed (a running program never picks up new sentences).
 * 4. The records are empty and the evidence file is absent (a pair starts clean).
 * 5. The worker answers RIGHT NOW: one tiny real call through the same door a
 *    job uses. Quota, credentials and the region are knowable only by asking,
 *    and 23 Sep pair 9 learned that the hard way, at 429 in mid-run. Skip it
 *    with --no-probe; it costs a fraction of a cent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const project = opt("--project", process.cwd());
const appCopy = opt("--app-copy", join(homedir(), ".claude", "plugins", "cache", "tilicho-ai-labs", "mmo", "0.8.2"));
const port = Number(opt("--port", "8793"));
const home = process.env.MMO_HOME || join(homedir(), ".mmo-ambient");
let failed = 0;
const say = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const { START_TOOLS, FOLLOW_TOOLS } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "stamp.mjs"));
const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
const pre = hooks.PreToolUse.filter((m) => JSON.stringify(m).includes("pre-mmo-tool")).map((m) => new RegExp(m.matcher));
const unwired = [...START_TOOLS, ...FOLLOW_TOOLS].filter((n) => !pre.some((re) => re.test(`mcp__plugin_mmo_model-dispatch__${n}`)));
say(unwired.length === 0, `hook wiring: every tool named by the before-hook matcher${unwired.length ? " (missing: " + unwired.join(", ") + ")" : ""}`);

if (!existsSync(appCopy)) say(false, `app copy present at ${appCopy}`);
else {
  let diff = "";
  try { execFileSync("diff", ["-rq", "--exclude", "node_modules", "--exclude", ".git", join(ROOT, "plugin"), appCopy], { stdio: "pipe" }); }
  catch (e) { diff = e.stdout?.toString() || "differs"; }
  say(diff === "", `app copy equals the repository's plugin folder${diff ? " (" + diff.split("\n").filter(Boolean).length + " differences; rsync it)" : ""}`);
}

let pid = null;
try { pid = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdio: "pipe" }).toString().trim().split("\n")[0] || null; } catch { /* nothing listening */ }
if (!pid) say(false, `board: nothing listens on port ${port} (start it)`);
else {
  let started = null;
  try { started = new Date(execFileSync("ps", ["-o", "lstart=", "-p", pid], { stdio: "pipe" }).toString().trim()); } catch { /* unknown */ }
  const boardDir = join(appCopy, "scripts", "ambient", "board");
  const newest = existsSync(boardDir) ? Math.max(...readdirSync(boardDir).map((f) => statSync(join(boardDir, f)).mtimeMs)) : 0;
  const fresh = started && Number.isFinite(started.getTime()) && started.getTime() >= newest;
  say(Boolean(fresh), `board process ${pid} started ${started ? started.toISOString() : "?"} ${fresh ? "after" : "BEFORE"} the board code last changed${fresh ? "" : "; restart it"}`);
}

const sessions = existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).length : 0;
const jobs = existsSync(join(home, "jobs")) ? readdirSync(join(home, "jobs")).length : 0;
say(sessions === 0 && jobs === 0, `records empty (${sessions} sessions, ${jobs} jobs)${sessions || jobs ? "; wipe first" : ""}`);
say(!existsSync(join(home, "evidence.json")), `evidence file absent${existsSync(join(home, "evidence.json")) ? "; move it to the Trash for a clean pair" : ""}`);

// 5. One real call, last, so a failure here never hides a wiring fault above.
if (args.includes("--no-probe")) console.log("SKIP  worker probe (--no-probe)");
else {
  const { probeWorker } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "probe.mjs"));
  const { loadConfig } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "config.mjs"));
  const { config } = loadConfig({ projectDir: project, env: process.env });
  const worker = config.workers?.[config.workers?.default ?? "flash"] ?? config.workers?.flash;
  let door = null;
  try {
    const dist = join(ROOT, "plugin", "mcp", "model-dispatch", "dist");
    const { chatPolicyNames, completionDoor } = await import(join(dist, "ambient", "tools.js"));
    const { loadPolicy } = await import(join(dist, "policy.js"));
    const policies = chatPolicyNames(process.env).map((policyName) => loadPolicy({ policyName, projectRoot: project }));
    door = completionDoor(policies, { thinking: config.jobs?.worker_thinking ?? "low" });
  } catch (e) { console.log(`      (no door: ${String(e?.message ?? e).slice(0, 120)})`); }
  // The probe runs at the depth the pair will run at, because that is what the
  // pair will pay for and wait on. 23 Sep: a one-word answer took 7 s at "low"
  // and far longer at "high", which is worth knowing before a pair, not during.
  const r = await probeWorker({ worker, callWorker: door, timeoutMs: Number(opt("--probe-timeout", "180")) * 1000 });
  say(r.ok, r.ok
    ? `worker probe: ${worker} answered in ${(r.ms / 1000).toFixed(1)} s at thinking ${config.jobs?.worker_thinking ?? "low"}${r.model && r.model !== worker ? ` (${r.model})` : ""}`
    : `worker probe: ${worker} did NOT answer${r.rateLimited ? " — OUT OF QUOTA, do not start a pair" : ""} (${r.detail})`);
}

process.exit(failed ? 1 : 0);
