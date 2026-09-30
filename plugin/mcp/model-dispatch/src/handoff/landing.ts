/**
 * Landing a hand-off in the project, and undoing it (zero-touch hand-off mode).
 *
 * A hand-off's checked files are written into the project here and nowhere else, and every landing is recorded with
 * what each file held before: a file that was there keeps a copy of its earlier text, a file the hand-off created is
 * marked as new. One call then undoes a landing. Undo never overwrites work done since: a file whose text is no
 * longer what the hand-off wrote is left alone and named, so the chat's model can look at it.
 *
 * The record lives with the chat's other records under MMO_HOME, never in the project:
 *   sessions/<chat id>/handoff_landings.json     the chat's landings, in order, each with its id ("h1", "h2", ...)
 *   sessions/<chat id>/handoff_undo/<id>/<n>     the earlier text of the landing's n-th file
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LANDINGS = "handoff_landings.json";
const UNDO_DIR = "handoff_undo";

export interface LandedFile { path: string; existed: boolean; sha256: string }
export interface Landing { id: string; tool: string; at: string; files: LandedFile[]; undone?: boolean }

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** The chat's landings, oldest first. */
export function landings(sessionDir: string): Landing[] {
  try {
    const v = JSON.parse(readFileSync(join(sessionDir, LANDINGS), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function save(sessionDir: string, all: Landing[]): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(sessionDir, LANDINGS), JSON.stringify(all), { mode: 0o600 });
}

/**
 * Writes a hand-off's files into the project and records the landing. The earlier text of every file is kept before
 * anything is written, so a failure halfway leaves a record that undoes exactly what was written. Returns the
 * landing's id.
 */
export function recordLanding(sessionDir: string, projectDir: string, landing: { tool: string; files: { path: string; content: string }[] }): string {
  const all = landings(sessionDir);
  const id = `h${all.length + 1}`;
  const keep = join(sessionDir, UNDO_DIR, id);
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  const files: LandedFile[] = landing.files.map((f, n) => {
    const target = join(projectDir, f.path);
    const existed = existsSync(target);
    if (existed) writeFileSync(join(keep, String(n)), readFileSync(target), { mode: 0o600 });
    return { path: f.path, existed, sha256: sha(f.content) };
  });
  save(sessionDir, [...all, { id, tool: landing.tool, at: new Date().toISOString(), files }]);
  for (const f of landing.files) {
    const target = join(projectDir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  return id;
}

/**
 * Takes a landing back: a changed file gets its earlier text, a created file is removed. A file that no longer holds
 * what the hand-off wrote was changed since and is left alone.
 */
export function undoLanding(sessionDir: string, projectDir: string, id: string): { restored: string[]; left_alone: string[]; refused?: undefined } | { refused: string } {
  const all = landings(sessionDir);
  const landing = all.find((l) => l.id === id);
  if (!landing) return { refused: `this chat has no hand-off ${id}${all.length ? ` (it has ${all.map((l) => l.id).join(", ")})` : ""}` };
  if (landing.undone) return { refused: `hand-off ${id} is already undone` };
  const restored: string[] = [];
  const leftAlone: string[] = [];
  landing.files.forEach((f, n) => {
    const target = join(projectDir, f.path);
    let now: Buffer | null = null;
    try { now = readFileSync(target); } catch { /* removed since */ }
    if (!now || sha(now) !== f.sha256) { leftAlone.push(f.path); return; }
    if (f.existed) writeFileSync(target, readFileSync(join(sessionDir, UNDO_DIR, id, String(n))));
    else rmSync(target, { force: true });
    restored.push(f.path);
  });
  landing.undone = true;
  save(sessionDir, all);
  return { restored, left_alone: leftAlone };
}
