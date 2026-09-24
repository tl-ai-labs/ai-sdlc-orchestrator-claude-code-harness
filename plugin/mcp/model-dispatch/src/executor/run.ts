/**
 * The shared executor: types every file job of one stage — the units of a
 * typed-spec stage, or the fixes of a repair round — checks each answer,
 * writes the file, and returns ONE short receipt.
 *
 * It is the same machine for both arms. The policy decides, per job and per
 * attempt, which typist types it (pickModel on the job's phase, kind and retry
 * count — the solo policy sends every job to Opus, the orchestrator policy
 * sends most to Gemini); everything else below is identical, so the only
 * difference between the arms is who types. The orchestrator never re-types a
 * file: the answer goes from the typist to disk by code, which removes the
 * round trip through the orchestrator's context that cost the old pipeline
 * most of its gap to solo.
 *
 * Per job, up to three attempts: two routed by the policy (retry_count 0 and
 * 1), the refusal reason fed back on the second; then one with the lean Opus
 * typist. For solo all three are lean Opus; for the orchestrator a Gemini job
 * gets two Gemini tries and one Opus try, paying Opus's price for the rescue —
 * which is also what the orchestrator policy's own debug rule says for fixes
 * (Flash, then Opus from retry_count 2). A vendor or network failure is not an
 * attempt: it waits — the vendor's own retry delay when it gives one, else
 * exponential backoff with full jitter — and asks again.
 *
 * A fix (stage "repair") is routed as phase `debug`, the policies' own rule
 * for fixes, and answered with exact edits to the file's current text: each
 * search must match exactly once, or the edit is refused and the file is left
 * untouched. A whole-file answer is accepted instead when the file is missing
 * or most of it changes.
 *
 * Every typist call, successful or not, is one telemetry event with that
 * call's own tokens and dollars, so every typist process is on the bill.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { FileSlice, Phase, Policy, TaskPacket, TelemetryEvent } from "../types.js";
import { pickModel } from "../routing.js";
import type { SelectOverrides } from "../types.js";
import { cacheWriteBuckets } from "../telemetry.js";
import { isSafeRelativePath, type Spec, type SpecUnit } from "../spec/store.js";
import { renderRepairInstruction, renderUnitInstruction, framedPacket, repairPacket, unitPacket } from "./brief.js";
import { checkAnswer, type CheckResult, type CheckTarget } from "./checks.js";
import type { Answer, Contract, Door, Edit, Typist, TypistResult } from "./typists.js";

export type Stage = "codegen" | "tests" | "docs" | "repair";

/** One file to fix: its path under the code directory, what must change, and files to show beside it for reference. */
/**
 * One file to fix. `new_file` asks for a file that does not exist yet (24 Sep, receivables: the
 * senior review asked for start-up code to move into a new file, the repair stage could only change
 * a file that exists or that the spec lists, and the finding stayed open). A missing file is never
 * guessed from a finding's path — the reviewer writes paths from the project root, so a new name can
 * mean two places — so the caller, which knows the code directory, asks for it explicitly, with a
 * path relative to the code directory (placeNewFile).
 */
export interface RepairItem { path: string; problems: string[]; context_paths?: string[]; new_file?: boolean }

export interface StageOptions {
  stage: Stage;
  /** Where files are written; every job path is relative to it. */
  codeDir: string;
  passId: string;
  policy: Policy;
  overrides?: SelectOverrides;
  /** Jobs typed at once: a stated upper bound (tools.ts). */
  concurrency: number;
  /** Attempts routed by the policy before the lean Opus attempt. */
  routedAttempts: number;
  /** Transport waits per call before giving up, and the backoff's base and cap. */
  transport: { maxWaits: number; baseMs: number; capMs: number };
  /** The files to fix, for stage "repair". */
  repairs?: RepairItem[];
}

