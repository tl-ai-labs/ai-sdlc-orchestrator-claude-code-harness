/**
 * Triggers: the EVIDENCE that handing typing to a worker could pay, recognised
 * from what the thinker is DOING, never from the wording of a prompt. A prompt
 * can be anything; a plan that names fourteen new files is a fact.
 *
 * Since 23 Sep 2026 typing is not asked about at all: a by-hand write above
 * the break-even is refused by the hook (enforceHandover) and the hand-over
 * named. What remains here is the evidence for the two lines that still exist,
 * the scout (reads so far) and the bug fix (a failing test the chat wrote),
 * plus the readers of Bash commands and test output the hook relies on.
 *
 * Every function here is pure: text or a list in, evidence out. The hook
 * supplies the file-exists check and keeps the small per-session state.
 */

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i;

export function isTestPath(p) {
  return TEST_PATH_RE.test(String(p));
}

/** Which seed-table file kind a list of paths mostly belongs to. */
export function fileKindOf(paths) {
  const count = { python: 0, go: 0, js_ts: 0, docs: 0 };
  for (const p of paths) {
    if (/\.py$/.test(p)) count.python++;
    else if (/\.go$/.test(p)) count.go++;
    else if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(p)) count.js_ts++;
    else if (/\.md$/.test(p)) count.docs++;
  }
  const [kind, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return n > 0 && n >= paths.length * 0.6 ? kind : "any";
}

/**
 * Files a Bash command WRITES to, by the common shapes: `sed -i`, `>` and `>>`
 * redirects, `tee`, `cp`/`mv` targets, and a script inside the command that
 * opens a path for writing (python `open(p, "w")`, node `writeFileSync`).
 * Measured on 847 past sessions: one test-file write in four goes through
 * Bash rather than the Edit or Write tool, and a session that writes its test
 * this way would otherwise never reach the bug-fix moment. The list is the
 * common shapes, not every possible one; the Edit tool stays the sure signal.
 */
const A_PATH = String.raw`(?:"[^"\n]+"|'[^'\n]+'|[\w./@-]+)`;
const WRITE_SHAPES = [
  new RegExp(String.raw`\bsed\s+-i(?:\s+'')?\s+(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+(${A_PATH})`, "g"),
  new RegExp(String.raw`(?:^|[^>])>{1,2}\s*(${A_PATH})`, "g"),
  new RegExp(String.raw`\btee\s+(?:-a\s+)?(${A_PATH})`, "g"),
  new RegExp(String.raw`\b(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+(${A_PATH})`, "g"),
  new RegExp(String.raw`\bopen\(\s*(${A_PATH})\s*,\s*['"](?:w|a)`, "g"),
  new RegExp(String.raw`\bwriteFileSync\(\s*(${A_PATH})`, "g"),
];

