/**
 * Wiring: the things the unit tests reach around. The live app finds the plugin
 * through the hook file's matchers, the plugin manifest and the installed copy;
 * a tool the code handles but the matcher does not name is invisible live
 * (23 Sep: the batch write ran unstamped for a whole pair because its name was
 * missing from the before-hook matcher, and no test looked at the matcher).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { START_TOOLS, FOLLOW_TOOLS, ambientToolName } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "stamp.mjs"));

test("every ambient tool the hook can stamp is named by a PreToolUse matcher that runs the stamping hook; the batch write also has its after-hook", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
  const pre = hooks.PreToolUse.filter((m) => JSON.stringify(m).includes("pre-mmo-tool")).map((m) => new RegExp(m.matcher));
  assert.ok(pre.length >= 1, "a PreToolUse entry runs pre-mmo-tool");
  for (const name of [...START_TOOLS, ...FOLLOW_TOOLS]) {
    const full = `mcp__plugin_mmo_model-dispatch__${name}`;
    assert.equal(ambientToolName(full), name, `${name} is a tool the hook knows`);
    assert.ok(pre.some((re) => re.test(full)), `${name}: named by the before-hook matcher, or it runs unstamped`);
  }
  const post = hooks.PostToolUse.filter((m) => JSON.stringify(m).includes("post-mmo-tool")).map((m) => new RegExp(m.matcher));
  assert.ok(post.some((re) => re.test("mcp__plugin_mmo_model-dispatch__write_files")), "the batch write's created files are counted after the call");
});

test("the server's tool list and the hook's tool sets name the same tools", async () => {
  const src = readFileSync(join(ROOT, "plugin", "mcp", "model-dispatch", "src", "ambient", "tools.ts"), "utf8");
  const listed = [...src.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]).filter((n) => ambientToolName(`mcp__plugin_mmo_model-dispatch__${n}`) || n === "consent_to_send");
  for (const name of [...START_TOOLS, ...FOLLOW_TOOLS]) assert.ok(listed.includes(name), `${name} is served by the server`);
});
