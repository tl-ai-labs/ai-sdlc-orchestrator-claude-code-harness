/**
 * evidence.ts — what the delegated agent actually did, recorded so a reader
 * does not have to take anyone's word for it.
 *
 * THE PROBLEM THIS SOLVES. A delegated run and a non-delegated run look
 * identical from the outside: same phases, same gates, same generated tree,
 * same report. The one thing that changed — that a Gemini agent opened the
 * directory, ran commands and wrote the files itself — leaves no trace anybody
 * can point at. `worker-task-*.md` shows what the worker was ASKED to do and
 * `worker-usage-*.json` shows what it COST; neither shows what it CHANGED.
 *
 * So the adapter takes an inventory of the working directory immediately
 * before the worker starts and again immediately after it exits, and this
 * module turns the pair into a list of files added, modified and removed. That
 * list, next to the tool-call count, is the delegation's receipt.
 *
 * WHAT THE RECEIPT DOES NOT CLAIM. It records what changed inside the working
 * directory across the worker's lifetime — nothing more. It cannot attribute a
 * change to a specific tool call, and it cannot prove no other process touched
 * the directory in the same window (a watch task, an editor save). For the way
 * this repo runs — one packet at a time, into a directory the orchestrator
 * generates into — the two are the same thing in practice, and the honest
 * phrasing is the one the report uses: "files that changed while the agent
 * worked", not "files the agent wrote".
 *
 * PURE BY DEFAULT. `diffInventories` and `buildDelegationRecord` are plain
 * input-to-output mappings, pinned offline. `takeInventory` is the one function
 * that touches a filesystem, and its tests build a real temporary directory
 * rather than mocking `fs` — the interesting failures are things a mock would
 * happily agree with, like a symlink loop or an unreadable file.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Directory names never descended into.
 *
 * Two different reasons, both of which produce a wrong answer rather than a
 * slow one. `node_modules`, `.git`, `.venv`, `__pycache__` and the build
 * outputs are machine-generated: a worker that runs `npm install` or a test
 * command would otherwise "change" tens of thousands of files, burying the
 * dozen it actually wrote. `.sdlc` is where the delegation evidence itself
 * lands when no telemetry path was supplied — walking it would make each
 * delegation report the previous delegation's receipt as a change it caused.
 */
export const INVENTORY_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".sdlc",
]);

/**
 * Files larger than this are fingerprinted by size rather than by content.
 *
 * Hashing is what makes an edit visible; reading a 200 MB artifact into memory
 * twice per delegation to discover it did not change is not. Two megabytes is
 * far above any source file and far below anything worth streaming. The
 * trade-off is stated in the record itself (`hashed: false` on those entries):
 * a change to a large file that preserves its byte length exactly would be
 * missed, which for build artifacts and media is a rounding error and for
 * source files cannot happen, because source files are under the cap.
 */
export const HASH_BYTE_CAP = 2 * 1024 * 1024;

/**
 * Ceiling on how many files one inventory records.
 *
 * A guard against pathological inputs, not a tuning knob — a working directory
 * with more than this many source files is not a directory this plugin
 * generated. When it trips, the inventory says so (`truncated: true`) and the
 * record repeats it, because a silently partial diff would understate what the
 * agent did and read exactly like a small, tidy delegation.
 */
export const INVENTORY_FILE_CAP = 20_000;

export interface InventoryEntry {
  /** Path relative to the inventoried root, with `/` separators on every OS. */
  path: string;
  size: number;
  /** Content digest, or a size surrogate for files over HASH_BYTE_CAP. */
  digest: string;
  /** False when `digest` is the size surrogate rather than a content hash. */
  hashed: boolean;
}

export interface Inventory {
  root: string;
  entries: InventoryEntry[];
  /** True when INVENTORY_FILE_CAP stopped the walk before it finished. */
  truncated: boolean;
  /** Paths that could not be read at all, with the reason. Rare, and evidence. */
  unreadable: { path: string; reason: string }[];
}

const EMPTY_INVENTORY = (root: string): Inventory => ({
  root,
  entries: [],
  truncated: false,
  unreadable: [],
});

