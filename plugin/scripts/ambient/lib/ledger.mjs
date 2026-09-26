/**
 * The realised savings ledger: what each valve action actually saved, computed
 * afterwards from what really happened, never from a forecast.
 *
 * For one action at request a, with F full tokens, K kept tokens:
 *
 *   saved = (F - K) * (w + r * n_a)  -  SUM over follow-ups j of [ X_j * (w + r * n_j) + C_j * r ]
 *
 *   n_a, n_j  later requests in the same context after the action / follow-up
 *   X_j       tokens the follow-up pulled in (all of F for a full re-read)
 *   C_j       context size at the follow-up (an extra request re-reads it)
 *
 * Derivation: without the valve the session pays F*(w + r*n_a). With it, it
 * pays K*(w + r*n_a) plus, for every follow-up, the tokens pulled in and one
 * extra request. The difference is the line above. It can be negative, and a
 * negative entry is reported as a loss, not hidden.
 *
 * Sessions that typed a pipeline command or ran in the control arm contribute
 * nothing to the saved total. Each action is priced at the cache prices (w, r)
 * of the model the chat was on when it was made (26 Sep 2026, option 3: the
 * rules act on any model, so their savings count on any model). An action on a
 * model with no known price is left out and counted in `left_out`, never priced
 * as another model. Before 26 Sep every action off the thinker was left out.
 */

/** Group events into context segments; a reset (compact, /clear) ends one. */
function segmentIndex(events) {
  let seg = 0;
  return events.map((e) => {
    if (e.type === "context.reset") seg++;
    return seg;
  });
}

/**
 * `requestTimes` is an optional sorted list of ISO timestamps of real model
 * requests (from the transcript). Without it, later hook events stand in for
 * requests and the result says so.
 */
/**
 * `w`, `r` are the thinker's cache write and read prices per token. `priceOf(model)` returns another model's
 * { w, r } or null; without it, an action on another model cannot be priced and is left out.
 */
export function summarise(events, { w, r, requestTimes = null, priceOf = null } = {}) {
  const segs = segmentIndex(events);
  const pipeline = events.some((e) => e.type === "session.pipeline");
  const start = events.find((e) => e.type === "session.start");
  const arm = start?.arm ?? null;
  // The model each event happened on: null = the thinker, from session.off_thinker { model } until the next
  // model.back_on_thinker another model ("" when the event did not name one).
  const modelAt = [];
  let current = null;
  for (const e of events) {
    if (e.type === "session.off_thinker") current = typeof e.model === "string" ? e.model : "";
    else if (e.type === "model.back_on_thinker") current = null;
    modelAt.push(current);
  }
  // The { w, r } an action at i is priced at, or null when its model has no known price.
  const pricesAt = (i) => {
    if (modelAt[i] === null) return { w, r };
    const p = modelAt[i] && typeof priceOf === "function" ? priceOf(modelAt[i]) : null;
    return p && Number.isFinite(p.w) && Number.isFinite(p.r) ? p : null;
  };
  const excluded = pipeline;

  const segmentEnd = (i) => {
    for (let j = i + 1; j < events.length; j++) if (segs[j] !== segs[i]) return events[j].ts;
    return null;
  };
  const laterRequests = (i) => {
    const from = events[i].ts;
    const until = segmentEnd(i);
    if (requestTimes) return requestTimes.filter((t) => t > from && (until === null || t < until)).length;
    let n = 0;
    for (let j = i + 1; j < events.length && segs[j] === segs[i]; j++) n++;
    return n;
  };

  const entries = [];
  let leftOut = 0;
  events.forEach((e, i) => {
    if (e.type !== "valve.act") return;
    const p = pricesAt(i);
    if (!p) { leftOut++; return; }
    // An action and its follow-ups are priced at the model the action was made on.
    const held = p.w + p.r * laterRequests(i);
    let usd = (e.tokens_full - e.tokens_kept) * held;
    const followups = [];
    events.forEach((f, j) => {
      if (j <= i || f.type !== "valve.regret" || f.act_id !== e.act_id) return;
      const cost = f.tokens * (p.w + p.r * laterRequests(j)) + (f.context_tokens ?? 0) * p.r;
      usd -= cost;
      followups.push({ kind: f.kind, tokens: f.tokens, cost_usd: cost });
    });
    entries.push({
      act_id: e.act_id, valve: e.valve, path: e.path, model: modelAt[i],
      tokens_kept_out: e.tokens_full - e.tokens_kept,
      later_requests: laterRequests(i), followups, saved_usd: usd,
    });
  });

  const total = entries.reduce((s, x) => s + x.saved_usd, 0);
  return {
    arm,
    counted: !excluded && arm === "on",
    excluded_reason: excluded ? "pipeline" : arm !== "on" ? "not-on-arm" : null,
    requests_source: requestTimes ? "transcript" : "hook-events",
    entries,
    left_out: leftOut,
    saved_usd: !excluded && arm === "on" ? total : 0,
  };
}
