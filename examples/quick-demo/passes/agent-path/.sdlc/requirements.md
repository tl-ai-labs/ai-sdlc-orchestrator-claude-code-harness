# Requirements — Ping Service

**Source brief:** `/workspace/ping-service/brief.md`
**Phase:** requirements_analysis · **Model:** claude-opus-4-7 · **Policy:** opus-plus-flash

---

## 1. In scope

1. A single HTTP service, runnable locally, exposing exactly one documented route.
2. `GET /ping` returning HTTP 200 with a JSON body `{ "status": "ok", "time": "<ISO-8601 UTC>" }`.
3. A catch-all handler: any request whose method+path does not match `GET /ping` returns HTTP 404 with JSON body `{ "error": "not found" }`.
4. All error responses are JSON — never HTML, never a stack trace.
5. Automated tests (Jest + supertest) covering the 200 case and the 404 case.
6. A README documenting `npm install`, `npm test`, `npm start`, and one worked `curl` example.
7. `package.json` declaring dependencies, and `start` / `test` scripts.

## 2. Out of scope

1. Any database, ORM, cache, or persistence of any kind.
2. Authentication, authorization, users, roles, sessions, or tokens.
3. Any endpoint other than `GET /ping` (no `/health`, no `/version`, no root route).
4. Logging, rate limiting, security headers (helmet), CORS, and Swagger/OpenAPI docs.
5. Docker, CI configuration, deployment manifests, and any frontend.
6. Input validation middleware — the one route takes no input.
7. Build step, transpilation, TypeScript. Plain CommonJS JavaScript only.

---

## 3. Functional requirements

### Module: `ping`

| ID | Requirement |
|---|---|
| **FR-1** | The service SHALL expose `GET /ping`. |
| **FR-2** | `GET /ping` SHALL respond with HTTP status `200`. |
| **FR-3** | The `GET /ping` response body SHALL be JSON with exactly two keys: `status` and `time`. |
| **FR-4** | `status` SHALL have the literal string value `"ok"`. |
| **FR-5** | `time` SHALL be the current instant as an ISO-8601 string in UTC (i.e. `new Date().toISOString()`, ending in `Z`), and SHALL be parseable by `Date.parse`. |
| **FR-6** | The `time` value SHALL be computed per-request, not captured once at boot. |
| **FR-7** | The `Content-Type` of every response SHALL be `application/json`. |

### Module: `errors`

| ID | Requirement |
|---|---|
| **FR-8** | Any request to a path other than `/ping` SHALL respond with HTTP status `404`. |
| **FR-9** | A request to `/ping` with a method other than `GET` SHALL also respond `404` (the brief specifies only `GET /ping`; everything else is "any other path" behaviour). |
| **FR-10** | The 404 response body SHALL be JSON `{ "error": "not found" }`. |
| **FR-11** | If an unexpected error is thrown while handling a request, the response SHALL be JSON, SHALL NOT include a stack trace, and SHALL NOT be Express's default HTML error page. |

### Module: `server`

| ID | Requirement |
|---|---|
| **FR-12** | The Express `app` SHALL be exported from a module that does NOT call `listen()`, so tests can mount it with supertest without binding a port. |
| **FR-13** | A separate entrypoint SHALL call `listen()` on port `3000` when the process is started via `npm start`. |
| **FR-14** | The listen port SHALL default to `3000` and MAY be overridden by `process.env.PORT`. |

---

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| **NFR-1** | Runtime: Node.js 20 or newer. |
| **NFR-2** | Language: JavaScript, CommonJS modules (`require` / `module.exports`). No `"type": "module"`. |
| **NFR-3** | Framework: Express. No other HTTP framework. |
| **NFR-4** | Test stack: Jest as runner, supertest for HTTP assertions. Exactly one test file. |
| **NFR-5** | `npm install` SHALL succeed on a clean clone with no manual steps. |
| **NFR-6** | `npm test` SHALL exit 0 on a clean clone. |
| **NFR-7** | No build step, no bundler, no transpiler. Source runs as authored. |
| **NFR-8** | The test suite SHALL NOT bind a real TCP port (supertest handles ephemeral binding), so tests do not leak handles or hang Jest. |
| **NFR-9** | Total production dependency count SHALL be 1 (`express`); dev dependencies limited to `jest` and `supertest`. |
| **NFR-10** | No environment variables are required for the service to boot. There is no config validation schema, therefore no `.env.example` / `.env.test` fixture is required. |

---

## 5. PII inventory

| Field | Sensitivity | Protection |
|---|---|---|
| — | — | — |

**The service handles no personal data.** It accepts no request body, no query parameters, no headers of interest, and no path parameters. The only value it emits is the server's own clock reading. There is nothing to classify, mask, encrypt, or retain, and therefore no PII controls are in scope.

---

## 6. Role matrix

| Role | Resource | Action | Allowed |
|---|---|---|---|
| Anonymous (unauthenticated) | `GET /ping` | read | Yes |
| Anonymous (unauthenticated) | any other path | any | No — 404 |

**There is exactly one role: anonymous.** The brief places authentication and roles explicitly out of scope, so the service is unauthenticated by design and every caller is treated identically. This is a deliberate accepted decision, recorded here so the security review can confirm it as intended rather than flag it as a missing control.

---

## 7. Acceptance criteria

| ID | Criterion | How verified |
|---|---|---|
| **AC-1** | `npm install` completes with exit code 0. | Run in the test phase. |
| **AC-2** | `npm test` completes with exit code 0 and all tests pass. | Run in the test phase. |
| **AC-3** | `npm start` boots the process and listens on port 3000. | Boot smoke check. |
| **AC-4** | `curl localhost:3000/ping` returns HTTP 200, `status === "ok"`, and a `time` that `Date.parse` accepts. | Test + boot smoke check. |
| **AC-5** | `curl localhost:3000/nope` returns HTTP 404 with a JSON body, not HTML. | Test + boot smoke check. |
| **AC-6** | The test file contains at least one assertion for the 200 case and one for the 404 case. | Senior code review. |
| **AC-7** | The README documents `npm install`, `npm test`, `npm start`, and one `curl` example. | Senior code review. |
| **AC-8** | No response anywhere in the app contains an HTML body or a stack trace. | Senior + security review. |

---

## 8. Open questions for HITL

1. **404 on wrong method.** The brief says "any other path returns 404". It is silent on `POST /ping`. FR-9 resolves this as 404 (rather than 405) on the grounds that the brief describes exactly one supported interaction and asks for the least machinery. Flagging it because 405 is the more conventional HTTP answer, and it is a one-line difference if you prefer it.
2. **`PORT` override.** FR-14 allows `process.env.PORT` to override the default 3000. The brief does not ask for this. It costs one line and does not add a config-validation dependency, but say the word and the port is hardcoded.

Neither question blocks design; both have a stated default that will be implemented if you simply approve.
