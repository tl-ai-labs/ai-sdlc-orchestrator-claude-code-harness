/**
 * The three typists the executor can hand a job to. Each takes the same brief
 * (the shared block + the framed job block, see brief.ts) and returns the same
 * answer shape — {path, content} when writing a file, exact edits or the
 * whole file when fixing one — with its own receipt's tokens and dollars. The
 * policy decides which one types a job; nothing else differs.
 *
 *  - lean-opus — `claude -p` with no tools, no MCP servers, safe mode, low
 *    effort, the shared block as the system-prompt tail (cached), the job on
 *    stdin. The solo arm types every file this way, and the orchestrator arm
 *    every file its policy keeps on Opus. Measured: 8/8 first-try on eight
 *    TeamBoard units, $0.074 per unit (task folder, probes/s2 round 2).
 *  - flash-completion — Gemini through the completion door (GeminiFlashAdapter),
 *    the shared block first as its inline header, a response schema, low
 *    thinking. Measured: 8/8, $0.0094 per unit.
 *  - agy — Gemini through the Antigravity SDK, configured as a typist
 *    (worker/typist_worker.py: FINISH-only, custom short system prompt + the
 *    shared block, no sub-agents, a model-call budget, low thinking).
 *    Measured: 8/8, $0.0089 per unit.
 *
 * Effort is LOW for every typist. It was chosen by one pre-registered rule on
 * the same eight units (the lowest effort whose first-try passes equal the
 * highest effort's): Opus high cost 37% more for no extra pass, and Flash at
 * high thinking failed 7 of 8 by running out of the policy's 8,192-token
 * output ceiling.
 *
 * Each typist's request is pinned by a test to the setup step 2 measured, and
 * each child process gets an environment built from an allowlist (step 2 ran
 * the children with exactly HOME, PATH, USER, LOGNAME, TERM and LANG), so no
 * variable of the launching session can change a typist in one arm only.
 *
 * A failure is classified from the vendor's structured fields, never from its
 * wording: a vendor or network failure ("not now") waits and is not an
 * attempt; anything else, including anything unknown, is an attempt.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptRecord, ModelConfig, TaskPacket } from "../types.js";
import { GeminiFlashAdapter } from "../adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../adapters/AntigravityWorkerAdapter.js";
import { priceClaudeCliResult } from "../adapters/claudeCliLedger.js";
import { computeCostUsd } from "../pricing.js";
import { mapSidecarTokens } from "../delegation/workerProcess.js";

export type Door = "lean-opus" | "flash-completion" | "agy";
/** Which answer the job asks for: a whole file, or a fix to one. */
export type Contract = "file" | "edit";

export interface Edit { search: string; replace: string }
/** A typist's answer: `content` when writing (or rewriting) a file, `edits` when fixing one. */
export interface Answer { path: string; content?: string; edits?: Edit[] }

export interface TypistTokens {
  input: number;
  input_cached: number;
  output: number;
  output_reasoning?: number;
  input_cache_write?: number;
  input_cache_write_1h?: number;
}

export interface TypistResult {
  /** A well-formed answer came back (whether it passes the checks is the executor's call). */
  answer: Answer | null;
  /** Why there is no answer. */
  error?: string;
  /** The failure was the vendor's or the network's ("not now"), read from structured fields; not an attempt. */
  transport: boolean;
  /**
   * The answer stopped at this typist's output limit (the vendor's own stop reason: Gemini
   * finishReason MAX_TOKENS, Anthropic stop_reason max_tokens). The executor then sends the file to a
   * typist with a larger limit instead of retrying this one (24 Sep; replaces the spec's line cap).
   */
  cut_off?: boolean;
  /** A retry delay the vendor asked for, when it gave one. */
  retry_after_ms?: number;
  /** The vendor's HTTP status for a refused call, when it reported one (the executor stops a stage on 401/403). */
  error_status?: number;
  tokens: TypistTokens;
  cost_usd: number;
  price_basis?: string;
  latency_ms: number;
}

