/**
 * A real chat always begins with Claude Code's start moment (SessionStart, source "startup"), and zero-touch acts
 * only in a chat whose start the zero-touch plugin marked (29 Sep 2026; zero-touch/scripts/start-chat.mjs writes the
 * chat's record, plugin/scripts/ambient/lib/chat-mode.mjs reads it). So a test chat starts the way a real chat with
 * the zero-touch plugin enabled does: the zero-touch plugin's start hook, then mmo's, once per chat and with the same
 * settings. A test that sends a chat's later moments straight to the hook gets that start first; a test that sends
 * the start moment itself (any source) gets the zero-touch hook run beside it, as Claude Code runs both plugins' start
 * hooks at the same moment. A test about a chat WITHOUT the plugin passes `zeroTouch: false`, or runs its own start.
 *
 * runOnce(event, payload, ...rest) sends one hook moment; keyOf(...rest) names the test's own home folder (MMO_HOME),
 * so two tests that reuse a chat id in different homes are two chats; envOf(...rest) gives that call's extra
 * environment, so a test's MMO_AMBIENT reaches the zero-touch hook too.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ZT_START = join(ROOT, "zero-touch", "hooks", "start-chat.sh");

/** Runs the zero-touch plugin's start hook for one chat, as Claude Code does at SessionStart while it is enabled. */
export function zeroTouchStart({ home, sid, source = "startup", cwd, env = {} }) {
  const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  spawnSync("sh", [ZT_START], { input: JSON.stringify({ session_id: sid, cwd, source }), env: childEnv, cwd });
}

export function startingChats(runOnce, keyOf, { envOf = () => ({}), zeroTouch = true } = {}) {
  const started = new Set();
  return async (event, payload, ...rest) => {
    const sid = payload && typeof payload === "object" ? payload.session_id : null;
    if (typeof sid === "string" && sid) {
      const key = `${keyOf(...rest)}\0${sid}`;
      const plugin = (source) => { if (zeroTouch) zeroTouchStart({ home: keyOf(...rest), sid, source, cwd: payload.cwd, env: envOf(...rest) ?? {} }); };
      if (event === "session-start") {
        started.add(key);
        plugin(payload.source);
      } else if (!started.has(key)) {
        started.add(key);
        plugin("startup");
        await runOnce("session-start", { session_id: sid, cwd: payload.cwd, source: "startup" }, ...rest);
      }
    }
    return runOnce(event, payload, ...rest);
  };
}
