/**
 * setup.test.mjs — guards the install path a first-time user walks.
 *
 * Two things are protected here. First, the decision table in
 * verify-setup.mjs: it decides whether a user is told their setup is ready,
 * and getting it wrong either blocks a legitimate Claude-only user or clears
 * a broken install to spend money. Second, the marketplace catalogue and the
 * names quoted in SETUP.md, which have no other check — a rename in one place
 * and not the other produces an install command that fails for everyone while
 * every file involved still looks correct on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  nodeMajorFrom,
  mcpPaths,
  evaluate,
  adcPath,
  hasGeminiCredentials,
} from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** A machine on which everything is in place. Tests vary one fact at a time. */
const healthy = {
  nodeMajor: 20,
  hasClaudeCli: true,
  hasNodeModules: true,
  hasDist: true,
  env: { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" },
};

const idsOf = (state) => state.problems.map((p) => p.id);

// ─── pure helpers ─────────────────────────────────────────────────────

test("nodeMajorFrom reads the major version, and refuses to guess", () => {
  assert.equal(nodeMajorFrom("20.11.1"), 20);
  assert.equal(nodeMajorFrom("22.0.0"), 22);
  assert.equal(nodeMajorFrom("not-a-version"), 0);
});

test("mcpPaths resolves the server paths under the plugin root", () => {
  const paths = mcpPaths("/plugins/orch");
  assert.equal(paths.serverDir, "/plugins/orch/mcp/gemini-flash-server");
  assert.equal(paths.distEntry, "/plugins/orch/mcp/gemini-flash-server/dist/server.js");
  assert.equal(paths.nodeModules, "/plugins/orch/mcp/gemini-flash-server/node_modules");
});

// ─── the decision table ───────────────────────────────────────────────

test("a fully prepared machine reports ready with nothing outstanding", () => {
  const state = evaluate(healthy);
  assert.equal(state.ok, true);
  assert.deepEqual(state.problems, []);
});

test("a missing server build blocks, and names the mid-run failure it prevents", () => {
  // The defect this whole script exists for: `/plugin install` succeeds while
  // dist/server.js is absent, and the run dies at the first dispatch.
  const state = evaluate({ ...healthy, hasDist: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["mcp-build"]);
  assert.match(state.problems[0].message, /dispatch/i);
  assert.match(state.problems[0].fix, /--fix/);
});

test("missing dependencies block, and both repairable faults are reported together", () => {
  // A fresh clone has neither. Reporting only the first would send the user
  // through two round trips to learn about the second.
  const state = evaluate({ ...healthy, hasNodeModules: false, hasDist: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["mcp-dependencies", "mcp-build"]);
});

test("Node older than 20 blocks and points at an upgrade, not at --fix", () => {
  const state = evaluate({ ...healthy, nodeMajor: 18 });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["node-version"]);
  assert.match(state.problems[0].fix, /nodejs\.org|nvm/);
});

test("a missing Claude Code CLI blocks with its install command", () => {
  const state = evaluate({ ...healthy, hasClaudeCli: false });
  assert.equal(state.ok, false);
  assert.deepEqual(idsOf(state), ["claude-cli"]);
  assert.match(state.problems[0].fix, /@anthropic-ai\/claude-code/);
});

test("absent credentials warn but do not block — a Claude-only run is legitimate", () => {
  // Failing here would tell a user with a working subscription and no Gemini
  // account that their setup is broken. It is not.
  const state = evaluate({ ...healthy, env: {} });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), ["anthropic-key", "gemini-credentials"]);
  assert.ok(state.problems.every((p) => p.severity === "warning"));
});

test("a service-account file satisfies the Gemini requirement without an API key", () => {
  const state = evaluate({
    ...healthy,
    env: { ANTHROPIC_API_KEY: "x", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" },
  });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), []);
});

test("a plain `gcloud auth application-default login` satisfies it too", () => {
  // That command sets no environment variable — it writes a credentials file
  // and nothing else. Checking env vars alone told every ordinary Google
  // Cloud user they had no credentials, while offering Vertex AI as an
  // option two lines further down. Their runs worked; the report was wrong.
  const state = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" }, hasAdcFile: true });
  assert.equal(state.ok, true);
  assert.deepEqual(idsOf(state), []);
});

