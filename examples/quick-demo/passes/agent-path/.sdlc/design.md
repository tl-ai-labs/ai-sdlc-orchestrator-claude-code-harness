# Design — Ping Service

**Source requirements:** `/workspace/ping-service/.sdlc/requirements.md` (human-approved at Gate 1 — authoritative)
**Source brief:** `/workspace/ping-service/brief.md`
**Phase:** design · **Code directory:** `./src` at the repo root

---

## 1. Overview and design goals

A single-process Express HTTP service exposing exactly one route, `GET /ping`, plus a JSON catch-all that answers `404` for everything else. There is no database, no auth, no logging framework, no build step, and no configuration layer.

Design goals, in priority order:

1. **Minimum file count.** Five generated files. No `src/common/`, no `controllers/`, no `services/`, no `config/`, no `middleware/` directory. Three of the five files are JavaScript, and each is under 25 lines.
2. **Minimum dependency count.** Exactly one production dependency (`express`) and exactly two dev dependencies (`jest`, `supertest`), per NFR-9. No `dotenv`, no `http-errors`, no `morgan`, no `helmet`, no `cross-env`.
3. **Testability without a bound port.** `app` is exported from a module that never calls `listen()` (FR-12), so supertest mounts it directly (NFR-8).
4. **No HTML anywhere.** Every response body the process can emit is JSON (FR-11, AC-8). Express's built-in HTML error page is unreachable by construction.
5. **Zero configuration surface.** One optional environment variable (`PORT`), read in one place, unvalidated. No validation schema, no `.env` files of any kind (NFR-10).

Non-goals, restated so codegen does not drift: no layering, no dependency injection, no error-class hierarchy, no route registry, no `index.js` barrel files, no TypeScript, no `"type": "module"`.

---

## 2. File / module layout

All paths below are relative to `./src` at the repo root. The generated project is flat — no subdirectories.

```
package.json      manifest: name, CommonJS (no "type" field), engines >=20, deps, start/test scripts
app.js            builds and exports the Express app: /ping route, 404 catch-all, JSON error handler. Never calls listen()
server.js         process entrypoint: requires ./app, resolves the port, calls listen()
app.test.js       the single Jest + supertest suite: 200 case, unknown-path 404 case, wrong-method 404 case
README.md         docs: npm install / npm test / npm start, endpoint table, worked curl examples
```

Exactly five files. `npm install` creates `node_modules/` and `package-lock.json`; neither is authored.

**Files deliberately NOT generated** (listed so codegen does not invent them and review does not flag them as missing):

- `.gitignore` — not required by any requirement or acceptance criterion.
- `.env`, `.env.example`, `.env.test` — no config schema exists (see §6, NFR-10).
- `jest.config.js` — Jest's default `testMatch` finds `app.test.js`, and Jest ≥27 already defaults `testEnvironment` to `"node"`. `package.json` contains **no** `jest` key.
- `Dockerfile`, CI workflows, `.eslintrc`, `.prettierrc`, `tsconfig.json` — out of scope per requirements §2.

**File conventions:** every `.js` file starts with `'use strict';`. CommonJS only (`require` / `module.exports`), per NFR-2.

### Requirements traceability

| File | Satisfies |
|---|---|
| `app.js` | FR-1 – FR-12, AC-8 |
| `server.js` | FR-13, FR-14, AC-3 |
| `app.test.js` | FR-1 – FR-11 verification, AC-2, AC-4, AC-5, AC-6, NFR-4, NFR-8 |
| `package.json` | NFR-1, NFR-2, NFR-3, NFR-5, NFR-6, NFR-9 |
| `README.md` | AC-7 |

---

## 3. Module boundaries and the request lifecycle

### 3.1 Boundaries

There are exactly two runtime modules and one boundary between them.

- **`app.js`** owns *routing and response shape*. It imports `express` and nothing else. It reads **no** environment variables. It opens **no** sockets. Its only export is the Express application object.
- **`server.js`** owns *process lifecycle and binding*. It imports `./app` and nothing else. It is the **only** file that touches `process.env`. It exports nothing.

This split is FR-12 and is what makes the test suite portless. It is recorded as ADR-001.

