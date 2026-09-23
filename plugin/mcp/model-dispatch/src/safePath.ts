/**
 * Paths that arrive as tool arguments are chosen by a model. `telemetry_path`,
 * `work_dir` and the like were used as given, so a steered model could make the
 * server append lines to any file the account can write. A path is accepted
 * only when the place it really lands (symlinks resolved, through the deepest
 * ancestor that exists) is inside an allowed root: the project, or the OS temp
 * folder that tests and scratch runs use.
 *
 * A relative path is refused: the server has no anchor for it that a model
 * could not also choose.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

function landing(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
  return abs;
}

export function pathIsAllowed(path: string, roots: string[]): boolean {
  if (typeof path !== "string" || !path || !isAbsolute(path)) return false;
  const real = landing(path);
  return roots.some((root) => {
    if (!root) return false;
    const rel = relative(landing(root), real);
    return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
  });
}

/** Throws a plain error naming the argument; the tool handler turns it into an error reply. */
export function assertPathAllowed(argName: string, path: unknown, roots: string[]): void {
  if (path === undefined || path === null || path === "") return;
  if (process.env.MMO_ALLOW_OUTSIDE_PATHS === "1") return;
  if (!pathIsAllowed(String(path), roots)) {
    throw new Error(`${argName} must be an absolute path inside the project or the temp folder; '${String(path).slice(0, 200)}' is not. (Set MMO_ALLOW_OUTSIDE_PATHS=1 in the server's environment to lift this check.)`);
  }
}
