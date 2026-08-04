/**
 * publish.test.mjs — guards the things that only matter once the repo is public.
 *
 * This repo is read by people outside the organisation that wrote it. Identity
 * details that are harmless internally read as carelessness in public: a
 * package named after a repo that no longer exists, a homepage pointing at a
 * URL that 404s, an internal migration log shipped as a changelog to people who
 * were never on the old version.
 *
 * None of these break a run, which is exactly why they survive review and reach
 * a stranger's terminal. Each check below is a mechanical fact, so it holds
 * without anyone having to remember it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const readJson = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

/** The repository this code is published from — derived, never restated by hand. */
const DESTINATION = "ai-sdlc-orchestrator-claude-code-harness";

test("the package is named after the repository it ships from", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, DESTINATION, "package name must match the destination repository");
  assert.match(
    pkg.repository.url,
    new RegExp(`/${DESTINATION}\\.git$`),
    "repository.url must point at the destination repository"
  );
});

test("the lockfile agrees with the package it locks", () => {
  // npm writes the package name into the lockfile in two places. A rename that
  // updates package.json alone leaves a lockfile that names a repo nobody can
  // clone, and `npm ci` is the first command a fresh install runs.
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.name, pkg.name, "package-lock.json root name is stale");
  assert.equal(lock.packages[""].name, pkg.name, "package-lock.json self-entry name is stale");
});

test("the plugin manifest points at the repository that hosts it", () => {
  const plugin = readJson("plugin", ".claude-plugin", "plugin.json");
  assert.ok(
    plugin.homepage.endsWith(DESTINATION),
    `plugin homepage is ${plugin.homepage} — a link a user will click and find nothing at`
  );
});

test("the marketplace entry and the plugin manifest describe the same plugin", () => {
  // /plugin install reads the marketplace entry; the installed plugin reads its
  // own manifest. If the two disagree on name or version, the install succeeds
  // and the cache path the setup instructions quote is wrong.
  const marketplace = readJson(".claude-plugin", "marketplace.json");
  const plugin = readJson("plugin", ".claude-plugin", "plugin.json");
  const entry = marketplace.plugins.find((p) => p.source === "./plugin");

  assert.ok(entry, "the marketplace must list the plugin at ./plugin");
  assert.equal(entry.name, plugin.name, "marketplace and plugin manifest disagree on the plugin name");
  assert.equal(entry.version, plugin.version, "marketplace and plugin manifest disagree on the version");
  assert.ok(entry.homepage.endsWith(DESTINATION), "the marketplace entry links to the wrong repository");
});

test("no internal bookkeeping files ship", () => {
  // A changelog documenting a rename nobody outside ever saw, a notes file
  // written for the team, or a macOS directory turd all say the same thing to a
  // reader: this was not prepared for you.
  for (const name of ["CHANGELOG.md", "NEXT_STEPS.md", ".DS_Store"]) {
    assert.ok(!existsSync(join(ROOT, name)), `${name} must not ship in a public repo`);
  }
});

test("licensing is attributed to the organisation, and NOTICE names this project", () => {
  assert.match(read("LICENSE"), /Tilicho Labs/, "LICENSE must carry the organisation's copyright line");
  const notice = read("NOTICE");
  assert.match(notice, /Tilicho Labs/, "NOTICE must carry the organisation's copyright line");
  assert.ok(
    !/Workforce Ops —/.test(notice.split("\n")[0]),
    "NOTICE still opens with the old single-case-study title"
  );
});

/**
 * Every text file a reader can see, excluding build output, dependencies, and
 * git internals. Walked rather than shelled out to git, so the check works in
 * an exported copy too.
 */
function textFiles(dir = ROOT, acc = []) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      textFiles(full, acc);
    } else if (/\.(md|json|ya?ml|mjs|js|ts)$/.test(entry.name) && statSync(full).size < 512_000) {
      acc.push(full);
    }
  }
  return acc;
}

test("nothing still references the repository this one replaced", () => {
  // The rename is only complete when no file quotes the old URL. A stale clone
  // line in a doc sends the first reader who follows it to a 404.
  //
  // The retired name is assembled from fragments rather than written out: a
  // literal here would itself be an occurrence of the string this test forbids,
  // and the check would fail on its own source.
  const retired = new RegExp(["ai", "study", "workforce", "ops"].join("-"));

  const offenders = textFiles()
    .filter((f) => retired.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, [], "these files still name the old repository");
});

test("no other organisation repository is referenced", () => {
  // Examples that point at a sibling internal repo are unreachable for the
  // audience this one is published for.
  const pattern = /github\.com\/tl-ai-labs\/([a-z0-9-]+)/g;
  const strays = new Map();

  for (const file of textFiles()) {
    for (const [, repo] of readFileSync(file, "utf8").matchAll(pattern)) {
      if (repo !== DESTINATION) strays.set(relative(ROOT, file), repo);
    }
  }

  assert.deepEqual([...strays], [], "these files link to a repository other than the one they ship from");
});

test("no personal contact details are embedded in shipped files", () => {
  // Authored files carry no individual's address; the organisation's own
  // domain is the correct point of contact and is allowed.
  const email = /[a-z0-9._%+-]+@(?!example\.)(?!tilicho\.in)[a-z0-9.-]+\.[a-z]{2,}/gi;
  const found = [];

  for (const file of textFiles()) {
    const rel = relative(ROOT, file);
    if (rel === "package-lock.json") continue; // registry metadata, not authored
    for (const [address] of readFileSync(file, "utf8").matchAll(email)) {
      found.push(`${rel}: ${address}`);
    }
  }

  assert.deepEqual(found, [], "these files carry a personal or third-party email address");
});