No body parser is mounted. `express.json()`, `express.urlencoded()`, and `express.static()` are all absent — the one route accepts no input (requirements §2.6), so a parser would be dead weight and would introduce a second failure mode (a `400` on malformed JSON) that has no specified response shape.

### 3.2 Registration order in `app.js` — load-bearing

Three handlers are registered on the app, in this exact order. **The order is load-bearing; changing it breaks a requirement.**

| # | Registration | Arity | Purpose |
|---|---|---|---|
| 1 | `app.get('/ping', handler)` | 2 | The only route. Matches method `GET` and path `/ping` only. |
| 2 | `app.use(handler)` — **no path argument** | 3 `(req, res, next)` | Catch-all 404. Runs for every request that fell through #1. |
| 3 | `app.use(handler)` — **no path argument** | 4 `(err, req, res, next)` | Terminal JSON error handler. |

Why each position matters:

- **#2 must come after #1.** Express matches in registration order. A path-less `app.use()` matches every method and every path. Registered first, it would swallow `GET /ping` and the service would return `404` for its only route, failing FR-1/FR-2.
- **#3 must be registered last.** An error thrown *inside* the 404 handler (#2) must still land on a JSON error handler. Express dispatches errors only to handlers registered *after* the point of failure; if #3 were registered before #2, a throw inside #2 would fall through to Express's built-in handler and emit an HTML error page, violating FR-11 and AC-8.
- **#3 must have exactly four declared parameters.** Express identifies error middleware by `fn.length === 4`. Written with three parameters, it is treated as ordinary middleware, never receives `err`, and errors again fall to the built-in HTML handler. The `next` parameter must be declared even though it is used only in the `headersSent` guard. This is ADR-003.
- **#2 must be registered with `app.use(fn)` and no path string.** Do **not** write `app.all('*', ...)` or `app.use('*', ...)`. See ADR-004.

### 3.3 Request lifecycle

**Boot (production):** `npm start` → `node server.js` → `require('./app')` executes `app.js`, which constructs the app and registers handlers #1–#3 → `server.js` resolves `port` → `app.listen(port, cb)` binds and logs one line to stdout.

**Boot (test):** Jest loads `app.test.js` → `require('./app')` executes `app.js` → `require('supertest')(app)`. `server.js` is never loaded, so `listen()` is never called by the suite. Supertest creates a throwaway `http.Server` on an ephemeral port per request and closes it when the response completes, so no handle leaks and Jest exits cleanly (NFR-8).

**`GET /ping`:** matches #1 → handler computes `new Date().toISOString()` *at call time* (FR-6, not a module-level constant) → `res.status(200).json({ status: 'ok', time })` → response. #2 and #3 never run.

**`GET /nope`, `POST /ping`, `DELETE /anything`:** no match at #1 (path or method mismatch) → falls through to #2 → `res.status(404).json({ error: 'not found' })` → response. #3 never runs. `POST /ping` returning 404 rather than 405 is FR-9 / ADR-002.

**An unexpected throw:** any synchronous throw in #1 or #2 is caught by Express and dispatched to #3 → if `res.headersSent` is true, delegate to `next(err)` (the response is already committed and cannot be rewritten); otherwise `res.status(500).json({ error: 'internal server error' })`. No stack trace, no `err.message`, no HTML (FR-11). The `headersSent` guard is the only defensive branch in the codebase.

### 3.4 Accepted Express defaults

Recorded so review confirms them rather than flags them as oversights. None of these get a configuration line.

- `case sensitive routing` stays **off** (Express default): `/PING` returns `200`. No test asserts case behaviour.
- `strict routing` stays **off** (Express default): `/ping/` returns `200`.
- `x-powered-by` stays **on** (Express default). Removing it is a security-header concern, explicitly out of scope per requirements §2.4.
- `etag` stays **on** (Express default). The `time` field changes per request, so the ETag changes per request and no `304` can be served to a client that does not send `If-None-Match`.

---

## 4. API contract

Base URL in local development: `http://localhost:3000`. No authentication, no headers required, no query parameters, no request body accepted anywhere. One role exists: anonymous (requirements §6).

