/**
 * agent-enable.test.mjs — the command that turns the agent path on, and the two
 * findings that catch the mistakes it was written to make impossible.
 *
 * The failure this whole file guards against is a real one, not a hypothetical.
 * The selection is an environment variable whose value is a PAIR —
 * `gemini-flash=flash-agsdk-worker` — and the half that carries the meaning is
 * the right half, so that is the half people write. `flash-agsdk-worker` alone
 * looks like a complete answer. It is not one, and until `--enable-agent`
 * existed the only way to set this on an installed plugin was to open a JSON
 * file and type it. What that produced: a setup check that reported green
 * (because it found no agent selection, so it skipped building the Python
 * environment), and then a run that threw at policy load — after the premium
 * phases had already been billed.
 *
 * Two things had to change, and both are pinned here. The command writes the
 * spec so nobody has to know its shape, and a malformed spec is now a blocking
 * finding rather than a silent no-op. A third check covers the credential door:
 * the agent worker signs with Application Default Credentials and has no
 * API-key branch at all, so an AI-Studio-key-only install that selects it would
 * pass every offline check and fail at the first delegated packet.
 *
 * Everything here is offline and free. Filesystem tests write into a temporary
 * directory and never touch the real `~/.claude` or the repo's own settings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSelectSpec,
  selectSpecProblem,
  hasVertexCredentials,
  settingsPathFor,
  withAgentSelection,
  withMcpSelection,
  isBundledServerEntry,
  enableAgentPath,
  evaluate,
  AGENT_WORKER_MODEL_ID,
  AGENT_WORKER_SLOT,
  AGENT_WORKER_SELECT,
} from "../../plugin/scripts/verify-setup.mjs";

/** A scratch directory that cleans itself up, so no test can leak into $HOME. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-enable-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A machine on which everything unrelated to the selection is in place. */
const healthy = {
  nodeMajor: 20,
  hasClaudeCli: true,
  hasNodeModules: true,
  hasDist: true,
  hasAdcFile: false,
  env: {},
  agentWorker: { selected: false, hasVenv: false, hasSdk: false, python: null },
};

// ─── the spec, parsed ────────────────────────────────────────────────────