export interface TypeRequest {
  /** The job's own id and path (a spec unit's, or a fix's). */
  unit: { id: string; path: string };
  /** The job as a packet: instruction, inputs, answer schema. The completion door sends it as is. */
  packet: TaskPacket;
  /** The same packet framed exactly as the completion door frames it (lean-opus and agy send this text). */
  framed: string;
  /** The shared block, and a file holding it (lean-opus and agy read it from disk). */
  shared: string;
  sharedFile: string;
  contract: Contract;
  passId: string;
}

export interface Typist {
  door: Door;
  modelId: string;
  modelName: string;
  type(req: TypeRequest): Promise<TypistResult>;
}

const ZERO: TypistTokens = { input: 0, input_cached: 0, output: 0 };

// ─── failures, from structured fields ───────────────────────────────────

/**
 * HTTP statuses that mean "not now" rather than "wrong": 408 Request Timeout,
 * 429 Too Many Requests and the 5xx server errors of HTTP semantics (RFC 9110),
 * plus 529, Anthropic's documented "overloaded" status.
 */
export const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Node and undici error codes of a connection that failed in transit. */
export const TRANSIENT_NET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export function isTransient(status?: number | null, code?: string): boolean {
  return (typeof status === "number" && TRANSIENT_HTTP.has(status)) || (typeof code === "string" && TRANSIENT_NET.has(code));
}

/** A `claude -p` result that reports an error: its api_error_status decides; no status (a turn limit, a refusal) is an attempt. */
export function leanOpusOutcome(o: { is_error?: boolean; subtype?: string; api_error_status?: number | null; stop_reason?: string | null }): { transport: boolean; cut_off: boolean } {
  return { transport: !!o.is_error && isTransient(o.api_error_status), cut_off: o.stop_reason === "max_tokens" };
}

/** The completion door's last attempt: the status, network code and requested delay the adapter recorded. */
export function flashOutcome(a: (Pick<AttemptRecord, "error_status" | "error_code" | "retry_after_ms"> & { stop_reason?: string | null }) | undefined): { transport: boolean; retry_after_ms?: number; cut_off: boolean } {
  return { transport: isTransient(a?.error_status, a?.error_code), retry_after_ms: a?.retry_after_ms, cut_off: a?.stop_reason === "MAX_TOKENS" };
}

/**
 * The agent door: the SDK retries transient API errors itself, with the
 * executor's retry count and first wait (its ModelAPIRetryConfig, set in
 * agyWorkerArgs: 6 retries, 2 s doubling to 64 s, no jitter — the SDK does not
 * document its jitter setting's units, so none is guessed), and
 * the errors it raises carry no HTTP status, so an error that reaches the
 * receipt — after those waits — is an attempt: fail closed.
 */
export function agyOutcome(_receipt: { error?: string; error_type?: string }): { transport: boolean } {
  return { transport: false };
}

/**
 * The answer contract, read strictly: the whole reply is one JSON object. For
 * a file, string `path` and `content`. For a fix, string `path` and exactly one
 * of a non-empty `edits` list (each a non-empty `search` and a string
 * `replace`) or the whole file as `content`. No fence stripping, no repair.
 */
export function parseAnswer(raw: unknown, contract: Contract): Answer | null {
  let o: any = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (!o || typeof o !== "object" || typeof o.path !== "string") return null;
  if (contract === "file") {
    return typeof o.content === "string" && o.edits === undefined ? { path: o.path, content: o.content } : null;
  }
  const hasContent = typeof o.content === "string";
  const hasEdits = o.edits !== undefined;
  if (hasContent === hasEdits) return null;
  if (hasContent) return { path: o.path, content: o.content };
  if (!Array.isArray(o.edits) || !o.edits.length) return null;
  const edits: Edit[] = [];
  for (const e of o.edits) {
    if (!e || typeof e.search !== "string" || !e.search || typeof e.replace !== "string") return null;
    edits.push({ search: e.search, replace: e.replace });
  }
  return { path: o.path, edits };
}