### 4.1 `GET /ping`

| Field | Value |
|---|---|
| Method | `GET` |
| Path | `/ping` |
| Request body | none |
| Auth | none |
| Status | `200` |
| `Content-Type` | `application/json; charset=utf-8` |

Response body — exactly two keys, `status` then `time`:

```json
{
  "status": "ok",
  "time": "2026-08-05T14:23:07.412Z"
}
```

- `status` (string) — always the literal `"ok"` (FR-4).
- `time` (string) — `new Date().toISOString()`, evaluated per request (FR-5, FR-6). Always UTC, always ends in `Z`, always parseable by `Date.parse`.

On the wire: `{"status":"ok","time":"2026-08-05T14:23:07.412Z"}`

### 4.2 Catch-all `404`

Applies to every method/path combination other than `GET /ping` — including `POST /ping`, `PUT /ping`, `DELETE /ping`, `GET /`, `GET /nope`, `GET /health`.

| Field | Value |
|---|---|
| Method | any |
| Path | any except `GET /ping` |
| Auth | none |
| Status | `404` |
| `Content-Type` | `application/json; charset=utf-8` |

```json
{
  "error": "not found"
}
```

On the wire: `{"error":"not found"}`

### 4.3 Unexpected error `500`

Not reachable by any specified input; specified so the surface is closed (FR-11).

| Field | Value |
|---|---|
| Status | `500` |
| `Content-Type` | `application/json; charset=utf-8` |

```json
{
  "error": "internal server error"
}
```

The body is a fixed literal. It never contains `err.message`, `err.stack`, a file path, or HTML.

> **Note for the test author:** `res.json()` emits `Content-Type: application/json; charset=utf-8`. Assert with a regex (`/application\/json/`) or `.expect('Content-Type', /json/)`. A strict equality assertion against `"application/json"` **will fail**.

---

## 5. Data model

**There is none.** No entities, no fields, no relationships, no indexes, no migrations, no ORM, no cache, no in-memory store, no module-level mutable state.

Persistence is explicitly out of scope (requirements §2.1). The service accepts no request body, no query parameters, and no path parameters; the only value it ever emits is a fresh reading of the server's own clock, which is computed per request and never retained. Nothing crosses a request boundary and nothing survives the process.

**PII:** none. The PII inventory in requirements §5 is empty by design. There is no field to classify, mask, encrypt, tokenize, or set a retention policy on, and therefore no encryption-at-rest, no key management, and no data-subject-request handling in scope.

Codegen must not create a `models/`, `entities/`, `schemas/`, or `db/` directory, and must not add a persistence dependency — doing so breaks NFR-9's hard count of one production dependency.

---

## 6. Configuration and environment

### 6.1 Complete environment variable inventory

| Name | Purpose | Read by | Format | Required at boot | Default |
|---|---|---|---|---|---|
| `PORT` | TCP port passed to `app.listen()` | `src/server.js`, one line | Decimal numeric string, `1`–`65535`. Passed to `listen()` as-is; Node accepts a numeric string. **Not validated, not coerced.** | **No** | `3000` |

That is the entire list. Resolution is exactly `const port = process.env.PORT || 3000;` (FR-14). No other variable is read anywhere in the codebase.

### 6.2 Explicitly absent configuration

**There is NO config validation schema for this project, and therefore NO `.env.example` and NO `.env.test` fixture are required or generated.**

This statement is a downstream contract: **the test runner uses it to skip env bootstrap entirely.** `npm test` must be invokable with a completely empty environment. There is no `.env` file to copy, no fixture to seed, and no boot-time validation that can fail on a missing key.

Consequences of that decision, stated concretely so no phase reintroduces them:

- No `dotenv` dependency. Adding one violates NFR-9 (production dependencies must total exactly one).
- No `ConfigModule`, no `config.js`, no `zod`/`joi`/`envalid` schema, no `assert` on startup.
- `app.js` reads `process.env` **zero** times. Only `server.js` does, and only for `PORT`.
- The application code never branches on `NODE_ENV`. Jest sets `NODE_ENV=test` in its own process; nothing in `src/` observes it.
- No JWT secret, no encryption key, no key-length constraint, no `DATABASE_URL`, no third-party API key or OAuth client secret, no feature flag, no `LOG_LEVEL` — none of these subsystems exist in this service.