export interface StageDeps {
  /** The typist for a policy leaf id. */
  typistFor(modelId: string): Typist;
  /** The lean Opus typist: the last attempt for every job, in both arms. */
  fallback: Typist;
  /** The shared block, and the file that holds it. */
  shared: string;
  sharedFile: string;
  emit(ev: TelemetryEvent): void;
  progress?(done: number, total: number, message: string): void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  now?(): number;
  check?(target: CheckTarget, answer: { path: string; content: string }): CheckResult;
}

export interface StageReceipt {
  stage: Stage;
  units: number;
  written: number;
  failed: { id: string; path: string; reason: string }[];
  failed_not_listed?: number;
  /**
   * Set when a door refused the login or permission (HTTP 401/403): the stage
   * stopped there, so the files are never quietly handed to the lean Opus
   * attempt — an orchestrator run with a broken Gemini door would otherwise
   * complete as a costlier solo run with no failure shown.
   */
  stopped?: string;
  /** Jobs not started because the stage stopped. */
  not_typed?: number;
  /** Files a repair round created (asked for with new_file); every other written file already existed. */
  created?: string[];
  /** Fixes whose file could not be placed (placeFixPath): reported, never guessed. */
  not_routed?: { file: string; reason: string }[];
  not_routed_not_listed?: number;
  by_door: Partial<Record<Door, { units_written: number; calls: number; cost_usd: number }>>;
  calls: number;
  transport_waits: number;
  cost_usd: number;
  seconds: number;
}

/** Full-jitter exponential backoff: a random wait in [0, min(cap, base·2^k)). */
export function backoffMs(k: number, baseMs: number, capMs: number, random: () => number): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** k));
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The receipt's size bound: a stated limit that keeps what the orchestrator re-reads each turn small. */
export const RECEIPT_MAX_BYTES = 2048;
/** HTTP statuses that mean the credentials or permission are wrong, not that the vendor is busy: 401 Unauthorized, 403 Forbidden (RFC 9110). */
const CONFIG_REFUSALS = new Set([401, 403]);

/**
 * The receipt as sent, within RECEIPT_MAX_BYTES measured on the compact JSON
 * the tool replies with: unplaced fixes, then failures, that do not fit are
 * counted, not listed (the telemetry has every call).
 */
export function boundReceipt<T extends { failed: unknown[]; failed_not_listed?: number; not_routed?: unknown[]; not_routed_not_listed?: number }>(receipt: T): T {
  const r: T = { ...receipt, failed: [...receipt.failed], ...(receipt.not_routed ? { not_routed: [...receipt.not_routed] } : {}) };
  while (JSON.stringify(r).length > RECEIPT_MAX_BYTES && r.not_routed?.length) {
    r.not_routed.pop();
    r.not_routed_not_listed = (r.not_routed_not_listed ?? 0) + 1;
  }
  while (JSON.stringify(r).length > RECEIPT_MAX_BYTES && r.failed.length) {
    r.failed.pop();
    r.failed_not_listed = (r.failed_not_listed ?? 0) + 1;
  }
  return r;
}

/**
 * Whether <codeRoot>/<rel> lands inside the code directory once every symlink
 * is followed: the deepest part of the path that exists decides where a write
 * would go. A lexical check alone let a symlinked folder carry a write out.
 */
