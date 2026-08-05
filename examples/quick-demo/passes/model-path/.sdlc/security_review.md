# Security Review — Ping Service

- **Date:** 2026-08-05
- **Scope reviewed:** `/workspace/ping-service/src` — `app.js`, `server.js`, `package.json`, `package-lock.json`, `README.md`, `.gitignore`, `__tests__/ping.test.js`
- **Specifications:** `.sdlc/requirements.md`, `.sdlc/design.md`
- **Method:** full file enumeration (`find` / `ls -R`, no reliance on unavailable search tools), line-by-line read of every non-`node_modules` file, `grep -rn` secret sweep across the whole tree, `npm audit --omit=dev` and `npm audit`, `npm ls --omit=dev --all`, plus live black-box probing of a running instance and a targeted harness that forces the error handler down every branch it has.

---

## Executive summary

**Overall risk rating: LOW.**

The service is genuinely small and genuinely inert: 27 lines of application code, one runtime dependency, one GET route, no body parser, no query/param/header read, no persistence, no file system access, no child processes, no regular expressions applied to user input, and no user-controlled value that reaches any response. I confirmed by live probe that path traversal attempts, encoded `<script>` payloads, malformed percent-encoding, unknown methods, and a 1 MB request body all return the same constant 21-byte JSON 404 with no reflection whatsoever. There is no injection, no reflected XSS, no SSRF, and no unbounded per-request work. `npm audit` and `npm audit --omit=dev` both report **0 vulnerabilities**, runtime and dev.

Two things are real and worth fixing, neither of which is a blocker. First, `X-Powered-By: Express` is served on every response (confirmed on the wire) — minor version-family fingerprinting, fixed by one line. Second, the JSON error handler forwards `err.status` to `res.status()` without validating it; I proved in a harness that a non-numeric status causes `res.json()` to throw, which unwinds to Express's default `finalhandler` and emits an **HTML page containing a full stack trace with absolute filesystem paths** — the exact outcome FR-9 / NFR-7 / ADR-002 exist to prevent. That path is **not reachable in the code as it stands today** (nothing in the current app can generate an error at all), so it is latent, not exploitable — but it is a two-line fix that makes the guarantee in the design document actually true rather than incidentally true.

The security posture of this service rests almost entirely on the fact that it has nothing to attack, not on defensive engineering. That is a legitimate and approved position for a health-check endpoint, and the "Accepted risks" section below states the residual exposure plainly so the decision stays an informed one.

---

## Findings

| ID | Title | Severity | Status |
|---|---|---|---|
| F-01 | Unvalidated `err.status` in the error handler can unwind to Express's HTML default handler and leak a stack trace | Low (latent — not currently reachable) | Open |
| F-02 | `X-Powered-By: Express` disclosed on every response | Low | Open |
| F-03 | Express 4.x is on the maintenance line, not the current major | Informational | Open |
| F-04 | No `server.on('error')` handler and no process-level rejection handling; Express 4 does not catch async handler rejections | Informational (availability) | Open |
| F-05 | `.gitignore` covers only `node_modules/` and `coverage/`; no `.env` / `.DS_Store` guard, and the tree is not yet a git repository | Informational (hygiene) | Open |

No High or Critical findings. No Medium findings.

---

## F-01 — Unvalidated `err.status` can unwind to Express's HTML default handler

**Severity:** Low (latent — no reachable trigger in the current code)
**Category:** Information disclosure
**Location:** `/workspace/ping-service/src/app.js:17-25`

### Evidence

```js
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500;   // <-- taken on trust
  res.status(status).json({
    error: 'internal server error'
  });
});
```

The body is correctly constant — it never includes `err.message` or `err.stack`, which is right and satisfies the letter of FR-9. The problem is the *status*, not the body. `res.status()` accepts anything; Node's `writeHead` then validates it and throws `ERR_HTTP_INVALID_STATUS_CODE`. That throw happens *inside* the error handler, so Express cannot route it to another error handler — it goes to `finalhandler`, which is precisely the HTML emitter ADR-002 was written to avoid.

I reproduced the middleware stack exactly (same three layers, same order) and drove the handler through each branch:

| Injected error | Result |
|---|---|
| `throw new Error('...')` | `500`, `application/json`, `{"error":"internal server error"}` — clean |
| `err.status = 418` | `418`, JSON, clean |
| `err.status = 999` | `999`, JSON, clean (odd, but no leak) |
| `err.status = 'abc'` | **`500`, `text/html`, `<!DOCTYPE html> ... <pre>RangeError [ERR_HTTP_INVALID_STATUS_CODE]: Invalid status code: abc<br>&nbsp;&nbsp;at ServerResponse.writeHead (node:_http_server:418:11)<br>&nbsp;&nbsp;at ... /workspace/ping-service/src/node_modules/express/lib/response.js:232:10 ...</pre>` — full stack trace and absolute host paths in the response body** |

