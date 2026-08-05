# Design — Ping Service

Source of truth for the codegen phase. Derived from `.sdlc/requirements.md` and `brief.md`.
Everything below is a decision, not a suggestion. Generate exactly what is specified.

All file paths in this document are relative to the application root:
`/workspace/ping-service/src`.

---

## 1. Overview

A single-process Express HTTP service in CommonJS JavaScript on Node 20+. One route
(`GET /ping`), one catch-all 404, one JSON error handler, one test file. No database, no
auth, no logging framework, no build step, no container, no CI.

The entire system is four source artifacts plus a README. There is no layering (no
controller/service/repository split), no dependency injection, no config module, and no
domain model — introducing any of those would add files without adding behavior, and the
requirements define exactly two behaviors.

### The one architectural decision that matters: app/listener split

**ADR-001 — Separate the Express app from the HTTP listener**

- **Title:** App module exports the Express app; a distinct entry point owns `listen()`.
- **Context:** FR-10 and FR-11 require the app to be mountable by supertest without binding
  a TCP port, while `npm start` must still boot a real listener on port 3000. If `app.js`
  called `listen()` at require time, every `require('../app')` in the test suite would bind
  port 3000 — causing `EADDRINUSE` when the suite runs alongside a dev server, leaving an
  open handle that keeps Jest alive after the tests finish, and forcing explicit
  `server.close()` teardown in the test file.
- **Decision:** `app.js` builds and `module.exports` the configured Express application and
  never calls `listen()`. `server.js` is the only file that calls `listen()`, and it is the
  only file referenced by the `start` script. `__tests__/ping.test.js` requires `app.js`
  directly and hands it to `supertest(app)`, which spins up an ephemeral listener per
  request and tears it down automatically.
- **Consequences:**
  - Tests need no `beforeAll`/`afterAll` and no server teardown; Jest exits cleanly with no
    open handles.
  - `server.js` is not covered by the test suite. Accepted — it contains three statements
    and no branching logic worth asserting.
  - Any future middleware must be registered in `app.js`, never in `server.js`, or tests
    would exercise a different app than production. This is a standing rule.

**ADR-002 — Explicit JSON 404 and JSON error handler instead of Express defaults**

- **Context:** Express's built-in final handler emits an HTML body (`Cannot POST /ping`) for
  unmatched routes and an HTML page including a stack trace for thrown errors when
  `NODE_ENV !== 'production'`. NFR-7, FR-8, and FR-9 forbid both.
- **Decision:** Register a terminal catch-all middleware that responds `404` with
  `{"error":"not found"}`, followed by a four-argument error handler that responds JSON and
  never serializes `err.stack` or `err.message`.
- **Consequences:** The service never emits HTML under any code path. The error handler
  discards error detail from the response body; since there is no logging in scope, error
  detail is not surfaced anywhere. Accepted for a service with no failure modes beyond
  malformed HTTP.

**ADR-003 — No configuration layer**

- **Context:** The requirements permit exactly one runtime knob: an optional `PORT`
  override (out-of-scope item 7). NFR-4 requires a clean clone to test green with no `.env`
  file.
- **Decision:** Read `process.env.PORT` inline in `server.js` with a literal default of
  `3000`. Do not add `dotenv`, a config module, a validation schema, `.env`, `.env.example`,
  or `.env.test`.
- **Consequences:** See §6 — this is binding on downstream phases.

---

## 2. File tree

```
src/
├── app.js                    # Builds and exports the Express app. Route + 404 + error handler. Never listens.
├── server.js                 # Entry point for `npm start`. Requires app.js and calls listen() on PORT || 3000.
├── package.json              # Name, version, engines, scripts, deps, devDeps, jest config block.
├── README.md                 # install / test / start instructions and one curl example.
├── .gitignore                # Ignores node_modules and coverage.
└── __tests__/
    └── ping.test.js          # The single test file: 200 case and 404 case.
```

Six files. Generate no others. Specifically: no `routes/` directory, no `controllers/`,
no `services/`, no `middleware/` directory, no `config/`, no `jest.config.js` (the Jest
config lives in `package.json`), no `Dockerfile`, no CI workflow, no lint config, no
`.env*` of any kind.

