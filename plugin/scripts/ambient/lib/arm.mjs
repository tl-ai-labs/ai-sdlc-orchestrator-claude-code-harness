/**
 * The on/control draw for one session, with exactly one authority.
 *
 * The arm is a marker file created with exclusive create, so however many hook
 * processes start at once only the first writes it and everyone reads the same
 * answer. The draw probability is stored beside the arm: an estimate made later
 * needs to know the chance each session had of landing in each arm.
 *
 * MMO_AMBIENT_ARM=on|control forces an arm (a demo pair). A forced session is
 * marked `forced`, which keeps it out of any randomised estimate.
 *
 * A missing or unreadable share means 0 (since 26 Sep; it was 0.5): a control-arm
 * chat gets no zero-touch at all, so the fallback must never switch the feature
 * off for real users. Measuring is opt-in: a settings file sets control.share.
 */
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExclusive, ensureSessionDir, sessionDir } from "./paths.mjs";

export const ARMS = ["on", "control"];

export function readArm(sessionId, env = process.env) {
  try {
    const file = join(sessionDir(sessionId, env), "arm.json");
    if (!existsSync(file)) return null;
    const rec = JSON.parse(readFileSync(file, "utf8"));
    return ARMS.includes(rec.arm) ? rec : null;
  } catch {
    return null;
  }
}

export function drawArm(sessionId, controlShare, env = process.env, draw = () => randomInt(0, 1_000_000) / 1_000_000) {
  const existing = readArm(sessionId, env);
  if (existing) return existing;
  const share = Number.isFinite(controlShare) ? Math.min(Math.max(controlShare, 0), 1) : 0;
  const forced = ARMS.includes(env.MMO_AMBIENT_ARM) ? env.MMO_AMBIENT_ARM : null;
  const rec = {
    arm: forced ?? (draw() < share ? "control" : "on"),
    control_share: share,
    forced: forced !== null,
    drawn_at: new Date().toISOString(),
  };
  const dir = ensureSessionDir(sessionId, env);
  createExclusive(join(dir, "arm.json"), JSON.stringify(rec));
  // Another process may have won the race; its record is the truth.
  return readArm(sessionId, env) ?? rec;
}
