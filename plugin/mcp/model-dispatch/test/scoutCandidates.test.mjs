/**
 * scout-candidates.mjs: the deterministic candidate set the repo scout packet
 * reads before the architect plans. No git in the fixture, so the walker path
 * is what runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { extractTerms, scoreFiles, pickCandidates, hitWindows, main, LARGE_FILE_BYTES } = await import(
  join(HERE, "..", "..", "..", "scripts", "scout-candidates.mjs")
);

const REQ = `# Requirements
- FR-1: add \`GET /public-profile/:userId\` mirroring \`GET /public-project/:id\` in \`apps/api/src/index.ts\`.
- FR-2: a new TanStack route \`apps/web/src/routes/public-profile.$userId.tsx\` reusing the \`components/public-project/*\` kit.
- FR-3: the default avatar falls back like \`resolveAvatarSrc\`.
- Off-limits: \`.env\`, \`.git/**\`, \`dist/**\`, \`node_modules/**\`.
`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "mmo-scout-"));
  const w = (p, c) => { mkdirSync(join(root, dirname(p)), { recursive: true }); writeFileSync(join(root, p), c); };
  w("apps/api/src/index.ts", "const publicProjectApi = api.get(\"/public-project/:id\");\n" + "x\n".repeat(50));
  w("apps/api/src/user/avatar.ts", "export function resolveAvatarSrc() {}\n");
  w("apps/api/src/project/controllers/get-public-project.ts", "export default async function getPublicProject() {}\n");
  w("apps/web/src/routes/public-project.$projectId.tsx", "import { KaneoBranding } from '@/components/public-project/kaneo-branding';\n");
  w("apps/web/src/components/public-project/kaneo-branding.tsx", "export function KaneoBranding() {}\n");
  w("apps/web/src/components/public-project/loading-skeleton.tsx", "export function LoadingSkeleton() {}\n");
  w("tests/api/project/get-public-project.test.ts", "describe('getPublicProject', () => {});\n");
  w("tests/api/unrelated.test.ts", "describe('nothing', () => {});\n");
  w("README.md", "public-project public-profile resolveAvatarSrc\n");
  w("node_modules/x/index.js", "public-project\n");
  w("dist/bundle.js", "public-project\n");
  w("apps/web/public/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  w(".env", "public-project\n");
  w("i18n/en-US.json", "{\n" + "\"k\": \"public-project\",\n".repeat(2000) + "\"z\": 1\n}\n");
  for (const l of ["fr-FR", "de-DE", "es-ES", "it-IT"]) w(`i18n/${l}.json`, "{\n" + "\"k\": \"public-project\",\n".repeat(2000) + "\"z\": 1\n}\n");
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, allowlist: ["apps/api/src/user/**", "apps/web/src/routes/public-profile.$userId.tsx"] }));
  writeFileSync(join(root, "requirements.md"), REQ);
  return root;
}

test("extractTerms: identifiers, kebab names and paths are strong; globs, dotfiles and stop words are not", () => {
  const terms = extractTerms(REQ);
  const w = Object.fromEntries(terms.map((t) => [t.term, t.weight]));
  assert.equal(w["apps/api/src/index.ts"], 4);
  assert.equal(w["components/public-project/"], 4, "a directory glob names its directory");
  assert.equal(w["public-profile"], 3);
  assert.equal(w["resolveavatarsrc"], 3);
  assert.equal(w["public-project"], 3);
  assert.equal(w[".env"], undefined);
  assert.equal(w[".git/**"], undefined);
  assert.equal(w["dist/**"], undefined);
  assert.equal(w["/public-profile/:userid"], undefined, "routes are not terms; their kebab parts are");
  assert.equal(w["the"], undefined);
  assert.equal(w["dist"], 1, "a plain word inside backticks is weak");
});

test("scoreFiles + pickCandidates: the right files lead, excluded paths never appear, siblings are capped, large files become windows", () => {
  const root = repo();
  const terms = extractTerms(REQ);
  const files = ["apps/api/src/index.ts", "apps/api/src/user/avatar.ts", "apps/api/src/project/controllers/get-public-project.ts",
    "apps/web/src/routes/public-project.$projectId.tsx", "apps/web/src/components/public-project/kaneo-branding.tsx",
    "apps/web/src/components/public-project/loading-skeleton.tsx", "tests/api/project/get-public-project.test.ts", "tests/api/unrelated.test.ts",
    "README.md", "node_modules/x/index.js", "dist/bundle.js", "apps/web/public/logo.png", ".env",
    "i18n/en-US.json", "i18n/fr-FR.json", "i18n/de-DE.json", "i18n/es-ES.json", "i18n/it-IT.json"];
  const scored = scoreFiles({ root, files, terms, allowlist: ["apps/api/src/user/**"], maxFileBytes: 120_000 });
  const paths = scored.map((s) => s.path);
  assert.ok(!paths.includes("node_modules/x/index.js") && !paths.includes("dist/bundle.js") && !paths.includes(".env") && !paths.includes("apps/web/public/logo.png"));
  assert.ok(!paths.includes("tests/api/unrelated.test.ts"), "a test with no hits and no matching source is not a candidate");
  assert.ok(paths.indexOf("apps/api/src/index.ts") < 5, `the path named in the requirements is near the top: ${paths.slice(0, 4)}`);
  assert.ok(paths.indexOf("apps/web/src/components/public-project/kaneo-branding.tsx") < paths.indexOf("README.md"), "the kit directory outranks prose");
  const kit = scored.find((s) => s.path.endsWith("loading-skeleton.tsx"));
  assert.ok(kit && kit.hits.includes("path:components/public-project/"), "files under a named directory get the path hit");
  const t = scored.find((s) => s.path === "tests/api/project/get-public-project.test.ts");
  assert.ok(t && t.hits.includes("test-of-top-source"));
  const av = scored.find((s) => s.path === "apps/api/src/user/avatar.ts");
  assert.ok(av.hits.includes("allowlist"));
  const locales = paths.filter((p) => p.startsWith("i18n/"));
  assert.ok(locales.length <= 2, `sibling cap keeps at most two of the identical locale files, got ${locales.length}`);
  const big = scored.find((s) => s.path === "i18n/en-US.json");
  assert.ok(big.bytes > LARGE_FILE_BYTES && Array.isArray(big.windows) && big.windows.length >= 1, "a large file carries hit windows");

  const picked = pickCandidates(scored, { maxFiles: 3, maxBytes: 1_000_000 });
  assert.equal(picked.length, 3);
  assert.ok(picked.every((p) => typeof p.input_bytes === "number" && p.test === undefined));
  const tight = pickCandidates(scored, { maxFiles: 10, maxBytes: 200 });
  assert.ok(tight.every((p) => p.input_bytes <= 200), "the byte budget skips what does not fit and keeps going");
  rmSync(root, { recursive: true, force: true });
});

test("hitWindows: merged ±25-line ranges around the heaviest hits, at most four, clipped to the file", () => {
  const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  const offAt = (line) => content.split("\n").slice(0, line - 1).join("\n").length + 1;
  const w = hitWindows(content, [[offAt(10), 4], [offAt(20), 3], [offAt(150), 4], [offAt(290), 2]], 300);
  assert.deepEqual(w, [[1, 45], [125, 175], [265, 300]]);
  assert.deepEqual(hitWindows(content, [], 300), [[1, 50]]);
});

test("main writes the candidate file and returns 0; usage errors return 2", () => {
  const root = repo();
  const out = join(root, "scout-candidates.json");
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    assert.equal(main(["--project-root", root, "--requirements", join(root, "requirements.md"), "--max-files", "6", "--out", out, "--json"]), 0);
    assert.equal(main(["--project-root", root]), 2);
    assert.equal(main(["--project-root", root, "--requirements", join(root, "nope.md")]), 2);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const r = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(r.candidates.length <= 6 && r.candidates.length >= 3);
  assert.ok(r.terms.every((t) => t.weight >= 2));
  assert.ok(r.candidates.slice(0, 5).some((c) => c.path === "apps/api/src/index.ts"));
  rmSync(root, { recursive: true, force: true });
});