// ─── child environments, from allowlists ────────────────────────────────

/** Who is logged in and the process basics: step 2's list, plus TMPDIR (the per-user temp directory on macOS) and the locale. */
const CHILD_BASE = ["HOME", "PATH", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];
/** Network routing only: proxies and extra CA certificates. They change where bytes go, never what a model does. */
const CHILD_NETWORK = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
/** The lean Opus child: plus CLAUDE_CONFIG_DIR, which says where the Claude login lives when it is not under HOME. */
export const LEAN_OPUS_ENV_ALLOW = [...CHILD_BASE, ...CHILD_NETWORK, "CLAUDE_CONFIG_DIR"];
/**
 * The agent child: plus Google's credential locations, the quota project, the
 * Python TLS roots, and the macOS library path the worker's Python may need
 * for pyexpat (the same reason the agent door passes it).
 */
export const AGY_ENV_ALLOW = [...CHILD_BASE, ...CHILD_NETWORK, "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "GOOGLE_CLOUD_QUOTA_PROJECT", "REQUESTS_CA_BUNDLE", "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"];

function pick(base: Record<string, string | undefined>, names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of names) if (base[k] !== undefined) env[k] = base[k]!;
  return env;
}

/**
 * The lean Opus typist's environment. Under --auth=estimated the run is on the
 * Claude subscription, so ANTHROPIC_API_KEY is left out: a `claude -p` that
 * sees the key uses it and bills the API (proved in the task folder,
 * probes/p10, with a fake key: 401). Under --auth=vendor the key is passed —
 * that run bills the API on purpose. The five-minute cache lifetime is set
 * explicitly: a stage's typist calls run back to back, so the shared block is
 * re-read within five minutes, and a five-minute write costs 1.25× input where
 * a one-hour write costs 2×. Auto-update is off so every typist call of a run
 * uses one CLI version.
 */
export function leanOpusEnv(base: Record<string, string | undefined>, authMode: "estimated" | "vendor"): Record<string, string> {
  const env = pick(base, LEAN_OPUS_ENV_ALLOW);
  if (authMode === "vendor" && base.ANTHROPIC_API_KEY !== undefined) env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = "5m";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/**
 * The agent typist's environment: the allowlist, the Vertex project and region
 * pinned (the SDK is Vertex-only here, so no API key is passed that could route
 * it elsewhere), and unbuffered output so a killed worker's last line survives.
 */
export function agyEnv(base: Record<string, string | undefined>, project: string, location: string): Record<string, string> {
  return { ...pick(base, AGY_ENV_ALLOW), GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, PYTHONUNBUFFERED: "1" };
}

// ─── lean-opus ──────────────────────────────────────────────────────────

/**
 * The typist's command line. Fails closed when the installed CLI lacks a flag
 * the lean route depends on (no tools, the system-prompt file, effort); the
 * isolation flags are added whenever the CLI lists them.
 */
export function leanOpusArgs(model: string, effort: string, sharedFile: string, helpText: string): string[] {
  const lists = (flag: string) => cliLists(helpText, flag);
  for (const needed of ["--tools", "--append-system-prompt-file", "--effort"]) {
    if (!lists(needed)) throw new Error(`this claude CLI lists no ${needed} flag, so the lean Opus typist cannot run; nothing was sent`);
  }
  const args = ["-p", "--model", model, "--output-format", "json", "--tools", ""];
  // --no-session-persistence: the typist's receipt (the JSON result) carries its
  // usage, so no transcript is needed; writing none keeps a transcript folder
  // per call off disk and keeps typist sessions out of anything that scans
  // ~/.claude/projects (the collector reads only the project's own folder).
  for (const f of ["--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) if (lists(f)) args.push(f);
  args.push("--effort", effort, "--append-system-prompt-file", sharedFile);
  return args;
}

/**
 * Whether the CLI's help text offers `flag`: as its own option, or folded into
 * a sibling's as `--name[-file]` — Claude Code 2.1.280 lists
 * --append-system-prompt-file only that way (inside --bare's description),
 * and the flag works (it carried the shared block in the step-2 measurement).
 */
export function cliLists(helpText: string, flag: string): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  if (new RegExp(`(^|\\s)${esc(flag)}(\\s|,|$)`, "m").test(helpText)) return true;
  const m = flag.match(/^(--.+)-file$/);
  return !!m && helpText.includes(`${m[1]}[-file]`);
}

let cliHelp: string | undefined;
function claudeHelp(): string {
  cliHelp ??= execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 30_000 });
  return cliHelp;
}

