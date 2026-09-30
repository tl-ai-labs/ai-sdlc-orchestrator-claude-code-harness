/**
 * How a Claude-login worker is started, for the typed pipeline and for a
 * zero-touch hand-over. 0.8.3 is 0.7.6's pipeline with zero-touch added: a typed
 * /mmo: command must start its worker exactly as 0.7.6 did, so the safety
 * switches zero-touch needs belong to the hand-over's launch alone. The
 * zero-touch branch (ed8e701) had put them on the pipeline's launch too; that
 * change is parked as its own pipeline change (docs/methodology.md, v0.8.3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCliArgs } from "../dist/adapters/ClaudeCliAdapter.js";

// A --help that lists every switch this code knows, as Claude Code 2.1.270 prints them.
const HELP_ALL =
  "  --safe-mode   Start with all customizations disabled\n" +
  "  --strict-mcp-config  Only use MCP servers from --mcp-config\n" +
  "  --disable-slash-commands  Disable all skills\n" +
  "  --tools <tools...>  Use \"\" to disable all tools\n";

test("the pipeline's claude worker starts exactly as in 0.7.6, whatever switches the CLI lists", () => {
  const plain = ["-p", "--model", "claude-sonnet-5", "--output-format", "json"];
  assert.deepEqual(claudeCliArgs("claude-sonnet-5", HELP_ALL, {}), plain);
  assert.deepEqual(claudeCliArgs("claude-sonnet-5", "  --model <model>\n", {}), plain);
});

test("a chat job's worker gets no tools and the safety switches this CLI has; a CLI that cannot promise no tools is refused", () => {
  // A chat job's worker turns a brief into text, and code checks that text
  // before anything lands. With tools it could read or write files those
  // checks never see; `--tools ""` is Claude Code's own "no tools at all".
  assert.deepEqual(
    claudeCliArgs("claude-sonnet-5", HELP_ALL, { noTools: true }),
    ["-p", "--model", "claude-sonnet-5", "--output-format", "json", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--tools", ""],
  );
  const onlyTools = "  --tools <tools...>  Use \"\" to disable all tools\n";
  assert.deepEqual(claudeCliArgs("m", onlyTools, { noTools: true }), ["-p", "--model", "m", "--output-format", "json", "--tools", ""], "a switch this CLI lacks is never passed");
  assert.throws(() => claudeCliArgs("m", "  --model <model>\n", { noTools: true }), /no --tools/);
  assert.ok(!claudeCliArgs("m", "  --bare  Minimal mode\n" + HELP_ALL, { noTools: true }).includes("--bare"), "--bare skips keychain reads, which a subscription login needs");
});
