/**
 * Two narrow readings of a Bash command string. Both are deliberately
 * conservative: when a command is anything other than the plain shape looked
 * for, the answer is "not this", and the command runs untouched.
 *
 *   parseFileDump   one of cat/head/tail/sed/awk printing ONE file, no pipe,
 *                   no redirect, no substitution.
 *   classifyRunner  a test, build or install command, optionally after a
 *                   single leading `cd <dir> &&`.
 */

const SHELL_META = /[|;&<>`\n]|\$\(|\$\{/;

/** Whitespace split that honours single and double quotes. Returns null on an unclosed quote. */
export function tokenize(command) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") return null; // escapes change meaning in ways not modelled here
    if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  if (started || cur) out.push(cur);
  return out;
}

export function parseFileDump(command) {
  if (typeof command !== "string" || command.length > 1000 || SHELL_META.test(command)) return null;
  const argv = tokenize(command.trim());
  if (!argv || argv.length < 2) return null;
  const tool = argv[0];
  const rest = argv.slice(1);

  if (tool === "cat") {
    const files = rest.filter((a) => !a.startsWith("-"));
    if (files.length !== 1) return null;
    return { tool, file: files[0], range: "all" };
  }

  if (tool === "head" || tool === "tail") {
    let n = 10;
    let fromLine = null;
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "-f" || a === "-F" || a === "-c" || a.startsWith("--follow") || a.startsWith("--bytes")) return null;
      if (a === "-n" || a === "--lines") {
        const v = rest[++i];
        if (v === undefined) return null;
        if (tool === "tail" && /^\+\d+$/.test(v)) fromLine = Number(v.slice(1));
        else if (/^\d+$/.test(v)) n = Number(v);
        else return null;
      } else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
      else if (/^-n\d+$/.test(a)) n = Number(a.slice(2));
      else if (a.startsWith("-")) return null;
      else files.push(a);
    }
    if (files.length !== 1) return null;
    if (fromLine !== null) return { tool, file: files[0], range: { from: fromLine, to: Infinity } };
    return { tool, file: files[0], range: tool === "head" ? { from: 1, to: n } : { lastLines: n } };
  }

  if (tool === "sed") {
    // Only the read-only print form: sed -n 'A,Bp' file  |  sed -n 'Ap' file
    if (rest.length !== 3 || rest[0] !== "-n") return null;
    const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(rest[1]);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === "$" ? Infinity : Number(m[2]);
    return { tool, file: rest[2], range: { from, to } };
  }

  if (tool === "awk") {
    // An awk program can print anything; its output size is unknown, so this
    // shape is only ever counted, never refused.
    const files = rest.filter((a) => !a.startsWith("-"));
    if (files.length !== 2) return null;
    return { tool, file: files[1], range: "unknown" };
  }
  return null;
}

/** How many of `totalLines` a parsed range prints. Infinity-safe. */
export function rangeLineCount(range, totalLines) {
  if (range === "all") return totalLines;
  if (range === "unknown") return null;
  if ("lastLines" in range) return Math.min(range.lastLines, totalLines);
  const from = Math.max(1, range.from);
  const to = Math.min(range.to, totalLines);
  return Math.max(0, to - from + 1);
}

const RUNNERS = [
  ["test", /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|^(npx\s+)?(jest|vitest|mocha|playwright|ava)\b|^(python3?\s+-m\s+)?pytest\b|^go\s+test\b|^cargo\s+test\b|^node\s+--test\b|^(mvn|\.\/mvnw)\s+(-\S+\s+)*test\b|^(gradle|\.\/gradlew)\s+(-\S+\s+)*test\b|^(bundle\s+exec\s+)?rspec\b|^phpunit\b|^dotnet\s+test\b|^make\s+(test|check)\b/],
  ["build", /^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck|compile)\b|^(npx\s+)?tsc\b|^go\s+(build|vet)\b|^cargo\s+(build|check|clippy)\b|^(mvn|\.\/mvnw)\s+(-\S+\s+)*(package|compile|verify|install)\b|^(gradle|\.\/gradlew)\s+(-\S+\s+)*(build|assemble)\b|^make(\s+(all|build))?\s*$|^dotnet\s+build\b/],
  ["install", /^(npm|pnpm|yarn|bun)\s+(ci|install|i|add)\b|^pip3?\s+install\b|^uv\s+(pip\s+install|sync)\b|^poetry\s+install\b|^go\s+mod\s+(download|tidy)\b|^bundle\s+install\b|^composer\s+install\b|^cargo\s+fetch\b/],
];

export function classifyRunner(command) {
  if (typeof command !== "string" || command.length > 1000) return null;
  let cmd = command.trim();
  const cd = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*/.exec(cmd);
  if (cd) cmd = cmd.slice(cd[0].length);
  // stderr folded into stdout is how most runners are called; allow exactly that redirect.
  cmd = cmd.replace(/\s+2>&1\s*$/, "");
  if (SHELL_META.test(cmd)) return null;
  for (const [kind, re] of RUNNERS) if (re.test(cmd)) return kind;
  return null;
}