Secondary, same line: for a `400`-class error the client is told `"internal server error"`, which is inaccurate rather than insecure.

### Reachability today

**None.** I probed the live service with malformed percent-encoding (`/%`, `/%ZZ`), a 30 KB URL, an unknown method, `TRACE`, `OPTIONS`, and a 1 MB unparsed POST body — every one produced the constant JSON 404, and the error handler was never entered. There is no body parser, no `express.static`, no route that throws, and Express 4.22's `Layer.match` swallows `URIError` from malformed paths into a non-match. So there is currently no attacker-reachable way to put any object into `err`. This is a defense-in-depth finding about a guarantee that holds by accident of there being no errors, not by construction.

### Impact

If reachable: disclosure of stack frames, dependency file paths, absolute host filesystem paths, and the Node internals version — classic reconnaissance material. The realistic route to reachability is a future change: adding `express.json()` (whose parse errors carry `err.status`, and whose `err.type` values are attacker-influenced), mounting middleware that sets a non-numeric status, or upgrading a dependency that does. `app.js` is the file a maintainer would touch to add any of those.

### Recommendation

Clamp the status to a valid range and default anything else to 500, and wrap the send so a throw can never escape:

```js
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const raw = Number(err && (err.status || err.statusCode));
  const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  res.status(status).json({
    error: status >= 500 ? 'internal server error' : 'bad request'
  });
});
```

Add a unit test that injects `err.status = 'abc'` via a temporary throwing route and asserts `content-type: application/json` and `expect(res.text).not.toMatch(/<html/i)` — the existing suite asserts no-HTML only on the 404 path, so the error handler's HTML guarantee is currently untested.

---

## F-02 — `X-Powered-By: Express` disclosed on every response

**Severity:** Low
**Category:** Information disclosure / fingerprinting
**Location:** `/workspace/ping-service/src/app.js:2` (omission — `app.disable('x-powered-by')` is never called; confirmed by `grep -rn "x-powered-by\|xPoweredBy\|disable(" --exclude-dir=node_modules src/` → no matches)

### Evidence

Live capture from the running service:

```
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
...
{"status":"ok","time":"2026-08-04T18:58:08.957Z"}
```

Present on the 200, the 404, and the `HEAD` response alike. Express sets this by default; nothing in the code turns it off.

### Scope note

This is deliberately treated as in scope. The approved out-of-scope item is *"security headers (helmet)"* — that is about **adding** protective headers (CSP, HSTS, `X-Frame-Options`) to a service that serves no HTML and sets no cookies, where the benefit is close to zero. F-02 is the opposite operation: **removing** a header Express volunteers about itself. It needs no dependency, no configuration, and no new middleware, and it does not reopen the helmet decision.

### Impact

Low, and I will not inflate it. It tells a scanner the stack is Express (framework family, not version) and slightly cheapens mass-scanning for Express-specific CVEs. It grants no access and enables no exploit on its own. It is worth fixing because the fix costs one line and zero risk, not because the exposure is significant.

### Recommendation

In `app.js`, immediately after `const app = express();`:

```js
app.disable('x-powered-by');
```

Assert it in the existing test: `expect(res.headers['x-powered-by']).toBeUndefined();`.

---

## F-03 — Express 4.x is on the maintenance line

**Severity:** Informational
**Category:** Dependency risk
**Location:** `/workspace/ping-service/src/package.json:16`

### Evidence

`"express": "^4.19.2"` resolves to **express@4.22.2** (`npm ls --omit=dev --all`). Both `npm audit --omit=dev` and full `npm audit` report **`found 0 vulnerabilities`** — no advisory affects this tree, runtime or dev. 4.22.2 is ahead of the fixes for the known 4.x advisories (open-redirect in `response.redirect`, `res.links` header injection), and the transitive tree is current: `body-parser@1.20.6`, `qs@6.15.3`, `cookie@0.7.2`, `raw-body@2.5.3`, `path-to-regexp@0.1.x` (as vendored by 4.22.2), `finalhandler@1.3.2`.

Note that `body-parser` and `qs` are present on disk as Express dependencies but are **never registered** as middleware, so their parsing surface is not exposed.