/** Runs a child in its own process group and kills the whole group on timeout, so nothing is left billing. */
function runChild(cmd: string, args: string[], opts: { env: Record<string, string>; cwd: string; input: string; timeoutMs: number }): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { err += String(e); });
    // A child that exits before reading all of its input (a brief over the
    // pipe's 64 KB buffer) makes the write fail with EPIPE; without a
    // listener that error would take the whole MCP server down. It is part of
    // this child's failure, which the caller reports as a failed attempt.
    child.stdin.on("error", (e) => { err += String(e); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, err, timedOut }); });
    child.stdin.end(opts.input);
  });
}

export class LeanOpusTypist implements Typist {
  readonly door = "lean-opus" as const;
  readonly modelId: string;
  readonly modelName: string;
  constructor(private readonly leaf: ModelConfig, private readonly opts: { authMode: "estimated" | "vendor"; effort: string; timeoutMs: number; env?: Record<string, string | undefined>; help?: string }) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    // Fail at construction, before any job is sent, when this CLI cannot run the lean route.
    leanOpusArgs(leaf.model_name, opts.effort, "/dev/null", opts.help ?? claudeHelp());
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    const started = Date.now();
    const args = leanOpusArgs(this.leaf.model_name, this.opts.effort, req.sharedFile, this.opts.help ?? claudeHelp());
    // A scratch working directory: the typist has no tools, and safe mode keeps
    // any project CLAUDE.md out, but an empty cwd makes that independent of flags.
    const cwd = mkdtempSync(join(tmpdir(), "mmo-typist-"));
    const r = await runChild("claude", args, { env: leanOpusEnv(this.opts.env ?? process.env, this.opts.authMode), cwd, input: req.framed, timeoutMs: this.opts.timeoutMs });
    const latency = Date.now() - started;
    let o: any;
    try { o = JSON.parse(r.out); } catch {
      // No receipt: a killed or crashed child. Its tokens are unknown (the CLI
      // writes its receipt only at the end), so the call is billed $0 and says
      // so; it is an attempt, never a wait — a timeout is not proof the vendor
      // is busy, and retrying it for free could repeat a long call many times.
      const why = r.timedOut
        ? `the lean Opus typist did not answer within ${Math.round(this.opts.timeoutMs / 1000)} s (killed; its usage is unknown)`
        : `no JSON receipt from claude -p (usage unknown): ${(r.err || r.out).slice(0, 300)}`;
      return { answer: null, error: why, transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    const ledger = priceClaudeCliResult(o, { config: this.leaf, date: new Date(started), transcript: null });
    const tokens: TypistTokens = { input: ledger.tokens.input, input_cached: ledger.tokens.input_cached, output: ledger.tokens.output, input_cache_write: ledger.tokens.input_cache_write, input_cache_write_1h: ledger.tokens.input_cache_write_1h, output_reasoning: o.usage?.output_tokens_details?.thinking_tokens };
    if (o.is_error) {
      const text = `${o.subtype ?? "error"}${o.api_error_status ? ` (HTTP ${o.api_error_status})` : ""}: ${String(o.result ?? r.err)}`;
      return { answer: null, error: text.slice(0, 300), transport: leanOpusOutcome(o).transport, ...(leanOpusOutcome(o).cut_off ? { cut_off: true } : {}), ...(typeof o.api_error_status === "number" ? { error_status: o.api_error_status } : {}), tokens, cost_usd: ledger.cost_usd, price_basis: ledger.price_basis, latency_ms: latency };
    }
    const answer = parseAnswer(o.result, req.contract);
    return { answer, error: answer ? undefined : `the reply was not one JSON object in the ${req.contract === "file" ? "{path, content}" : "{path, edits} or {path, content}"} contract`, transport: false, ...(!answer && leanOpusOutcome(o).cut_off ? { cut_off: true } : {}), tokens, cost_usd: ledger.cost_usd, price_basis: ledger.price_basis, latency_ms: latency };
  }
}

// ─── flash-completion ───────────────────────────────────────────────────

export class FlashCompletionTypist implements Typist {
  readonly door = "flash-completion" as const;
  readonly modelId: string;
  readonly modelName: string;
  private readonly adapter: GeminiFlashAdapter;
  private headerSet = "";
  /** The time limit on each request (the SDK's own httpOptions.timeout); a request past it fails and is an attempt. */
  readonly requestTimeoutMs?: number;
  constructor(private readonly leaf: ModelConfig, effort: string, requestTimeoutMs?: number) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    this.requestTimeoutMs = requestTimeoutMs;
    this.adapter = new GeminiFlashAdapter({ ...leaf, reasoning: { ...(leaf as any).reasoning, tier: effort } } as ModelConfig, { requestTimeoutMs });
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    if (this.headerSet !== req.shared) { this.adapter.inlineHeader(req.shared); this.headerSet = req.shared; }
    const started = Date.now();
    const maxOut = this.leaf.max_output_tokens_absolute ?? 8192;
    const r = await this.adapter.execute({ ...req.packet, budget: { ...req.packet.budget, maxOutputTokens: maxOut } });
    const tokens: TypistTokens = { input: r.tokens?.input ?? 0, input_cached: r.tokens?.input_cached ?? 0, output: r.tokens?.output ?? 0, output_reasoning: (r.tokens as any)?.output_reasoning };
    const last = r.attempts?.[r.attempts.length - 1];
    if (!r.success) {
      const text = String(r.error ?? last?.error ?? r.terminal_reason ?? "the completion door failed");
      const o = flashOutcome(last);
      return { answer: null, error: text.slice(0, 300), transport: o.transport, retry_after_ms: o.retry_after_ms, ...(o.cut_off ? { cut_off: true } : {}), ...(last?.error_status !== undefined ? { error_status: last.error_status } : {}), tokens, cost_usd: r.cost_usd ?? 0, price_basis: last?.price_basis, latency_ms: Date.now() - started };
    }
    const answer = parseAnswer(r.result, req.contract);
    return { answer, error: answer ? undefined : `the reply was not an object in the ${req.contract === "file" ? "{path, content}" : "{path, edits} or {path, content}"} contract`, transport: false, tokens, cost_usd: r.cost_usd ?? 0, price_basis: last?.price_basis, latency_ms: Date.now() - started };
  }
}

