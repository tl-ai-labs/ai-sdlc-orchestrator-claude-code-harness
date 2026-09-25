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
 * Sessions that left the policy's thinker model, typed a pipeline command, or
 * ran in the control arm contribute nothing to the saved total.
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
export function summarise(events, { w, r, requestTimes = null } = {}) {
  const segs = segmentIndex(events);
  const pipeline = events.some((e) => e.type === "session.pipeline");
  const start = events.find((e) => e.type === "session.start");
  const arm = start?.arm ?? null;
  // Off the main model is a PERIOD: from session.off_thinker until the next
  // model.back_on_thinker. Actions inside it are left out; the rest of the
  // chat still counts. (Jobs already resume on return; the count must too.)
  const offAt = events.map((e, i) => {
    let off = false;
    for (let j = 0; j <= i; j++) { if (events[j].type === "session.off_thinker") off = true; else if (events[j].type === "model.back_on_thinker") off = false; }
    return off;
  });
  const stillOff = offAt[events.length - 1] === true;
  const excluded = pipeline || (stillOff && !events.some((e, i) => e.type === "valve.act" && !offAt[i]));

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
  events.forEach((e, i) => {
    if (e.type !== "valve.act" || offAt[i]) return;
    const held = w + r * laterRequests(i);
    let usd = (e.tokens_full - e.tokens_kept) * held;
    const followups = [];
    events.forEach((f, j) => {
      if (j <= i || f.type !== "valve.regret" || f.act_id !== e.act_id) return;
      const cost = f.tokens * (w + r * laterRequests(j)) + (f.context_tokens ?? 0) * r;
      usd -= cost;
      followups.push({ kind: f.kind, tokens: f.tokens, cost_usd: cost });
    });
    entries.push({
      act_id: e.act_id, valve: e.valve, path: e.path,
      tokens_kept_out: e.tokens_full - e.tokens_kept,
      later_requests: laterRequests(i), followups, saved_usd: usd,
    });
  });

  const total = entries.reduce((s, x) => s + x.saved_usd, 0);
  return {
    arm,
    counted: !excluded && arm === "on",
    excluded_reason: pipeline ? "pipeline" : excluded ? "off-thinker" : arm !== "on" ? "not-on-arm" : null,
    requests_source: requestTimes ? "transcript" : "hook-events",
    entries,
    saved_usd: !excluded && arm === "on" ? total : 0,
  };
}
