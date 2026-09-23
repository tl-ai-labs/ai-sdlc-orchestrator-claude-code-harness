/**
 * The batch write, on BOTH sides of a pair (build spec v1.2, parity): the
 * thinker hands over files it composed ITSELF, many in one call, with its test
 * command; the plugin writes them into the project and runs the tests in the
 * same call. One request instead of one per file. No worker is involved, so it
 * is an optimization, not a delegation, and it runs where jobs are off too
 * (rules only). Without it a hand-over's one-request landing would credit
 * delegation with a saving that is really batching (23 Sep).
 *
 * Paths are checked like a landing: inside the project, no symlink on the way,
 * never a secret or hard-denied file; writes are atomic; the tests run only
 * when a command was given, in the project, as the thinker's own Bash would.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkedTarget } from "./apply.mjs";
import { loadConfig } from "./lib/config.mjs";
import { isHardDenied, isSecretFile, safeRelPath } from "./lib/deny-paths.mjs";
import { appendEvent } from "./lib/events.mjs";

const MAX_FILE_BYTES = 512 * 1024;

export function writeFiles({ files, testCommand = null, projectDir, stamp = null, env = process.env }) {
  const { config } = loadConfig({ projectDir, env });
  const max = Number(config.jobs?.max_files ?? 60) || 60;
  if (!Array.isArray(files) || files.length === 0) return { status: "refused", reason: "files is empty; pass every file to write, each with its path and its full content" };
  if (files.length > max) return { status: "refused", reason: `more than ${max} files in one call` };
  const root = resolve(projectDir);
  const plan = [];
  for (const f of files) {
    const rel = safeRelPath(f?.path);
    if (!rel) return { status: "refused", reason: `not a safe project-relative path: ${String(f?.path ?? "").slice(0, 80)}` };
    if (isHardDenied(rel) || isSecretFile(rel)) return { status: "refused", reason: `${rel}: this path is never written by the plugin` };
    if (typeof f.content !== "string" || f.content.includes("\0")) return { status: "refused", reason: `${rel}: content must be text` };
    if (Buffer.byteLength(f.content) > MAX_FILE_BYTES) return { status: "refused", reason: `${rel}: larger than ${MAX_FILE_BYTES} bytes` };
    let target;
    try { target = checkedTarget(root, rel); } catch (e) { return { status: "refused", reason: e.message }; }
    plan.push({ rel, target, content: f.content, existed: existsSync(target) });
  }
  const written = [];
  for (const p of plan) {
    mkdirSync(dirname(p.target), { recursive: true });
    const tmp = p.target + ".mmo-tmp-" + process.pid;
    writeFileSync(tmp, p.content, { mode: 0o644 });
    renameSync(tmp, p.target);
    written.push(p);
  }
  let tests = { ran: false };
  if (typeof testCommand === "string" && testCommand.trim()) tests = runTests(testCommand, root, Number(config.jobs?.verify_timeout_ms ?? 600000) || 600000, env);
  const created = written.filter((p) => !p.existed).map((p) => p.rel);
  const overwritten = written.filter((p) => p.existed).map((p) => p.rel);
  const bytes = written.reduce((n, p) => n + Buffer.byteLength(p.content), 0);
  const sid = stamp && typeof stamp.session_id === "string" ? stamp.session_id : null;
  if (sid) {
    try {
      appendEvent(sid, "write_files.used", { files: written.length, created: created.length, overwritten: overwritten.length, bytes, tests_ran: tests.ran, tests_passed: tests.ran ? tests.passed : undefined, exit_code: tests.exit_code, agent: typeof stamp.agent === "string" && stamp.agent ? stamp.agent : undefined }, env);
    } catch { /* the record is a bonus; the files are written */ }
  }
  return {
    status: "written", files: written.map((p) => p.rel), created, overwritten, bytes, tests,
    next: tests.ran ? (tests.passed ? "Written; the tests passed. Carry on." : "Written; the tests FAILED (tests.tail has the last lines). Fix and call again, or edit by hand.") : "Written. No test command was given, so run the tests yourself.",
  };
}

function runTests(command, cwd, timeoutMs, env) {
  const t0 = Date.now();
  let out = "";
  let code = 0;
  try {
    out = execFileSync("sh", ["-c", command], { cwd, env, timeout: timeoutMs, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 1;
    out = (e?.stdout?.toString?.() ?? "") + (e?.stderr?.toString?.() ?? "") + (e?.status === null ? "\n(test command killed: timeout or signal)" : "");
  }
  return { ran: true, command, passed: code === 0, exit_code: code, ms: Date.now() - t0, tail: out.split("\n").slice(-40).join("\n") };
}
