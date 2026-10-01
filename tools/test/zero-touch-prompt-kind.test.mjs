/**
 * "Did the person type this message while the chat was idle?" is answered in two plugins, and the answers must never
 * disagree (1 Oct 2026):
 *   - the mmo plugin's routing (plugin/scripts/ambient/hook.mjs NOTICE_TAG, lib/transcript.mjs sentWhileWorking), the
 *     original;
 *   - the zero-touch plugin's settings box (zero-touch/scripts/prompt-kind.mjs), a copy, because Claude Code gives each
 *     plugin its own files.
 * If they disagreed, one message could end a settings sequence in one plugin while the other took it as part of the
 * running task. This test runs both on the same cases.
 *
 * Offline: files in a temporary folder only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const Z = await import(join(ROOT, "zero-touch", "scripts", "prompt-kind.mjs"));
const T = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "transcript.mjs"));

test("the notice tags are the mmo plugin's, character for character", () => {
  const hook = readFileSync(join(ROOT, "plugin", "scripts", "ambient", "hook.mjs"), "utf8");
  const original = /const NOTICE_TAG = (\/.+\/[a-z]*);/.exec(hook)?.[1];
  assert.ok(original, "the original is found in hook.mjs");
  assert.equal(String(Z.NOTICE_TAG), original);
  for (const text of ["<task-notification>\n<task-id>1</task-id>", "  <system-reminder>x", "<p>my own html</p>", "fix the bug"]) {
    const notice = new RegExp(original.slice(1, original.lastIndexOf("/")), "i").test(text);
    assert.equal(Z.promptKind({ prompt: text }), notice ? "notice" : "idle", text);
  }
});

test("sent while Claude was working: both copies give the same answer on every case", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-prompt-kind-"));
  try {
    const cases = [
      ["an idle message", [{ type: "user", message: { content: "hello" } }], "hello", false],
      ["typed while working", [{ type: "attachment", attachment: { type: "queued_command", prompt: "also this" } }], "also this", true],
      ["the latest entry decides", [{ type: "attachment", attachment: { type: "queued_command", prompt: "again" } }, { type: "user", message: { content: [{ type: "text", text: "again" }] } }], "again", false],
      ["a helper's entry is not the chat's", [{ type: "user", isSidechain: true, message: { content: "x" } }], "x", null],
      ["not in the transcript", [{ type: "user", message: { content: "other" } }], "missing", null],
    ];
    for (const [name, entries, text, expected] of cases) {
      const file = join(dir, `${name.replace(/\W+/g, "-")}.jsonl`);
      writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
      assert.equal(T.sentWhileWorking(file, text), expected, `${name}: the original`);
      assert.equal(Z.sentWhileWorking(file, text), expected, `${name}: the copy agrees`);
    }
    assert.equal(Z.sentWhileWorking(join(dir, "none.jsonl"), "x"), null, "no transcript");
    assert.equal(Z.promptKind({ prompt: "also this", transcript_path: join(dir, "typed-while-working.jsonl") }), "working");
    assert.equal(Z.promptKind({ prompt: "hello", transcript_path: join(dir, "an-idle-message.jsonl") }), "idle");
    assert.equal(Z.promptKind({ prompt: "not written yet", transcript_path: join(dir, "an-idle-message.jsonl") }), "unknown", "a transcript that does not show it yet");
    assert.equal(Z.promptKind({ prompt: "hello" }), "idle", "no transcript to tell: as mmo's routing assumes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
