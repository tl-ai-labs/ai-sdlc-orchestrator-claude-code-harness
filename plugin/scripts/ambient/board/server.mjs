#!/usr/bin/env node
/**
 * The live board: a local page over the real ambient-mode records.
 *
 *   node server.mjs [--pair <sessionA> <sessionB>] [--port <n>] [--new-token]
 *
 * It prints one URL. The page is for the person at this machine only:
 *   - binds 127.0.0.1 on a port the OS picks, never a public interface;
 *   - every request must carry the token AND a Host header that names this
 *     exact address, so a web page in the browser cannot read the board by
 *     guessing the port (cross-site requests carry another Host or no token);
 *   - the token is made once and kept in <MMO_HOME>/board-token (mode 0600),
 *     so the link in an open tab keeps working after a restart. `--new-token`
 *     replaces it, and the old link stops working;
 *   - exactly three routes. There is no file serving, so there is no path to
 *     walk out of;
 *   - a strict Content-Security-Policy: no inline script, no other origin, no
 *     external font. Styles are allowed only with this launch's nonce.
 * The page itself writes every value with textContent, never as markup.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildData } from "./data.mjs";
import { ensureDir, mmoHome } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The board's token: read from <MMO_HOME>/board-token when it holds a valid
 * one, otherwise (or with newToken) made fresh and stored there, owner-only.
 * A file that does not hold exactly 48 hex characters is never trusted.
 */
function boardToken(env, newToken) {
  const file = join(mmoHome(env), "board-token");
  if (!newToken) {
    try {
      const kept = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{48}$/.test(kept)) return kept;
    } catch { /* first launch on this machine */ }
  }
  const token = randomBytes(24).toString("hex");
  ensureDir(mmoHome(env));
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode on write; set it explicitly
  return token;
}

export function startBoard({ env = process.env, pair = null, port = 0, newToken = false } = {}) {
  const token = boardToken(env, newToken);
  const nonce = randomBytes(16).toString("base64");
  const page = readFileSync(join(HERE, "page.html"), "utf8").replaceAll("__NONCE__", nonce).replaceAll("__TOKEN__", token);
  const script = readFileSync(join(HERE, "app.js"), "utf8");

  const server = createServer((req, res) => {
    const address = server.address();
    const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    const headers = {
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin",
    };
    const send = (code, type, body) => { res.writeHead(code, { ...headers, "Content-Type": type }); res.end(body); };
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch { return send(400, "text/plain", "bad request"); }
    if (req.method !== "GET") return send(405, "text/plain", "GET only");
    if (!allowedHosts.has(String(req.headers.host))) return send(403, "text/plain", "wrong host");
    if (!sameToken(url.searchParams.get("t"), token)) return send(403, "text/plain", "missing or wrong token");
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", page);
    if (url.pathname === "/app.js") return send(200, "text/javascript; charset=utf-8", script);
    if (url.pathname === "/data.json") {
      try { return send(200, "application/json; charset=utf-8", JSON.stringify(buildData({ env, pair }))); }
      catch (e) { return send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(e.message).slice(0, 200) })); }
    }
    return send(404, "text/plain", "no such page");
  });

  return new Promise((ready) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      ready({ server, token, url: `http://127.0.0.1:${p}/?t=${token}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--pair");
  const pair = i >= 0 && args[i + 1] && args[i + 2] ? [args[i + 1], args[i + 2]] : null;
  const p = args.indexOf("--port");
  const board = await startBoard({ pair, port: p >= 0 && /^\d+$/.test(args[p + 1] ?? "") ? Number(args[p + 1]) : 0, newToken: args.includes("--new-token") });
  console.log(`mmo board: ${board.url}\n(local to this machine; Ctrl-C stops it)`);
}