test("a Google Cloud project named in the environment satisfies it", () => {
  const state = evaluate({
    ...healthy,
    env: { ANTHROPIC_API_KEY: "x", GOOGLE_CLOUD_PROJECT: "some-project" },
  });
  assert.deepEqual(idsOf(state), []);
});

test("the missing-Gemini fix names both doors, Vertex first", () => {
  // A field engineer at a company with Google Cloud should not be sent to
  // create a personal AI Studio key; the fix text is the only place that
  // steering happens.
  const state = evaluate({ ...healthy, env: { ANTHROPIC_API_KEY: "x" } });
  const problem = state.problems.find((p) => p.id === "gemini-credentials");
  assert.ok(problem, "expected a gemini-credentials warning");
  assert.match(problem.fix, /gcloud auth application-default login/);
  assert.match(problem.fix, /GEMINI_API_KEY/);
  assert.ok(
    problem.fix.indexOf("gcloud") < problem.fix.indexOf("GEMINI_API_KEY"),
    "the keyless Vertex path should be offered before the API-key path",
  );
});

test("hasGeminiCredentials accepts any one door and rejects none", () => {
  assert.equal(hasGeminiCredentials({ env: {} }), false);
  assert.equal(hasGeminiCredentials({ env: { GEMINI_API_KEY: "k" } }), true);
  assert.equal(hasGeminiCredentials({ env: {}, hasAdcFile: true }), true);
  assert.equal(hasGeminiCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" } }), true);
  assert.equal(hasGeminiCredentials({ env: { GOOGLE_CLOUD_PROJECT: "p" } }), true);
});

test("every credential the check accepts is one the server actually honours", () => {
  // The two lists are written in different languages in different packages and
  // cannot import each other, so nothing but this test stops them drifting.
  // Drift is silent and expensive in one direction: a name accepted here but
  // ignored by the server clears the setup check, and the run then dies at the
  // first Gemini dispatch — after the premium phases have already been billed.
  // Both files, because the API key name arrives indirectly: the adapter reads
  // it from the policy's `auth.env` and only defaults to GEMINI_API_KEY, so it
  // never appears as a literal `env.GEMINI_API_KEY` in the transport.
  // Comments are stripped first — a name that survives only in prose after its
  // handling was deleted would otherwise still pass.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const source = ["geminiTransports.ts", "GeminiFlashAdapter.ts"]
    .map((f) =>
      stripComments(
        readFileSync(join(ROOT, "plugin/mcp/gemini-flash-server/src/adapters", f), "utf8"),
      ),
    )
    .join("\n");

  const candidates = [
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT_ID",
  ];
  for (const name of candidates) {
    if (!hasGeminiCredentials({ env: { [name]: "x" } })) continue;
    assert.ok(
      source.includes(name),
      `${name} clears the setup check but no adapter code reads it`,
    );
  }
});

test("both env-forwarding sites carry every name the server reads", () => {
  // A stdio MCP server does not inherit the parent environment. Anything the
  // server reads has to be forwarded explicitly, in both places that spawn it:
  // the plugin manifest (install path) and tools/setup.mjs (clone path).
  // Miss one and that path alone fails, which is the hardest kind to notice.
  const names = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GEMINI_BACKEND",
  ];
  // Read whichever server the manifest declares rather than a hardcoded key,
  // so renaming the server does not turn this into a false pass.
  const servers = Object.values(readJson("plugin/.claude-plugin/plugin.json").mcpServers ?? {});
  assert.equal(servers.length, 1, "expected exactly one bundled MCP server");
  const manifestEnv = servers[0].env ?? {};
  const setupSource = readFileSync(join(ROOT, "tools/setup.mjs"), "utf8");
  for (const name of names) {
    assert.ok(name in manifestEnv, `plugin.json does not forward ${name} to the MCP server`);
    assert.ok(setupSource.includes(name), `tools/setup.mjs does not forward ${name}`);
  }
});

