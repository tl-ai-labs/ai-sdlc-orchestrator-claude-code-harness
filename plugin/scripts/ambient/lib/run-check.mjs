/**
 * The run-start check's command, with the person's policy file added (1 Oct 2026).
 *
 * A run zero-touch started must be checked against the person's chosen policy, never a project's own
 * routing-policy.yaml. The orchestrator runs the check as a shell command (`node …/driver-model-check.mjs
 * --project-root "$(pwd)"`, agents/orchestrator.md) and is told to pass the run's policy file; this is the backstop
 * for a model that does not. Rewriting a shell command is only safe when there is no doubt what it is, so the rule is
 * narrow on purpose (the first version, found in review the same day, broke a command with two check calls and put the
 * flag into `sed`/`grep` commands that merely named the script):
 *   - the command must be ONE plain call: `node <…/driver-model-check.mjs> <words>`, where a word is plain text or a
 *     quoted string, and a backslash-newline counts as a space. Anything else (`;`, `&&`, `|`, a redirect, a subshell,
 *     backticks, `$(…)` outside quotes, another program, a newline) leaves the command untouched;
 *   - a command that already names a policy file (`--policy-path`) is left untouched: the model passed one;
 *   - the flag goes right after the script's own word, and nothing else in the command changes (the script puts an
 *     explicit file ahead of `--policy` and of a project's file, as the model server does).
 * Returns the new command, or null to leave it as it is.
 */

const OPERATORS = new Set([";", "&", "|", "<", ">", "(", ")", "`", "\n"]);

/** The command's words, with where each ends, or null when it is not one plain command. */
export function plainWords(command) {
  const words = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "\\" && command[i + 1] === "\n") { i += 2; continue; }
    const start = i;
    let text = "";
    while (i < n) {
      const c = command[i];
      if (c === " " || c === "\t") break;
      if (c === "\\" && command[i + 1] === "\n") break;
      if (OPERATORS.has(c)) return null;
      if (c === "$" && command[i + 1] === "(") return null;
      if (c === "\\") { if (i + 1 >= n) return null; text += command[i + 1]; i += 2; continue; }
      if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) return null;
        text += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let inner = "";
        while (j < n && command[j] !== '"') {
          if (command[j] === "\\" && j + 1 < n) { inner += command[j + 1]; j += 2; continue; }
          if (command[j] === "`") return null;
          inner += command[j];
          j++;
        }
        if (j >= n) return null;
        text += inner;
        i = j + 1;
        continue;
      }
      text += c;
      i++;
    }
    words.push({ text, end: i, start });
  }
  return words;
}

export function stampedRunCheck(command, policyFile) {
  if (typeof command !== "string" || typeof policyFile !== "string" || !policyFile) return null;
  // Never a path the shell could read as more than a path.
  if (/["$`\\\n]/.test(policyFile)) return null;
  const words = plainWords(command);
  if (!words || words.length < 2) return null;
  if (!/(^|\/)node$/.test(words[0].text)) return null;
  if (!/(^|\/)driver-model-check\.mjs$/.test(words[1].text)) return null;
  if (words.some((w) => w.text === "--policy-path" || w.text.startsWith("--policy-path="))) return null;
  const at = words[1].end;
  return `${command.slice(0, at)} --policy-path "${policyFile}"${command.slice(at)}`;
}