export function insideCodeDir(codeRoot: string, rel: string): boolean {
  const realRoot = realpathSync(codeRoot);
  let p = resolve(codeRoot, rel);
  while (!existsSync(p)) { const up = dirname(p); if (up === p) break; p = up; }
  const r = relative(realRoot, realpathSync(p));
  return !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Where a fix applies. A review finding or a failing test names a file; the
 * name is placed only on a regular file that exists under the code directory,
 * or on a file the spec lists (a planned file may be written even if it is
 * missing) — never guessed, and never a new stray file. The senior reviewer
 * writes paths from the project root (the pipeline smoke's review.json said
 * "src/notes_api/api.py" for code_dir <project>/src), so a path written from
 * a folder that contains the code directory is placed by dropping that
 * folder's part of the code directory's own path. Anything else — a line
 * number glued to the name, a missing file, a path that leaves the code
 * directory, even through a symlink — is reported back.
 */
export function placeFixPath(file: string, codeRoot: string, unitPaths: Set<string>): { path: string } | { reason: string } {
  const root = resolve(codeRoot);
  const rel = isAbsolute(file) ? relative(root, file).split(sep).join("/") : posix.normalize(file.replace(/\\/g, "/"));
  const candidates = [rel];
  const segs = root.split(sep).filter(Boolean);
  for (let k = 1; k <= segs.length; k++) {
    const prefix = segs.slice(-k).join("/") + "/";
    if (rel.startsWith(prefix)) candidates.push(rel.slice(prefix.length));
  }
  for (const c of candidates) {
    if (!isSafeRelativePath(c)) continue;
    const full = resolve(root, c);
    const isFile = existsSync(full) && statSync(full).isFile();
    if ((isFile || unitPaths.has(c)) && insideCodeDir(root, c)) return { path: c };
  }
  return { reason: NOT_PLACED };
}

/** Why a fix was not placed, and how to ask for a file that does not exist yet. */
export const NOT_PLACED = "names no file under the code directory and no file of the spec; to create a file that does not exist yet, send it in failures with new_file: true and its path relative to the code directory";

/**
 * Where a fix that creates a file goes: the path exactly as given, relative to the code directory,
 * held to the same checks as every file the executor writes — a safe relative path (no leading
 * slash, no '..') that stays inside the code directory even through a symlinked folder
 * (insideCodeDir). Never an absolute path, never moved or guessed.
 */
export function placeNewFile(file: string, codeRoot: string): { path: string } | { reason: string } {
  const norm = file.replace(/\\/g, "/");
  if (isAbsolute(file) || norm.startsWith("/")) return { reason: "a new file's path must be relative to the code directory" };
  const rel = posix.normalize(norm);
  if (!isSafeRelativePath(rel) || !insideCodeDir(resolve(codeRoot), rel)) return { reason: "a new file's path must stay inside the code directory" };
  return { path: rel };
}
/**
 * How long a lean Opus typist's cache stays warm after its last call: the
 * five-minute lifetime the typist is launched with (CLAUDE_CODE_PROMPT_CACHE_TTL=5m,
 * typists.ts). A typist idle for longer sends one job alone before fanning out.
 */
export const LEAN_OPUS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Applies exact edits in order. Each search must appear exactly once in the
 * text as it stands when that edit applies; otherwise nothing is changed and
 * the reason says which edit and how many times its text appeared.
 */
export function applyEdits(text: string, edits: Edit[]): { content?: string; reason?: string } {
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const { search, replace } = edits[i];
    // Occurrences are counted overlapping (step 1), so "}\n}" in "}\n}\n}" counts twice: an ambiguous edit is refused, never applied at the first match.
    let count = 0;
    for (let at = out.indexOf(search); at !== -1; at = out.indexOf(search, at + 1)) count++;
    if (count !== 1) return { reason: `edit ${i + 1}: its search text appears ${count} times in the current text (it must appear exactly once); the file was left unchanged` };
    out = out.replace(search, () => replace);
  }
  return { content: out };
}

/** One file to type: a unit to write, or a file to fix. */
interface Job {
  id: string;
  path: string;
  /**
   * The stage the policy routes on — and nothing else. Who types a file never
   * depends on its language, name or kind (24 Sep: a task-type list written for
   * NestJS/React sent every other file to the default model).
   */
  phase: Phase;
  contract: Contract;
  target: CheckTarget;
  packet(refusal?: string): TaskPacket;
  /** The file's new content from an answer, or why the answer cannot apply. */
  resolve(answer: Answer): { content?: string; reason?: string };
}

function unitJob(spec: Spec, unit: SpecUnit, passId: string): Job {
  return {
    id: unit.id, path: unit.path, phase: unit.phase, contract: "file", target: unit,
    packet: (refusal) => unitPacket(unit, renderUnitInstruction(spec, unit, refusal), passId, 0),
    resolve: (a) => ({ content: a.content }),
  };
}

