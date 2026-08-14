#!/usr/bin/env node
/**
 * Brownfield uninstall cleanup. Removes what the brownfield mode dropped
 * on your project so `/plugin uninstall` leaves zero footprint.
 *
 * Two artifacts get cleaned:
 *   1. `.sdlc/` directory — the plugin's per-project state, per plan §14.1.
 *   2. The `@.sdlc/CLAUDE-SDLC.md` import line in your CLAUDE.md, if the
 *      first-run mini-gate ever added it. v1 doesn't auto-add this line
 *      (the SessionStart hook that would is v1.5), but the cleanup
 *      handles it defensively in case a future version did.
 *
 * Always asks before doing anything destructive. `--dry-run` prints
 * what would happen without doing it. `--yes` skips prompts (for
 * scripted use).
 *
 * Usage:
 *   node brownfield-cleanup.mjs                # interactive, from cwd
 *   node brownfield-cleanup.mjs --repo /path   # explicit repo root
 *   node brownfield-cleanup.mjs --dry-run      # print, don't touch
 *   node brownfield-cleanup.mjs --yes          # no prompts (careful!)
 *
 * Exit codes:
 *   0 — nothing to clean OR cleanup succeeded
 *   1 — cleanup failed OR user aborted
 */

import { existsSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const IMPORT_LINE_RE = /^\s*@\.sdlc\/CLAUDE-SDLC\.md\s*$/;

function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function parseArgs(argv) {
  const args = { repo: null, dryRun: false, yes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? null;
    else if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
  }
  return args;
}

async function ask(question, defaultYes = false) {
  return await new Promise((r) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    rl.question(`${question} ${suffix} `, (ans) => {
      rl.close();
      const clean = String(ans).trim().toLowerCase();
      if (clean === "") r(defaultYes);
      else r(clean === "y" || clean === "yes");
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.repo ? resolve(args.repo) : findRepoRoot();

  if (!repoRoot) {
    console.error("brownfield-cleanup: no git repo found from cwd. Pass --repo /path/to/repo.");
    process.exit(1);
  }

  console.log(`brownfield-cleanup: scanning ${repoRoot}`);

  const sdlcDir = join(repoRoot, ".sdlc");
  const claudeMd = join(repoRoot, "CLAUDE.md");

  const sdlcExists = existsSync(sdlcDir) && statSync(sdlcDir).isDirectory();
  let importPresent = false;
  let claudeMdContent = null;
  if (existsSync(claudeMd) && statSync(claudeMd).isFile()) {
    try {
      claudeMdContent = readFileSync(claudeMd, "utf8");
      importPresent = claudeMdContent.split(/\r?\n/).some((l) => IMPORT_LINE_RE.test(l));
    } catch { /* skip */ }
  }

  if (!sdlcExists && !importPresent) {
    console.log("Nothing to clean. Repo has no `.sdlc/` and no `@.sdlc/CLAUDE-SDLC.md` import in CLAUDE.md.");
    process.exit(0);
  }

  console.log("");
  console.log("Found the following to clean:");
  if (sdlcExists) console.log(`  • ${sdlcDir} (whole directory — includes per-run records, ledger, baseline)`);
  if (importPresent) console.log(`  • one @import line in ${claudeMd}`);
  console.log("");

  if (args.dryRun) {
    console.log("--dry-run: exiting without changes.");
    process.exit(0);
  }

  if (sdlcExists && !args.yes) {
    console.log("The `.sdlc/` directory contains COMMITTED files (runs history, ledger).");
    console.log("If you want to preserve them, commit or stash first — this action is not reversible without git.");
    const yes = await ask("Delete .sdlc/ entirely?", false);
    if (!yes) {
      console.log("Aborted at .sdlc/ prompt.");
      process.exit(1);
    }
  }

  if (importPresent && !args.yes) {
    const yes = await ask("Remove the @.sdlc/CLAUDE-SDLC.md import line from CLAUDE.md?", true);
    if (!yes) {
      console.log("Keeping the import line. You'll want to remove it manually or it will fail after .sdlc/ is deleted.");
    } else {
      const newContent = claudeMdContent
        .split(/\r?\n/)
        .filter((l) => !IMPORT_LINE_RE.test(l))
        .join("\n");
      try {
        writeFileSync(claudeMd, newContent);
        console.log(`✓ Removed import line from ${claudeMd}`);
      } catch (e) {
        console.error(`✗ Could not update ${claudeMd}: ${e?.message ?? e}`);
      }
    }
  } else if (importPresent && args.yes) {
    // --yes path
    const newContent = claudeMdContent
      .split(/\r?\n/)
      .filter((l) => !IMPORT_LINE_RE.test(l))
      .join("\n");
    try {
      writeFileSync(claudeMd, newContent);
      console.log(`✓ Removed import line from ${claudeMd}`);
    } catch (e) {
      console.error(`✗ Could not update ${claudeMd}: ${e?.message ?? e}`);
    }
  }

  if (sdlcExists) {
    try {
      rmSync(sdlcDir, { recursive: true, force: true });
      console.log(`✓ Removed ${sdlcDir}`);
    } catch (e) {
      console.error(`✗ Could not remove ${sdlcDir}: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  console.log("");
  console.log("Cleanup complete. To finish uninstalling the plugin itself, run:");
  console.log("  /plugin uninstall sdlc@tilicho-ai-labs");
  console.log("(or /plugin marketplace remove tilicho-ai-labs to also drop the marketplace registration).");
}

main().catch((e) => {
  console.error(`brownfield-cleanup: ${e?.message ?? e}`);
  process.exit(1);
});
