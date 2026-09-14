/**
 * tools/report.mjs lists a run's Claude Code transcripts (its Artifacts
 * section) from ~/.claude/projects/<dir>, where <dir> is Claude Code's own
 * name for the project root: every character that is not a letter or digit
 * becomes "-". That is the rule the collector's transcriptsDirFor uses and
 * docs/methodology.md states.
 *
 * The report kept an older rule that replaced only "/" and whitespace. For any
 * project path holding a dot or an underscore (`my_app.v0.6.0`) it looked in a
 * directory that never exists and silently listed no session or subagent
 * transcript at all. This test fails on that rule.
 *
 * HOME points at a temp home, so nothing is read from the machine's own
 * ~/.claude. The files' mtimes are set inside the run's manifest window,
 * because the report lists only transcripts written during the run.
 * $0, offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const RUN = join(ROOT, "tools", "test", "fixtures", "receivables-ops", "pass1");

test("report Artifacts: a project root with a dot and an underscore finds its transcripts under Claude Code's directory name", () => {
  const tmp = mkdtempSync(join(tmpdir(), "report-transcript-dir-"));
  try {
    // The report takes the project root as four levels above the pass directory.
    const projectRoot = join(tmp, "work", "my_app.v0.6.0");
    const passDir = join(projectRoot, "examples", "study", "passes", "pass1");
    mkdirSync(passDir, { recursive: true });
    const manifest = readFileSync(join(RUN, "manifest.json"), "utf8");
    writeFileSync(join(passDir, "manifest.json"), manifest);
    writeFileSync(join(passDir, "telemetry.jsonl"), readFileSync(join(RUN, "telemetry.jsonl")));

    const home = join(tmp, "home");
    const claudeDir = join(home, ".claude", "projects", projectRoot.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(join(claudeDir, "sess-1", "subagents"), { recursive: true });
    const session = join(claudeDir, "sess-1.jsonl");
    const helper = join(claudeDir, "sess-1", "subagents", "agent-a1.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(helper, "{}\n");
    const started = Date.parse(JSON.parse(manifest).started_at ?? "");
    if (Number.isFinite(started)) {
      const t = (started + 60_000) / 1000;
      utimesSync(session, t, t);
    }

    const out = execFileSync(process.execPath, [REPORT, passDir], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.match(out, /Claude Code session log\s+\S*sess-1\.jsonl/);
    assert.match(out, /Subagent transcript\s+\S*agent-a1\.jsonl/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