function repairJob(spec: Spec, item: RepairItem, codeRoot: string, passId: string, unitPaths: Set<string>): Job {
  const unit = spec.units.find((u) => u.path === item.path);
  const read = (p: string) => { const f = resolve(codeRoot, p); return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null; };
  const current = read(item.path);
  const inputs: FileSlice[] = [
    { path: item.path, reason: current === null ? "current text: the file does not exist yet" : "current text (your edits apply to this)", content: current ?? "" },
    // Reference files are placed like fixes: only a file under the code
    // directory (or of the spec) is read, so nothing outside the project can
    // reach a vendor's brief.
    ...(item.context_paths ?? []).filter((p) => p !== item.path).map((p) => {
      const placed = placeFixPath(p, codeRoot, unitPaths);
      return "path" in placed
        ? { path: placed.path, reason: "for reference only; do not edit", content: read(placed.path) ?? "(missing)" }
        : { path: p, reason: "for reference only", content: "(not found under the code directory; not shown)" };
    }),
  ];
  return {
    id: `${unit?.id ?? "F"}-fix`, path: item.path, phase: "debug", contract: "edit",
    target: { path: item.path },
    packet: (refusal) => repairPacket(`${unit?.id ?? "F"}-fix`, renderRepairInstruction(spec, { path: item.path, unit }, item.problems, refusal), passId, inputs, 0),
    resolve: (a) => {
      if (a.content !== undefined) return { content: a.content };
      if (current === null) return { reason: `${item.path} does not exist yet, so edits cannot apply; send the whole file as content` };
      return applyEdits(current, a.edits ?? []);
    },
  };
}

/**
 * Why a policy cannot route this executor stage, or null when it can. The
 * executor routes a job by its stage and retry count alone; a rule for the
 * stage that also matches on task type, module or intent would be missed by
 * every job, which would fall to another rule or the default without a word —
 * the multi-model arm quietly typed by Opus (24 Sep). Such a policy is refused
 * before anything is paid for.
 */
export function stageRuleProblem(policy: Policy, phase: string): string | null {
  for (const [i, rule] of policy.rules.entries()) {
    if ("default" in rule) continue;
    const w = rule.when;
    if (w.phase !== undefined && ![w.phase].flat().includes(phase)) continue;
    const extra = (["task_type", "module", "intent"] as const).filter((k) => w[k] !== undefined);
    if (extra.length) return `policy '${policy.name}' rule ${i} routes ${phase} on ${extra.join(", ")}; the executor routes by stage alone — who types a file never depends on its kind, name or language — so that rule could never match here. Remove ${extra.join(", ")} from it.`;
  }
  return null;
}

