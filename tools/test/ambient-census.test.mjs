/**
 * The task census reads session transcripts and reports aggregates. The
 * fixture is a small hand-built transcript, so every expected number below can
 * be checked by eye.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = join(ROOT, "plugin", "scripts", "ambient", "census.mjs");
const { census } = await import(SCRIPT);
const { loadConfig } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "config.mjs"));

const at = (min) => new Date(Date.UTC(2026, 8, 22, 10, min)).toISOString();
const usage = { input_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000, output_tokens: 400 };
const REQUEST_USD = (1000 * 5 + 2000 * 6.25 + 100000 * 0.5 + 400 * 25) / 1e6;

function fixture() {
  const user = (min, content, extra = {}) => ({ type: "user", timestamp: at(min), message: { role: "user", content }, ...extra });
  const asst = (min, id, content = []) => ({ type: "assistant", timestamp: at(min), message: { id, model: "claude-opus-5[1m]", usage, content } });
  const result = (id, chars) => [{ type: "tool_result", tool_use_id: id, content: "x".repeat(chars) }];
  return [
    user(0, "fix the crash in the date parser SECRET-PROMPT-TEXT"),
    asst(1, "m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/big.ts" } }]),
    asst(1, "m1", [{ type: "text", text: "same request, second content block" }]),
    user(2, result("t1", 40000)),
    asst(3, "m2", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "cat src/other.ts" } }]),
    user(4, result("t2", 30000)),
    asst(5, "m3", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }]),
    user(6, result("t3", 10000)),
    asst(7, "m4", [{ type: "tool_use", id: "t4", name: "Read", input: { file_path: "src/big.ts", offset: 1, limit: 2000 } }]),
    user(8, result("t4", 40000)),
    asst(9, "m5", [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "git log | head" } }]),
    user(10, result("t5", 20000)),
    { type: "system", subtype: "compact_boundary", timestamp: at(11) },
    user(100, "yes"),
    asst(101, "m6"),
    { type: "assistant", isSidechain: true, timestamp: at(102), message: { id: "side", model: "claude-opus-5", usage } },
    user(200, "write docs for the parser"),
    asst(201, "m7"),
    "{ torn line",
  ].map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
}

test("census counts requests once, prices them, labels episodes and sizes what each rule could touch", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-census-"));
  try {
    mkdirSync(join(dir, "proj"));
    writeFileSync(join(dir, "proj", "s1.jsonl"), fixture());
    const r = census(dir, loadConfig({ env: { MMO_HOME: join(dir, "none") } }).config);
    assert.equal(r.sessions, 1);
    assert.equal(r.requests, 7, "m1 appears twice in the file and is one request; the sidechain entry is not counted");
    assert.ok(Math.abs(r.priced_usd - 7 * REQUEST_USD) < 1e-9, "the [1m] tag prices as the same model");
    assert.deepEqual(r.labels, { bugfix: 2, docs: 1 }, "'yes' inherits the label of the prompt before it");
    assert.equal(r.episodes.bugfix.count, 2, "a long idle gap starts a new episode even under the same label");
    assert.equal(r.episodes.docs.count, 1);
    assert.equal(r.tool_result_chars, 140000);
    assert.deepEqual(r.eligible_chars, { read_valve: 40000, file_dump_valve: 30000 },
      "the ranged read and the piped command are out of reach of every rule");
    assert.ok(Math.abs(r.eligible_share_of_tool_result_chars - 70000 / 140000) < 1e-12);
    assert.deepEqual(r.pauses, { under_5m: 4, from_5m_to_60m: 0, over_60m: 2 });
    assert.equal(r.n_hat, 1, "requests left before a reset: 4,3,2,1,0 then 1,0 -> median 1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the command line prints aggregates only and --write stores n_hat where the cost rule reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-census-cli-"));
  try {
    mkdirSync(join(dir, "t"));
    writeFileSync(join(dir, "t", "s1.jsonl"), fixture());
    const home = join(dir, "home");
    const out = execFileSync("node", [SCRIPT, "--dir", join(dir, "t"), "--write"], { env: { ...process.env, MMO_HOME: home } }).toString();
    assert.ok(!out.includes("SECRET-PROMPT-TEXT"), "prompt text must never be printed");
    assert.match(out, /bugfix\s+2/);
    assert.equal(JSON.parse(readFileSync(join(home, "measured.json"), "utf8")).n_hat, 1);
    const json = JSON.parse(execFileSync("node", [SCRIPT, "--dir", join(dir, "t"), "--json"], { env: { ...process.env, MMO_HOME: home } }).toString());
    assert.equal(json.requests, 7);
    assert.ok(!JSON.stringify(json).includes("SECRET"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
