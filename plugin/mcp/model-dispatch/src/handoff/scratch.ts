/**
 * The scratch copy a hand-off is checked in (zero-touch hand-off mode).
 *
 * Tests written by the hand-off model, and a change repeated across files, are RUN before they reach the project, in
 * a copy of the project, with a command the chat's model named. The project itself is never the place a hand-off is
 * tried out: a test file that does not pass, or an edit that breaks the build, must leave no trace in it.
 *
 * The copy holds the project's own files as they are on disk now (tracked files and new ones, uncommitted work
 * included), as real copies, so whatever the command writes over them stays in the copy. What git ignores (installed
 * dependencies, build output, caches) is linked in, not copied: it can be large, and the command needs it to run.
 * Git is what tells the two apart, so a project that is not a git repository gets no copy and the hand-off is
 * refused with that reason; the chat's model then does the work itself.
 *
 * Nothing is written into the repository to make the copy (no commit, no worktree): the file lists come from
 * `git ls-files`, and the copy lives under the system's temp folder until `remove()`.
 */
import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ScratchCopy = { dir: string; remove(): void; refused?: undefined } | { refused: string; dir?: undefined };

function gitList(projectDir: string, args: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", ...args], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 256 << 20 }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

/** A copy of the project folder to run a command in, or why there is none. */
export function makeScratchCopy(projectDir: string): ScratchCopy {
  const root = resolve(projectDir);
  let own: string[];
  let ignored: string[];
  try {
    // The project's own files: tracked ones and new ones git does not ignore, from the project folder down.
    own = gitList(root, ["--cached", "--others", "--exclude-standard"]);
    // What git ignores, a wholly ignored folder as one entry ("node_modules/").
    ignored = gitList(root, ["--others", "--ignored", "--exclude-standard", "--directory"]);
  } catch {
    return { refused: "the project is not a git repository, so a scratch copy cannot tell its own files from installed dependencies and the hand-off cannot be checked" };
  }
  const dir = mkdtempSync(join(tmpdir(), "mmo-handoff-scratch-"));
  const remove = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ } };
  try {
    for (const rel of new Set(own)) {
      const from = join(root, rel);
      let stat;
      try { stat = lstatSync(from); } catch { continue; } // deleted since it was tracked
      const to = join(dir, rel);
      mkdirSync(dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      // Copy-on-write where the file system has it, so a large project costs no time and no disk until written to.
      else if (stat.isFile()) copyFileSync(from, to, constants.COPYFILE_FICLONE);
      // A directory here is another repository inside this one (a submodule): not the project's own files.
    }
    for (const entry of ignored) {
      const rel = entry.replace(/\/$/, "");
      if (!rel || rel === ".git" || rel.startsWith(".git/")) continue;
      const to = join(dir, rel);
      try {
        mkdirSync(dirname(to), { recursive: true });
        symlinkSync(join(root, rel), to);
      } catch { /* already there (a copied file's folder), or a link this system will not make: the command runs without it */ }
    }
  } catch (e: any) {
    remove();
    return { refused: `a scratch copy of the project could not be made: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { dir, remove };
}

/**
 * How much of a command's output is kept: its end. One test file's or one build's failure report is far shorter;
 * a longer output is a runner's progress noise, which comes first. A stated bound, so a runaway command cannot fill
 * the server's memory or a typist's brief.
 */
export const RUN_OUTPUT_KEPT_CHARS = 8000;

export interface ScratchRun { code: number | null; output: string; timedOut: boolean; ms: number }

/**
 * Runs the person's own command in the copy (through `sh -c`, as they would type it), both output streams together.
 * CI=1 tells test runners not to wait for a person (no watch mode, no prompts). A command past its time limit is
 * stopped, its whole process group with it.
 */
export function runInScratch(dir: string, command: string, opts: { timeoutMs: number; cwd?: string; env?: Record<string, string | undefined> }): Promise<ScratchRun> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd ? join(dir, opts.cwd) : dir, env: { ...(opts.env ?? process.env), CI: "1" } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let cut = false;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > RUN_OUTPUT_KEPT_CHARS * 2) { output = output.slice(-RUN_OUTPUT_KEPT_CHARS); cut = true; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, opts.timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => { output += String(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (output.length > RUN_OUTPUT_KEPT_CHARS) { output = output.slice(-RUN_OUTPUT_KEPT_CHARS); cut = true; }
      // A cut never starts in the middle of a line.
      if (cut) output = "[earlier output cut]\n" + output.slice(output.indexOf("\n") + 1);
      done({ code: timedOut ? (code ?? 124) : code, output, timedOut, ms: Date.now() - started });
    });
  });
}
