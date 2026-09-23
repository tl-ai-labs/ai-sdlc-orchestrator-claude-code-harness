/**
 * Per-repository counts of what each valve did and how often the model came
 * back for more. These counts are the MEASURED p (full re-read) and q (ranged
 * follow-up) inside the cost rule, so a repo where outlines keep being undone
 * stops getting them without anyone tuning a threshold.
 *
 * Storage is one append-only file per repo; counting reads a bounded tail, so
 * old behaviour ages out on its own as new records push it past the window.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { appendPrivate, ensureDir, mmoHome } from "./paths.mjs";
import { parseEvents } from "./events.mjs";
import { readTail } from "./transcript.mjs";
import { isHardDenied, isSecretFile } from "./deny-paths.mjs";

export function repoKey(projectDir) {
  let real = String(projectDir ?? "");
  try { real = realpathSync(real); } catch { /* keep the given string */ }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

function statsFile(projectDir, env) {
  return join(mmoHome(env), "repos", repoKey(projectDir), "valves.jsonl");
}

export function recordValve(projectDir, valve, kind, env = process.env) {
  ensureDir(mmoHome(env));
  ensureDir(join(mmoHome(env), "repos"));
  ensureDir(join(mmoHome(env), "repos", repoKey(projectDir)));
  appendPrivate(statsFile(projectDir, env), "\n" + JSON.stringify({ ts: new Date().toISOString(), type: "valve", valve, kind }) + "\n");
}

export function valveCounts(projectDir, valve, env = process.env) {
  const counts = { acts: 0, full: 0, ranged: 0 };
  for (const rec of parseEvents(readTail(statsFile(projectDir, env)))) {
    if (rec.valve !== valve) continue;
    if (rec.kind === "act") counts.acts++;
    else if (rec.kind === "full") counts.full++;
    else if (rec.kind === "ranged") counts.ranged++;
  }
  return counts;
}

/**
 * How big a file of this kind really is IN THIS PROJECT, as the median size of its own
 * files of the same shape, or null when the project has nothing to say.
 *
 * His goal 2 (23 Sep): delegation must get its best chance to fire when it should, on the
 * thirteen harness tasks AND on tasks nobody has seen. Whether it fires is decided by how
 * much typing a hand-over would save, and that came from a size learned across every task
 * the plugin had ever run — a number borrowed from seen tasks and spent on unseen ones. A
 * NestJS module, a Go handler and a Python test differ several-fold, and the same job kind
 * differs between two repositories. The project in front of us can simply be measured.
 *
 * Median, not mean, so one vendored monster cannot move it. Files are matched by extension
 * and by whether they are tests, because a test file and a source file are different animals.
 * Only files git tracks are sampled, which keeps node_modules, build output and anything
 * ignored out of it; secrets and denied paths are never opened, only their sizes read.
 * Returns { chars, samples } so the caller can WEIGH it rather than swallow it: at the very
 * start of a greenfield the only files that exist are a couple of tiny configs, and taking
 * that as gospel would say "files here are tiny" and stop delegation before it began. Few
 * samples move the prior a little, many samples move it a lot, which is how the rest of this
 * plugin's evidence already behaves. Null when the project has nothing of that kind at all.
 */
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 400;
const isTestish = (rel) => /(^|\/)(tests?|__tests__|spec)\//i.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(rel) || /_test\.(go|py)$/i.test(rel) || /(^|\/)test_[^/]+\.py$/i.test(rel);

export function projectCharsPerFile({ projectDir, paths, env = process.env }) {
  const want = (Array.isArray(paths) ? paths : []).map((p) => String(p || "")).filter(Boolean);
  if (!want.length || !projectDir) return null;
  const ext = extname(want[0]).toLowerCase();
  const wantTest = isTestish(want[0]);
  let tracked = [];
  try {
    // Tracked AND untracked-but-not-ignored: in a greenfield nothing is committed yet, and the
    // files the model just wrote are exactly the evidence of how big its files are. Ignored
    // paths stay out, so node_modules and build output are never sampled.
    tracked = execFileSync("git", ["-C", projectDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*" + (ext || "")], { env, timeout: 10000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8").split("\0").filter(Boolean);
  } catch { return null; }
  const sizes = [];
  for (const rel of tracked) {
    if (sizes.length >= MAX_SAMPLES) break;
    if (want.includes(rel)) continue;                    // the files this job is about do not exist yet
    if (isTestish(rel) !== wantTest) continue;           // a test is measured against tests
    if (isSecretFile(rel) || isHardDenied(rel)) continue;
    try { const st = statSync(join(projectDir, rel)); if (st.isFile() && st.size > 0) sizes.push(st.size); } catch { /* gone under us */ }
  }
  if (sizes.length < MIN_SAMPLES) return null;
  sizes.sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  const chars = sizes.length % 2 ? sizes[mid] : Math.round((sizes[mid - 1] + sizes[mid]) / 2);
  return { chars, samples: sizes.length };
}