// ─── agy ────────────────────────────────────────────────────────────────

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker");
export const TYPIST_WORKER = join(WORKER_DIR, "typist_worker.py");

/**
 * The agent typist's command line: step 2's agy-best setup, with the job's
 * answer schema, and the executor's wait rule for rate limits handed to the
 * SDK's own API retry (its errors carry no HTTP status, so the executor cannot
 * wait them out itself; left unset, the SDK applies unstated defaults and a
 * rate limit surfaced as a failed attempt in step 8).
 */
export function agyWorkerArgs(i: { briefFile: string; sharedFile: string; schemaFile: string; model: string; region: string; workdir: string; receiptFile: string; thinking: string; maxModelCalls: number; timeoutSec: number; apiRetries: number; apiRetryInitialMs: number }): string[] {
  return [TYPIST_WORKER, "--brief-file", i.briefFile, "--system-file", i.sharedFile, "--answer-schema-file", i.schemaFile, "--model", i.model, "--region", i.region,
    "--workdir", i.workdir, "--out", i.receiptFile, "--thinking", i.thinking.toUpperCase(), "--max-model-calls", String(i.maxModelCalls), "--timeout", String(i.timeoutSec),
    "--api-retries", String(i.apiRetries), "--api-retry-initial-ms", String(i.apiRetryInitialMs)];
}

