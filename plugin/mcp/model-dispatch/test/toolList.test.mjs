/**
 * The tools this server lists, read the way Claude Code reads them: the built server started over stdio, an MCP
 * `initialize`, then `tools/list`.
 *
 * Why (0.8.4): zero-touch keeps only its workflow routing (a plain-words request starts the matching /mmo: workflow).
 * The generic orchestrator that made other chats cheaper is removed, and with it the ten worker tools this server used
 * to list in every chat, workflow runs included (fix_from_analysis, write_files_from_specs, lookup, ...). The list is
 * the pipeline's own tools and the executor's, nothing else, so a chat never sees a tool it cannot use.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

/** Starts the server, lists its tools, stops it. Messages are newline-delimited JSON-RPC (the MCP stdio transport). */
function listTools() {
  const project = mkdtempSync(join(tmpdir(), "mmo-tool-list-"));
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [SERVER], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: project, CLAUDE_PROJECT_DIR: project },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = setTimeout(() => { p.kill(); fail(new Error("the server did not answer tools/list within 15 s")); }, 15000);
    let buf = "";
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (msg.id === 2) {
          clearTimeout(stop);
          p.kill();
          rmSync(project, { recursive: true, force: true });
          done(msg.result?.tools ?? []);
        }
      }
    });
    p.on("error", fail);
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-list-test", version: "0" } },
    }) + "\n");
  });
}

test("the server lists the pipeline's tools and the executor's, and none of the removed chat-worker tools", async () => {
  const names = (await listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [
    "execute_stage",
    "execute_with_model",
    "finalize_spec",
    "load_policy",
    "log_telemetry",
    "preflight_dispatch",
    "simulate_policy",
    "submit_spec_section",
  ]);
});