---

## 3. Per-file contracts

### 3.1 `app.js`

**Requires:** `express` only.
**Exports:** `module.exports = app;` — a single Express application instance. No named
exports, no factory function, no object wrapper.

**Contents, in order:**

1. `const express = require('express');`
2. `const app = express();`
3. The `GET /ping` handler (§3.1.1).
4. The catch-all 404 middleware (§3.1.2).
5. The JSON error handler (§3.1.3).
6. `module.exports = app;`

No body parser is registered — the service reads no request body. No `express.json()`, no
`express.urlencoded()`.

#### 3.1.1 Route: `GET /ping`

- Registered as `app.get('/ping', handler)`.
- Handler signature `(req, res)`. It reads nothing from `req`.
- Behavior: `res.status(200).json({ status: 'ok', time: new Date().toISOString() })`.
- `new Date()` is evaluated **inside** the handler on every request, so `time` reflects the
  moment the request is served, not module load time (FR-4).

**Response — 200**

```json
{
  "status": "ok",
  "time": "2026-08-05T12:34:56.789Z"
}
```

- Status: `200`.
- Exactly two keys, in this order: `status`, `time`. No `uptime`, no `version`, no
  `hostname`.
- `status` is the literal string `"ok"`.
- `time` is the exact output of `new Date().toISOString()`: `Z`-suffixed, millisecond
  precision, always parseable by `Date.parse()`.
- `Content-Type`: `res.json()` sets `application/json; charset=utf-8`. This satisfies FR-5;
  assertions must match on the `application/json` substring, not on strict equality (see
  §7).

#### 3.1.2 Catch-all 404 middleware

- Registered as `app.use((req, res) => { ... })` — **path-less** `app.use`, not
  `app.all('*')` and not `app.use('*')`. A path-less `app.use` matches every method and
  every path with no dependence on wildcard path parsing, which is what makes FR-7 fall out
  for free: `POST /ping` does not match the `GET /ping` route, falls through, and is
  answered by this middleware with the same 404 body.
- Behavior: `res.status(404).json({ error: 'not found' })`.
- It does **not** accept or call `next` — it is terminal.

**Response — 404**

```json
{ "error": "not found" }
```

- Status: `404`. Exactly one key, `error`, with the literal lowercase value `"not found"`.
- `Content-Type`: `application/json; charset=utf-8`. Never HTML (FR-9).
- Applies to: `GET /nope`, `GET /`, `POST /ping`, `PUT /ping`, `DELETE /ping`,
  `PATCH /ping`, and every other method/path pair other than `GET /ping`.
- `HEAD /ping` is answered `200` with an empty body by Express's automatic HEAD handling of
  the `GET` route. This is Express default behavior and is left as-is; no requirement
  addresses it.

#### 3.1.3 JSON error handler

- Registered last, as `app.use((err, req, res, next) => { ... })`. It **must** declare all
  four parameters — Express identifies error handlers by arity, and a three-parameter
  function here would silently become ordinary middleware and never run.
- Behavior:
  1. If `res.headersSent`, delegate with `return next(err);` (Express aborts the connection;
     nothing can be written after headers are flushed).
  2. Otherwise `const status = err.status || err.statusCode || 500;`
  3. `res.status(status).json({ error: 'internal server error' })`.
- The body never includes `err.message`, `err.stack`, or any error property (FR-9, NFR-7).
- The `next` parameter is used in the `headersSent` branch, so it is not an unused
  parameter.

**Response — 500**

```json
{ "error": "internal server error" }
```

No route in this service throws, so this handler is a guarantee rather than a live code
path. It exists because NFR-7 requires it. It is not asserted by the test suite.

### 3.2 `server.js`

**Requires:** `./app`.
**Exports:** nothing.

**Contents:**

1. `const app = require('./app');`
2. `const PORT = process.env.PORT || 3000;`
3. `app.listen(PORT, () => { console.log(`Ping service listening on port ${PORT}`); });`

