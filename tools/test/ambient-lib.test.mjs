/**
 * Unit tests for the ambient-mode libraries under plugin/scripts/ambient/lib:
 * settings layering, the cost rule, the outline builder, prompt labels, the
 * command reader and the realised-savings ledger. Pure functions, no network.
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LIB = join(ROOT, "plugin", "scripts", "ambient", "lib");
const { loadConfig, applyTightenOnly, sha256 } = await import(join(LIB, "config.mjs"));
// The price-list comparison needs the built dispatch server; see tools/test/lib/server-built.mjs.
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { netValueUsd, decide, posteriorMean, pricesFor, handoverNet } = await import(join(LIB, "cost-rule.mjs"));
const { buildOutline, coverage, findDeclarations } = await import(join(LIB, "outline.mjs"));
const { labelPrompt, loadRules, isPipelineCommand, wantsFullOutput, LABEL_WINDOW_CHARS } = await import(join(LIB, "labels.mjs"));
const { parseFileDump, rangeLineCount, classifyRunner, tokenize } = await import(join(LIB, "shell-parse.mjs"));
const { summarise } = await import(join(LIB, "ledger.mjs"));
const { parseEvents } = await import(join(LIB, "events.mjs"));
const { lastTurnFacts } = await import(join(LIB, "transcript.mjs"));

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-ambient-lib-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------- settings ----------

test("the shipped default is mode off, names the fixed lineup and leaves the model picker free", () => {
  const t = tmp();
  try {
    const { config, sources } = loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } });
    assert.equal(config.mode, "off");
    assert.equal(config.thinker, "claude-opus-5");
    assert.deepEqual(config.workers, { flash: "gemini-3.8-flash", sonnet: "claude-sonnet-5", default: "flash" });
    // Off since 26 Sep (option 3): the lock existed to keep the chat on the thinker so the savings rules could act;
    // they now act on whatever model the person picks, priced at that model, so nothing needs the lock by default.
    assert.equal(config.lock_model, false);
    // 0 since 26 Sep: a control-arm chat gets no zero-touch at all, so a non-zero default would silently switch the
    // feature off for that share of real users. Measuring is opt-in: a settings file sets control.share itself.
    assert.equal(config.control.share, 0);
    assert.deepEqual(sources, ["defaults"]);
  } finally { t.cleanup(); }
});

test("a missing control share means no control arm; a set share still draws, clamped to 0..1", async () => {
  const { drawArm } = await import(join(LIB, "arm.mjs"));
  const t = tmp();
  try {
    const env = { MMO_HOME: t.dir };
    // No share at all (a settings file without "control"): every chat is "on", the same as the shipped 0.
    const none = drawArm("s-none", undefined, env, () => 0);
    assert.equal(none.arm, "on");
    assert.equal(none.control_share, 0);
    // A measuring team's share still draws: a roll under the share lands in control, over it stays on.
    assert.equal(drawArm("s-half-low", 0.5, env, () => 0.2).arm, "control");
    assert.equal(drawArm("s-half-high", 0.5, env, () => 0.7).arm, "on");
    assert.equal(drawArm("s-over", 7, env, () => 0.99).control_share, 1);
  } finally { t.cleanup(); }
});

test("an unverified project file can only tighten; with a user-level receipt it applies in full", () => {
  const t = tmp();
  try {
    const home = join(t.dir, "home");
    const repo = join(t.dir, "repo");
    mkdirSync(home);
    mkdirSync(join(repo, ".sdlc"), { recursive: true });
    // The developer's own file switches the cat/sed rule off and locks the model (off by default since 26 Sep);
    // the repository's file tries to switch the rule back on and the lock off.
    writeFileSync(join(home, "ambient.json"), JSON.stringify({ mode: "observe", lock_model: true, valves: { file_dump: { act: false } } }));
    const hostile = JSON.stringify({
      mode: "on", lock_model: false, thinker: "attacker-model", cost_of_bad_result_usd: 0,
      cost: { margin_usd: -100 }, valves: { file_dump: { act: true }, read: { enabled: false } },
      closed_cells: ["bugfix|python|flash|completion"], never_delegate_paths: ["billing/**"],
    });
    writeFileSync(join(repo, ".sdlc", "ambient.json"), hostile);

    const loose = loadConfig({ projectDir: repo, env: { MMO_HOME: home } });
    assert.equal(loose.config.mode, "observe", "a repository cannot raise the mode");
    assert.equal(loose.config.lock_model, true, "a repository cannot unlock the model");
    assert.equal(loose.config.thinker, "claude-opus-5");
    assert.equal(loose.config.cost.margin_usd, 0.002);
    assert.equal(loose.config.cost_of_bad_result_usd, 9);
    assert.equal(loose.config.valves.file_dump.act, false, "a repository cannot switch a rule on that the developer switched off");
    assert.equal(loose.config.valves.read.enabled, false, "switching a valve off is a tightening and is honoured");
    assert.deepEqual(loose.config.closed_cells, ["bugfix|python|flash|completion"]);
    assert.deepEqual(loose.config.never_delegate_paths, ["billing/**"]);
    assert.ok(loose.sources.includes("project-tighten-only"));

    writeFileSync(join(home, "receipts.json"), JSON.stringify({ policies: [{ sha256: sha256(hostile) }] }));
    const verified = loadConfig({ projectDir: repo, env: { MMO_HOME: home } });
    assert.equal(verified.config.mode, "on");
    assert.ok(verified.sources.includes("project-verified"));

    writeFileSync(join(repo, ".sdlc", "ambient.json"), hostile + " ");
    assert.equal(loadConfig({ projectDir: repo, env: { MMO_HOME: home } }).config.mode, "observe", "one changed byte voids the receipt");
  } finally { t.cleanup(); }
});

test("tighten-only can lower the mode but a wrong value changes nothing", () => {
  const base = { mode: "on", lock_model: false, closed_cells: [], never_delegate_paths: [], valves: { read: { enabled: true } } };
  assert.equal(applyTightenOnly(base, { mode: "observe" }).mode, "observe");
  assert.equal(applyTightenOnly(base, { mode: "turbo" }).mode, "on");
  assert.equal(applyTightenOnly(base, { lock_model: true }).lock_model, true);
  assert.equal(applyTightenOnly(base, { valves: { read: { enabled: true, min_chars: 1 } } }).valves.read.min_chars, undefined);
});

test("unreadable, oversized or wrongly typed settings fall back instead of throwing", () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, "ambient.json"), "{ not json");
    assert.equal(loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } }).config.mode, "off");
    writeFileSync(join(t.dir, "ambient.json"), JSON.stringify({ mode: 7, valves: "all", cost: { n_hat: "many" } }));
    const { config } = loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir } });
    assert.equal(config.mode, "off");
    assert.equal(config.cost.n_hat, 23);
    assert.equal(typeof config.valves, "object");
    assert.equal(loadConfig({ projectDir: t.dir, env: { MMO_HOME: t.dir, MMO_AMBIENT: "observe" } }).config.mode, "observe");
  } finally { t.cleanup(); }
});

// ---------- cost rule ----------

test("with no ranged follow-ups the rule is exactly the design's inequality", () => {
  const x = { F: 20000, K: 1500, C: 180000, w: 10e-6, r: 0.5e-6, N: 23, p: 0.18, L: 0.004 };
  const held = x.w + x.r * x.N;
  const design = (1 - x.p) * (x.F - x.K) * held - x.p * (x.C * x.r + x.K * held + x.L);
  assert.ok(Math.abs(netValueUsd({ ...x, q: 0, R: 0 }) - design) < 1e-12);
});

test("the same file pays in a small context and does not pay in a very large one", () => {
  const file = { F: 3000, K: 600, R: 750, w: 10e-6, r: 0.5e-6, N: 23, p: 0.2, q: 0.5, L: 0 };
  assert.equal(decide({ ...file, C: 30000 }, 0.002).act, true);
  assert.equal(decide({ ...file, C: 600000 }, 0.002).act, false, "an extra request in a 600k context costs more than the file");
});

test("a repo where outlines keep being undone stops getting them", () => {
  const file = { F: 8000, K: 900, R: 2000, C: 150000, w: 10e-6, r: 0.5e-6, N: 23, L: 0 };
  const fresh = { p: posteriorMean(0, 0, 1, 5), q: posteriorMean(0, 0, 2, 4) };
  const burnt = { p: posteriorMean(18, 20, 1, 5), q: posteriorMean(2, 20, 2, 4) };
  assert.equal(decide({ ...file, ...fresh }, 0.002).act, true);
  assert.equal(decide({ ...file, ...burnt }, 0.002).act, false);
});

test("the rule refuses to act on missing numbers or when nothing would be saved", () => {
  const ok = { F: 8000, K: 900, R: 2000, C: 1000, w: 1e-5, r: 5e-7, N: 23, p: 0.1, q: 0.1, L: 0 };
  assert.equal(decide({ ...ok, C: NaN }).reason, "missing-input");
  assert.equal(decide({ ...ok, K: 9000 }).reason, "nothing-to-save");
});

test("the sum is worker write against thinker write: the break-even is about 800 characters with Flash at ANY chat size, and only a job past the wait adds a request", () => {
  // Official price cards: Opus 5 output 25, input 5, cache read 0.50; Flash 3.8 input 0.75, output 3.75 ($ per million tokens).
  // Until 23 Sep the rule charged every hand-over extra requests that re-read the chat; a hand-over is now one call, like
  // the thinker's own write, so the round trip cancels and only the typing price and the spec are left.
  const prices = { out: 25e-6, in: 5e-6, r: 0.5e-6 };
  const worker = { in: 0.75e-6, out: 3.75e-6 };
  const fix = handoverNet({ chars: 2700, C: 120000, prices, worker });
  assert.ok(fix.net > 0, `a typical 2,700-character fix pays even in a 120k chat: ${fix.net.toFixed(4)}`);
  const small = handoverNet({ chars: 0, C: 20000, prices, worker }).breakEvenChars;
  const large = handoverNet({ chars: 0, C: 120000, prices, worker }).breakEvenChars;
  assert.equal(small, large, "the chat's size is no longer in the sum");
  assert.ok(small > 600 && small < 1000, `break-even with Flash: ${small}`);
  const sonnet = handoverNet({ chars: 0, C: 20000, prices, worker: { in: 2e-6, out: 10e-6 } }).breakEvenChars;
  assert.ok(sonnet > 1500 && sonnet < 2500, `break-even with Sonnet: ${sonnet}`);
  assert.ok(handoverNet({ chars: 300, C: 20000, prices, worker }).net < 0, "a 300-character edit is cheaper by hand: the spec would cost more");
  assert.ok(handoverNet({ chars: small + 1, C: 20000, prices, worker }).net > 0 && handoverNet({ chars: small - 1, C: 20000, prices, worker }).net < 0, "the break-even is where the net crosses zero");
  const late = handoverNet({ chars: 0, C: 120000, prices, worker, extraRequests: 1 }).breakEvenChars;
  assert.ok(late > large, "a job past the wait adds one collect call that re-reads the chat, and that raises the break-even");
  assert.equal(handoverNet({ chars: 5000, C: 20000, prices: null, worker }).net, null, "no price card, no verdict");
});

test("the cache price follows the login: one-hour writes on a subscription, five-minute on a metered route", () => {
  const { config } = loadConfig({ env: { MMO_HOME: "/nonexistent" } });
  assert.equal(pricesFor(config, "claude-opus-5", {}).w, 10 / 1e6);
  assert.equal(pricesFor(config, "claude-opus-5", { CLAUDE_CODE_USE_VERTEX: "1" }).w, 6.25 / 1e6);
  // Until 26 Sep an unknown model was priced as the thinker (Opus 5), so on Opus 5.5, Fable or Sonnet 4.6 every
  // decision used the wrong prices. A model with no card is now not priced at all: no decision on a guessed price.
  assert.equal(pricesFor(config, "some-unknown-model", {}), null, "a model with no price card is never priced as another model");
});

test("every Claude model the picker offers has its own price card, and the names the transcript uses resolve to it", () => {
  const { config } = loadConfig({ env: { MMO_HOME: "/nonexistent" } });
  // platform.claude.com/docs/en/about-claude/pricing, read 26 Sep 2026: input / 5m write / 1h write / cache read / output.
  const opus55 = pricesFor(config, "claude-opus-5-5", {});
  assert.deepEqual([opus55.in, opus55.w, opus55.r, opus55.out].map((x) => +(x * 1e6).toFixed(4)), [4, 8, 0.2, 20], "Opus 5.5 at its own prices (1h write on a subscription)");
  assert.equal(pricesFor(config, "claude-fable-5-1", {}).r, 0.25 / 1e6, "Fable 5.1 reads its cache at 0.025x input");
  assert.equal(pricesFor(config, "claude-sonnet-4-6", {}).out, 15 / 1e6);
  assert.equal(pricesFor(config, "claude-opus-5-5[1m]", {}).out, 20 / 1e6, "a 1M-context tag is the same model");
  assert.equal(pricesFor(config, "claude-haiku-4-5-20251001", {}).out, 5 / 1e6, "a dated id is the same model");
  for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5", "claude-fable-5-1"]) {
    assert.ok(pricesFor(config, m, {}), `${m} has a card`);
  }
});

test("the savings maths uses the same prices as the dispatch server's dated list for every model both know", { skip: serverBuilt() ?? false }, async () => {
  const { PRICE_LIST } = await import(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "prices.js"));
  const { config } = loadConfig({ env: { MMO_HOME: "/nonexistent" } });
  const table = config.cost.prices_usd_per_mtok;
  const onlyHere = [];
  for (const [model, card] of Object.entries(table)) {
    const periods = PRICE_LIST[model];
    if (!periods) { onlyHere.push(model); continue; }
    const now = periods[periods.length - 1];
    assert.deepEqual(
      [card.input, card.cache_write_5m, card.cache_write_1h, card.cache_read, card.output],
      [now.input, now.input_cache_write, now.input_cache_write_1h, now.input_cached, now.output],
      `${model} matches the server's list`,
    );
  }
  // Every model the savings maths prices is on the server's list too (Opus 5.5 was added there on 26 Sep).
  assert.deepEqual(onlyHere, []);
});

// ---------- outline ----------

test("the outline finds declarations across the supported languages", () => {
  const cases = {
    "a.py": ["class Billing:", "    def charge(self, amount, note='x'):", "        pass", "async def main():", "    pass"],
    "a.go": ["func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {", "}", "type Server struct {", "}"],
    "a.ts": ["export class Store {", "  async load(id: string): Promise<Item> {", "  }", "}", "export const pick = (a, b) => a", "interface Item { id: string }"],
    "a.rs": ["pub fn run(cfg: &Config) -> Result<()> {", "}", "impl Config {", "}"],
    "a.md": ["# Title", "text", "```", "# not a heading", "```", "## Part"],
  };
  const want = {
    "a.py": ["class Billing", "fn charge(self, amount, note=\"\")", "fn main()"],
    "a.go": ["fn Handle(w http.ResponseWriter, r *http.Request)", "type Server"],
    "a.ts": ["class Store", "fn load(id: string)", "fn pick", "interface Item"],
    "a.rs": ["fn run(cfg: &Config)", "impl Config"],
    "a.md": ["section # Title", "section ## Part"].map((s) => s.replace("section ", "")),
  };
  for (const [name, lines] of Object.entries(cases)) {
    const got = findDeclarations(lines.join("\n"), name).decls.map((d) => d.text);
    assert.deepEqual(got, want[name], name);
  }
  assert.equal(findDeclarations("a,b\n1,2", "rows.csv"), null, "an unknown language has no outline");
});

test("nested declarations end where the next sibling starts", () => {
  const src = ["class A:", "    def one(self):", "        pass", "    def two(self):", "        pass", "class B:", "    pass"].join("\n");
  const d = findDeclarations(src, "x.py").decls;
  assert.deepEqual(d.map((x) => [x.start, x.end]), [[1, 5], [2, 3], [4, 5], [6, 7]]);
});

test("coverage fails a file with a long stretch the outline cannot describe", () => {
  assert.equal(coverage([{ start: 1 }, { start: 150 }], 300), 1);
  assert.ok(coverage([{ start: 1 }], 5000) < 0.1);
  const table = ["export function head() {}", ...Array.from({ length: 3000 }, (_, i) => `  [${i}, ${i * 2}],`)].join("\n");
  assert.equal(buildOutline(table, "table.js"), null, "one function above a 3000-line data table is not a fair map");
});

test("an outline over budget is refused so the read passes through", () => {
  const many = Array.from({ length: 900 }, (_, i) => `export function someRatherLongFunctionName${i}(alpha, beta, gamma) {}`).join("\n");
  assert.equal(buildOutline(many, "big.js", { budgetChars: 9000 }), null);
  assert.ok(buildOutline(many, "big.js", { budgetChars: 90000 }));
});

// ---------- labels ----------

test("labels: first match wins, only the first 4 KB is read, unknown prompts are other", () => {
  assert.equal(labelPrompt("pls fix teh crash when saving").label, "bugfix");
  assert.equal(labelPrompt("add unit tests for the date helpers").label, "test");
  assert.equal(labelPrompt("rename getUser to fetchUser everywhere").label, "refactor");
  assert.equal(labelPrompt("where is the retry logic").label, "lookup");
  assert.equal(labelPrompt("max verstappen or pedro acosta").label, "other");
  assert.equal(labelPrompt("x".repeat(LABEL_WINDOW_CHARS + 10) + " fix the bug").label, "other");
  assert.equal(labelPrompt("continue", "refactor").inherited, true);
  assert.equal(labelPrompt("continue the refactor but also fix the crash in the parser module", "docs").label, "refactor", "when both fit, the refactor pattern is checked first");
  assert.equal(isPipelineCommand("  /mmo:bugfix the date parser"), true);
  assert.equal(isPipelineCommand("what does /mmo:bugfix do"), false);
  assert.equal(wantsFullOutput("show me the whole file"), true);
});

test("every label pattern stays fast on hostile input", () => {
  const hostile = [" ".repeat(4096), "a".repeat(4096), "fix ".repeat(1024), "(".repeat(4096), "where is ".repeat(455)];
  for (const rule of loadRules().rules) {
    for (const text of hostile) {
      const t0 = performance.now();
      rule.re.test(text);
      assert.ok(performance.now() - t0 < 25, `label rule ${rule.id} is slow on hostile input`);
    }
  }
});

// ---------- command reader ----------

test("file-dump reader accepts only the plain single-file shapes", () => {
  assert.deepEqual(parseFileDump("cat src/app.ts"), { tool: "cat", file: "src/app.ts", range: "all" });
  assert.deepEqual(parseFileDump("cat -n 'my file.ts'"), { tool: "cat", file: "my file.ts", range: "all" });
  assert.deepEqual(parseFileDump("sed -n '10,400p' a.py"), { tool: "sed", file: "a.py", range: { from: 10, to: 400 } });
  assert.deepEqual(parseFileDump("sed -n '5,$p' a.py").range, { from: 5, to: Infinity });
  assert.deepEqual(parseFileDump("head -500 a.py").range, { from: 1, to: 500 });
  assert.deepEqual(parseFileDump("tail -n +20 a.py").range, { from: 20, to: Infinity });
  assert.deepEqual(parseFileDump("tail -n 30 a.py").range, { lastLines: 30 });
  assert.equal(parseFileDump("awk '{print $1}' a.py").range, "unknown");
  for (const no of [
    "cat a b", "cat a | wc -l", "cat a > b", "cat $(ls)", "cat `x`", "cat a; rm b", "cat a && echo", "tail -f log",
    "sed -i 's/a/b/' f", "sed 's/a/b/' f", "sed -n '/x/p' f", "head -c 100 f", "cat 'unclosed", "cat a\\ b", "ls", "cat",
  ]) assert.equal(parseFileDump(no), null, no);
  assert.equal(rangeLineCount({ from: 10, to: Infinity }, 100), 91);
  assert.equal(rangeLineCount({ lastLines: 500 }, 100), 100);
  assert.equal(rangeLineCount("unknown", 100), null);
  assert.deepEqual(tokenize("a 'b c' \"d\" ''"), ["a", "b c", "d", ""]);
});

test("runner reader recognises test, build and install commands and nothing piped", () => {
  assert.equal(classifyRunner("npm test"), "test");
  assert.equal(classifyRunner("cd apps/api && pnpm run test 2>&1"), "test");
  assert.equal(classifyRunner("python -m pytest -q tests/"), "test");
  assert.equal(classifyRunner("go test ./..."), "test");
  assert.equal(classifyRunner("npx tsc --noEmit"), "build");
  assert.equal(classifyRunner("npm ci"), "install");
  for (const no of ["npm test | tail", "git status", "npm test; rm -rf x", "echo npm test", "cat package.json"]) {
    assert.equal(classifyRunner(no), null, no);
  }
});

// ---------- ledger ----------

test("the ledger prices an action by what really followed it, and a loss shows as a loss", () => {
  const w = 10e-6;
  const r = 0.5e-6;
  const at = (n) => `2026-09-22T10:00:${String(n).padStart(2, "0")}.000Z`;
  const events = [
    { ts: at(0), type: "session.start", arm: "on" },
    { ts: at(1), type: "valve.act", act_id: "a1", valve: "read", path: "/r/a.js", tokens_full: 20000, tokens_kept: 2000 },
    { ts: at(5), type: "valve.act", act_id: "a2", valve: "read", path: "/r/b.js", tokens_full: 6000, tokens_kept: 1500 },
    { ts: at(6), type: "valve.regret", act_id: "a2", valve: "read", kind: "full", tokens: 6000, context_tokens: 400000 },
  ];
  const requestTimes = [at(2), at(3), at(4), at(7), at(8)];
  const out = summarise(events, { w, r, requestTimes });
  const a1 = 18000 * (w + r * 5);
  const a2 = 4500 * (w + r * 2) - (6000 * (w + r * 2) + 400000 * r);
  assert.ok(Math.abs(out.entries[0].saved_usd - a1) < 1e-12);
  assert.ok(Math.abs(out.entries[1].saved_usd - a2) < 1e-12);
  assert.ok(out.entries[1].saved_usd < 0, "a full re-read in a large context is a loss and is reported as one");
  assert.ok(Math.abs(out.saved_usd - (a1 + a2)) < 1e-12);
  assert.equal(out.requests_source, "transcript");
});

test("requests after a context reset do not count, and excluded sessions report zero", () => {
  const w = 10e-6;
  const r = 0.5e-6;
  const base = [
    { ts: "2026-09-22T10:00:00.000Z", type: "session.start", arm: "on" },
    { ts: "2026-09-22T10:00:01.000Z", type: "valve.act", act_id: "a1", valve: "read", tokens_full: 10000, tokens_kept: 1000 },
    { ts: "2026-09-22T10:00:05.000Z", type: "context.reset" },
  ];
  const requestTimes = ["2026-09-22T10:00:02.000Z", "2026-09-22T10:00:06.000Z", "2026-09-22T10:00:07.000Z"];
  assert.equal(summarise(base, { w, r, requestTimes }).entries[0].later_requests, 1);
  // Leaving the main model AFTER the action: the action happened on the main model and still counts.
  const leftLater = summarise([...base, { ts: "2026-09-22T10:00:09.000Z", type: "session.off_thinker" }], { w, r, requestTimes });
  assert.equal(leftLater.entries.length, 1);
  // An action on another model that cannot be priced (no model named, no price source) is left out, never
  // priced as the main model; the chat itself still counts (26 Sep: the rules act on any model).
  const off = summarise([base[0], { ts: "2026-09-22T10:00:00.500Z", type: "session.off_thinker" }, base[1], base[2]], { w, r, requestTimes });
  assert.equal(off.saved_usd, 0);
  assert.equal(off.entries.length, 0);
  assert.equal(off.left_out, 1);
  const control = summarise([{ ...base[0], arm: "control" }, base[1]], { w, r, requestTimes });
  assert.equal(control.saved_usd, 0);
});

// ---------- storage helpers ----------

test("a torn record never damages its neighbours", () => {
  const text = '\n{"ts":"t","type":"a"}\n\n{"ts":"t","type":"b","x":\n{"ts":"t","type":"c"}\n';
  assert.deepEqual(parseEvents(text).map((e) => e.type), ["a", "c"]);
});

test("context size and model come from the newest main-thread reply in the transcript tail", () => {
  const t = tmp();
  try {
    const file = join(t.dir, "t.jsonl");
    const line = (o) => JSON.stringify(o) + "\n";
    writeFileSync(file,
      line({ type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 2, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000 } } }) +
      line({ type: "user", message: {} }) +
      line({ type: "assistant", message: { model: "claude-opus-5[1m]", usage: { input_tokens: 4, cache_read_input_tokens: 120000, cache_creation_input_tokens: 3000 } } }) +
      line({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5", usage: { input_tokens: 9 } } }) +
      '{"type":"assistant","message":{"usage":{"input_tok');
    assert.deepEqual(lastTurnFacts(file), { contextTokens: 123004, model: "claude-opus-5" });
    assert.deepEqual(lastTurnFacts(join(t.dir, "missing.jsonl")), { contextTokens: null, model: null });
  } finally { t.cleanup(); }
});

test("the shipped settings and label files are valid and carry no secrets or addresses", () => {
  for (const name of ["ambient.default.json", "ambient-labels.json"]) {
    const text = readFileSync(join(ROOT, "plugin", "config", name), "utf8");
    assert.doesNotThrow(() => JSON.parse(text), name);
  }
});


test("a call whose argument spills onto later lines is not a declaration", () => {
  // Measured on 847 past sessions: 45 of the 162 outlines that pass their checks carry an
  // entry like "fn describeRoute(" (a call, not a definition), and 8 outlines are half or
  // more such entries: a map that names nothing. A declaration's parameter list closes on
  // its own line; a spilled call's does not.
  const src = ["const app = new Hono()", "  .get(", '    "/x",', "    describeRoute({", '      description: "x",', "    }),", "  );",
    "class View {", "  render({ items }) {", "    return items;", "  }", "}", "export function real(a, b) {", "  return a;", "}"].join("\n");
  const names = findDeclarations(src, "a.ts").decls.map((d) => d.text);
  assert.deepEqual(names, ["class View", "fn render({ items })", "fn real(a, b)"]);
});

test("labels: a prompt that starts by asking to build something is a feature even if it mentions tests; a consolidation is a refactor even if it mentions an exception", () => {
  // Both seen on the rehearsal: "Build a small inventory REST API ... unit tests with vitest" came out as
  // "test", and "every place that throws ... one shared helper ... returns that exception" as "bugfix".
  assert.equal(labelPrompt("Build a small inventory REST API in TypeScript with Express: create, list, get, update and delete items, in-memory storage, input validation, and unit tests with vitest.").label, "feature");
  assert.equal(labelPrompt("Create a CLI that prints the weather, with tests.").label, "feature");
  assert.equal(labelPrompt("add unit tests for the date helpers").label, "test", "asking for tests is still a test task");
  assert.equal(labelPrompt("In apps/api/src/task, every place that throws new HTTPException(404) should use one shared helper instead. Create not-found.ts exporting notFound(message) that returns that exception, then update every file to use it.").label, "refactor");
  assert.equal(labelPrompt("the parser throws an exception on empty input, please fix").label, "bugfix");
});

test("the ledger prices each saving at the model the chat was on when it was made; an unpriced model is left out", () => {
  const w = 10e-6, r = 0.5e-6;
  const fable = { w: 20e-6, r: 0.25e-6 };
  const at = (n) => `2026-09-22T10:00:${String(n).padStart(2, "0")}.000Z`;
  const events = [
    { ts: at(0), type: "session.start", arm: "on" },
    { ts: at(1), type: "session.off_thinker", model: "claude-fable-5-1" },
    { ts: at(2), type: "valve.act", act_id: "off", valve: "read", tokens_full: 9000, tokens_kept: 1000 },
    { ts: at(4), type: "model.back_on_thinker" },
    { ts: at(5), type: "valve.act", act_id: "on", valve: "read", tokens_full: 9000, tokens_kept: 1000 },
  ];
  const requestTimes = [at(3), at(6), at(7)];
  const priceOf = (m) => (m === "claude-fable-5-1" ? fable : null);
  const out = summarise(events, { w, r, requestTimes, priceOf });
  assert.equal(out.counted, true);
  assert.deepEqual(out.entries.map((e) => e.act_id), ["off", "on"], "the action on Fable counts too, since the rules now act there");
  const off = out.entries.find((e) => e.act_id === "off");
  assert.ok(Math.abs(off.saved_usd - 8000 * (fable.w + fable.r * 3)) < 1e-12, "priced at Fable's cache prices, not the main model's");
  assert.ok(Math.abs(out.entries.find((e) => e.act_id === "on").saved_usd - 8000 * (w + r * 2)) < 1e-12);
  const noPrices = summarise(events, { w, r, requestTimes });
  assert.deepEqual(noPrices.entries.map((e) => e.act_id), ["on"], "without a price for Fable its action is left out, never priced as the main model");
  assert.equal(noPrices.left_out, 1);
  const unknown = summarise(events, { w, r, requestTimes, priceOf: () => null });
  assert.equal(unknown.left_out, 1, "a model with no price card is left out");
});

test("a placeholder entry Claude Code writes for an interrupted turn is not a model", () => {
  // Seen live: an entry with model "<synthetic>" made the orchestrator believe the chat had left
  // the main model, and it stopped counting until the next real reply.
  const t = tmp();
  try {
    const file = join(t.dir, "t.jsonl");
    const line = (o) => JSON.stringify(o) + "\n";
    writeFileSync(file,
      line({ type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 2, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } } }) +
      line({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
    assert.deepEqual(lastTurnFacts(file), { contextTokens: 502, model: "claude-opus-5" });
  } finally { t.cleanup(); }
});

test("labels: the ordinary refactor verbs (split, move, extract, reorganise) name a refactor even when the prompt ends with 'run the tests'", () => {
  // Seen live on 22 Sep: "Split it: one file per route ... Run the API unit tests at the end." was labelled test.
  const split = "apps/api/src/task/index.ts holds 17 routes in one chain. Split it: one file per route under apps/api/src/task/routes/, each exporting a function that registers that route on a router. index.ts then only composes the routers. No behaviour change. Run the API unit tests at the end.";
  assert.equal(labelPrompt(split, null).label, "refactor");
  assert.equal(labelPrompt("Move the date helpers out of utils/index.ts into their own module and run the tests", null).label, "refactor");
  assert.equal(labelPrompt("Extract the validation into a schema file per controller; add unit tests for each", null).label, "refactor");
  assert.equal(labelPrompt("Reorganise the controllers folder by resource", null).label, "refactor");
  assert.equal(labelPrompt("Add unit tests for the date helpers", null).label, "test", "a request that is about tests stays a test");
  assert.equal(labelPrompt("split the bill three ways", null).label, "other", "the verb alone, with no code around it, is not a refactor");
});

test("a project file may switch cheaper-model jobs OFF (delegation: off) without a receipt; it can never switch them on", () => {
  const { config } = loadConfig({ env: { MMO_HOME: "/nonexistent" } });
  assert.equal(config.delegation, "on", "shipped default: jobs on wherever the mode is on");
  assert.equal(applyTightenOnly(config, { delegation: "off" }).delegation, "off", "off is a tightening");
  assert.equal(applyTightenOnly({ ...config, delegation: "off" }, { delegation: "on" }).delegation, "off", "on is not");
});

test("the worker probe answers with one line, and names a rate limit as one", async () => {
  const { probeWorker, PROBE_BRIEF } = await import(join(LIB, "probe.mjs"));
  assert.ok(PROBE_BRIEF.length < 60, "a probe that costs more than a fraction of a cent is not a probe");

  let seen = null;
  const ok = await probeWorker({ worker: "gemini-3.8-flash", callWorker: async (c) => { seen = c; return { text: "ready", model: "gemini-3.8-flash" }; } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(seen.worker, "gemini-3.8-flash", "the probe asks the worker a job would ask");
  assert.equal(seen.brief, PROBE_BRIEF);

  const limited = await probeWorker({ worker: "w", callWorker: async () => { throw Object.assign(new Error("429 Resource exhausted"), { rateLimited: true }); } });
  assert.equal(limited.ok, false);
  assert.equal(limited.rateLimited, true, "a quota failure is reported as one, not as a generic error");

  const mute = await probeWorker({ worker: "w", callWorker: async () => ({ text: "  " }) });
  assert.equal(mute.ok, false, "an empty answer is a failure: the call went through and the worker said nothing");

  const slow = await probeWorker({ worker: "w", timeoutMs: 40, callWorker: () => new Promise((r) => setTimeout(() => r({ text: "late" }), 5000).unref()) });
  assert.equal(slow.ok, false);
  assert.match(slow.detail, /no answer within/);

  const nodoor = await probeWorker({ worker: "w", callWorker: null });
  assert.equal(nodoor.ok, false);
  assert.match(nodoor.detail, /not built/, "a missing tool server is said plainly, not as a crash");
});

/**
 * 23 Sep, pair 10: every worker brief ended with the EDIT job's footer ("touch only
 * the files listed as changeable", "do not change tests, lockfiles or configuration").
 * A create job lists no changeable files and commissions configuration, so Flash
 * obeyed the footer and answered {"edits":[]} six times while Sonnet wrote the files.
 * The footer now says what the job actually is.
 */