### 6.3 Runtime prerequisites

Node.js ≥ 20 (NFR-1), declared as `"engines": { "node": ">=20" }` in `package.json`. No global tooling, no post-install step; `npm install` on a clean clone is sufficient (NFR-5).

### 6.4 `package.json` contract

- `"private": true`, no `"type"` field (CommonJS is the default and NFR-2 forbids `"type": "module"`).
- `"main": "app.js"`.
- Scripts: exactly `"start": "node server.js"` and `"test": "jest"`. No `build`, no `lint`, no `dev`, no `prepare`.
- `dependencies`: `{ "express": "^5.1.0" }` — one entry.
- `devDependencies`: `{ "jest": "^29.7.0", "supertest": "^7.1.1" }` — two entries.
- No `jest` key. No `engineStrict`. No `workspaces`.

---

## 7. Test strategy

**One test file: `app.test.js`** (NFR-4). It sits beside `app.js` so Jest's default `testMatch` finds it with no configuration. It imports `supertest` and `./app`. It never imports `server.js`, never calls `app.listen()`, and never closes a server.

### 7.1 Why supertest mounts the exported app

`request(app)` hands supertest the Express request handler; supertest wraps it in a throwaway `http.Server`, binds an OS-assigned ephemeral port for the duration of the single request, and closes it as the response resolves. Nothing binds `3000`, so the suite cannot collide with a running dev server, cannot fail on a busy port in CI, and leaves no open handle that would make Jest hang or print "did not exit one second after the test run completed" (NFR-8). This is the entire payoff of the FR-12 app/server split.

### 7.2 Suite structure — three `it` blocks

**Block 1 — `GET /ping` returns 200 (FR-1 – FR-7, AC-4).** Record `const before = Date.now()` immediately before the request and `const after = Date.now()` immediately after, then assert:

1. `res.status === 200`.
2. `res.headers['content-type']` matches `/application\/json/` (regex, not equality — charset suffix).
3. `res.body.status` is **exactly** the string `'ok'` (`toBe('ok')`, not truthiness, not `toMatch`).
4. `Object.keys(res.body).sort()` equals `['status', 'time']` — proves exactly two keys and no extras (FR-3).
5. `typeof res.body.time === 'string'`.
6. `Number.isNaN(Date.parse(res.body.time)) === false` — parseable ISO-8601 (FR-5).
7. `res.body.time === new Date(res.body.time).toISOString()` — proves the string is *canonical* ISO-8601 UTC, not merely something `Date.parse` tolerates.
8. `res.body.time.endsWith('Z') === true` — UTC, not a local offset (FR-5).
9. `Date.parse(res.body.time) >= before - 1000` and `<= after + 1000` — proves the timestamp is computed per request rather than captured at module load (FR-6). The ±1000 ms tolerance absorbs clock granularity without flaking.

**Block 2 — unknown path returns 404 JSON (FR-8, FR-10, AC-5).** Request `GET /nope`, then assert:

1. `res.status === 404`.
2. `res.headers['content-type']` matches `/application\/json/`.
3. `res.body` deep-equals `{ error: 'not found' }` (`toEqual`) — proves the exact body and no extra keys.
4. `res.text.trim().startsWith('<') === false` — proves the payload is **JSON and not HTML**. This is the assertion that would catch a regression to Express's default HTML error page, and it is the reason the test inspects `res.text` and not only `res.body` (AC-8).

**Block 3 — wrong method on `/ping` returns 404 JSON (FR-9).** Request `POST /ping` with no body, then assert `res.status === 404` and `res.body` deep-equals `{ error: 'not found' }`. The assertion is `404`, explicitly **not** `405`, and the test carries a comment naming FR-9 so a future reader does not "fix" it.

### 7.3 What is not tested

No test for the `500` handler — no input can reach it without mocking, and mocking would require a fourth file or a test-only route, both of which are scope growth. The handler's correctness is enforced by review against §3.2 (4-arity, registered last). No coverage thresholds, no snapshot tests, no load tests, no lint step in `npm test`.