/**
 * Walk a directory and fingerprint every file in it.
 *
 * `exclude` takes ABSOLUTE paths, and exists for one specific hazard: the
 * worker's own output directory can sit inside the working directory (it does
 * whenever no telemetry path was supplied), and the Antigravity SDK writes its
 * session save-dir in there while the agent runs. Without the exclusion, every
 * delegation would report its own brief, its own sidecar and the SDK's
 * transcript as files the agent changed — evidence contaminated by the act of
 * collecting it.
 *
 * Symlinks are recorded by where they point, never followed. A link is one
 * line in the inventory — creating one shows up as an addition, re-pointing one
 * as a modification — and the walk never descends through it, so a link aimed
 * at its own ancestor cannot loop.
 *
 * Never throws. An inventory is evidence about a run, not part of it, and a
 * permission error on one file must not fail a delegation the user has already
 * paid for — the unreadable path is recorded and the walk continues.
 */
export function takeInventory(root: string, opts: { exclude?: string[] } = {}): Inventory {
  const inv = EMPTY_INVENTORY(root);
  const excluded = (opts.exclude ?? []).filter(Boolean);
  const isExcluded = (abs: string) =>
    excluded.some((ex) => abs === ex || abs.startsWith(ex.endsWith(sep) ? ex : ex + sep));

  const walk = (dir: string) => {
    if (inv.truncated) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err: any) {
      inv.unreadable.push({ path: rel(root, dir), reason: reason(err) });
      return;
    }
    for (const name of names) {
      if (inv.truncated) return;
      const abs = join(dir, name);
      if (isExcluded(abs)) continue;
      let st;
      try {
        // lstat, NOT stat: stat resolves a symlink and would describe the
        // target, so a link to a directory would report `isDirectory()` and the
        // walk below would descend through it. A link aimed at its own
        // ancestor — which an agent is perfectly capable of creating in the
        // workspace it was given — would then recurse until the process ran out
        // of stack, hanging a delegation that had already been paid for.
        st = lstatSync(abs, { throwIfNoEntry: true });
      } catch (err: any) {
        // A file that vanished between readdir and stat is the normal case
        // here, not an anomaly: the agent may be writing temporary files while
        // the after-inventory runs.
        inv.unreadable.push({ path: rel(root, abs), reason: reason(err) });
        continue;
      }
      if (st.isSymbolicLink()) {
        // Recorded by target rather than hashed, so the link is one line
        // instead of a whole second copy of a tree that is already inventoried
        // under its real path. Creating a link shows as an addition and
        // re-pointing one as a modification, which is the part a reader cares
        // about; a dangling link keeps its entry with an empty target.
        let target = "";
        try {
          target = readlinkSync(abs);
        } catch (err: any) {
          inv.unreadable.push({ path: rel(root, abs), reason: reason(err) });
        }
        if (!push(inv, { path: rel(root, abs), size: 0, digest: `symlink:${target}`, hashed: false })) return;
        continue;
      }
      if (st.isDirectory()) {
        if (INVENTORY_SKIP_DIRS.has(name)) continue;
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue; // sockets, fifos, devices — not deliverables
      if (!push(inv, fingerprint(root, abs, st.size))) return;
    }
  };

  walk(root);
  inv.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return inv;
}

/**
 * Append one entry, honouring the file cap. Returns false once the cap is hit,
 * which is the caller's signal to stop walking. The cap is a guard against
 * being pointed at a home directory by accident, not a normal operating mode —
 * `truncated` rides along into the diff so a partial list is never read as a
 * complete one.
 */
function push(inv: Inventory, entry: InventoryEntry): boolean {
  if (inv.entries.length >= INVENTORY_FILE_CAP) {
    inv.truncated = true;
    return false;
  }
  inv.entries.push(entry);
  return true;
}

function fingerprint(root: string, abs: string, size: number): InventoryEntry {
  const path = rel(root, abs);
  if (size > HASH_BYTE_CAP) return { path, size, digest: `size:${size}`, hashed: false };
  try {
    return {
      path,
      size,
      digest: createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16),
      hashed: true,
    };
  } catch {
    // Unreadable content with a readable stat — record it as size-only rather
    // than dropping the file, so its appearance or disappearance still shows.
    return { path, size, digest: `size:${size}`, hashed: false };
  }
}

const rel = (root: string, abs: string) => relative(root, abs).split(sep).join("/") || ".";
const reason = (err: any) => String(err?.code ?? err?.message ?? err);

export interface InventoryDiff {
  added: string[];
  modified: string[];
  removed: string[];
  /** Files present in both inventories with an identical digest. */
  unchanged: number;
  /** Total files seen in the after-inventory. */
  scanned: number;
  /** True when either inventory hit the file cap, so the lists may be partial. */
  truncated: boolean;
  /** Paths neither inventory could read. Empty on a healthy run. */
  unreadable: string[];
}

