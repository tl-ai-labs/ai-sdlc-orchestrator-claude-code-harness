#!/usr/bin/env node
/**
 * Task census: what does this machine's Claude Code work actually consist of,
 * and how much of its cost could each ambient rule touch? Reads existing
 * session transcripts, costs nothing, sends nothing anywhere.
 *
 *   node census.mjs [--dir <transcripts-dir>] [--json] [--write]
 *
 *   --dir    default ~/.claude/projects
 *   --json   machine-readable output
 *   --write  store the measured "requests left before a context reset" in
 *            <MMO_HOME>/measured.json, where the cost rule picks it up
 *
 * Output is aggregates only: counts, shares and dollars by label. Prompt text,
 * file content and command output are read in memory to measure their size and
 * shape, and are never printed or stored.
 *
 * The kill line from the design: if the share of spend the rules could touch
 * is under about 8%, routing work is not worth building on this task mix and
 * the native settings are the whole win.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { labelPrompt } from "./lib/labels.mjs";
import { languageOf } from "./lib/outline.mjs";
import { ensureDir, mmoHome } from "./lib/paths.mjs";
import { parseFileDump } from "./lib/shell-parse.mjs";

const IDLE_GAP_MS = 30 * 60 * 1000;
const WORK_LABELS = new Set(["bugfix", "test", "refactor", "docs", "deps", "feature", "review"]);

function* transcriptFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* transcriptFiles(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

/**
 * Line reader with a fixed 1 MB buffer. Transcripts reach hundreds of
 * megabytes; reading one whole into a string multiplies that in memory, and a
 * census over a busy machine must not be the thing that exhausts it.
 */
function forEachLine(file, onLine) {
  const fd = openSync(file, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let nl;
      while ((nl = data.indexOf(10)) !== -1) {
        onLine(data.toString("utf8", 0, nl));
        data = data.subarray(nl + 1);
      }
      carry = Buffer.from(data);
    }
    if (carry.length) onLine(carry.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function priceOf(config, model, usage) {
  const table = config.cost?.prices_usd_per_mtok ?? {};
  const card = table[String(model ?? "").replace(/\[[^\]]*\]$/, "")];
  if (!card || !usage) return null;
  const cacheWrite = usage.cache_creation?.ephemeral_1h_input_tokens !== undefined
    ? (usage.cache_creation.ephemeral_1h_input_tokens ?? 0) * card.cache_write_1h + (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) * card.cache_write_5m
    : (usage.cache_creation_input_tokens ?? 0) * card.cache_write_5m;
  return ((usage.input_tokens ?? 0) * card.input + cacheWrite + (usage.cache_read_input_tokens ?? 0) * card.cache_read + (usage.output_tokens ?? 0) * card.output) / 1e6;
}

function promptText(entry) {
  if (entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((b) => b.type === "text")) return c.map((b) => b.text).join("\n");
  return null; // tool results are not prompts
}

function resultChars(block) {
  const c = block.content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0);
  return 0;
}

