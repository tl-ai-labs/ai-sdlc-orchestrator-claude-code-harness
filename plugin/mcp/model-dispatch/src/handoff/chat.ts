/**
 * A hand-off chat, as the server sees it (zero-touch hand-off mode; docs/ambient-mode.md, "Hand-off mode").
 *
 * The server never sees a chat: it learns which chat a hand-off tool call belongs to from the stamp the plugin's
 * hook adds to the call (`_mmo`, see scripts/ambient/hook.mjs "pre-handoff"). The stamp only names the chat. What
 * the chat may do is read from the chat's own records under MMO_HOME, which the zero-touch plugin wrote when the
 * chat started and the hook completed at the chat's first hand-off:
 *   sessions/<chat id>/chat_mode            "b" for a hand-off chat
 *   sessions/<chat id>/handoff.json         the chat's settings: the model the chat is kept on, and who types each
 *                                           kind of work (1 Oct 2026: the person's choices in the settings box)
 *   sessions/<chat id>/handoff_models.json  per kind of work: the model and the shipped policy that route it, or
 *                                           { kept: true } for work the person keeps in the chat; resolved once
 * So a call with no stamp, or a stamp naming a chat that is not a hand-off chat, is refused: the hooks did not see
 * it. A stamp the chat's model wrote itself cannot widen anything, because nothing but the chat's id is taken from
 * it (the hook replaces the stamp on every call it sees).
 *
 * The chat's hand-off bill is kept with its records, never inside the project: handoff-telemetry.jsonl, one line
 * per typist call, in the same shape as a workflow's telemetry.
 *
 * The path rules are the hook's own (scripts/ambient/lib/paths.mjs); test/handoffChat.test.mjs proves the two agree.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function mmoHome(env: Record<string, string | undefined> = process.env): string {
  return env.MMO_HOME && env.MMO_HOME.trim() ? env.MMO_HOME : join(homedir(), ".mmo-ambient");
}

/** A chat id that is not a plain token becomes a hash of itself, so it can never walk out of the sessions folder. */
export function safeId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  if (SAFE_ID.test(s)) return s;
  return "x" + createHash("sha256").update(s).digest("hex").slice(0, 24);
}

/**
 * One kind of hand-off work, as the chat resolved it: the policy leaf, its model, its adapter and the shipped policy it
 * comes from; or `kept` for work the person keeps in the chat (nothing is handed off).
 */
export interface HandoffRoute { id: string; model: string; adapter: string; policy: string; kept?: false }
export interface KeptRoute { kept: true }
export type HandoffWork = "docs" | "tests" | "repeat";

export interface ChatHandoff {
  sessionId: string;
  /** The chat's records folder. */
  dir: string;
  /** The project the chat works in (the hook's own reading of it). */
  projectDir: string;
  /** Who pays for a Claude typist: "estimated" is the person's Claude login, "vendor" the API key. */
  authMode: "estimated" | "vendor";
  /**
   * The model the chat is kept on (the person's choice, or the organisation's pinned model): it makes the last
   * attempt when the chosen typist fails twice. Null when the organisation pinned an alias that names no one model;
   * the policy's own Claude model then makes it, as before 1 Oct 2026.
   */
  chatModel: string | null;
  routes: Record<HandoffWork, HandoffRoute | KeptRoute>;
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

const isRoute = (r: any): boolean => !!r && (r.kept === true || (typeof r.id === "string" && !!r.id && typeof r.model === "string" && !!r.model && typeof r.adapter === "string" && typeof r.policy === "string" && !!r.policy));

/**
 * The hand-off chat a stamped call belongs to, or why the call is refused. `needRoutes: false` is for a call that
 * sends nothing to a model (an undo): it needs the chat and its project, not the chat's models.
 */
export function readChatHandoff(stamp: unknown, env: Record<string, string | undefined> = process.env, { needRoutes = true }: { needRoutes?: boolean } = {}): ChatHandoff | { refused: string } {
  const s = stamp as { session_id?: unknown; project_dir?: unknown; auth?: unknown } | undefined;
  if (!s || typeof s !== "object" || typeof s.session_id !== "string" || !s.session_id) {
    return { refused: "this call carries no stamp from the plugin's hook, so it is not inside a zero-touch hand-off chat" };
  }
  if (typeof s.project_dir !== "string" || !isAbsolute(s.project_dir) || !existsSync(s.project_dir)) {
    return { refused: "the hook's stamp names no project folder" };
  }
  const dir = join(mmoHome(env), "sessions", safeId(s.session_id));
  let mode = "";
  try { mode = readFileSync(join(dir, "chat_mode"), "utf8").trim(); } catch { /* no record: not a zero-touch chat */ }
  if (mode !== "b") return { refused: "this is not a hand-off chat: the hand-off tools work only in a chat that started in zero-touch hand-off mode" };
  const settings = readJson(join(dir, "handoff.json"));
  if (!settings || typeof settings !== "object" || (!settings.typists && (typeof settings.policy !== "string" || !settings.policy))) {
    return { refused: "this chat's hand-off settings cannot be read" };
  }
  const routes = readJson(join(dir, "handoff_models.json"))?.routes;
  const resolved = isRoute(routes?.docs) && isRoute(routes?.tests) && isRoute(routes?.repeat);
  if (!resolved && needRoutes) return { refused: "this chat's hand-off models are not resolved" };
  const none: KeptRoute = { kept: true };
  return {
    sessionId: s.session_id,
    dir,
    projectDir: s.project_dir,
    authMode: s.auth === "vendor" ? "vendor" : "estimated",
    chatModel: typeof settings.chat_model === "string" && settings.chat_model ? settings.chat_model : null,
    routes: resolved ? { docs: routes.docs, tests: routes.tests, repeat: routes.repeat } : { docs: none, tests: none, repeat: none },
  };
}

/** Where the chat's hand-off calls are billed. */
export function handoffTelemetryPath(chat: Pick<ChatHandoff, "dir">): string {
  return join(chat.dir, "handoff-telemetry.jsonl");
}

const RELEASED = "handoff_released.json";

/** The project files a failed hand-off left for the chat's model to write by hand. */
export function releasedPaths(dir: string): string[] {
  const v = readJson(join(dir, RELEASED));
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * A hand-off that failed hands its file back: the chat's model writes it itself, and the hook, which refuses a new
 * document typed by hand in a hand-off chat, reads this list and lets that one file through.
 */
export function releasePath(dir: string, path: string): void {
  const all = new Set(releasedPaths(dir));
  if (all.has(path)) return;
  all.add(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, RELEASED), JSON.stringify([...all].sort()), { mode: 0o600 });
}