---

## 8. Architecture decision records

### ADR-001 — Export the app from `app.js`; call `listen()` only in `server.js`

**Context.** Supertest needs an Express request handler, not a listening server. If the module that builds the app also calls `listen()`, then merely `require`-ing it in a test binds a TCP port, which collides with a running dev server, fails on busy ports, and leaves an open handle that keeps Jest alive after the run. FR-12 mandates the split.

**Decision.** `app.js` constructs the app, registers the three handlers, and ends with `module.exports = app;`. It contains no `listen`, no `process.env`, and no `console` call. `server.js` is a four-line entrypoint that requires `./app`, resolves the port, and calls `app.listen(port, cb)`. `package.json`'s `start` script targets `server.js`; `main` points at `app.js`.

**Consequences.** Tests import `./app` and bind nothing (NFR-8). Two files exist where a naive implementation would have one — accepted, and the cost is bounded at four lines. Anyone adding boot-time work (signal handlers, warmup) must put it in `server.js`, or the test suite will start executing it as a side effect of `require`.

### ADR-002 — A non-`GET` method on `/ping` returns `404`, not `405`

**Context.** `405 Method Not Allowed` (with an `Allow: GET` header) is the conventional HTTP answer for a known path with an unsupported method. The brief describes exactly one supported interaction and asks for the least machinery. Requirements FR-9 resolved this as `404` and the human approved it at Gate 1; it is closed.

**Decision.** `POST /ping`, `PUT /ping`, `DELETE /ping`, and every other non-`GET` method on `/ping` fall through the `app.get('/ping', ...)` registration into the path-less catch-all and receive `404` with `{"error":"not found"}`. No `Allow` header is emitted. No `app.all('/ping', ...)` guard is written.

**Consequences.** One handler covers both "unknown path" and "wrong method", so the code has a single 404 path and the catch-all needs no method awareness. The API is technically less RESTful; the service exposes one endpoint to one anonymous role, so no client can act on the distinction. Test block 3 asserts `404` and cites FR-9 so the behaviour is not "corrected" later.

### ADR-003 — JSON-only error surface via a terminal 4-arity error handler

**Context.** FR-11 and AC-8 forbid HTML bodies and stack traces in every response. Express ships a default error handler that renders an HTML page — including the stack trace when `NODE_ENV` is not `production`. That default fires whenever an error reaches the end of the middleware stack without a custom error handler, and it also fires if a handler is written with three parameters, because Express detects error middleware solely by `fn.length === 4`.

**Decision.** Register, as the **last** middleware in `app.js`, `app.use((err, req, res, next) => { ... })` with all four parameters declared. Its body is: if `res.headersSent`, `return next(err)`; otherwise `res.status(500).json({ error: 'internal server error' })`. The body is a fixed literal — no `err.message`, no `err.stack`, no error code. Registration last guarantees that a throw inside the 404 catch-all also lands here rather than on the built-in handler.

**Consequences.** Express's HTML error page becomes unreachable for any error raised inside the middleware stack, satisfying FR-11 and AC-8 by construction. Diagnostics are sacrificed — a `500` in production reveals nothing, which is acceptable because no route can produce one and logging is out of scope. The `headersSent` delegation is the one case where control returns to Express's default handler; it can only trigger after a response has already been committed, so no HTML can be written. Codegen must not shorten the parameter list to satisfy an unused-variable linter — there is no linter, and the arity is the mechanism.

### ADR-004 — Register the catch-all as a path-less `app.use()`, never `app.all('*')`

**Context.** Express 5 replaced path-to-regexp v0.x with v8, which **rejects a bare `*` as a path**. `app.all('*', handler)` and `app.use('*', handler)` throw `TypeError: Missing parameter name` at module load under Express 5 — the process dies before it can serve anything, and the test suite fails at `require('./app')` with an error that looks unrelated to routing. The Express 5 spelling is `'*splat'` or `'/{*splat}'`, which is unfamiliar and easy to get wrong.