export function census(dir, config) {
  const minRead = config.valves?.read?.min_chars ?? 8000;
  const minDump = config.valves?.file_dump?.min_chars ?? 6000;
  const out = {
    sessions: 0, requests: 0, priced_usd: 0, unpriced_requests: 0,
    labels: {}, episodes: {},
    tool_result_chars: 0,
    eligible_chars: { read_valve: 0, file_dump_valve: 0 },
    pauses: { under_5m: 0, from_5m_to_60m: 0, over_60m: 0 },
    requests_left_before_reset: [],
  };

  for (const file of transcriptFiles(dir)) {
    out.sessions++;
    const seenMessages = new Set();
    const toolUses = new Map();
    let label = null;
    let lastRequestAt = null;
    let sinceReset = 0;
    let previousLabel = null;

    const onLine = (line) => {
      if (!line || line[0] !== "{") return;
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.isSidechain) return;
      const at = e.timestamp ? Date.parse(e.timestamp) : null;

      if (e.type === "system" && (e.subtype === "compact_boundary" || e.isCompactSummary)) {
        for (let i = sinceReset - 1; i >= 0; i--) out.requests_left_before_reset.push(i);
        sinceReset = 0;
      }

      if (e.type === "user") {
        const prompt = promptText(e);
        if (prompt !== null && !prompt.startsWith("<")) {
          const l = labelPrompt(prompt, previousLabel);
          previousLabel = l.label;
          out.labels[l.label] = (out.labels[l.label] ?? 0) + 1;
          const idle = at !== null && lastRequestAt !== null && at - lastRequestAt > IDLE_GAP_MS;
          if (label === null || idle || (WORK_LABELS.has(l.label) && !l.inherited && l.label !== label)) {
            label = l.label;
            out.episodes[label] = out.episodes[label] ?? { count: 0, usd: 0 };
            out.episodes[label].count++;
          }
        }
        for (const block of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (block.type !== "tool_result") continue;
          const chars = resultChars(block);
          out.tool_result_chars += chars;
          const use = toolUses.get(block.tool_use_id);
          if (!use || block.is_error) continue;
          if (use.name === "Read" && chars >= minRead && use.input?.offset == null && use.input?.limit == null && languageOf(use.input?.file_path ?? "")) {
            out.eligible_chars.read_valve += chars;
          } else if (use.name === "Bash") {
            const cmd = use.input?.command;
            if (chars >= minDump && parseFileDump(cmd)) out.eligible_chars.file_dump_valve += chars;
          }
        }
      }

      if (e.type === "assistant" && e.message?.usage) {
        const id = e.message.id ?? e.uuid;
        for (const block of Array.isArray(e.message.content) ? e.message.content : []) {
          if (block.type === "tool_use") toolUses.set(block.id, { name: block.name, input: block.input });
        }
        if (seenMessages.has(id)) return; // one request is logged once per content block
        seenMessages.add(id);
        out.requests++;
        sinceReset++;
        const usd = priceOf(config, e.message.model, e.message.usage);
        if (usd === null) out.unpriced_requests++;
        else {
          out.priced_usd += usd;
          if (label) out.episodes[label].usd += usd;
        }
        if (at !== null && lastRequestAt !== null) {
          const gap = at - lastRequestAt;
          if (gap < 5 * 60000) out.pauses.under_5m++;
          else if (gap < 60 * 60000) out.pauses.from_5m_to_60m++;
          else out.pauses.over_60m++;
        }
        if (at !== null) lastRequestAt = at;
      }
    };
    try { forEachLine(file, onLine); } catch { /* unreadable file: counted as a session, contributes nothing */ }
    for (let i = sinceReset - 1; i >= 0; i--) out.requests_left_before_reset.push(i);
  }

  const left = out.requests_left_before_reset.sort((a, b) => a - b);
  out.n_hat = left.length ? left[Math.floor(left.length / 2)] : null;
  delete out.requests_left_before_reset;
  const eligible = Object.values(out.eligible_chars).reduce((a, b) => a + b, 0);
  out.eligible_share_of_tool_result_chars = out.tool_result_chars ? eligible / out.tool_result_chars : 0;
  return out;
}

function printHuman(r) {
  const pct = (x) => (100 * x).toFixed(1) + "%";
  const usd = (x) => "$" + x.toFixed(2);
  console.log(`sessions ${r.sessions}   requests ${r.requests}   priced ${usd(r.priced_usd)}   unpriced requests ${r.unpriced_requests}`);
  console.log("\nepisodes by label (count, cost, share of priced cost)");
  for (const [label, v] of Object.entries(r.episodes).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${label.padEnd(18)} ${String(v.count).padStart(6)}  ${usd(v.usd).padStart(10)}  ${pct(r.priced_usd ? v.usd / r.priced_usd : 0).padStart(6)}`);
  }
  console.log("\nshare of all tool-result characters each rule could touch");
  for (const [rule, chars] of Object.entries(r.eligible_chars)) console.log(`  ${rule.padEnd(18)} ${pct(r.tool_result_chars ? chars / r.tool_result_chars : 0)}`);
  console.log(`  ${"all rules".padEnd(18)} ${pct(r.eligible_share_of_tool_result_chars)}`);
  console.log(`\npauses between requests: under 5 min ${r.pauses.under_5m}, 5 to 60 min ${r.pauses.from_5m_to_60m}, over 60 min ${r.pauses.over_60m}`);
  console.log(`median requests left before a context reset (n_hat): ${r.n_hat ?? "no data"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf("--dir");
  const dir = dirAt >= 0 && args[dirAt + 1] ? args[dirAt + 1] : join(homedir(), ".claude", "projects");
  const { config } = loadConfig({});
  const result = census(dir, config);
  if (args.includes("--write") && result.n_hat !== null) {
    ensureDir(mmoHome());
    writeFileSync(join(mmoHome(), "measured.json"), JSON.stringify({ n_hat: result.n_hat, measured_at: new Date().toISOString(), requests: result.requests }, null, 2), { mode: 0o600 });
  }
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}