Express 5 is the current major; 4.x receives security fixes but not hardening work. ADR-002/§294 of the design records the deliberate choice of 4 over 5 (path-to-regexp wildcard syntax and error-handling changes). That reasoning is sound for this service.

### Recommendation

No action now. Track it: re-run `npm audit --omit=dev` on any dependency bump, and revisit Express 5 if this app ever grows routes with parameters. If you do move to Express 5, note that it changes error handling in a way that would *also* resolve the async half of F-04.

---

## F-04 — No listener error handling; async rejections are uncaught

**Severity:** Informational (availability, not confidentiality)
**Category:** Denial of service / robustness
**Location:** `/workspace/ping-service/src/server.js:1-3`

### Evidence

```js
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Ping service listening on port ${PORT}`); });
```

There is no `server.on('error', ...)`. If port 3000 is already bound, or is privileged and the process is unprivileged, the `'error'` event is unhandled and Node terminates with an `EADDRINUSE` stack trace on stderr. That trace goes to the operator's console, never to a client, so it is not a disclosure — it is a startup-failure ergonomics issue.

Separately, Express 4 does not await handler return values: a rejected promise from an `async` route handler bypasses the error handler entirely and surfaces as an unhandled rejection, which under Node's default `--unhandled-rejections=throw` **crashes the process**. I confirmed this in the harness (`Error: async boom` terminated the run). No handler in the current app is `async`, so this is latent, and it is the same class of trap as F-01: the guarantee holds because there is nothing to test it.

I also verified the server's inherited timeouts are Node defaults and are reasonable: `headersTimeout 60000`, `requestTimeout 300000`, `keepAliveTimeout 5000`. These give baseline slowloris resistance without tuning.

### Recommendation

Optional and low priority for a health check. If uptime matters:

```js
const server = app.listen(PORT, () => { console.log(`Ping service listening on port ${PORT}`); });
server.on('error', (err) => {
  console.error(`Failed to bind port ${PORT}: ${err.code}`);
  process.exit(1);
});
```

If any handler is ever made `async`, wrap it so the rejection reaches the error handler, or move to Express 5.

---

## F-05 — `.gitignore` scope and repository state

**Severity:** Informational (hygiene)
**Category:** Secrets & config
**Location:** `/workspace/ping-service/src/.gitignore`

### Evidence

The file contains exactly:

```
node_modules/
coverage/
```

`node_modules/` **is** covered — that specific checklist item passes. `package-lock.json` is correctly *not* ignored, which is right for reproducible installs and audit fidelity.

Two observations, neither of them a request to add a config layer:

1. There is no `.env` pattern. I verified by `find` that **no `.env` file exists anywhere in the tree**, which matches ADR-003 exactly — this is not a "missing dotenv" complaint. The point is forward-looking: if a maintainer ever drops a `.env` in, nothing would stop it being committed. A single `.env*` line costs nothing and closes that door before it opens.
2. `/workspace/ping-service/.DS_Store` exists at the repo root and is not ignored, and the root has no `.gitignore` at all — the only one is inside `src/`. The tree is also **not currently a git repository**, so no ignore rule is in force yet.

### Recommendation

Add `.env*` and `.DS_Store` to `src/.gitignore`, and place a `.gitignore` at the repository root covering `.DS_Store` when the repo is initialized. No `.env.example` is needed — ADR-003 rules it out, and with `PORT` as the sole knob (documented in `README.md:27`) there is nothing for it to document.

---

## Accepted risks (out of scope by design)

Approved at two gates and recorded in `.sdlc/requirements.md` §"Out of scope" and `.sdlc/design.md` ADR-003. These are **not** defects and require no fix. They are stated with their residual exposure so the posture is understood as *"there is little to attack"* rather than *"this is hardened"* — those are different things, and only the first is true here.

| Area | Decision | Residual exposure if deployed as-is |
|---|---|---|
| **Authentication / authorization / roles** | No auth. `GET /ping` is public by design (role matrix, `requirements.md:72`). | Anyone who can reach the port can confirm the service is alive and enumerate that `/ping` exists. There is no data behind it and no state to alter, so the disclosure is limited to liveness plus the clock reading in F-07 below. If the service is ever placed on a network where mere reachability is sensitive, this becomes a network-boundary question, not a code one. |
| **Logging** | None, anywhere. | **This is the most consequential accepted risk.** There is no record of who called the service, when, from where, or how often. An attacker probing this host leaves zero trace in the application; abuse is invisible and post-incident reconstruction is impossible. It also means F-01, if it ever became reachable, would fire silently. |
| **Rate limiting** | None. | A single client can drive the endpoint as fast as the socket allows. Each request is O(1) — one `Date` allocation and a ~49-byte serialization, no I/O and no blocking — so the practical ceiling is Node's event loop and the host's network capacity, not algorithmic amplification. Node's default `keepAliveTimeout` (5 s) and `headersTimeout` (60 s) provide baseline slowloris resistance. Expect the endpoint to be usable as a cheap liveness oracle and as a (poor) amplification target; it will not fall over from application-level cost. |
| **Security headers (helmet)** | Not installed. | The service returns only `application/json` and sets no cookies, so CSP, HSTS, `X-Frame-Options`, and friends have essentially no attack to prevent here. Genuinely near-zero residual risk — the weakest of the accepted risks. Note F-02 is explicitly *not* covered by this acceptance. |
| **CORS** | Not configured. | No `Access-Control-Allow-Origin` is sent, so browsers block cross-origin reads of the response by default. This is the safe default; the residual issue is functional (a browser-based dashboard could not read `/ping`), not a security one. |
| **TLS termination** | Out of scope; plaintext HTTP listener. | Traffic is unencrypted and unauthenticated in transit. The payload is a status string and a timestamp — nothing confidential — but the endpoint is trivially spoofable by an on-path attacker, so a green `/ping` cannot be treated as a trustworthy signal without TLS in front of it. Terminate TLS at the ingress. |
| **Docker / CI** | Out of scope. | No automated dependency scanning on a schedule. Today's clean `npm audit` is a point-in-time result from 2026-08-05, not a standing guarantee; a future advisory against Express or a transitive package will go unnoticed until someone runs the command by hand. |
| **Database / persistence / ORM** | None (`requirements.md:15`). | Removes the entire injection and data-at-rest class. No residual exposure. |
| **Config layer / dotenv / `.env`** | ADR-003 — `process.env.PORT` read inline, literal default `3000`. | No config file to leak, no secret loader to misconfigure. `PORT` is not sensitive. No residual exposure. |
| **Swagger / OpenAPI** | Out of scope. | No machine-readable schema to hand an attacker. Slightly *reduces* exposure. |

### PII and audit-log checklist items — not applicable

The PII inventory in `requirements.md:62-66` is deliberately empty, and I verified this against the code rather than taking the document's word for it: `app.js` never reads `req.body`, `req.query`, `req.params`, `req.headers`, or `req.cookies`; the only response values are the literal `'ok'` and a server-generated timestamp. There is no `government_id`, `bank_account`, or `salary_base` field anywhere in the tree — confirmed by `grep -rn` across all non-`node_modules` files. Consequently the encryption-at-rest, role-based response masking, audit-log ordering, append-only audit table, and auditor-role-read checks have **no subject matter in this codebase**. They are recorded here as *not applicable*, explicitly not as *passing* — there is nothing to encrypt and nothing to mask, which is a different statement from "encryption and masking are correctly implemented."

Likewise, the JWT-secret and password-hashing checks are not applicable: there is no authentication code, no `jsonwebtoken` or `bcrypt`/`argon2` dependency, and no credential handling of any kind.

---

## Verified clean

Each item below was actively tested, not inferred from the absence of a search result.

**Information disclosure**
- Error handler body is a constant string; `err.message` and `err.stack` never reach the response (`app.js:22-24`), verified by forcing a throw — response was `{"error":"internal server error"}` and nothing more.
- Express's HTML `finalhandler` is unreachable by any request I could construct. Probed: `/nope`, `/%`, `/%ZZ`, a 30 KB URL, `POST /ping`, `OPTIONS /ping`, `TRACE /ping`, `-X FOOBAR`, and a 1 MB body — all returned `404 {"error":"not found"}` with `content-type: application/json`. (The one theoretical route to `finalhandler` is F-01, which has no live trigger.)
- The `res.headersSent` guard at `app.js:18` is correct: delegating to `next(err)` after headers are sent causes `finalhandler` to destroy the socket rather than attempt a second response — no HTML, no partial leak.
- No hostname, internal path, dependency version, or build metadata appears in any response body.
- Node-core-level rejections were checked separately and are clean: oversized headers return a bare `431 Request Header Fields Too Large` and a malformed request line returns a bare `400 Bad Request`, both with no body and no server banner.

**Input surface**
- No body parser is registered — `express.json()`, `express.urlencoded()`, and `express.text()` are all absent from `app.js`. A 1 MB `application/json` POST was accepted and discarded without parsing.
- No query parameter is echoed: `GET /ping?x=<script>` returned the identical unmodified `{"status":"ok","time":"..."}`.
- No path segment is reflected: `GET /%3Cscript%3Ealert(1)%3C/script%3E` returned the constant 21-byte 404 body. The 404 handler ignores `req` entirely.
- No reflected-XSS, no HTML rendering, no template engine, no injection sink of any kind. No `eval`, no `Function`, no `child_process`, no `fs`, no network egress.

**Denial of service**
- Per-request work is O(1) and constant: one `new Date()`, one `toISOString()`, one small JSON serialization. No loops over user input, no recursion, no unbounded allocation.
- No regular expression is applied to any user-controlled value anywhere in `app.js` or `server.js` — the only regexes in the tree are ISO-8601 assertions inside the test file, applied to server-generated output. **No ReDoS surface.**
- No synchronous blocking calls: no `fs.*Sync`, no `execSync`, no `crypto.*Sync`, no busy loop.
- Server timeouts are Node defaults and sane (`headersTimeout` 60 s, `requestTimeout` 300 s, `keepAliveTimeout` 5 s).

**Dependencies**
- `npm audit --omit=dev` → `found 0 vulnerabilities` (exit 0). **Runtime exposure: none.**
- `npm audit` (including dev) → `found 0 vulnerabilities`. **Dev-only exposure: none.** `jest@29.7.0` and `supertest@7.0.0` are dev-only and never loaded by `npm start`.
- Exactly one runtime dependency (`express@4.22.2`), satisfying NFR-3. Full transitive tree resolved and inspected via `npm ls --omit=dev --all` — no advisory, no deprecated-with-known-issue package.

**Secrets**
- The prescribed sweep `grep -rE "(api[_-]?key|secret|password)[ \t]*=[ \t]*['\"][a-zA-Z0-9]"` returned **no matches**, as did a broader case-insensitive sweep for `secret|password|api_key|token|credential|BEGIN RSA/PRIVATE KEY` across every non-`node_modules` file. The only hit was the package name `js-tokens` in `package-lock.json` — a false positive.
- No hardcoded credential, token, or key in `app.js`, `server.js`, `package.json`, `README.md`, or `__tests__/ping.test.js`. The test file uses supertest against the in-process app and carries no fixture credentials.
- `find` confirmed **no `.env` file exists anywhere** in the tree — consistent with ADR-003, not an oversight.
- `node_modules/` is gitignored (`src/.gitignore:1`).

**Correctness of the security-relevant design**
- Middleware order is correct and matches `design.md` §4: route → path-less 404 → 4-arity error handler last. The error handler's arity (4) is right, so Express will actually treat it as an error handler rather than silently as normal middleware.
- `app.js` exports the app without calling `listen()` (FR-10); `server.js` is the sole binding entry point (FR-11). This keeps the test suite from binding a port.
- `OPTIONS /ping` returns the JSON 404 rather than Express's default `Allow: GET,HEAD` response — verified on the wire. The path-less 404 middleware responds before the router's built-in OPTIONS handler runs, so no method enumeration is offered.
- `npm test` passes (2/2) and the suite includes explicit `expect(res.text).not.toMatch(/<html/i)` assertions on both 404 paths.

**F-07 — residual risk of the open, unauthenticated `/ping`**
The endpoint is intentionally public and approved; the only thing it discloses beyond liveness is the server's wall-clock reading to millisecond precision, which marginally aids an attacker fingerprinting clock skew or reasoning about time-dependent tokens elsewhere in the estate — negligible for a health check, but worth naming rather than leaving implied.

---

## Required fixes before sign-off

**Nothing here is a deployment blocker.** The two items below are recommended because they are cheap, not because they are urgent.

1. **F-02 — add `app.disable('x-powered-by');`** to `app.js` after `const app = express();`, plus a one-line test assertion. One line, no dependency, no scope reopened.
2. **F-01 — validate the status in the error handler** (clamp to 400–599, default 500) and add a regression test that forces a non-numeric `err.status` and asserts the response is JSON and contains no `<html`. This makes ADR-002's "the service never emits HTML under any code path" true by construction rather than by the current absence of any error source — which matters because `app.js` is exactly the file a future maintainer will edit to add `express.json()`.

**Recommended but optional:** F-05 (`.env*` and `.DS_Store` in `.gitignore`), F-04 (`server.on('error')`).

**Before this is exposed to any untrusted network,** revisit two accepted risks with the operator — not as code changes, but as deployment decisions: **TLS termination at the ingress** (without it a green `/ping` is spoofable and cannot be trusted as a health signal) and **request logging at the proxy** (with zero application logging, abuse of this endpoint is currently invisible and unreconstructable).
