/**
 * What one session cost, from its own transcript: every model request once
 * (a request is logged once per content block, so requests are de-duplicated
 * by message id), priced at the cards in the settings. Read with a fixed
 * buffer, because a transcript can be hundreds of megabytes. Requests on a
 * model that has no price card are COUNTED and reported, never guessed.
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
      while ((nl = data.indexOf(10)) !== -1) { onLine(data.toString("utf8", 0, nl)); data = data.subarray(nl + 1); }
      carry = Buffer.from(data);
    }
    if (carry.length) onLine(carry.toString("utf8"));
  } finally { closeSync(fd); }
}

export function priceRequest(cards, model, usage) {
  const card = cards?.[String(model ?? "").replace(/\[[^\]]*\]$/, "")];
  if (!card || !usage) return null;
  const c = usage.cache_creation;
  const write = c && (c.ephemeral_1h_input_tokens !== undefined || c.ephemeral_5m_input_tokens !== undefined)
    ? (c.ephemeral_1h_input_tokens ?? 0) * card.cache_write_1h + (c.ephemeral_5m_input_tokens ?? 0) * card.cache_write_5m
    : (usage.cache_creation_input_tokens ?? 0) * card.cache_write_5m;
  return ((usage.input_tokens ?? 0) * card.input + write + (usage.cache_read_input_tokens ?? 0) * card.cache_read + (usage.output_tokens ?? 0) * card.output) / 1e6;
}

/**
 * The transcripts of a chat's Claude Code helper agents (the Agent tool):
 * `<transcript dir>/<session id>/subagents/agent-*.jsonl`. Their requests
 * are the chat's spend as much as the main transcript's: on 22 Sep a plain
 * chat ran four of them (49 requests) and looked $4 cheaper than it was.
 */
export function subagentTranscripts(transcriptPath) {
  const dir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ""), "subagents");
  try {
    return readdirSync(dir).filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl")).sort().map((n) => join(dir, n));
  } catch { return []; }
}

function addTranscript(out, transcriptPath, config, seen, into, since) {
  forEachLine(transcriptPath, (line) => {
    if (!line || line[0] !== "{") return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type !== "assistant" || !e.message?.usage) return;
    // A re-opened chat's transcript starts with its earlier history; requests
    // before `since` belong to the record that covered that history, not this one.
    if (since && e.timestamp && e.timestamp < since) return;
    const id = e.message.id ?? e.uuid;
    if (seen.has(id)) return;
    seen.add(id);
    out.requests++;
    into.requests++;
    if (!e.isSidechain && e.timestamp) out.request_times.push(e.timestamp);
    const usd = priceRequest(config.cost?.prices_usd_per_mtok, e.message.model, e.message.usage);
    const model = String(e.message.model ?? "unknown").replace(/\[[^\]]*\]$/, "");
    if (usd === null) { out.unpriced_requests++; return; }
    out.usd += usd;
    into.usd += usd;
    out.by_model[model] = (out.by_model[model] ?? 0) + usd;
  });
}

/**
 * `since` (an ISO timestamp) prices only the requests from that moment on. The
 * board passes the record's own start for a re-opened chat (session.start with
 * source "resume"): on 22 Sep such a chat showed as "running, 0 prompts" at the
 * cost of its whole old history after the records had been reset.
 */
export function sessionCost(transcriptPath, config, { since = null } = {}) {
  const out = { usd: 0, requests: 0, unpriced_requests: 0, by_model: {}, request_times: [], subagent_requests: 0, subagent_usd: 0 };
  if (typeof transcriptPath !== "string" || !transcriptPath) return out;
  const seen = new Set();
  const main = { usd: 0, requests: 0 };
  try {
    addTranscript(out, transcriptPath, config, seen, main, since);
  } catch { /* no transcript yet: a session that has not made a request */ }
  const helpers = { usd: 0, requests: 0 };
  for (const file of subagentTranscripts(transcriptPath)) {
    try { addTranscript(out, file, config, seen, helpers, since); } catch { /* a helper agent still writing */ }
  }
  out.subagent_requests = helpers.requests;
  out.subagent_usd = helpers.usd;
  out.request_times.sort();
  return out;
}