test("a create job's brief asks for creates and never tells the worker to touch nothing", async () => {
  const { BUILDERS } = await import(join(LIB, "brief.mjs"));
  const specs = BUILDERS.write_files_from_specs({ design_file: "docs/DESIGN.md", specs: [
    { path: "package.json", exports: [], behaviour: "npm manifest for a NestJS project with jest and ts-jest, per DESIGN." },
    { path: "src/a.ts", exports: ["a"], behaviour: "Export a constant a equal to one, per DESIGN." },
  ] });
  const brief = specs.render([{ path: "docs/DESIGN.md", content: "# Design\n" }]);
  assert.match(brief, /"creates"/, "the create shape is shown");
  assert.doesNotMatch(brief, /listed as changeable/, "a create job lists no changeable files, so that sentence must not appear");
  assert.doesNotMatch(brief, /Do not change tests, lockfiles or configuration/, "the commissioned files ARE the configuration");
  assert.doesNotMatch(brief, /must be copied exactly from the file shown/, "there is no find in a create");
  assert.match(brief, /every file (listed|above)/i, "it says every commissioned file comes back");
  const tests = BUILDERS.write_tests_from_cases({ tests: [{ path: "src/a.test.ts", cases: ["a is one"] }], target_files: ["src/a.ts"] });
  const tbrief = tests.render([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  assert.doesNotMatch(tbrief, /listed as changeable/);
  assert.doesNotMatch(tbrief, /Do not change tests/, "a test job writes tests");
  const edit = BUILDERS.repeat_edit_across_files({ instruction: "use the helper", example: { path: "src/a.js", find: "x", replace: "y" }, files: ["src/b.js", "src/c.js"] });
  assert.match(edit.render([{ path: "src/b.js", content: "x\n" }, { path: "src/c.js", content: "x\n" }]), /listed as changeable/, "an edit job keeps the edit footer");
});


/**
 * Pair 11 (23 Sep) measured the reason a create job cannot pay: Opus wrote 124,500 chars of
 * free-prose specs for 185,175 chars of files (67%; 81–99% on the code jobs), because a
 * "spec" was any text over twenty characters and the architecture was restated inside every
 * one. A bug fix has had v2's shape since the start — a record written once, a gate that
 * rejects code and open decisions. A create job now has the same: ONE design file on disk,
 * inlined once by the harness, and per file only what cannot be read off the design
 * (exports, one behaviour line, a file to mirror for style).
 */
test("a create job is a design file plus short per-file entries, and the gate holds it to that", async () => {
  const { BUILDERS } = await import(join(LIB, "brief.mjs"));
  const good = (over = {}) => BUILDERS.write_files_from_specs({
    design_file: "docs/DESIGN.md",
    specs: [
      { path: "src/employees/masking.ts", exports: ["maskFor", "MaskedEmployee"], behaviour: "Field-masking policy per DESIGN §3: maskFor(role, record) blanks the PII the role may not see.", mirror: "src/common/domain.ts" },
      { path: "src/auth/auth.module.ts", exports: ["AuthModule"], behaviour: "The whole Auth module in one file per DESIGN §5: DTOs, service, controller, guard on every route." },
    ],
    ...over,
  });
  const b = good();
  assert.equal(b.commissioned, true);
  assert.deepEqual(b.declared, ["src/employees/masking.ts", "src/auth/auth.module.ts"]);
  assert.ok(b.show.includes("docs/DESIGN.md"), "the design is inlined by the harness, not pasted by the thinker");
  assert.ok(b.show.includes("src/common/domain.ts"), "so is the file whose style is mirrored");
  assert.ok(b.protectedPaths.includes("docs/DESIGN.md"), "and both are read only");
  assert.ok(b.specChars > 0 && b.specChars < 900, `what the thinker actually wrote, for the cost rule: ${b.specChars}`);

  const brief = b.render([{ path: "docs/DESIGN.md", content: "# Design\n## §3 Employees\nmask everything.\n" }, { path: "src/common/domain.ts", content: "export const ROLES = 1;\n" }]);
  assert.equal((brief.match(/# Design/g) || []).length, 1, "the design appears ONCE, not once per file");
  assert.match(brief, /EXPORTS: maskFor, MaskedEmployee/);
  assert.match(brief, /MIRROR: src\/common\/domain\.ts/);
  assert.ok(brief.indexOf("# Design") < brief.indexOf("EXPORTS"), "design first, then the files to write");
  assert.match(brief, /"creates"/);
  assert.doesNotMatch(brief, /listed as changeable/, "a create job never carries the edit footer");

  const refuse = (over, re, why) => assert.throws(() => good(over), re, why);
  refuse({ design_file: undefined }, /design_file/, "no design file, no job: the architecture is written once, on disk");
  refuse({ design_file: "../../etc/passwd" }, /design_file/, "the design file is a safe repo path");
  refuse({ specs: [{ path: "src/a.ts", exports: [], behaviour: "Implement:\n```ts\nexport const a = 1;\n```" }] }, /code/i, "a behaviour holding the code saves nothing by being handed over");
  refuse({ specs: [{ path: "src/a.ts", exports: [], behaviour: "Either a map or a list, unsure which is better for the lookup here." }] }, /decision open/, "an open decision is the thinker's to make");
  refuse({ specs: [{ path: "src/a.ts", exports: Array.from({ length: 21 }, (_, i) => "e" + i), behaviour: "A module of many exports, per DESIGN." }] }, /exports/, "more than twenty exports is a module the design should have split");
  // No length cap: the cost rule judges size, not a magic number.
  const long = good({ specs: [{ path: "src/a.ts", exports: ["a"], behaviour: "x".repeat(4000) }] });
  assert.ok(long.specChars > 4000, "a long behaviour is allowed here and judged by the cost rule at the door");
});

/**
 * His goal 2 (23 Sep): delegation gets its best chance to fire WHEN IT SHOULD, on all 13
 * harness tasks and on tasks the plugin has never seen. The gate decides that from how big
 * the files are likely to be, which until now came from a number learned across every task
 * the plugin had ever run — borrowed from seen tasks and applied to unseen ones. A NestJS
 * module, a Go handler and a Python test differ several-fold, and the same job kind differs
 * between two repos. So ask THIS project first: the median size of its own files of the same
 * kind. A brownfield task answers at once; a greenfield one answers from its first landed
 * hand-over onward; a project with nothing to say falls back to the learned prior, as before.
 */
test("how big a file will be is measured from this project, and only falls back to the learned prior", async () => {
  const { projectCharsPerFile } = await import(join(LIB, "repo-stats.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "mmo-size-"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "pipe" }); // every project the plugin acts in is a git repo
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    for (const [n, size] of [["a", 900], ["b", 1100], ["c", 5000]]) writeFileSync(join(dir, "src", `${n}.ts`), "x".repeat(size));
    for (const n of ["a", "b"]) writeFileSync(join(dir, "test", `${n}.spec.ts`), "y".repeat(12000));

    const code = projectCharsPerFile({ projectDir: dir, paths: ["src/new.ts", "src/other.ts"] });
    assert.ok(code !== null, "a project with files of that kind answers");
    assert.equal(code.chars, 1100, "the MEDIAN of its own source files, so one huge file cannot move it");
    assert.equal(code.samples, 3, "and how many it saw, so the caller can weigh it");

    const tests = projectCharsPerFile({ projectDir: dir, paths: ["test/new.spec.ts"] });
    assert.equal(tests.chars, 12000, "test files are measured against test files, not against source");

    assert.equal(projectCharsPerFile({ projectDir: dir, paths: ["docs/x.md"] }), null, "a kind this project has none of says nothing, and the caller keeps its prior");
    assert.equal(projectCharsPerFile({ projectDir: join(dir, "nope"), paths: ["src/a.ts"] }), null, "an empty project says nothing");
    assert.equal(projectCharsPerFile({ projectDir: dir, paths: [] }), null);

    // Never reads outside the project, and never opens a file it should not.
    writeFileSync(join(dir, ".env"), "z".repeat(50000));
    assert.equal(projectCharsPerFile({ projectDir: dir, paths: ["src/n.ts"] }).chars, 1100, "a secret file is not a sample");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