**Decision.** The catch-all is `app.use((req, res) => { res.status(404).json({ error: 'not found' }); });` with **no path argument**. A path-less `app.use()` matches every method and every path in both Express 4 and Express 5. `express` is pinned at `^5.1.0`.

**Consequences.** The 404 handler is version-agnostic and cannot throw at boot. Because a path-less `app.use()` matches everything, its position after the `/ping` route becomes load-bearing (§3.2) — this is documented rather than defended with code. Any future route must be registered *above* the catch-all.

### ADR-005 — Flat file layout, no configuration layer, no fourth dependency

**Context.** The reflexive Express layout is `src/routes/`, `src/controllers/`, `src/middleware/`, `src/config/`, plus `dotenv` and a validation schema. This service has one route, one error handler, and one optional environment variable. NFR-9 caps production dependencies at exactly one and NFR-10 states that no environment variable is required to boot.

**Decision.** Five files in one flat directory, listed in §2. No subdirectories. No `config.js`, no `ConfigModule`, no `dotenv`, no `zod`/`joi`/`envalid`. `PORT` is read with `process.env.PORT || 3000` in `server.js` and used unvalidated. No `.env`, `.env.example`, or `.env.test` is generated. No `.gitignore`, no `jest.config.js`.

**Consequences.** The dependency count stays at 1 / 2 and `npm install` on a clean clone is fast and reproducible (NFR-5). `npm test` runs against an empty environment with no bootstrap step — the fixture-drift failure mode (schema, `.env.example`, and `.env.test` disagreeing) cannot occur because none of the three exists. An invalid `PORT` (e.g. `PORT=abc`) surfaces as a Node `listen` error at startup instead of a friendly validation message; acceptable for a service with one operator-set variable. If this service ever grows a second module or a secret, the layout must be revisited deliberately rather than by accretion.

---

## 9. Work breakdown hint

Flat, file-sized units for the packet planner. One TaskPacket per line. Build order is top to bottom; each unit's dependency is noted.

1. **`package.json`** — *codegen*. Manifest with `private: true`, no `"type"` field, `main: "app.js"`, `engines.node >= 20`, scripts `start` (`node server.js`) and `test` (`jest`), `dependencies` `{ express: ^5.1.0 }`, `devDependencies` `{ jest: ^29.7.0, supertest: ^7.1.1 }`, and no `jest` config key. No dependencies on other units. Gates NFR-9.
2. **`app.js`** — *codegen*. `'use strict'`, require `express`, construct app, register `app.get('/ping', ...)` → `app.use(404)` → `app.use(err, req, res, next)` in that exact order, `module.exports = app`. No `listen`, no `process.env`, no body parser. Depends on unit 1 (needs `express` installed). Implements FR-1 – FR-12.
3. **`server.js`** — *codegen*. `'use strict'`, `require('./app')`, `const port = process.env.PORT || 3000`, `app.listen(port, () => console.log(\`listening on port ${port}\`))`. Four statements, no exports. Depends on unit 2. Implements FR-13, FR-14, AC-3.
4. **`app.test.js`** — *tests*. Single Jest suite, three `it` blocks per §7.2: 200-case (nine assertions including exact `status === 'ok'`, canonical ISO-8601 `time`, and per-request freshness), unknown-path 404 (including the not-HTML assertion on `res.text`), and `POST /ping` → 404 citing FR-9. Mounts `require('./app')` via supertest; never requires `server.js`. Depends on units 1 and 2. Verifies AC-2, AC-4, AC-5, AC-6.
5. **`README.md`** — *docs*. Sections: title and one-line description; prerequisites (Node 20+); `npm install`; `npm test`; `npm start` (note the `3000` default and the `PORT` override); an endpoint table with `GET /ping` → `200` and everything-else → `404`; a worked `curl localhost:3000/ping` example with its exact `{"status":"ok","time":"..."}` output; a second `curl localhost:3000/nope` example with its `{"error":"not found"}` output; a short "not included" list (no database, no auth, no logging). Depends on units 1–4 being final. Satisfies AC-7.

No sixth unit. No packet for configuration, migrations, Docker, CI, linting, or environment fixtures — none of those artifacts exist in this design.