test("adcPath matches where gcloud writes credentials", () => {
  // Kept in step by hand with defaultAdcPath() in the server and ADC_FILE in
  // tools/setup.mjs — three copies, because none of the three files can
  // import the others.
  assert.equal(
    adcPath("/home/someone"),
    "/home/someone/.config/gcloud/application_default_credentials.json",
  );
});

// ─── the catalogue a first install reads ──────────────────────────────

test("marketplace.json carries the fields Claude Code requires", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.match(mkt.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "marketplace name must be kebab-case");
  assert.ok(mkt.owner?.name, "owner.name is required");
  assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length > 0);
  for (const p of mkt.plugins) {
    assert.ok(p.name, "every plugin entry needs a name");
    assert.equal(typeof p.source, "string");
    assert.match(p.source, /^\.\//, "a relative plugin source must start with ./");
  }
});

test("the marketplace name is not one Anthropic reserves", () => {
  // A reserved name stops loading on every launch, which would break the
  // install for every user at once with no change on our side.
  const reserved = new Set([
    "claude-code-marketplace", "claude-code-plugins", "claude-plugins-official",
    "claude-plugins-community", "claude-community", "anthropic-marketplace",
    "anthropic-plugins", "agent-skills", "anthropic-agent-skills",
    "knowledge-work-plugins", "life-sciences", "claude-for-legal",
    "claude-for-financial-services", "financial-services-plugins",
    "first-party-plugins", "healthcare",
  ]);
  const { name } = readJson(".claude-plugin/marketplace.json");
  assert.equal(reserved.has(name), false, `${name} is reserved for Anthropic use`);
  assert.equal(/anthropic|official.*claude/i.test(name), false, "name must not imitate an official source");
});

test("every plugin source resolves to a directory holding a plugin manifest", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  for (const p of mkt.plugins) {
    const manifest = join(ROOT, p.source, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(manifest), `${p.source} has no .claude-plugin/plugin.json`);
    assert.equal(
      JSON.parse(readFileSync(manifest, "utf8")).name,
      p.name,
      "the catalogue name and the plugin manifest name must match, or install resolves nothing"
    );
  }
});

test("the setup script ships inside the plugin, where an install can reach it", () => {
  // It lives under plugin/ on purpose: the plugin directory is what gets
  // copied into the plugin cache, so the script is present after an install
  // even when the user never cloned the repo.
  const { plugins } = readJson(".claude-plugin/marketplace.json");
  for (const p of plugins) {
    assert.ok(existsSync(join(ROOT, p.source, "scripts", "verify-setup.mjs")));
  }
});

test("SETUP.md quotes the names the catalogue actually publishes", () => {
  const setup = readFileSync(join(ROOT, "SETUP.md"), "utf8");
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.ok(
    setup.includes(`${mkt.plugins[0].name}@${mkt.name}`),
    "the install command in SETUP.md must match the published names"
  );
  // The path is wrapped in a shell expansion that resolves the versioned
  // cache directory, so assert on the script and the repair flag separately
  // rather than on one literal command string.
  assert.ok(setup.includes("verify-setup.mjs"), "SETUP.md must invoke the setup script");
  assert.ok(
    setup.includes("--fix"),
    "SETUP.md must tell Claude Code to run the build step, not just the check"
  );
  assert.ok(
    /marketplace add https:\/\/github\.com\/.*\.git/.test(setup),
    "the marketplace must be added over HTTPS; the owner/repo shorthand clones over SSH"
  );
});

test("the README documents the install a first-time user is given, with the real names", () => {
  // The README is the first thing anyone reads, and it is the one place the
  // repair command can be copied from without an install already working.
  // A rename that misses it hands users a command that silently finds nothing.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.ok(readme.includes("SETUP.md"), "the README must point at the instructions Claude Code follows");
  assert.ok(
    readme.includes(`cache/${mkt.name}/${mkt.plugins[0].name}/`),
    "the repair command in the README must use the published marketplace and plugin names"
  );
});