export class AgyTypist implements Typist {
  readonly door = "agy" as const;
  readonly modelId: string;
  readonly modelName: string;
  private readonly agent: AntigravityWorkerAdapter;
  constructor(private readonly leaf: ModelConfig, private readonly opts: { effort: string; maxModelCalls: number; timeoutSec: number; apiRetries: number; apiRetryInitialMs: number }) {
    this.modelId = leaf.id;
    this.modelName = leaf.model_name;
    // The product's agent-door adapter resolves the Vertex project, the region,
    // the worker's Python and the price exactly as the agent door does; the
    // typist reuses all four, so its bill is computed the same way.
    this.agent = new AntigravityWorkerAdapter(leaf);
  }
  async type(req: TypeRequest): Promise<TypistResult> {
    const started = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), "mmo-agy-typist-"));
    const briefFile = join(scratch, "brief.md"), receiptFile = join(scratch, "receipt.json"), schemaFile = join(scratch, "answer-schema.json");
    writeFileSync(briefFile, req.framed);
    writeFileSync(schemaFile, JSON.stringify(req.packet.outputSchema));
    const args = agyWorkerArgs({ briefFile, sharedFile: req.sharedFile, schemaFile, model: this.leaf.model_name, region: this.agent.location, workdir: scratch, receiptFile, thinking: this.opts.effort, maxModelCalls: this.opts.maxModelCalls, timeoutSec: this.opts.timeoutSec, apiRetries: this.opts.apiRetries, apiRetryInitialMs: this.opts.apiRetryInitialMs });
    // The worker enforces its own time limit and still writes its receipt; the
    // extra 30 s is the process-group kill for a worker that hangs past it.
    const r = await runChild(this.agent.python, args, { env: agyEnv(process.env, this.agent.project, this.agent.location), cwd: scratch, input: "", timeoutMs: (this.opts.timeoutSec + 30) * 1000 });
    const latency = Date.now() - started;
    if (!existsSync(receiptFile)) {
      const why = r.timedOut ? `the agent typist did not finish within ${this.opts.timeoutSec + 30} s (killed; its usage is unknown)` : `the agent typist wrote no receipt (usage unknown): ${r.err.slice(-300)}`;
      return { answer: null, error: why, transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    let receipt: any;
    try { receipt = JSON.parse(readFileSync(receiptFile, "utf8")); } catch (e: any) {
      // A receipt cut short (a worker killed mid-write) is a failed attempt whose usage is unknown, never a thrown error.
      return { answer: null, error: `the agent typist left an unreadable receipt (usage unknown): ${e?.message ?? e}`.slice(0, 300), transport: false, tokens: ZERO, cost_usd: 0, latency_ms: latency };
    }
    // The worker records the session's cumulative usage even when the session
    // failed or timed out, so a failed call is billed for what it spent.
    const tokens = receipt.usage ? mapSidecarTokens({ sdk_version: receipt.sdk_version, usage: receipt.usage }) : ZERO;
    const price = this.agent.pricingOn(new Date(started));
    const cost = price.unpriced ? 0 : computeCostUsd(tokens, price.billed);
    const basis = price.unpriced ? undefined : price.basis;
    if (receipt.error && !receipt.finish_output) {
      const text = String(receipt.error);
      return { answer: null, error: text.slice(0, 300), transport: agyOutcome(receipt).transport, tokens, cost_usd: cost, price_basis: basis, latency_ms: latency };
    }
    const answer = parseAnswer(receipt.finish_output, req.contract);
    return { answer, error: answer ? undefined : `the agent did not finish with one object in the ${req.contract === "file" ? "{path, content}" : "{path, edits} or {path, content}"} contract`, transport: false, tokens, cost_usd: cost, price_basis: basis, latency_ms: latency };
  }
}