export async function executeStage(spec: Spec, opts: StageOptions, deps: StageDeps): Promise<StageReceipt> {
  const started = Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const check = deps.check ?? ((t: CheckTarget, a: { path: string; content: string }) => checkAnswer(t, a));
  const codeRoot = resolve(opts.codeDir);

  let jobs: Job[];
  const notRouted: { file: string; reason: string }[] = [];
  if (opts.stage === "repair") {
    // Each fix is placed on a real file (placeFixPath); one job per file:
    // problems for the same file are merged, so two fixes never race on it.
    const unitPaths = new Set(spec.units.map((u) => u.path));
    const byPath = new Map<string, RepairItem>();
    for (const r of opts.repairs ?? []) {
      // An existing file (or one the spec lists) is placed as always; only a fix that asks for a
      // new file (new_file) may name a file that does not exist yet, at exactly the path it gives.
      let placed = placeFixPath(r.path, codeRoot, unitPaths);
      if ("reason" in placed && r.new_file) placed = placeNewFile(r.path, codeRoot);
      if ("reason" in placed) { notRouted.push({ file: r.path, reason: placed.reason }); continue; }
      const m = byPath.get(placed.path);
      if (m) { m.problems.push(...r.problems); m.context_paths = [...new Set([...(m.context_paths ?? []), ...(r.context_paths ?? [])])]; }
      else byPath.set(placed.path, { path: placed.path, problems: [...r.problems], context_paths: [...(r.context_paths ?? [])] });
    }
    jobs = [...byPath.values()].map((r) => repairJob(spec, r, codeRoot, opts.passId, unitPaths));
  } else {
    jobs = spec.units.filter((u) => u.phase === opts.stage).map((u) => unitJob(spec, u, opts.passId));
  }

  const receipt: StageReceipt = { stage: opts.stage, units: jobs.length, written: 0, failed: [], ...(opts.stage === "repair" ? { not_routed: notRouted } : {}), by_door: {}, calls: 0, transport_waits: 0, cost_usd: 0, seconds: 0 };
  let done = 0;

  const bill = (door: Door) => (receipt.by_door[door] ??= { units_written: 0, calls: 0, cost_usd: 0 });
  // No task type: the policy routes an executor job by its stage alone (stageRuleProblem refuses a policy that cannot).
  const route = (job: Job, retry: number) => pickModel({ phase: job.phase, task_type: "", module: "spec", retry_count: retry }, opts.policy, opts.overrides ?? {});

  const event = (job: Job, typist: Typist, decision: ReturnType<typeof pickModel> | null, r: TypistResult, attempt: number, ok: boolean, why?: string, retryReason?: string): TelemetryEvent => ({
    ts: new Date().toISOString(),
    pass: opts.passId,
    phase: job.phase,
    task_type: job.phase,
    task_id: job.id,
    module: "spec",
    model: typist.modelName,
    model_id: typist.modelId,
    routed_by: "orchestrator",
    provenance: "vendor",
    door: typist.door,
    routing: {
      policy_name: opts.policy.name,
      policy_version: opts.policy.version,
      rule_index: decision ? decision.ruleIndex : -1,
      rule_reason: decision ? decision.reason : "executor: the lean Opus attempt every job gets after its routed attempts",
      ...(decision?.selection ? { select: decision.selection } : {}),
    },
    input_tokens: r.tokens.input,
    input_tokens_cached: r.tokens.input_cached,
    ...cacheWriteBuckets(r.tokens),
    output_tokens: r.tokens.output,
    output_tokens_reasoning: r.tokens.output_reasoning,
    cost_usd: r.cost_usd,
    latency_ms: r.latency_ms,
    success: ok,
    attempt_number: attempt,
    retry_count: attempt - 1,
    retry_reason: retryReason,
    error: ok ? undefined : why,
    price_basis: r.price_basis as any,
  } as TelemetryEvent);

  // Warm the cache first. A lean Opus typist whose cache has gone cold sends
  // one job alone; the others wait for it and then read the shared block from
  // the cache it wrote, instead of each writing it. Only Claude typists: the
  // Gemini doors have no cache the executor controls.
  const lastCall = new Map<Typist, number>();
  const warming = new Map<Typist, Promise<void>>();
  // The cache lifetime runs from the request that read or wrote it, so a call
  // that reached the model refreshes the window from the moment it started.
  async function warmGate(typist: Typist): Promise<((reachedModel: boolean) => void) | null> {
    if (typist.door !== "lean-opus") return null;
    for (;;) {
      const w = warming.get(typist);
      if (w) { await w; continue; }
      const startedAt = now();
      const last = lastCall.get(typist);
      if (last !== undefined && startedAt - last < LEAN_OPUS_CACHE_TTL_MS) return (reached) => { if (reached) lastCall.set(typist, Math.max(lastCall.get(typist) ?? 0, startedAt)); };
      let release!: () => void;
      warming.set(typist, new Promise<void>((r) => (release = r)));
      return (reached) => { if (reached) lastCall.set(typist, Math.max(lastCall.get(typist) ?? 0, startedAt)); warming.delete(typist); release(); };
    }
  }

  /** One typist call, waiting out transport failures. Every call is billed. */
  async function call(job: Job, typist: Typist, decision: ReturnType<typeof pickModel> | null, refusal: string | undefined, attempt: number): Promise<TypistResult> {
    const packet = job.packet(refusal);
    for (let k = 0; ; k++) {
      const t0 = Date.now();
      let r: TypistResult;
      const release = await warmGate(typist);
      try {
        r = await typist.type({ unit: { id: job.id, path: job.path }, packet, framed: framedPacket(packet), shared: deps.shared, sharedFile: deps.sharedFile, contract: job.contract, passId: opts.passId });
      } catch (e: any) {
        // A typist that throws (a spawn failure, an unreadable receipt) fails this
        // attempt; it never takes the rest of the stage down with it.
        r = { answer: null, error: `the ${typist.door} typist failed: ${e?.message ?? String(e)}`.slice(0, 300), transport: false, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: Date.now() - t0 };
      }
      release?.(r.tokens.input + r.tokens.input_cached + (r.tokens.input_cache_write ?? 0) + (r.tokens.input_cache_write_1h ?? 0) > 0);
      // A pause longer than one rate-limit window means the quota is spent for
      // longer than a stage waits (both vendors meter rate limits per minute):
      // that is an attempt, not a wait.
      if (r.transport && r.retry_after_ms !== undefined && r.retry_after_ms > opts.transport.capMs) {
        r = { ...r, transport: false, error: `${r.error ?? "rate limited"} — the vendor asked for a ${Math.round(r.retry_after_ms / 1000)} s pause, longer than one ${Math.round(opts.transport.capMs / 1000)} s rate-limit window` };
        // It is an attempt, but the next attempt still waits one full window, so it does not hit the same wall at once.
        await sleep(opts.transport.capMs);
      }
      if (r.error_status !== undefined && CONFIG_REFUSALS.has(r.error_status) && !stopped) {
        stopped = `the ${typist.door} door refused the call with HTTP ${r.error_status} (its login or permission is broken): the stage stopped here instead of sending the remaining files to another typist; fix the credentials and run the stage again`;
      }
      receipt.calls++;
      receipt.cost_usd += r.cost_usd;
      const b = bill(typist.door);
      b.calls++;
      b.cost_usd += r.cost_usd;
      if (r.transport && k < opts.transport.maxWaits) {
        deps.emit(event(job, typist, decision, r, attempt, false, r.error, "transport"));
        receipt.transport_waits++;
        await sleep(r.retry_after_ms ?? backoffMs(k, opts.transport.baseMs, opts.transport.capMs, random));
        continue;
      }
      return r;
    }
  }

  // A door that refuses the login or permission stops the stage (see StageReceipt.stopped).
  let stopped: string | undefined;

  const planFor = (job: Job) => [
    ...Array.from({ length: opts.routedAttempts }, (_, i) => { const d = route(job, i); return { typist: deps.typistFor(d.modelId), decision: d as ReturnType<typeof pickModel> | null }; }),
    { typist: deps.fallback, decision: null },
  ];

  async function typeJob(job: Job): Promise<void> {
    const plan = planFor(job);
    let refusal: string | undefined;
    for (let i = 0; i < plan.length; i++) {
      const { typist, decision: d } = plan[i];
      const attempt = i + 1;
      const r = await call(job, typist, d, refusal, attempt);
      if (stopped) {
        deps.emit(event(job, typist, d, r, attempt, false, r.error));
        receipt.failed.push({ id: job.id, path: job.path, reason: "stopped: the door refused the login or permission" });
        return;
      }
      let verdict: CheckResult | null = null;
      let why = r.error;
      let content: string | undefined;
      if (r.answer) {
        if (r.answer.path !== job.path) why = `the answer names ${r.answer.path}, not ${job.path}`;
        else {
          const applied = job.resolve(r.answer);
          if (applied.reason !== undefined) why = applied.reason;
          else {
            content = applied.content!;
            verdict = check(job.target, { path: job.path, content });
            if (!verdict.ok) why = verdict.reason;
          }
        }
      }
      const ok = !!(content !== undefined && verdict?.ok);
      deps.emit(event(job, typist, d, r, attempt, ok, why, attempt > 1 ? (refusal ? "refused" : "error") : undefined));
      if (ok) {
        const target = resolve(codeRoot, job.path);
        const rel = relative(codeRoot, target);
        if (rel.startsWith("..") || rel === "") { refusal = `unsafe path ${job.path}`; continue; }
        mkdirSync(dirname(target), { recursive: true });
        const existed = existsSync(target);
        writeFileSync(target, content!);
        receipt.written++;
        if (opts.stage === "repair" && !existed) (receipt.created ??= []).push(job.path);
        bill(typist.door).units_written++;
        return;
      }
      if (r.cut_off) {
        // The answer stopped at this typist's output limit (the vendor's own stop reason). The same typist
        // cannot return the whole file at the same limit, so every later attempt by it is skipped and the
        // file goes to the next typist in the plan; with none left it fails with this reason (24 Sep;
        // replaces the spec's line cap, which was a tokens-per-line figure measured on Python).
        refusal = `the answer was cut off at the ${typist.door} typist's output limit, so it cannot return this whole file in one answer`;
        while (i + 1 < plan.length && plan[i + 1].typist.door === typist.door && plan[i + 1].typist.modelId === typist.modelId) i++;
        continue;
      }
      refusal = why ?? "no answer";
    }
    receipt.failed.push({ id: job.id, path: job.path, reason: (refusal ?? "no answer").slice(0, 160) });
  }

  // Nothing is paid for until the stage can run: the checker's tools are
  // present (never "pass unchecked"), every job path is safe, and every
  // typist the stage can use is built — a typist that cannot run here (a CLI
  // flag missing, no Python for the agent door, no Vertex project) stops the
  // stage before a single job is sent.
  const stageProblem = stageRuleProblem(opts.policy, opts.stage === "repair" ? "debug" : opts.stage);
  if (stageProblem) throw new Error(stageProblem);
  // A job whose file would land outside the code directory — lexically, or
  // through a symlinked folder — is failed before any typist is paid for it.
  jobs = jobs.filter((j) => {
    const rel = relative(codeRoot, resolve(codeRoot, j.path));
    const inside = !(rel.startsWith("..") || rel === "" || j.path.startsWith("/")) && insideCodeDir(codeRoot, j.path);
    if (!inside) receipt.failed.push({ id: j.id, path: j.path, reason: "the file would land outside the code directory" });
    return inside;
  });
  for (const j of jobs) planFor(j);

  // A pool of `concurrency` workers draining the stage's jobs. A unit's brief
  // carries only the spec entries of the units it uses, never their files, so
  // units of one stage do not wait for each other; a fix carries only its own
  // file's text, and each file has at most one fix job.
  const queue = [...jobs];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, queue.length)) }, async () => {
    for (let j = stopped ? undefined : queue.shift(); j; j = stopped ? undefined : queue.shift()) {
      // A job that throws (a filesystem error while writing) is a failed job;
      // it never rejects the stage while other workers are still typing.
      try { await typeJob(j); } catch (e: any) { receipt.failed.push({ id: j.id, path: j.path, reason: `the job failed: ${e?.message ?? String(e)}`.slice(0, 160) }); }
      done++;
      deps.progress?.(done, jobs.length, `${j.path}`);
    }
  });
  await Promise.all(workers);

  if (stopped) { receipt.stopped = stopped; receipt.not_typed = queue.length; }
  receipt.cost_usd = round6(receipt.cost_usd);
  for (const b of Object.values(receipt.by_door)) b!.cost_usd = round6(b!.cost_usd);
  receipt.seconds = Math.round((Date.now() - started) / 1000);
  // The orchestrator reads the receipt into its context, where every byte is
  // re-read on each later turn: it is kept within RECEIPT_MAX_BYTES.
  return boundReceipt(receipt);
}
