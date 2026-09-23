/**
 * Doors: how a brief reaches a worker and an answer comes back. A door takes
 * text and returns text. It never gets a shell, a working directory or tools:
 * workers in chat do not execute anything.
 *
 *   completion  one request through the MCP server's adapters. It lives in the
 *               server (TypeScript) and is handed to the job runner as a
 *               function, so this plain-ESM side has no vendor code at all.
 *   stub        canned answers from MMO_AMBIENT_STUB_DIR, for tests. A test
 *               that reaches a real vendor is a defect.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DoorError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

/** Returns a callWorker function, or null when no stub directory is configured. */
export function stubDoor(env = process.env) {
  const dir = env.MMO_AMBIENT_STUB_DIR;
  if (!dir) return null;
  return async ({ kind, worker }) => {
    let canned;
    try { canned = JSON.parse(readFileSync(join(dir, kind + ".json"), "utf8")); }
    catch { throw new DoorError(`stub door: no canned answer for ${kind}`); }
    // `by_worker`: one canned record per worker model, so a test can make one worker fail and another pass (the cascade).
    if (canned.by_worker && typeof canned.by_worker === "object" && canned.by_worker[worker]) canned = { ...canned, ...canned.by_worker[worker], by_worker: undefined };
    if (canned.delay_ms) await new Promise((r) => setTimeout(r, canned.delay_ms));
    // `fail_first`: the first call for this kind fails with that text, later calls go on to the answer.
    if (canned.fail_first) {
      const seen = join(dir, kind + ".first-call-done");
      if (!existsSync(seen)) { writeFileSync(seen, ""); throw new DoorError(canned.fail_first === "429" ? "rate limited" : String(canned.fail_first), { rateLimited: canned.fail_first === "429" }); }
    }
    if (canned.error === "429") throw new DoorError("rate limited", { rateLimited: true });
    if (canned.error) throw new DoorError(String(canned.error));
    // `answers`: one canned answer per call, in order (the last one repeats).
    let answer = canned.answer;
    if (Array.isArray(canned.answers) && canned.answers.length) {
      const counter = join(dir, kind + (canned.model ? "." + String(canned.model).replace(/[^A-Za-z0-9._-]/g, "") : "") + ".calls");
      let n = 0;
      try { n = Number(readFileSync(counter, "utf8")) || 0; } catch { /* first call */ }
      writeFileSync(counter, String(n + 1));
      answer = canned.answers[Math.min(n, canned.answers.length - 1)];
    }
    return {
      text: typeof canned.text === "string" ? canned.text : JSON.stringify(answer),
      usage: canned.usage ?? { input_tokens: 1000, output_tokens: 200 },
      model: canned.model ?? "stub",
      ...(typeof canned.thinking === "string" ? { thinking: canned.thinking } : {}),
      ...(Number.isFinite(canned.cost_usd) ? { cost_usd: canned.cost_usd } : {}),
    };
  };
}