export function bashWrittenPaths(command) {
  if (typeof command !== "string" || command.length > 20000) return [];
  const out = new Set();
  // A python/node script that names a path in a variable and writes it later:
  // `p='tests/x.py'` ... `open(p,'w')`. Resolve the one-letter variable case.
  const vars = new Map();
  for (const m of command.matchAll(/^\s*(\w+)\s*=\s*(["'])([^"'\n]+)\2\s*$/gm)) vars.set(m[1], m[3]);
  for (const re of WRITE_SHAPES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(command)) !== null) {
      const raw = m[1].replace(/^["']|["']$/g, "");
      out.add(vars.get(raw) ?? raw);
    }
  }
  return [...out].filter((p) => p && !p.startsWith("-") && p !== "/dev/null");
}

/**
 * Does this command RUN tests, anywhere inside it? Deliberately looser than the
 * strict reader used for trimming: the thinker almost always writes
 * `cd x && npx vitest run ... 2>&1 | tail -20`. The pipe makes the shell report
 * tail's exit code, so a failing run looks like a success to Claude Code and
 * no failure event fires. This reading is only ever used to NOTICE a failing
 * test; it never changes a tool result.
 */
const TEST_RUN_RE = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:npx\s+|pnpm\s+exec\s+)?(?:vitest|jest|mocha|ava|playwright\s+test)\b|(?:python3?\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|(?:bundle\s+exec\s+)?rspec\b|phpunit\b|dotnet\s+test\b|(?:\.\/)?(?:mvnw?|gradlew?)\s+(?:-\S+\s+)*test\b|make\s+(?:test|check)\b)/;

export function mentionsTestRunner(command) {
  return typeof command === "string" && command.length <= 4000 && TEST_RUN_RE.test(command);
}

/** Failure markers of the common runners. "0 failed" and stray words like "failed to fetch" do not count. */
const FAILING_OUTPUT_RE = /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|^\s*(?:FAIL|✗|✖|×)\s|^--- FAIL:|\bAssertionError\b|\bFAILED\b\s+\S+::/m;

export function outputShowsFailingTests(output) {
  return typeof output === "string" && FAILING_OUTPUT_RE.test(output.slice(-20000));
}

/**
 * The bug-fix moment: this session wrote or edited a test file, and a test run
 * has now failed. That is the thinker holding a failing reproduce test, which
 * is exactly where the measured flow hands the FIX (never the diagnosis) over.
 */
export function bugfixTrigger({ testFileTouched, failedRunner }) {
  if (testFileTouched && failedRunner === "test") return { fired: true, kind: "failing_repro_test", job: "bugfix_code", tool: "fix_from_analysis", count: 1 };
  return { fired: false };
}

/**
 * The SHAPE of one edit: its before and after text with every quoted string and
 * number blanked and all spacing removed. Replacing
 *   throw new HTTPException(404, { message: "Task not found" })
 * with  throw notFound("Task not found")  has the same shape in every file,
 * whatever the message says and however the lines are broken.
 *
 * Why this trigger exists: over 850 real sessions the plan tool was used 0
 * times and the todo tools twice, so triggers built on them never fire. What a
 * hook does see is the thinker making the same edit file after file.
 */
export function editShape(oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") return null;
  if (oldString === newString || oldString.length < 12 || oldString.length > 2000 || newString.length > 2000) return null;
  const norm = (t) => t
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "S")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N")
    .replace(/\s+/g, "")
    .replace(/,(?=[}\])])/g, "");
  const a = norm(oldString);
  const b = norm(newString);
  return a === b ? null : a + "=>" + b;
}

/** A piece of the old text that is safe to search for: the longest run with no quotes and no line break. */
export function searchNeedle(oldString) {
  const pieces = String(oldString).split(/["'`\n]/).map((x) => x.trim()).filter((x) => x.length >= 12);
  pieces.sort((x, y) => y.length - x.length);
  return pieces[0] ?? null;
}

/**
 * The chat has opened one more distinct project file by hand: evidence for the
 * scout job. A hunt through existing code is mostly reading, one request per
 * file; whether a scout that reads the likely files pays is the cost rule's
 * call (reads so far against the scout's own cost).
 */
export function readsFanOutTrigger({ filesRead, before = filesRead - 1 }) {
  if (!(filesRead >= 1 && filesRead > before)) return { fired: false };
  return { fired: true, kind: "reads_fan_out", job: "scout", tool: "scout_repo", count: filesRead };
}

/** The plugin's tools as Claude Code lists them. Hidden until loaded, so every mention says so. */
export const fullToolName = (t) => `mcp__plugin_mmo_model-dispatch__${t}`;
export const toolRef = (t) => `the tool \`${t}\` (full name \`${fullToolName(t)}\`; load it with ToolSearch first)`;
const num = (x) => Number(x).toLocaleString("en-US");

/**
 * The ONE factual line shown to the thinker, at the first moment the cost rule
 * says handing over pays. No persuasion, no orders: the numbers it saw (the
 * typing it expects against this chat's break-even) and the tool's full name.
 */
export function offerLine(t) {
  const be = Number.isFinite(t.breakEvenChars) && t.breakEvenChars > 0 ? t.breakEvenChars : null;
  if (t.kind === "reads_fan_out") {
    const reads = Number.isFinite(t.breakEvenReads) ? ` At this chat's size ${t.breakEvenReads} reads cost as much as one scout job, so it pays now.` : "";
    return `[mmo] You have read ${t.count} files of this project by hand.${reads} ${toolRef(t.tool)} has a worker model read the likely files and report where to look or edit, each place with its exact Read range and a quoted line checked by code; one job replaces the reads still to come. It changes nothing.`;
  }
  if (t.kind === "failing_repro_test") {
    return `[mmo] A test you wrote is failing. Once you know the root cause, ${toolRef(t.tool)} has a worker model write the fix from your written analysis; you keep the diagnosis and you run the tests.` +
      (be ? ` That pays at this chat's size if the fix is more than about ${num(be)} characters of code.` : "");
  }
  return null;
}