Notes binding on codegen:
- `process.env.PORT` is a string when set; `app.listen` accepts a numeric string. Do not add
  `Number()` coercion, validation, `parseInt`, or a fallback chain beyond `|| 3000`.
- The single `console.log` is a boot banner, not application logging. It is the only
  `console` call in the entire codebase. Do not add request logging, morgan, pino, or a
  shutdown handler.
- No `process.on('SIGTERM')`, no graceful shutdown, no cluster mode.
- This file is never required by tests.

### 3.3 `__tests__/ping.test.js`

Contract in §7.

### 3.4 `package.json`

Contents in §5.

### 3.5 `README.md`

Sections, in order:

1. `# Ping Service` — one-sentence description.
2. **Requirements** — Node.js 20 or newer.
3. **Install** — fenced block: `npm install`.
4. **Test** — fenced block: `npm test`.
5. **Start** — fenced block: `npm start`, and one sentence noting the service listens on
   port 3000 and honors a `PORT` environment variable override.
6. **Example** — exactly one curl example with its expected output:
   ```
   curl -s localhost:3000/ping
   {"status":"ok","time":"2026-08-05T12:34:56.789Z"}
   ```
7. **Endpoints** — a two-row table: `GET /ping` → `200 {"status":"ok","time":"..."}`; any
   other method/path → `404 {"error":"not found"}`.

No badges, no license section, no contributing section, no architecture diagram.

### 3.6 `.gitignore`

Two lines:

```
node_modules/
coverage/
```

---

## 4. Middleware order in `app.js`

Registration order is load-bearing. Express evaluates the middleware stack top-down and the
first handler that responds wins. Generate in exactly this order:

| # | Registration | Why it must be here |
|---|---|---|
| 1 | `app.get('/ping', ...)` | Must precede the catch-all. If the path-less `app.use` were registered first it would swallow every request, including `GET /ping`, and the service would return 404 for everything. |
| 2 | `app.use((req, res) => ...)` — 404 | Must follow all routes and precede the error handler. Being path-less and method-less, it is reached only when no route matched, which is precisely the FR-6/FR-7 condition. Placed before the error handler because Express skips 4-arity handlers during normal (non-error) dispatch, so ordering between the two is unambiguous only if the normal handler comes first. |
| 3 | `app.use((err, req, res, next) => ...)` — error | Must be last. Express only routes an error to handlers registered *after* the middleware that raised it; an error handler registered before the route would never see errors thrown by that route. |

There is no fourth middleware. Do not insert `express.json()`, `helmet`, `cors`,
`compression`, or a request logger at any position.

---

## 5. `package.json`

```json
{
  "name": "ping-service",
  "version": "1.0.0",
  "description": "An HTTP service with one endpoint that answers GET /ping.",
  "main": "app.js",
  "private": true,
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.19.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  },
  "jest": {
    "testEnvironment": "node"
  }
}
```

Binding details:

- **No `"type": "module"`.** The absence of this key is what makes `.js` files CommonJS
  (NFR-2).
- **Express 4, not 5.** Express 5 changed path-to-regexp wildcard syntax and error-handling
  defaults; pinning to `^4.19.2` keeps the path-less `app.use` catch-all and the documented
  `res.json` behavior exactly as specified above.
- **`"main": "app.js"`** points at the app export, not the listener, consistent with ADR-001.
- **`"test": "jest"`** with no flags. No `--coverage`, no `--watch`, no `--runInBand`, no
  `NODE_ENV=test` prefix (that would be a shell-portability hazard and nothing reads
  `NODE_ENV`).
- The `jest` block sets `testEnvironment: "node"` explicitly. Jest 29 already defaults to
  `node`, but stating it removes any dependence on the default and keeps the config in
  `package.json` so no `jest.config.js` file is needed.
- Exactly one runtime dependency and exactly two devDependencies (NFR-3). Do not add
  `nodemon`, `dotenv`, `eslint`, `prettier`, `cross-env`, or `@types/*`.

---

## 6. Configuration

**The only configuration input to this application is the optional `PORT` environment
variable, read in `server.js`, defaulting to `3000` when unset or empty.**

That is the complete configuration surface. Concretely, and binding on all downstream
phases:

