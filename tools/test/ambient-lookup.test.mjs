/**
 * The bundled lookup (design v1.1, reading layer item 5): one call takes search
 * terms and returns the matching lines with exact Read ranges, so a hunt through
 * existing code costs one round trip instead of one grep plus one read per file.
 * Offline: a throwaway git repository. Never leaves the machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { lookup } = await import(join(ROOT, "plugin", "scripts", "ambient", "lookup.mjs"));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-lookup-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(home);
  const git = (...a) => execFileSync("git", a, { cwd: project, stdio: "pipe" });
  git("init", "-q");
  const fn = (name, body) => `export function ${name}(req, res) {\n${body}\n}\n`;
  writeFileSync(join(project, "src", "orders.js"), fn("createOrder", "  const total = computeTotal(req.body.items);\n  return res.json({ total });") + "\n" + fn("listOrders", "  return res.json(store.orders);"));
  writeFileSync(join(project, "src", "items.js"), fn("computeTotal", "  return items.reduce((s, i) => s + i.price * i.qty, 0);") + "\n" + "export const TAX = 0.18;\n");
  writeFileSync(join(project, ".env"), "API_KEY=computeTotal_is_not_here_but_this_file_is_secret\n");
  writeFileSync(join(project, "notes.md"), "computeTotal is called from createOrder.\n");
  git("add", "-A");
  return { dir, home, project, env: { MMO_HOME: home, HOME: home, PATH: process.env.PATH }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one call, several terms: every hit comes with its line, an exact Read range and the enclosing declaration; secret files are never searched", () => {
  const r = repo();
  try {
    const out = lookup({ terms: ["computeTotal", "TAX"], projectDir: r.project, stamp: { session_id: "s1" }, env: r.env });
    assert.equal(out.status, "ok", JSON.stringify(out));
    assert.ok(out.hits >= 4 && out.files >= 3, `${out.hits} hits in ${out.files} files`);
    assert.match(out.text, /src\/items\.js/);
    assert.match(out.text, /L\d+: export function computeTotal/);
    assert.match(out.text, /Read src\/orders\.js offset 1 limit \d+ \(in fn createOrder\(req, res\) L1-L\d+\)/, "a hit inside a function names the function and its range");
    assert.doesNotMatch(out.text, /\.env/, "a secret-bearing file is never searched or named");
    const events = readFileSync(join(r.home, "sessions", "s1", "events.jsonl"), "utf8");
    assert.match(events, /"type":"lookup.used"/);
  } finally { r.cleanup(); }
});

test("bounded: a hit cap with a plain 'more not shown' line, terms that are too short or too many are refused, and outside a git repository it refuses instead of scanning", () => {
  const r = repo();
  try {
    const capped = lookup({ terms: ["res"], maxHits: 2, projectDir: r.project, env: r.env });
    assert.equal(capped.status, "ok");
    assert.equal(capped.shown, 2);
    assert.match(capped.text, /more hit/);
    assert.equal(lookup({ terms: ["x"], projectDir: r.project, env: r.env }).status, "refused");
    assert.equal(lookup({ terms: Array.from({ length: 9 }, (_, i) => "term" + i), projectDir: r.project, env: r.env }).status, "refused");
    assert.equal(lookup({ terms: ["nothing-here-at-all"], projectDir: r.project, env: r.env }).status, "empty");
    const bare = mkdtempSync(join(tmpdir(), "mmo-nogit-"));
    try { assert.equal(lookup({ terms: ["computeTotal"], projectDir: bare, env: r.env }).status, "refused"); } finally { rmSync(bare, { recursive: true, force: true }); }
  } finally { r.cleanup(); }
});
