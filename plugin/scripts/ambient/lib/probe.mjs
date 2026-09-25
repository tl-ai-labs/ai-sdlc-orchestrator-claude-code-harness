/**
 * One tiny real call to a worker, before a pair starts.
 *
 * 23 Sep, pair 9: Google returned 429 Resource exhausted in the MIDDLE of a
 * paid run, after twenty-five minutes and two failed attempts. Nothing before
 * the pair had asked the vendor a single question, because every other check
 * reads local files. Quota, credentials and the region are only ever knowable
 * by asking, so the preflight asks: the same door a job uses, the same worker
 * name, a brief small enough to cost a fraction of a cent.
 */
export const PROBE_BRIEF = "Answer with one word: ready.";

export async function probeWorker({ worker, callWorker, kind = "write_files_from_specs", timeoutMs = 60000 }) {
  const t0 = Date.now();
  if (typeof callWorker !== "function") return { ok: false, worker, ms: 0, detail: "no door: the plugin's tool server is not built" };
  try {
    const reply = await Promise.race([
      callWorker({ kind, worker, brief: PROBE_BRIEF }),
      new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs).unref()),
    ]);
    const text = String(reply?.text ?? "");
    // An empty answer is a failure: the call went through but the worker said nothing,
    // which is what a blocked model or an exhausted region looks like from here.
    if (!text.trim()) return { ok: false, worker, ms: Date.now() - t0, detail: "the worker answered with nothing" };
    return { ok: true, worker, ms: Date.now() - t0, model: reply?.model ?? null, chars: text.length };
  } catch (e) {
    const detail = String(e?.message ?? e).slice(0, 200);
    return { ok: false, worker, ms: Date.now() - t0, rateLimited: e?.rateLimited === true || /rate limit|429|resource exhausted/i.test(detail), detail };
  }
}
