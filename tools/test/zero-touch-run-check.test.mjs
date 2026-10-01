/**
 * The run-start check's command, with the person's policy file added (plugin/scripts/ambient/lib/run-check.mjs).
 *
 * Why (1 Oct 2026): a run zero-touch started must be checked against the person's policy, never a project's own
 * routing-policy.yaml, and the orchestrator runs that check as a shell command. The first version of the backstop,
 * found in review the same day, rewrote any command that mentioned the script: it removed every --policy-path in a
 * command with two check calls (the second one then read the project's file and failed), put the flag into `sed` and
 * `grep` commands that only named the script, and trimmed trailing spaces off every line. So the rule now touches only
 * one plain call of the check that names no file yet, and changes nothing else in it.
 *
 * Offline: string in, string out; one case runs the rewritten command through a real shell to prove it still parses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { stampedRunCheck, plainWords } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "run-check.mjs"));
const FILE = "/plug/config/policies/opus-plus-sonnet.yaml";
const FLAG = `--policy-path "${FILE}"`;

test("one plain call of the check gets the file, right after the script, and nothing else changes", () => {
  const cases = [
    ['node "${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" --project-root "$(pwd)"', `node "\${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" ${FLAG} --project-root "$(pwd)"`],
    ["node /p/scripts/driver-model-check.mjs --project-root . --policy=opus-plus-flash", `node /p/scripts/driver-model-check.mjs ${FLAG} --project-root . --policy=opus-plus-flash`],
    ["  node '/p/scripts/driver-model-check.mjs' \\\n    --project-root \"$(pwd)\"  ", `  node '/p/scripts/driver-model-check.mjs' ${FLAG} \\\n    --project-root "$(pwd)"  `],
    ["/usr/local/bin/node /p/driver-model-check.mjs --print-only --project-root .", `/usr/local/bin/node /p/driver-model-check.mjs ${FLAG} --print-only --project-root .`],
  ];
  for (const [command, expected] of cases) assert.equal(stampedRunCheck(command, FILE), expected, command);
});

test("everything else is left exactly as written: more than one command, another program, a file already named", () => {
  const untouched = [
    // The reviewer's case: two calls in one command, both already right; the old rewrite broke the second.
    `node /p/driver-model-check.mjs --project-root . --policy-path "${FILE}" --print-only && node /p/driver-model-check.mjs --project-root . --policy-path "${FILE}"`,
    // Commands that only name the script.
    'sed -n 1,80p "/p/scripts/driver-model-check.mjs"',
    "grep -n policy /p/scripts/driver-model-check.mjs | head",
    "cat /p/scripts/driver-model-check.mjs",
    // Not one plain command.
    "cd /tmp && node /p/driver-model-check.mjs --project-root .",
    "node /p/driver-model-check.mjs --project-root . ; echo done",
    "node /p/driver-model-check.mjs --project-root . > out.txt",
    "node /p/driver-model-check.mjs --project-root $(pwd)",
    "node /p/driver-model-check.mjs --project-root `pwd`",
    "node /p/driver-model-check.mjs --project-root .\nnode /p/driver-model-check.mjs --project-root .",
    "node /p/driver-model-check.mjs --project-root 'unclosed",
    // A file already named, in either spelling.
    "node /p/driver-model-check.mjs --project-root . --policy-path /tmp/theirs.yaml",
    "node /p/driver-model-check.mjs --policy-path=/tmp/theirs.yaml",
    // Another script, or not node.
    "node /p/verify-setup.mjs --fix",
    "bun /p/driver-model-check.mjs --project-root .",
    "",
  ];
  for (const command of untouched) assert.equal(stampedRunCheck(command, FILE), null, JSON.stringify(command));
  assert.equal(stampedRunCheck("node /p/driver-model-check.mjs", 'bad"path'), null, "a file the shell could misread is never added");
  assert.equal(stampedRunCheck(null, FILE), null);
});

test("the rewritten command is still one valid shell command, with the file as its own word", () => {
  const stamped = stampedRunCheck('node "/p/scripts/driver-model-check.mjs" --project-root "$(pwd)"', "/plug/with space/policy.yaml");
  // Print each word the shell sees, one per line, without running node.
  const r = spawnSync("/bin/sh", ["-c", `set -- ${stamped.replace(/^node /, "")}; for w in "$@"; do printf '%s\\n' "$w"; done`], { encoding: "utf8", cwd: "/tmp" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n").slice(0, 3), ["/p/scripts/driver-model-check.mjs", "--policy-path", "/plug/with space/policy.yaml"]);
  assert.deepEqual(plainWords("a 'b c' \"d\\\"e\" f\\ g").map((w) => w.text), ["a", "b c", 'd"e', "f g"]);
});