test("the constants spell one valid pair, never assembled by hand", () => {
  assert.equal(AGENT_WORKER_SELECT, `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`);
  const { pairs, invalid } = parseSelectSpec(AGENT_WORKER_SELECT);
  assert.deepEqual(invalid, []);
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

test("an absent, empty or whitespace spec is no choices, not an error", () => {
  // These three have to behave identically: an unset variable, a variable the
  // wizard wrote as "", and one a shell expanded to spaces all mean the same
  // thing to a user who took the default.
  for (const spec of [undefined, null, "", "   "]) {
    assert.deepEqual(parseSelectSpec(spec), { pairs: {}, invalid: [] });
  }
});

test("several pairs parse independently, and stray whitespace is tolerated", () => {
  const { pairs, invalid } = parseSelectSpec(` a=1 , ${AGENT_WORKER_SELECT} `);
  assert.deepEqual(invalid, []);
  assert.equal(pairs.a, "1");
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

test("a piece with no usable '=' is collected as invalid, not silently dropped", () => {
  // Dropping was the old behaviour and it is what made the bare leaf survive
  // all the way to policy load.
  for (const bad of ["flash-agsdk-worker", "=x", "slot=", "just-words"]) {
    const { invalid } = parseSelectSpec(bad);
    assert.deepEqual(invalid, [bad], `'${bad}' must be reported, not ignored`);
  }
});

test("one bad piece does not discard the good ones alongside it", () => {
  const { pairs, invalid } = parseSelectSpec(`oops,${AGENT_WORKER_SELECT}`);
  assert.deepEqual(invalid, ["oops"]);
  assert.equal(pairs[AGENT_WORKER_SLOT], AGENT_WORKER_MODEL_ID);
});

// ─── the malformed-spec finding ──────────────────────────────────────────

test("a valid spec produces no finding", () => {
  assert.equal(selectSpecProblem({ SDLC_SELECT: AGENT_WORKER_SELECT }), null);
  assert.equal(selectSpecProblem({}), null);
  assert.equal(selectSpecProblem({ SDLC_SELECT: "" }), null);
});

test("the bare leaf is named as the exact mistake it is", () => {
  const problem = selectSpecProblem({ SDLC_SELECT: AGENT_WORKER_MODEL_ID });
  assert.ok(problem, "a bare leaf must be a finding");
  assert.equal(problem.severity, "blocking");
  // The message has to say WHICH half is missing. "Invalid value" sends the
  // reader back to the same file to make the same edit.
  assert.match(problem.message, /is the option, not the whole selection/);
  assert.match(problem.fix, new RegExp(AGENT_WORKER_SELECT));
  assert.match(problem.fix, /--enable-agent/);
});

test("any other malformed spec is blocking too, and quotes what it saw", () => {
  const problem = selectSpecProblem({ SDLC_SELECT: "gibberish" });
  assert.ok(problem);
  assert.equal(problem.severity, "blocking");
  assert.match(problem.message, /'gibberish'/);
  // Only the bare-leaf case gets the extra sentence; a random typo does not
  // deserve a paragraph about a leaf the user never mentioned.
  assert.ok(!/is the option, not the whole selection/.test(problem.message));
});

test("evaluate surfaces the malformed spec as a blocking problem", () => {
  const { ok, problems } = evaluate({
    ...healthy,
    env: { SDLC_SELECT: AGENT_WORKER_MODEL_ID },
  });
  assert.equal(ok, false, "a spec no policy can load must not report a runnable install");
  assert.ok(problems.some((p) => p.id === "select-spec"));
});

// ─── the credential door ─────────────────────────────────────────────────

test("Vertex credentials are recognised by any of the three ways they arrive", () => {
  assert.equal(hasVertexCredentials({ env: {}, hasAdcFile: false }), false);
  assert.equal(hasVertexCredentials({ env: {}, hasAdcFile: true }), true);
  assert.equal(hasVertexCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" } }), true);
  assert.equal(hasVertexCredentials({ env: { GOOGLE_CLOUD_PROJECT: "proj" } }), true);
});

test("an AI Studio key does not satisfy the agent path", () => {
  // gemini_worker.py constructs its client with vertex=True and has no
  // API-key branch, so a GEMINI_API_KEY is not a partial credential here — it
  // is the wrong door entirely, and saying so is the whole value of the check.
  assert.equal(hasVertexCredentials({ env: { GEMINI_API_KEY: "AIza-x" } }), false);

  const { ok, problems } = evaluate({
    ...healthy,
    env: { SDLC_SELECT: AGENT_WORKER_SELECT, GEMINI_API_KEY: "AIza-x" },
    agentWorker: { selected: true, hasVenv: true, hasSdk: true, python: "/py" },
  });
  const problem = problems.find((p) => p.id === "agent-worker-credentials");
  assert.ok(problem, "selecting the agent path with no Vertex credentials must block");
  assert.equal(ok, false);
  assert.match(problem.message, /AI Studio path/);
  assert.match(problem.fix, /gcloud auth application-default login/);
  assert.match(problem.fix, /--disable-agent/);
});

test("the credential check is silent for anyone who did not select the agent path", () => {
  // The model path works with an AI Studio key and always has. A user on it
  // must never be told to run a gcloud command they do not need.
  const { problems } = evaluate({ ...healthy, env: { GEMINI_API_KEY: "AIza-x" } });
  assert.ok(!problems.some((p) => p.id === "agent-worker-credentials"));
});

test("Vertex credentials present means no credential finding", () => {
  const { problems } = evaluate({
    ...healthy,
    hasAdcFile: true,
    env: { SDLC_SELECT: AGENT_WORKER_SELECT },
    agentWorker: { selected: true, hasVenv: true, hasSdk: true, python: "/py" },
  });
  assert.ok(!problems.some((p) => p.id === "agent-worker-credentials"));
});

// ─── which file gets written ─────────────────────────────────────────────

test("the default scope is this folder's local settings, not the machine's", () => {
  // A machine-wide default would silently change every other project the user
  // opens, and the agent path is a per-project decision.
  assert.equal(settingsPathFor("project", "/w", "/h"), join("/w", ".claude", "settings.local.json"));
  assert.equal(settingsPathFor("user", "/w", "/h"), join("/h", ".claude", "settings.json"));
});

test("the project target is the local file, which is not the committed one", () => {
  // .claude/settings.json is committed; whether the agent path works depends on
  // the machine, so a teammate must not inherit this selection from a clone.
  assert.ok(settingsPathFor("project", "/w", "/h").endsWith("settings.local.json"));
});

// ─── the merge rules ─────────────────────────────────────────────────────

test("enabling adds the pair and leaves every other key alone", () => {
  const next = withAgentSelection(
    { permissions: { allow: ["Bash"] }, env: { ANTHROPIC_API_KEY: "sk-x" } },
    true
  );
  assert.equal(next.env.SDLC_SELECT, AGENT_WORKER_SELECT);
  assert.equal(next.env.ANTHROPIC_API_KEY, "sk-x", "the user's key must survive");
  assert.deepEqual(next.permissions, { allow: ["Bash"] });
});

test("enabling is idempotent, so running the command twice is harmless", () => {
  const once = withAgentSelection({}, true);
  assert.deepEqual(withAgentSelection(once, true), once);
});

test("disabling removes our pair and keeps anyone else's", () => {
  const next = withAgentSelection({ env: { SDLC_SELECT: `other=x,${AGENT_WORKER_SELECT}` } }, false);
  assert.equal(next.env.SDLC_SELECT, "other=x");
});

test("disabling deletes the variable rather than leaving an empty string", () => {
  // An empty spec and an absent one must behave identically at the parser, and
  // only one of the two looks like it was meant.
  const next = withAgentSelection({ env: { SDLC_SELECT: AGENT_WORKER_SELECT } }, false);
  assert.ok(!("SDLC_SELECT" in (next.env ?? {})));
});

test("an env block that becomes empty is removed, not left as {}", () => {
  const next = withAgentSelection({ env: { SDLC_SELECT: AGENT_WORKER_SELECT } }, false);
  assert.ok(!("env" in next), "an empty env block is noise in a file the user reads");
});

test("disabling leaves a selection this command did not make", () => {
  // Someone who pinned the slot to the completion leaf on purpose said
  // something; --disable-agent means "not the agent", not "forget everything".
  const next = withAgentSelection(
    { env: { SDLC_SELECT: `${AGENT_WORKER_SLOT}=flash-completion` } },
    false
  );
  assert.equal(next.env.SDLC_SELECT, `${AGENT_WORKER_SLOT}=flash-completion`);
});

test("a malformed existing spec is repaired, not merged", () => {
  // This is the mistake the command exists to fix. Preserving the bad piece
  // would leave the policy unable to load and make the command useless.
  const next = withAgentSelection({ env: { SDLC_SELECT: AGENT_WORKER_MODEL_ID } }, true);
  assert.equal(next.env.SDLC_SELECT, AGENT_WORKER_SELECT);
});

test("withAgentSelection does not mutate what it was given", () => {
  const before = { env: { ANTHROPIC_API_KEY: "sk-x" } };
  withAgentSelection(before, true);
  assert.deepEqual(before, { env: { ANTHROPIC_API_KEY: "sk-x" } });
});

// ─── the clone route's .mcp.json ─────────────────────────────────────────

test("only the bundled server is recognised, and by its script not its key", () => {
  const ours = { command: "node", args: [join("/x", "gemini-flash-server", "dist", "server.js")] };
  assert.equal(isBundledServerEntry(ours), true);
  assert.equal(isBundledServerEntry({ command: "node", args: ["/x/other/dist/server.js"] }), false);
  assert.equal(isBundledServerEntry({ command: "uvx", args: ["some-mcp"] }), false);
  assert.equal(isBundledServerEntry({}), false);
});

test("the selection reaches the clone route's server entry", () => {
  // On that route the entry's env block is exhaustive — a stdio server does not
  // inherit the parent environment — so a settings-only write would be read by
  // Claude Code and then dropped at the server boundary.
  const doc = {
    mcpServers: {
      "gemini-flash-server": {
        command: "node",
        args: [join("/x", "gemini-flash-server", "dist", "server.js")],
        env: { GEMINI_API_KEY: "AIza-x" },
      },
      other: { command: "uvx", args: ["some-mcp"], env: { A: "1" } },
    },
  };
  const { config, updated } = withMcpSelection(doc, true);
  assert.deepEqual(updated, ["gemini-flash-server"]);
  assert.equal(config.mcpServers["gemini-flash-server"].env.SDLC_SELECT, AGENT_WORKER_SELECT);
  assert.equal(config.mcpServers["gemini-flash-server"].env.GEMINI_API_KEY, "AIza-x");
  assert.deepEqual(config.mcpServers.other.env, { A: "1" }, "another server must be untouched");
});

test("a document with no bundled server is returned unchanged", () => {
  const doc = { mcpServers: { other: { command: "uvx", args: ["x"] } } };
  assert.deepEqual(withMcpSelection(doc, true), { config: doc, updated: [] });
  assert.deepEqual(withMcpSelection({}, true), { config: {}, updated: [] });
});

// ─── writing to disk ─────────────────────────────────────────────────────

test("the settings file is created when it does not exist", () =>
  withTempDir((cwd) => {
    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.spec, AGENT_WORKER_SELECT);
    assert.equal(result.mcpPath, null, "no .mcp.json here, so nothing to report");
    assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), {
      env: { SDLC_SELECT: AGENT_WORKER_SELECT },
    });
  }));

test("an existing settings file is merged, not replaced", () =>
  withTempDir((cwd) => {
    const path = join(cwd, ".claude", "settings.local.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-x" }, model: "opus" }));

    enableAgentPath({ cwd, enabled: true });
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.env.ANTHROPIC_API_KEY, "sk-x");
    assert.equal(after.env.SDLC_SELECT, AGENT_WORKER_SELECT);
    assert.equal(after.model, "opus");
  }));

