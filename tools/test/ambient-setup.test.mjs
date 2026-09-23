/**
 * The setup script edits a person's Claude Code settings file, so the tests pin
 * the three things that must never go wrong: a dry run writes nothing, an apply
 * MERGES and leaves a backup, and a file that does not parse is left alone.
 * Everything runs against a temp HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = join(ROOT, "plugin", "scripts", "ambient", "setup.mjs");
const { plan, addReceipt } = await import(SCRIPT);
const { loadConfig } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "config.mjs"));

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-setup-"));
  mkdirSync(join(dir, ".claude"));
  const env = { HOME: dir, MMO_HOME: join(dir, ".mmo-ambient") };
  return { dir, env, settings: join(dir, ".claude", "settings.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the default is a dry run: it reports every change and writes nothing", () => {
  const h = home();
  try {
    writeFileSync(h.settings, JSON.stringify({ theme: "dark", hooks: { Stop: [] } }));
    const before = readFileSync(h.settings, "utf8");
    const report = plan({ env: h.env });
    assert.deepEqual(report.map((r) => r.status), ["would-change", "would-change", "would-change", "would-change"]);
    assert.equal(readFileSync(h.settings, "utf8"), before);
    assert.deepEqual(readdirSync(join(h.dir, ".claude")), ["settings.json"], "no backup, no new file");
    assert.ok(!existsSync(h.env.MMO_HOME));
  } finally { h.cleanup(); }
});

test("apply merges into the existing file, keeps every other key, and leaves a backup of the original", () => {
  const h = home();
  try {
    const original = { theme: "dark", hooks: { Stop: [{ hooks: [] }] }, env: { FOO: "1" }, model: "claude-sonnet-5" };
    writeFileSync(h.settings, JSON.stringify(original));
    const report = plan({ env: h.env, apply: ["cache", "model"], now: new Date("2026-09-22T00:00:00Z") });
    const after = JSON.parse(readFileSync(h.settings, "utf8"));
    assert.deepEqual({ theme: after.theme, hooks: after.hooks, env: after.env }, { theme: "dark", hooks: original.hooks, env: original.env });
    assert.deepEqual([after.promptCacheTtl, after.subagentPromptCacheTtl, after.model], ["1h", "1h", "claude-opus-5"]);
    assert.equal(after.bashOutputMaxChars, undefined, "a group that was not named is not applied");
    const backup = readdirSync(join(h.dir, ".claude")).find((f) => f.includes(".before-mmo-"));
    assert.deepEqual(JSON.parse(readFileSync(join(h.dir, ".claude", backup), "utf8")), original);
    assert.equal(report.find((r) => r.group === "bash").status, "would-change");
    assert.deepEqual(plan({ env: h.env, apply: ["cache"] }).find((r) => r.group === "cache").status, "already-set", "a second run changes nothing");
  } finally { h.cleanup(); }
});

test("a settings file that does not parse is never overwritten", () => {
  const h = home();
  try {
    writeFileSync(h.settings, "{ broken json, // with a comment");
    const report = plan({ env: h.env, apply: ["all"] });
    assert.equal(readFileSync(h.settings, "utf8"), "{ broken json, // with a comment");
    assert.ok(report.filter((r) => r.file === h.settings).every((r) => r.status === "skipped"));
    assert.equal(JSON.parse(readFileSync(join(h.env.MMO_HOME, "ambient.json"), "utf8")).mode, "observe", "the plugin's own file is still written");
  } finally { h.cleanup(); }
});

test("the mode group turns ambient mode on for the account, and a receipt trusts one exact project file", () => {
  const h = home();
  try {
    plan({ env: h.env, apply: ["mode"], mode: "on" });
    assert.equal(loadConfig({ env: h.env }).config.mode, "on");
    const project = join(h.dir, "repo");
    mkdirSync(join(project, ".sdlc"), { recursive: true });
    writeFileSync(join(project, ".sdlc", "ambient.json"), JSON.stringify({ lock_model: false }));
    assert.equal(loadConfig({ projectDir: project, env: h.env }).config.lock_model, true, "unreceipted: a project cannot unlock the model");
    assert.equal(addReceipt(project, h.env).ok, true);
    assert.equal(loadConfig({ projectDir: project, env: h.env }).config.lock_model, false);
    assert.equal(addReceipt(join(h.dir, "nope"), h.env).ok, false);
  } finally { h.cleanup(); }
});

test("the command line prints the plan and says plainly that nothing was changed", () => {
  const h = home();
  try {
    const out = execFileSync("node", [SCRIPT], { env: { ...process.env, ...h.env } }).toString();
    assert.match(out, /\[cache\] would-change/);
    assert.match(out, /Nothing was changed/);
    assert.ok(!existsSync(h.settings));
    assert.match(execFileSync("node", [SCRIPT, "--status"], { env: { ...process.env, ...h.env }, cwd: h.dir }).toString(), /mode: off {3}from: defaults/);
  } finally { h.cleanup(); }
});
