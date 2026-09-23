/**
 * Code-built outline of one source file: declaration kind, name, parameters
 * and the line range each declaration spans. No model is involved and nothing
 * leaves the machine.
 *
 * Only identifiers and line numbers are emitted. Comments are never copied and
 * string literals inside a signature are blanked, so an outline cannot carry
 * instructions that someone planted in a file.
 *
 * The outline replaces a large Read only when it is a fair map of the file:
 *   - the language is one this module can parse,
 *   - it fits the character budget,
 *   - its coverage passes (no long stretch of the file without an entry).
 * Anything else returns null and the read passes through untouched.
 */
import { extname } from "node:path";

const MAX_LINE_CHARS = 2000;
const GAP_LINES = 200;

const JS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\)?)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(\([^)]*\)?)\s*(?::\s*[^{]+)?\{\s*$/,
];
const PY = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\)?)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
];
const GO = [
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(\([^)]*\)?)/,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/,
];
const JAVA = [
  /^\s*(?:public|private|protected|internal|abstract|final|static|sealed|open|data|\s)*\s*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected|internal|static|final|abstract|synchronized|override|suspend|\s)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*(\([^)]*\)?)\s*(?:throws [\w., ]+)?\s*\{?\s*$/,
  /^\s*(?:override\s+|suspend\s+|private\s+|public\s+|internal\s+)*fun\s+([A-Za-z_]\w*)\s*(\([^)]*\)?)/,
];
const RUBY = [/^\s*def\s+([A-Za-z_][\w.?!]*)\s*(\([^)]*\)?)?/, /^\s*(?:class|module)\s+([A-Z][\w:]*)/];
const RUST = [
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*(\([^)]*\)?)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/,
  /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w:<>, ]*)/,
];
const C = [
  /^(?:[A-Za-z_][\w\s\*&:<>,]*?)\s+\**([A-Za-z_][\w:~]*)\s*(\([^;{]*\))\s*(?:const\s*)?\{?\s*$/,
  /^\s*(?:class|struct|namespace|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/,
];
const PHP = [/^\s*(?:public|private|protected|static|final|abstract|\s)*function\s+&?([A-Za-z_]\w*)\s*(\([^)]*\)?)/, /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/];
const MD = [/^(#{1,6})\s+(.+?)\s*#*\s*$/];

const LANGS = {
  ".js": JS, ".mjs": JS, ".cjs": JS, ".jsx": JS, ".ts": JS, ".tsx": JS, ".mts": JS, ".cts": JS,
  ".py": PY, ".go": GO, ".java": JAVA, ".kt": JAVA, ".kts": JAVA, ".cs": JAVA,
  ".rb": RUBY, ".rs": RUST, ".php": PHP,
  ".c": C, ".h": C, ".cc": C, ".cpp": C, ".hpp": C,
  ".md": MD,
};

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with", "function", "constructor"]);

export function languageOf(filePath) {
  const ext = extname(String(filePath)).toLowerCase();
  return LANGS[ext] ? ext : null;
}

function blankStrings(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  return m[0].replace(/\t/g, "    ").length;
}

function kindOf(line, ext) {
  if (ext === ".md") return "section";
  const m = /\b(class|interface|type|enum|namespace|struct|trait|impl|mod|module|record|object|def|func|fn|fun|function)\b/.exec(line);
  if (!m) return "fn";
  return ["def", "func", "fn", "fun", "function"].includes(m[1]) ? "fn" : m[1];
}

/** Returns [{ start, end, indent, text }] with 1-based inclusive line ranges. */
export function findDeclarations(text, filePath) {
  const ext = languageOf(filePath);
  if (!ext) return null;
  const patterns = LANGS[ext];
  const lines = text.split("\n");
  const found = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_CHARS) return null; // minified or generated: no fair outline exists
    if (ext === ".md") {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
    }
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      // `describeRoute({` is a call whose argument spills onto later lines, not
      // a declaration. A declaration's parameter list closes on its own line.
      // Measured: 45 of 162 passing outlines carried such an entry; 8 were
      // useless because of it.
      if (m[2] !== undefined && m[2].startsWith("(") && !m[2].endsWith(")")) continue;
      if (ext === ".md") {
        found.push({ start: i + 1, indent: m[1].length, text: m[1] + " " + blankStrings(m[2]).slice(0, 80) });
        break;
      }
      const name = m[1].trim();
      if (CONTROL_WORDS.has(name)) continue;
      const params = m[2] ? blankStrings(m[2]).replace(/\s+/g, " ").slice(0, 80) : "";
      found.push({ start: i + 1, indent: indentOf(line), text: kindOf(line, ext) + " " + name + params });
      break;
    }
  }
  // A declaration ends on the line before the next one at the same or a
  // shallower indent (for markdown: the same or a higher heading level).
  for (let i = 0; i < found.length; i++) {
    let end = lines.length;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].indent <= found[i].indent) { end = found[j].start - 1; break; }
    }
    found[i].end = end;
  }
  return { decls: found, totalLines: lines.length };
}

/**
 * Share of the file's lines that sit within GAP_LINES of an outline entry. A
 * long stretch with no entry (a data table, a language construct this module
 * does not know) lowers it, and a low score means "pass the read through".
 */
export function coverage(decls, totalLines) {
  if (totalLines === 0) return 0;
  const starts = decls.map((d) => d.start);
  const edges = [0, ...starts, totalLines + 1];
  let uncovered = 0;
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i] - edges[i - 1] - 1;
    if (gap > GAP_LINES) uncovered += gap - GAP_LINES;
  }
  return 1 - uncovered / totalLines;
}

export function buildOutline(text, filePath, { budgetChars = 9000, minCoverage = 0.7 } = {}) {
  const parsed = findDeclarations(text, filePath);
  if (!parsed || parsed.decls.length === 0) return null;
  const cov = coverage(parsed.decls, parsed.totalLines);
  if (cov < minCoverage) return null;
  const body = parsed.decls
    .map((d) => " ".repeat(Math.min(d.indent, 12)) + "L" + d.start + "-" + d.end + "  " + d.text)
    .join("\n");
  if (body.length > budgetChars) return null;
  return { body, entries: parsed.decls.length, totalLines: parsed.totalLines, coverage: cov };
}