test("a clone's .mcp.json is updated alongside the settings file", () =>
  withTempDir((cwd) => {
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "gemini-flash-server": {
            command: "node",
            args: [join(cwd, "plugin", "mcp", "gemini-flash-server", "dist", "server.js")],
            env: { GEMINI_API_KEY: "AIza-x" },
          },
        },
      })
    );

    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.mcpPath, mcpPath, "the caller must be able to name the file it changed");
    const after = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.equal(after.mcpServers["gemini-flash-server"].env.SDLC_SELECT, AGENT_WORKER_SELECT);
    assert.equal(after.mcpServers["gemini-flash-server"].env.GEMINI_API_KEY, "AIza-x");
  }));

test("no .mcp.json is created where there was none", () =>
  withTempDir((cwd) => {
    enableAgentPath({ cwd, enabled: true });
    assert.equal(
      existsSync(join(cwd, ".mcp.json")),
      false,
      "a routing flag must not register a server at a path it guessed"
    );
  }));

test("disabling clears the selection from both files", () =>
  withTempDir((cwd) => {
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "gemini-flash-server": {
            command: "node",
            args: [join(cwd, "gemini-flash-server", "dist", "server.js")],
            env: { SDLC_SELECT: AGENT_WORKER_SELECT, GEMINI_API_KEY: "AIza-x" },
          },
        },
      })
    );
    enableAgentPath({ cwd, enabled: true });
    const result = enableAgentPath({ cwd, enabled: false });

    assert.equal(result.spec, null);
    assert.ok(!("SDLC_SELECT" in (JSON.parse(readFileSync(result.path, "utf8")).env ?? {})));
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.ok(!("SDLC_SELECT" in mcp.mcpServers["gemini-flash-server"].env));
    assert.equal(mcp.mcpServers["gemini-flash-server"].env.GEMINI_API_KEY, "AIza-x");
  }));

test("an unreadable settings file is refused, and nothing at all is written", () =>
  withTempDir((cwd) => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const path = join(cwd, ".claude", "settings.local.json");
    writeFileSync(path, "{ not json");
    const mcpPath = join(cwd, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          s: { command: "node", args: [join(cwd, "gemini-flash-server", "dist", "server.js")] },
        },
      })
    );

    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json", "the user's file must be left alone");
    // The refusal happens before any write, so the install is not half-changed.
    assert.ok(!/SDLC_SELECT/.test(readFileSync(mcpPath, "utf8")));
  }));

test("an unreadable .mcp.json is refused before the settings file is touched", () =>
  withTempDir((cwd) => {
    writeFileSync(join(cwd, ".mcp.json"), "{ not json");
    const result = enableAgentPath({ cwd, enabled: true });
    assert.equal(result.ok, false);
    assert.equal(
      existsSync(join(cwd, ".claude", "settings.local.json")),
      false,
      "a half-applied selection is worse than none"
    );
  }));