/**
 * What changed between two inventories of the same directory.
 *
 * Modification is a digest change, not an mtime change. An agent that rewrites
 * a file with byte-identical content has not modified anything a reader cares
 * about, and a tool that rewrites timestamps — `npm install`, a formatter run
 * over untouched files, a `touch` in a test script — would otherwise fill the
 * receipt with changes nobody made.
 */
export function diffInventories(before: Inventory, after: Inventory): InventoryDiff {
  const prior = new Map(before.entries.map((e) => [e.path, e]));
  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const entry of after.entries) {
    const was = prior.get(entry.path);
    if (!was) added.push(entry.path);
    else if (was.digest !== entry.digest) modified.push(entry.path);
    else unchanged += 1;
    prior.delete(entry.path);
  }

  return {
    added,
    modified,
    removed: [...prior.keys()].sort(),
    unchanged,
    scanned: after.entries.length,
    truncated: before.truncated || after.truncated,
    unreadable: [
      ...new Set([...before.unreadable, ...after.unreadable].map((u) => u.path)),
    ].sort(),
  };
}

/**
 * Schema tag on every record.
 *
 * The report reads these files from a directory it globs, so it will meet
 * records written by older versions of this plugin. A version here lets it say
 * "written by a newer plugin than this report understands" instead of silently
 * rendering a half-empty row.
 */
export const DELEGATION_RECORD_SCHEMA = "delegation-record/1";

export interface DelegationRecordInput {
  packet: { id: string; phase: string; task_type: string; module: string };
  modelId: string;
  modelName: string;
  workdir: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  costUsd: number;
  tokens: { input: number; input_cached: number; output: number; output_reasoning?: number };
  /** The worker's usage sidecar, or null when it never wrote one. */
  sidecar: any;
  diff: InventoryDiff;
  /** Filenames, not paths — the record sits in the same directory as both. */
  briefFile: string;
  usageFile: string;
}

/**
 * Assemble the JSON a reader (and `tools/report.mjs`) gets.
 *
 * ONE FILE, NOT A JOIN ACROSS THREE. The brief, the sidecar and the telemetry
 * event each hold a piece of a delegation, and the pieces are keyed
 * differently — the sidecar by filename, the event by `task_id`. This record
 * carries `task_id` explicitly so the report joins on a field rather than by
 * reconstructing the adapter's filename convention, which would be a fourth
 * hand-maintained copy of a rule that already exists in `evidenceStem`.
 *
 * `cable` is copied out of the sidecar rather than out of the adapter's own
 * configuration on purpose. The adapter knows what it INTENDED — project P,
 * region R, through the Antigravity SDK. The sidecar is written by the worker
 * process after the session ran, so it reports what the run actually used. When
 * the two disagree, the one worth keeping is the worker's.
 */
export function buildDelegationRecord(i: DelegationRecordInput): Record<string, unknown> {
  const sidecar = i.sidecar ?? {};
  return {
    schema: DELEGATION_RECORD_SCHEMA,
    task_id: i.packet.id,
    phase: i.packet.phase,
    task_type: i.packet.task_type,
    module: i.packet.module,
    model_id: i.modelId,
    model_name: i.modelName,
    cable: {
      sdk: sidecar.sdk ?? null,
      sdk_version: sidecar.sdk_version ?? null,
      vertex_project: sidecar.vertex_project ?? null,
      vertex_location: sidecar.vertex_location ?? null,
      thinking: sidecar.thinking ?? null,
    },
    workdir: i.workdir,
    started_at: i.startedAt,
    duration_ms: i.durationMs,
    success: i.success,
    error: i.error ?? null,
    cost_usd: i.costUsd,
    tokens: i.tokens,
    tool_calls: {
      // The count is the drained total; the list stops at the worker's own
      // recording cap. Reporting `sample.length` as the count would understate
      // every long session by exactly the amount that makes it interesting.
      count: Number(sidecar.tool_call_count ?? 0),
      truncated: sidecar.tool_calls_truncated === true,
      sample: Array.isArray(sidecar.tool_calls) ? sidecar.tool_calls : [],
    },
    files: {
      added: i.diff.added,
      modified: i.diff.modified,
      removed: i.diff.removed,
      unchanged: i.diff.unchanged,
      scanned: i.diff.scanned,
      truncated: i.diff.truncated,
      unreadable: i.diff.unreadable,
    },
    artifacts: { brief: i.briefFile, usage: i.usageFile },
  };
}