- There is **no** `.env`, `.env.example`, `.env.test`, `.env.local`, or any other dotfile
  environment file in this project. Do not create one.
- There is **no** config module, no `ConfigModule`, no `config/` directory, no
  `config.js`, and no settings object.
- There is **no** environment-variable validation schema — no Joi, no Zod, no envalid, no
  `class-validator`. Nothing validates `PORT`; if a caller exports a nonsense `PORT`, Node's
  `listen()` raises and the process exits, which is the correct and sufficient behavior for
  a service of this size.
- There is **no** `dotenv` dependency and no `require('dotenv').config()` call anywhere.
- Nothing reads `NODE_ENV`. The application behaves identically in every environment.
- There are no secrets, no JWT secrets, no encryption keys, no database URLs, no third-party
  API keys, and no feature flags — the service has no auth, no persistence, no outbound
  calls, and no conditional behavior (see the PII inventory in `requirements.md`: the system
  handles no PII and persists nothing).

The generic architecture template calls for an exhaustive env-var table feeding a
`ConfigModule` validation schema plus `.env.example` and `.env.test` fixtures. **That
section does not apply to this stack and is intentionally omitted.** This is an Express
project with no config layer; manufacturing one would violate NFR-4 (clean clone, no `.env`
file, `npm test` green) by introducing a boot-time validation step that the test run would
then have to satisfy. For completeness, the full env-var contract is the single row below.

| Variable | Purpose | Format | Required at boot | Read by |
|---|---|---|---|---|
| `PORT` | TCP port for the HTTP listener | Numeric string, 1–65535 | No — defaults to `3000` | `server.js` |

`PORT` is not read by `app.js` and therefore has no effect on the test suite; supertest
binds an ephemeral port of its own choosing.

---

## 7. Test strategy

**File:** `__tests__/ping.test.js` — the only test file in the repository (NFR-5).

**Imports:**

```js
const request = require('supertest');
const app = require('../app');
```

`app.js` is required directly. Because of ADR-001 it exports a non-listening app, so the
require has no side effect beyond building the middleware stack. `supertest(app)` starts an
ephemeral listener on an OS-assigned port for the duration of each request and closes it
when the request settles.

**Structure:** one top-level `describe('Ping Service', ...)` containing two `it` blocks.
Use `async/await` with `await request(app)...`, not the `.end(done)` callback form.

**Test 1 — `GET /ping` returns 200 with status ok and a parseable ISO timestamp**

Assertions:
1. `expect(res.status).toBe(200)` (FR-1).
2. `expect(res.headers['content-type']).toMatch(/application\/json/)` — substring match, because
   Express sends `application/json; charset=utf-8` (FR-5).
3. `expect(Object.keys(res.body).sort()).toEqual(['status', 'time'])` — exactly two keys,
   no more (FR-2).
4. `expect(res.body.status).toBe('ok')` (FR-3).
5. `expect(Number.isNaN(Date.parse(res.body.time))).toBe(false)` (FR-4).
6. `expect(res.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)` — pins
   `Z` suffix and millisecond precision (FR-4).

Do not assert an exact `time` value and do not use fake timers; the timestamp is
nondeterministic by design.

**Test 2 — unknown path returns the 404 JSON body**

Assertions against `GET /nope`:
1. `expect(res.status).toBe(404)` (FR-6).
2. `expect(res.headers['content-type']).toMatch(/application\/json/)`.
3. `expect(res.body).toEqual({ error: 'not found' })` — deep equality pins the body exactly
   (FR-8).
4. `expect(res.text).not.toMatch(/<html/i)` — no HTML (FR-9).

The same `it` block additionally asserts `POST /ping` (FR-7) with the same four assertions,
keeping the file at exactly two `it` blocks while covering the wrong-method case. This
satisfies acceptance criterion 2 (2 or more passing tests) and NFR-5 (one file).

**Teardown:** none. There is no `beforeAll`, `afterAll`, `beforeEach`, or `afterEach`, and
no `server.close()`. Nothing in the test process ever calls `listen()` on a fixed port:
`app.js` does not listen, `server.js` is never required, and supertest owns the lifecycle of
its own ephemeral servers. Jest therefore exits with no open handles and no
`--forceExit` / `--detectOpenHandles` flags.

