/**
 * One cost rule for every valve: shrink a tool result only when the expected
 * money saved is larger than the expected money lost.
 *
 * Symbols (tokens unless said otherwise):
 *   F  size of the full result            K  size of what is kept instead
 *   R  size of a ranged follow-up read    C  context size at the moment of the call
 *   w  price to write one token to cache  r  price to re-read one cached token
 *   N  expected later requests in this context (each re-reads the cache)
 *   p  chance the full result is needed after all (full re-read)
 *   q  chance of a ranged follow-up read
 *   L  developer-time cost of one extra request, in dollars
 *
 * A kept token costs (w + r*N): written once, re-read on every later request.
 * An extra request costs C*r (the whole context is re-read) plus L.
 *
 *   net = (1-p-q) * (F-K)*(w+rN)
 *       +  q      * ((F-K-R)*(w+rN) - C*r - L)
 *       -  p      * (C*r + K*(w+rN) + L)
 *
 * With q = 0 this is the design's inequality
 *   (1-p)(F-K)(w+rN) - p(C*r + K(w+rN) + L) >= margin.
 * A fixed size threshold cannot express this: the same file is worth shrinking
 * in a 40k context and not worth it in a 600k one, where an extra request
 * costs more than the file does.
 */

export function pricesFor(config, model, env = process.env) {
  const table = config?.cost?.prices_usd_per_mtok ?? {};
  const card = table[model] ?? table[config?.thinker] ?? null;
  if (!card) return null;
  let tier = config.cost.cache_tier;
  if (tier !== "5m" && tier !== "1h") {
    // The one-hour cache exists only on a subscription login. An API key or a
    // cloud provider route means the five-minute tier.
    const metered = Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_BEDROCK);
    tier = metered ? "5m" : "1h";
  }
  const write = tier === "1h" ? card.cache_write_1h : card.cache_write_5m;
  return { w: write / 1e6, r: card.cache_read / 1e6, out: card.output / 1e6, in: card.input / 1e6, tier };
}

/**
 * Dollars kept when `chars` of typing go to a worker instead of the thinker:
 * worker write against thinker write, for the same files.
 *
 * Until 23 Sep 2026 this charged every hand-over one or two EXTRA requests
 * (collect the result, land it), each re-reading the whole chat, and that
 * dominated: break-evens of 9,000 to 14,000 characters. A hand-over is now one
 * call that waits and lands, and the thinker writing a file itself is one call
 * too, so the round trip cancels (given equal batching, which the tools give:
 * all the files of a phase in one call). The thinker also no longer reads the
 * worker's text back (receipt only). What is left:
 *
 *   saved = typed * out                        the thinker would have typed it
 *   cost  = extra * C * r                      only a job past the wait adds a collect call
 *         + spec * out                         the thinker writes the spec
 *         + (typed + spec + context) * w_in    the worker reads the brief
 *         + typed * w_out                      the worker types
 *
 * `breakEvenChars` is the typing size at which saved equals cost: about 800
 * characters with Flash, about 1,800 with Sonnet, at any chat size. Sizes in
 * characters, prices in dollars per token, `cpt` characters per token.
 */
export function handoverNet({ chars, C, prices, worker, extraRequests = 0, specChars = 400, contextChars = 8000, cpt = 4 }) {
  if (!prices || !worker || ![chars, C, prices.out, prices.in, prices.r, worker.in, worker.out].every(Number.isFinite)) return { net: null, breakEvenChars: null };
  const perChar = (prices.out - worker.in - worker.out) / cpt;
  const fixed = Math.max(0, extraRequests) * C * prices.r + (specChars / cpt) * prices.out + ((specChars + contextChars) / cpt) * worker.in;
  return { net: chars * perChar - fixed, breakEvenChars: perChar > 0 ? Math.ceil(fixed / perChar) : null };
}

export function netValueUsd({ F, K, R = 0, C, w, r, N, p, q = 0, L = 0 }) {
  const held = w + r * N;
  const pq = Math.min(p + q, 1);
  const qq = pq - Math.min(p, 1);
  const pp = Math.min(p, 1);
  return (1 - pq) * (F - K) * held + qq * ((F - K - R) * held - C * r - L) - pp * (C * r + K * held + L);
}

/**
 * Beta-posterior mean of a rate from counts, with a prior expressed as
 * pseudo-counts. The prior is what a fresh install uses; measured counts from
 * this repo and valve take over as they arrive.
 */
export function posteriorMean(hits, trials, priorHits, priorTrials) {
  const h = Math.max(0, hits) + priorHits;
  const n = Math.max(0, trials) + priorTrials;
  return n > 0 ? h / n : 0;
}

export function decide(inputs, marginUsd = 0) {
  const values = Object.values(inputs);
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return { act: false, net: 0, reason: "missing-input" };
  if (inputs.F <= inputs.K) return { act: false, net: 0, reason: "nothing-to-save" };
  const net = netValueUsd(inputs);
  return { act: net >= marginUsd, net, reason: net >= marginUsd ? "pays" : "does-not-pay" };
}
