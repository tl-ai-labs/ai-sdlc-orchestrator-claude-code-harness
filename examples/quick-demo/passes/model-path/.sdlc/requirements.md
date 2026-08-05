# Requirements — Ping Service

Derived from `brief.md`. Source of truth for the architecture phase.

## In scope

1. A single HTTP service exposing exactly one route: `GET /ping`.
2. A JSON 404 fallback for every other method/path combination.
3. A Jest + supertest test file covering the 200 case and the 404 case.
4. A README documenting `npm install`, `npm test`, `npm start`, and one `curl` example.
5. An `npm start` entry point that boots an HTTP listener on port 3000.

## Out of scope

1. Any database, ORM, persistence, or migration.
2. Authentication, authorization, users, roles, sessions, tokens.
3. Any endpoint other than `GET /ping`.
4. Logging, rate limiting, security headers (helmet), CORS config, and Swagger/OpenAPI docs.
5. Docker, CI configuration, and any frontend.
6. Any build/transpile step (no TypeScript, no bundler).
7. Runtime configuration via environment variables beyond an optional `PORT` override.

## Functional requirements

### Module: ping

- **FR-1** `GET /ping` MUST return HTTP status `200`.
- **FR-2** The `GET /ping` response body MUST be JSON with exactly two keys: `status` and `time`.
- **FR-3** `status` MUST be the literal string `"ok"`.
- **FR-4** `time` MUST be an ISO-8601 UTC timestamp of the moment the request was served,
  in the form produced by `new Date().toISOString()` (i.e. `Z`-suffixed, millisecond precision),
  and MUST be parseable by `Date.parse()`.
- **FR-5** The `Content-Type` of the `GET /ping` response MUST be `application/json`.

### Module: not-found handling

- **FR-6** Any request whose path is not `/ping` MUST return HTTP status `404`.
- **FR-7** A request to `/ping` with a method other than `GET` MUST also return the 404 JSON
  body rather than Express's default HTML `Cannot POST /ping` page.
- **FR-8** The 404 response body MUST be exactly `{ "error": "not found" }`.
- **FR-9** No 404 or error response may contain HTML or a stack trace.

### Module: server bootstrap

- **FR-10** The Express app MUST be exported from a module that does **not** call `listen()`,
  so supertest can mount it without binding a port.
- **FR-11** A separate entry point MUST call `listen()` on port `3000` (overridable via
  `process.env.PORT`) and is what `npm start` runs.

## Non-functional requirements

- **NFR-1** Runtime: Node.js 20 or newer; `package.json` MUST declare `"engines": { "node": ">=20" }`.
- **NFR-2** Module system: CommonJS (`require`/`module.exports`); no `"type": "module"`.
- **NFR-3** Framework: Express. Test stack: Jest + supertest. No other runtime dependencies.
- **NFR-4** `npm install` then `npm test` MUST be green on a clean clone with no manual setup,
  no `.env` file, and no network access beyond the registry.
- **NFR-5** Exactly one test file containing both the 200 case and the 404 case.
- **NFR-6** No build step: `npm start` runs the source directly via `node`.
- **NFR-7** Any unhandled error MUST be serialized as JSON, never as an HTML error page
  (Express's default error handler emits HTML, so an explicit JSON error handler is required).

## PII inventory

| Field | Sensitivity | Protection |
|---|---|---|
| _(none)_ | — | The service accepts no request body, no query parameters, no headers of interest, and persists nothing. There is no PII anywhere in this system. |

## Role matrix

| Role | Resource | Action | Allowed |
|---|---|---|---|
| Anonymous (unauthenticated) | `GET /ping` | read | Yes — the endpoint is public by design |
| Anonymous | any other path | any | No — answered with 404 JSON |

Authentication and roles are explicitly out of scope; the single endpoint is
intentionally unauthenticated. There are no privileged roles in this system.

## Acceptance criteria

1. `npm install` completes with exit code 0.
2. `npm test` completes with exit code 0 and reports 2 or more passing tests, 0 failing.
3. `npm start` boots and listens on port 3000 without throwing.
4. `curl -s localhost:3000/ping` returns HTTP 200, `status === "ok"`, and a `time` value
   for which `Number.isNaN(Date.parse(time)) === false`.
5. `curl -s -i localhost:3000/nope` returns HTTP 404, a `content-type` of `application/json`,
   and the body `{"error":"not found"}` — no HTML.
6. `curl -s -X POST localhost:3000/ping` returns the same 404 JSON body.
7. The repository contains no database client, no auth middleware, and no build config.

## Open questions for HITL

1. **404 vs 405 on wrong method.** The brief says "any other path returns 404". A `POST /ping`
   is the same path with a different method. FR-7 resolves this as **404** (simplest, matches
   "no endpoint other than `GET /ping`" and avoids introducing method-negotiation logic).
   Flag at Gate 1 if 405 is preferred.
2. **`time` precision.** FR-4 pins to `toISOString()` millisecond precision. Called out only
   because the brief says "ISO-8601 UTC" without fixing precision; no action needed unless
   second-precision is required.