**No mocks.** There are no external dependencies to mock — no database, no HTTP clients, no
clock control, no auth. The suite is a pure black-box HTTP test of the real app.

---

## 8. Traceability

| ID | Requirement | Satisfied by |
|---|---|---|
| FR-1 | `GET /ping` returns 200 | `app.js` §3.1.1; asserted `__tests__/ping.test.js` test 1 |
| FR-2 | Body has exactly `status` and `time` | `app.js` §3.1.1; asserted test 1 (key-set equality) |
| FR-3 | `status === "ok"` | `app.js` §3.1.1; asserted test 1 |
| FR-4 | `time` is `new Date().toISOString()`, `Date.parse`-able | `app.js` §3.1.1 (evaluated per request); asserted test 1 (regex + `Date.parse`) |
| FR-5 | `Content-Type: application/json` | `app.js` §3.1.1 via `res.json()`; asserted test 1 |
| FR-6 | Non-`/ping` paths return 404 | `app.js` §3.1.2 path-less `app.use`; asserted test 2 |
| FR-7 | Wrong method on `/ping` returns the 404 JSON body, not 405/HTML | `app.js` §3.1.2 (method-less catch-all); asserted test 2 (`POST /ping`) |
| FR-8 | 404 body is exactly `{"error":"not found"}` | `app.js` §3.1.2; asserted test 2 (`toEqual`) |
| FR-9 | No HTML, no stack trace in any error response | `app.js` §3.1.2 and §3.1.3 (body omits `err.message`/`err.stack`); asserted test 2 (`not.toMatch(/<html/i)`) |
| FR-10 | App exported without `listen()` | `app.js` §3.1 (`module.exports = app`); ADR-001 |
| FR-11 | Separate entry point listens on 3000, `PORT`-overridable, run by `npm start` | `server.js` §3.2; `package.json` `scripts.start` |
| NFR-1 | Node >= 20 declared | `package.json` `engines` §5 |
| NFR-2 | CommonJS, no `"type": "module"` | `package.json` §5; `require`/`module.exports` in `app.js`, `server.js`, `__tests__/ping.test.js` |
| NFR-3 | Express + Jest + supertest only | `package.json` `dependencies` / `devDependencies` §5 |
| NFR-4 | Clean-clone `npm install && npm test` green, no `.env` | §6 (no config layer, no dotenv); §7 (no fixtures, no external services) |
| NFR-5 | Exactly one test file, both cases | `__tests__/ping.test.js` §7 |
| NFR-6 | No build step; `npm start` runs source via `node` | `package.json` `scripts.start = "node server.js"` §5; no transpiler in devDependencies |
| NFR-7 | Unhandled errors serialized as JSON | `app.js` §3.1.3 four-arity error handler; ADR-002 |
| Scope 4 | README documents install/test/start + one curl | `README.md` §3.5 |
| Out-of-scope 1–7 | No DB, auth, extra endpoints, logging/rate-limit/helmet/CORS/Swagger, Docker/CI/frontend, build step, env config beyond `PORT` | Enforced by the six-file tree §2, the three-middleware stack §4, the dependency list §5, and §6 |

---

## 9. Sequencing notes

Generation order for the codegen phase. Each step depends only on steps above it.

1. **`package.json`** — first. Nothing else can be installed or run until dependencies and
   the `jest` block exist.
2. **`app.js`** — the only file with behavior. `server.js` and the test file both require it.
3. **`server.js`** — depends on `app.js`.
4. **`__tests__/ping.test.js`** — depends on `app.js`. Written after `app.js` so the
   assertions pin the shipped response shapes rather than the reverse.
5. **`README.md`**, **`.gitignore`** — last; documentation and hygiene, no dependents.

There is no "Auth before everything" or "Audit before PII" sequencing in this system: there
is no auth module, no audit module, and no PII (per the PII inventory in
`requirements.md`, the service accepts no body, no query parameters, and persists nothing).
Verification is a single command, `npm test`, after step 4.
