# Security Review — Ping Service

**Code under review:** `/workspace/ping-service/src`
**Authored files:** `package.json`, `app.js`, `server.js`, `app.test.js`, `README.md` (5)
**Context:** `.sdlc/requirements.md` (human-approved, Gate 1), `.sdlc/design.md` (human-approved, Gate 2), `.sdlc/review.json` (senior, `approve_with_nits`)
**Phase:** security_review · **Date:** 2026-08-05

---

## 1. Verdict

**PASS WITH ACCEPTED RISKS**

The code delivers exactly the security posture the design intends, and I verified that by execution rather than by reading. Every response the Express application can emit is a fixed JSON literal — I proved the `500` path four different ways (sync throw, async rejection, `next(err)`, and post-`headersSent`) and none leaked a stack frame, an `err.message`, a file path, or an HTML tag. There are **zero security defects**: no critical, high, medium, or low findings. The two `info` rows below are documentation-accuracy notes about behaviour *below* the Express layer, neither of which discloses anything and neither of which warrants a code change. The accepted-risk register is non-empty and materially real (an unauthenticated, plain-HTTP, unrate-limited service), which is why this is not a bare PASS — but every item in it is approved at two human gates and correctly out of scope for this run.

---

## 2. Scope and method

**Tool note:** `Glob` and `Grep` were not present on this build. Every search below was executed through `Bash` (`ls`, `find`, `grep -rn`, `python3`). No check in this document rests on a search I could not run; where I assert an absence, the command that established it is named.

### Inspected (static)

| Artifact | Path |
|---|---|
| Application | `/workspace/ping-service/src/app.js` |
| Entrypoint | `/workspace/ping-service/src/server.js` |
| Manifest | `/workspace/ping-service/src/package.json` |
| Test suite | `/workspace/ping-service/src/app.test.js` |
| Docs | `/workspace/ping-service/src/README.md` |
| Lockfile (artifact) | `/workspace/ping-service/src/package-lock.json` |

Full-tree enumeration first: `find . -path ./src/node_modules -prune -o -type f -print` returned 27 files repo-wide. `src/` contains exactly the five authored files plus the two install artifacts, flat, **no dotfiles** (`ls -A src/ | grep '^\.'` → no matches).

### Executed (dynamic)

1. **Live server probes** — booted the real `server.js` on port 31337 and issued 23 HTTP probes: malformed percent-encoding (`/%`, `/%zz`, `/%c0%ae`, `/%00`), path traversal (raw and encoded), prototype-pollution paths and query strings, XSS reflection probe, 8 KB path, `Accept: text/html`, `Host`/`X-Forwarded-For` overrides, `OPTIONS`/`TRACE`/unknown verbs, and a 1 MB body POST.
2. **Raw-socket probes** — 10 malformed wire-level requests through `net.connect`: bad request line, bad HTTP version, invalid header octet, 100 KB header, 200 headers, CL+TE request-smuggling pair, absolute-form URI, CRLF-injection in path.
3. **Fault injection (independent of the senior review's)** — copied `app.js` verbatim, injected four throwing routes *above* the catch-all so the **real** registered error handler was under test, and scanned every response body for sentinel markers, stack frames, `.js:NN` positions, absolute paths, and HTML tags.
4. **`NODE_ENV` sensitivity** — re-ran the `500` path under unset / `development` / `production`.
5. **Resource behaviour** — 100 MB POST body, 2000 sequential requests, 3000 further concurrent requests at 40–50 parallel, with RSS sampled at each stage.
6. **`npm audit --omit=dev` and `npm audit`**, plus lockfile provenance and install-hook analysis.
7. **`npm test`** — re-run to confirm the suite is green (3/3 passed, 0.378 s).

The user's `src/` was not modified; fault-injection copies were written to the session scratchpad. All probe servers were stopped.

---

## 3. Threat model

### Assets

There are, honestly, almost none. The service holds **no data at rest, no data in transit beyond a clock reading, no credentials, no keys, and no session state**. The complete set of values the process can emit to a client is:

- the literal string `"ok"`,
- `new Date().toISOString()` — the host's wall-clock time, UTC, millisecond precision,
- the literal strings `"not found"` and `"internal server error"`.

The only asset with any confidentiality character at all is the host clock reading, which is already inferable from the mandatory HTTP `Date` header on every response. The real assets are therefore **availability of the process** and **the integrity of the JSON-only response contract** (FR-11 / AC-8), not confidentiality of anything.

### Trust boundaries

| # | Boundary | Crossing | Notes |
|---|---|---|---|
| B1 | Network → Node HTTP parser | Raw bytes | The only boundary an attacker can reach. Node rejects malformed framing before Express sees it. |
| B2 | Node HTTP parser → Express router | `req` object | Express reads method + path for routing. **The application reads nothing off `req`.** |
| B3 | Process → stdout | One line at boot | `console.log` fires once, in `server.js:5`, printing the port. No request data ever reaches it. |
| B4 | Environment → process | `process.env.PORT` | One variable, one read site, unvalidated by design (ADR-005). |

There is no database boundary, no filesystem boundary, no outbound network boundary, no template engine, no serialization boundary, no privilege boundary (one role: anonymous).

### Entry points

Exactly one route is registered: `GET /ping`. Everything else — every other path and every other verb — falls into a path-less `app.use()` catch-all that returns a fixed 404 literal.

**Attack surface, stated plainly: one unauthenticated GET route that returns a clock reading.** No authentication to bypass, no authorization to escalate through, no input to inject into, no data to exfiltrate, no state to corrupt. The plausible attacker goals reduce to (a) making the process return something other than JSON, and (b) exhausting the process. I tested both directly; see §4 and the DoS assessment below.

### STRIDE, proportionately

| Category | Assessment |
|---|---|
| **Spoofing** | No identity exists to spoof. `Host` and `X-Forwarded-For` overrides were accepted and ignored — nothing branches on them (verified: `grep -rnE "req\.[a-zA-Z]+"` across authored `.js` returns **no matches**). |
| **Tampering** | No writable state anywhere. No persistence, no module-level mutable state, no filesystem write. A 100 MB POST body was accepted and discarded without being read. |
| **Repudiation** | No audit log by design (requirements §2.4). Nothing happens that could need repudiating — there is no state-changing operation in the service. |
| **Information disclosure** | **The highest-value check here; see §4.** Proven closed at the application layer by fault injection. |
| **Denial of service** | Real but accepted (no rate limit, out of scope per requirements §2.4). Confirmed no *amplifying* weakness: no unbounded allocation, no blocking loop, no ReDoS. See below. |
| **Elevation of privilege** | Not applicable. One role, anonymous, with read access to one route (requirements §6). There is no higher privilege to reach. |

### DoS / resource — measured, not assumed

The accepted risk is that an attacker can send unlimited requests. What matters for review is whether the code *amplifies* that, and it does not:

- **No unbounded allocation.** A 100 MB POST to `/ping` returned `404` in **0.09 s** with RSS moving 52,944 KB → 53,456 KB (+0.5 MB). Because no body parser is mounted (design §3.1), the request body is never accumulated in application memory — the response is committed and the socket reset before the body is consumed. This is a genuine security property of the "no body parser" decision, not an accident.
- **No memory leak.** RSS across 5000 requests: 52.9 MB baseline → 74.9 MB (2000 req) → 82.3 → 82.9 → 85.8 MB (3000 more). Growth rate falls from ~11 KB/req to ~1 KB/req and flattens — V8 heap warm-up and GC lag, not per-request retention.
- **No synchronous blocking loop.** The `/ping` handler is O(1): one `Date` construction, one `res.json()`. There is no loop, no `await` on I/O, no crypto, no compression in the request path.
- **No ReDoS.** `grep -rnoE "/[^/\n]+/[gimsuy]*"` over authored `.js` finds regex literals **only in `app.test.js`** (lines 12 and 29, `/application\/json/`). `app.js` and `server.js` contain **zero regex literals**. The test-file regexes are linear with no nested quantifiers and are not in the request path.
- **Node-level limits hold.** A 100 KB header was rejected `431` by Node before reaching Express.

---

## 4. Findings

**There are no security defects.** No critical, high, medium, or low findings. I am recording two `info` rows because they are true and newly established by this review, not to pad the table — both are documentation-accuracy notes about layers below the application, and **neither requires a code change**.

| ID | Severity | Title | File | Evidence | Recommendation |
|---|---|---|---|---|---|
| SEC-01 | info | Node-layer `400`/`431` responses are body-less, so FR-7's literal "every response" has an exception below Express | `/workspace/ping-service/src/app.js` (out of its reach) | Raw socket: `FROBNICATE /ping HTTP/1.1` → `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n` — **zero-byte body, no `Content-Type`**. Same shape for a bad request line, bad HTTP version, invalid header octet, and a CL+TE smuggling pair; `431` for a 100 KB header. These are emitted by Node's HTTP parser before Express is invoked. | **No code change.** AC-8 ("no HTML body, no stack trace") is fully satisfied — the body is empty, so there is nothing to disclose. This is a wording gap in FR-7/design §4, exactly parallel to the senior review's F-1 HEAD nit. Suggest adding "Node-layer framing rejections (`400`/`431`) return no body" to the accepted-defaults list in design §3.4. Suppressing it would require a `server.on('clientError')` handler in `server.js`, which is scope growth for zero security gain. |
| SEC-02 | info | The `headersSent` delegation path prints `err.stack` to stderr via Express's `finalhandler` | `/workspace/ping-service/src/app.js:20-22` | Fault injection with a route that writes a partial body then throws: the client received the committed body and then a socket reset (`curl: (18) transfer closed with outstanding read data remaining`) — **no HTML, no stack, no trailer appended**. The stack was written to the *process* stderr only. | **No code change; forward-looking note only.** This path is unreachable in the current codebase — no handler writes headers before it can throw. It is recorded so that a future maintainer who adds a streaming or chunked route knows that an error after commit will surface a stack in process logs. The client-facing behaviour is correct and matches ADR-003's stated consequence. |

### Information disclosure — verified closed (item 1 of the brief)

This was the highest-value check and I verified it independently of the senior review.

**The error handler body is a fixed literal.** `app.js:23-25` is `res.status(500).json({ error: 'internal server error' })`. There is no `err.message`, no `err.stack`, no `err.code`, no interpolation, and no conditional on `NODE_ENV` anywhere in the file.

**Fault injection, four paths, all clean.** I copied `app.js` verbatim and injected four throwing routes *above* the catch-all so the genuine registered error handler was exercised:

| Injected path | Failure mode | Result |
|---|---|---|
| `/boom-sync` | synchronous `throw` carrying sentinel `SENTINEL_SECRET_/etc/shadow_LEAK_MARKER` | `500`, `application/json; charset=utf-8`, body exactly `{"error":"internal server error"}` (33 bytes) |
| `/boom-async` | `async` handler rejection (Express 5 auto-forwards) | identical `500` JSON literal |
| `/boom-next` | explicit `next(err)` | identical `500` JSON literal |
| `/boom-after-headers` | partial write, then throw (`headersSent` branch) | committed body then socket destroy — no HTML, no stack, nothing appended |

Every response body was scanned with `grep -qE "SENTINEL|Error:|at .*\(|\.js:[0-9]+|/Users/|/private/|node_modules|<html|<!DOCTYPE|<pre|<body|stack"`. **All four: CLEAN** — no sentinel, no stack frame, no file path, no HTML tag.

**Express's default HTML error page is genuinely unreachable.** Two conditions would expose it, and both are closed:

1. *No error handler registered, or one with wrong arity.* The handler at `app.js:19` declares exactly four parameters `(err, req, res, next)`, so Express's `fn.length === 4` detection fires, and it is registered **last** — after the 404 catch-all — so a throw inside the catch-all also lands on it (design §3.2). The senior review confirmed the live router stack; my fault injection confirms the behaviour end-to-end.
2. *`NODE_ENV` gating.* Express's built-in handler leaks the stack when `NODE_ENV !== 'production'`. Re-ran `/boom-sync` under unset, `development`, and `production`: **all three returned `{"error":"internal server error"}`**. The protection is structural, not environmental — which is the stronger property, since nothing in `src/` reads `NODE_ENV` (design §6.2).

The only path that reaches `finalhandler` is the `headersSent` delegation, and by definition the response is already committed there, so `finalhandler` destroys the socket rather than writing a body (confirmed empirically — SEC-02).

**No reflection.** The 404 body is a fixed literal and never echoes the request path. `GET /%3Cscript%3Ealert(1)%3C/script%3E` returned `{"error":"not found"}` verbatim. There is no XSS vector because there is no reflection and no HTML content type anywhere.

**No header injection.** `GET /ping%0d%0aX-Injected:%20yes` returned a normal `404` with no injected header.

### Secret leakage — verified absent (item 2)

- **Credential scan:** `grep -rnE "(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|access[_-]?key|bearer|authorization)[ \t]*[:=][ \t]*['\"][a-zA-Z0-9]"` over `--include=*.js --include=*.json --include=*.md`, excluding `node_modules` → **exit 1, no matches**.
- **Key material / connection strings / vendor tokens:** `grep -rnE "(mongodb|postgres|postgresql|mysql|redis|amqp|jdbc)://|-----BEGIN|AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20}|ghp_[a-zA-Z0-9]{20}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10}"` → **exit 1, no matches**.
- **No `.env` of any kind is present:** `find . -name ".env*" -not -path "*/node_modules/*"` → **no results**, repo-wide.
- **The absence of `.env.example` / `.env.test` is correct here, and I confirmed it is consistent rather than merely asserted.** There is no config validation schema to seed: `dotenv`, `zod`, `joi`, `envalid`, `config`, `convict`, `nconf` and `@nestjs/config` are all absent from `node_modules`, and `grep -rnE "require\(['\"](dotenv|zod|joi|envalid|config|convict|nconf)"` over authored `.js` → **exit 1, no matches**. Declared dependencies are exactly `{"express": "^5.1.0"}`. This matches NFR-10, design §6.2, and ADR-005. Flagging a missing `.env.example` here would be flagging the approved design.
- **`PORT` is the only environment variable read anywhere:** `grep -rn "process\.env"` over authored `.js` returns exactly one hit — `/workspace/ping-service/src/server.js:4`, `const port = process.env.PORT || 3000;`. `app.js` reads `process.env` zero times, matching ADR-001.
- **The one log line carries no secret and no request data:** `server.js:5` logs only the resolved port at boot.

### Input handling — no untrusted input reaches any sink (item 4)

This is the cleanest result in the review. `grep -rnE "req\.[a-zA-Z]+"` across all authored `.js` returns **no matches** — the handlers declare `req` but never read a single property off it. There is no input to sanitize because no input is ever consumed.

| Sink | Present? | Evidence |
|---|---|---|
| `eval` / `new Function` / `vm` | No | `grep -rnE "\beval\s*\(\|new Function\|vm\."` → exit 1 |
| `child_process` / `exec` / `spawn` | No | same grep → exit 1 |
| `fs` read or write | No | `grep -rnE "require\(['\"]fs\|readFile\|writeFile"` → exit 1 |
| `path.join` from request data | No | `grep -rnE "require\(['\"]path\|path\.join"` → exit 1 |
| Template rendering | No | `grep -rnE "res\.render\|res\.sendFile"` → exit 1. No view engine configured. |
| SQL / ORM | No | `grep -rnE "\.query\(\|SELECT \|INSERT \|UPDATE \|DELETE FROM"` → exit 1. No database dependency exists. |
| Prototype pollution | No | `grep -rnE "__proto__\|prototype\[\|Object\.assign\|constructor\[\|JSON\.parse"` → exit 1. Live probes `/__proto__`, `/constructor/prototype`, and `?__proto__[x]=1` all behaved normally (404/404/200). No body parser is mounted, so the classic pollution vector (parsed JSON body merged into an object) does not exist. |
| Redirect / SSRF | No | `grep -rnE "res\.redirect"` → exit 1. No outbound HTTP client. Absolute-form URI `GET http://evil.example.com/ping` returned a normal `200` — routed on path, nothing proxied. |
| Deserialization | No | `grep -rnE "deserialize\|unserialize"` → exit 1 |

Traversal probes (`/../../../etc/passwd` with `--path-as-is`, and `/..%2f..%2fetc%2fpasswd`) both returned `{"error":"not found"}`. There is no `express.static()` mount and no filesystem access of any kind, so traversal has no target.

---

## 5. Accepted risks / out of scope by decision

Every item below was placed out of scope by the brief and approved by a human at Gate 1 (requirements) and Gate 2 (design). **None of these is a finding, and none blocks sign-off.** They are recorded so the register is explicit and so a future reviewer does not re-litigate a closed decision.

| Risk | Why accepted | Approving reference |
|---|---|---|
| **No authentication or authorization.** Every caller is anonymous and identical. | The service exposes one read-only route returning a clock reading. There is no principal, no resource ownership, and no state-changing operation, so there is nothing for authn/authz to protect. | brief "Explicitly OUT of scope" §2; requirements §2.2; requirements §6 role matrix (exactly one role: anonymous) |
| **No security headers — `helmet` absent.** No CSP, HSTS, `X-Content-Type-Options`, or frame options. | Security headers are explicitly out of scope. The response is always `application/json` with no HTML, so the browser-facing threats these headers mitigate (XSS, clickjacking, MIME sniffing into script) have no vehicle here. | brief §4; requirements §2.4; design §1 goal 2 (no `helmet` dependency) |
| **`x-powered-by: Express` is on** — server fingerprinting. Confirmed present on every response. | Accepted Express default; removing it is a security-header concern, which is out of scope. Fingerprinting discloses only that this is Express, which the JSON error shapes would suggest anyway. | design §3.4 (accepted defaults, explicitly "recorded so review confirms them rather than flags them"); requirements §2.4 |
| **No rate limiting.** A client may issue unlimited requests. | Out of scope. Confirmed in §3 that the code does not *amplify* this: no unbounded allocation, no blocking loop, no ReDoS. Mitigation for a real deployment belongs at the ingress, not in a five-file demo. | brief §4; requirements §2.4; design §1 |
| **No logging and no audit trail.** No request log, no error log, no audit entries. | Out of scope. There is no state-changing operation, no PII access, and no privileged action to audit. The audit-integrity checks (append-only, auditor-only read, actor/action/target capture) are not applicable — no audit subsystem exists and none is required. | brief §4; requirements §2.4 |
| **No CORS policy.** No `Access-Control-Allow-Origin`; browsers apply same-origin by default. | Out of scope. Absent CORS headers are the *restrictive* default — cross-origin browser reads are blocked, not allowed. `OPTIONS /ping` correctly returns `404` with no `Allow` header. | requirements §2.4; design §4.2 |
| **Plain HTTP on port 3000, no TLS.** Traffic is unencrypted and unauthenticated in transit. | For a local demo bound on the loopback interface, traffic does not leave the host. The only payload is a public clock reading, so confidentiality loss is nil; the meaningful residual is that an on-path attacker on a shared network could tamper with the response. See §8 for what changes if this is ever exposed. | brief acceptance criterion 3 ("listens on port 3000"); design §4 ("Base URL in local development: `http://localhost:3000`"); TLS/deployment out of scope per requirements §2.5 |
| **No `.gitignore`; `node_modules/` (347 packages) would be committed if this tree were `git init`-ed.** The directory is currently **not** a git repo (`ls -d .git` → no such file). | Deliberately not generated; not required by any requirement or AC. There is no `.env` and no secret anywhere in the tree, so the confidentiality consequence of committing is zero — the cost is repository size only. | design §2 "Files deliberately NOT generated"; ADR-005 |
| **`PORT` is read unvalidated.** `PORT=abc` surfaces as a Node `listen` error rather than a friendly message. | Deliberate: adding validation means adding a config layer and a dependency, breaking NFR-9's hard count of one production dependency. `PORT` is operator-set, not attacker-controlled. | ADR-005 (states this consequence verbatim); design §6.1 ("Not validated, not coerced") |
| **`etag` on, case-insensitive and non-strict routing** (`/PING` and `/ping/` both return `200`). | Accepted Express defaults. The ETag is computed over a body containing a per-request timestamp, so it changes every request and cannot serve a stale `304`. Routing leniency has no security consequence with one public route. | design §3.4 |
| **PII controls (encryption at rest, role-based masking, audit-before-read) are absent.** | There is no PII, no persistence, and no role beyond anonymous. See §7 — I verified the empty inventory against the code rather than taking it on trust. | requirements §5 (empty by design); design §5 ("PII: none") |

---

## 6. Dependency audit

### `npm audit` — actual output

Run in `/workspace/ping-service/src`:

```
$ npm audit --omit=dev
found 0 vulnerabilities

$ npm audit
found 0 vulnerabilities
```

Machine-readable summary (`npm audit --json` → `.metadata`):

```json
{
  "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0 },
  "dependencies":    { "prod": 68, "dev": 280, "optional": 1, "peer": 0, "peerOptional": 0, "total": 347 }
}
```

**No high or critical advisories. No advisories at any severity, production or development.** Toolchain: Node v26.4.0, npm 11.17.0.

### Installed versions

| Package | Declared | Installed | Note |
|---|---|---|---|
| `express` | `^5.1.0` | **5.2.1** | Satisfies the range. No advisory affects this version. |
| `jest` (dev) | `^29.7.0` | — | dev only, never loaded by `server.js` |
| `supertest` (dev) | `^7.1.1` | — | dev only |

Transitive packages with a history of Express-ecosystem advisories, all on patched lines:

| Package | Installed | Relevance |
|---|---|---|
| `path-to-regexp` | 8.4.2 | The ReDoS advisory (GHSA-9wv6-86v2-598j) affects 0.1.x / 1.x–6.2.x / 7.x–8.0.0. 8.4.2 is patched. Additionally, ADR-004's path-less `app.use()` means no user-supplied pattern is ever compiled. |
| `cookie` | 0.7.2 | Out-of-bounds advisory affects `<0.7.0`. Patched — and no cookie is ever read or set. |
| `body-parser` | 2.3.0 | DoS advisory affects the `<1.20.3` line. Patched — and **not mounted**, so it is never invoked. |
| `send` / `serve-static` | 1.2.1 / 2.2.1 | Post-patch. Never invoked; no static mount exists. |
| `qs` | 6.15.3 | Post-patch. No query string is ever read. |
| `finalhandler` | 2.1.1 | Reachable only via the `headersSent` delegation (SEC-02). |

### Supply-chain assessment

**Honest posture: small, clean, and well-provenanced, but not as small as the manifest suggests.** The manifest declares one production dependency, and NFR-9 is satisfied at the declaration level. The *installed* production tree is **68 packages** — Express 5 pulls in a substantial transitive graph. That is the real trusted-code surface at runtime and it is worth stating plainly rather than reporting "one dependency" and moving on. It is nonetheless small for a Node HTTP service, and the graph is Express's own, maintained under the Express/`jshttp` orgs.

Provenance checks on `package-lock.json` (lockfileVersion 3, 348 entries):

- **Registry provenance:** every entry with a `resolved` field resolves to `registry.npmjs.org`. **No git sources, no plain-`http://` sources, no tarball URLs, no local file paths.**
- **Integrity:** **every** resolved entry carries an `integrity` hash. There are no unpinned or unverifiable entries.
- **Install-time execution surface:** **zero.** No installed top-level package declares `preinstall`, `install`, or `postinstall` (verified by parsing every `node_modules/*/package.json` and `node_modules/@*/*/package.json`). A tree-wide scan surfaced 19 `prepare` scripts, but `prepare` does not execute for packages installed from registry tarballs — it runs only for git dependencies and local links, of which there are none. The single `postinstall` hit was inside `node_modules/resolve/test/resolver/multirepo/package.json`, a test fixture that is never installed or executed.
- **Dev/prod separation:** the 280 dev packages (Jest's toolchain) are loaded only by `npm test` and never by `npm start`, so they are not part of the runtime attack surface.

Residual supply-chain risk is the ordinary npm ecosystem risk of a 68-package production graph — a compromised upstream release would be pulled in on a future `npm install` because the ranges are carets (`^5.1.0`). The lockfile pins exact versions with integrity hashes, so that risk materialises only on a deliberate re-resolve. Acceptable for this service; noted in §8 for anything longer-lived.

---

## 7. PII and data handling

**The empty PII inventory in requirements §5 is accurate. I verified it against the code rather than accepting the assertion.**

The checklist's PII items — encryption at rest for `government_id` / `bank_account` / `salary_base`, role-based response masking in a serializer or interceptor, audit-log-before-PII-read — are **not applicable**, and I want to be precise about *why*, because "not applicable" earned by inspection is a different claim from "not applicable" assumed:

| Claim | Verification |
|---|---|
| Those fields do not exist | `grep -rnE "government_id\|bank_account\|salary_base"` over authored files → no matches. There is no entity, schema, model, or DTO of any kind — no `models/`, `entities/`, `schemas/`, or `db/` directory exists (`find` over `src/` shows a flat tree with no subdirectories other than `node_modules`). |
| No PII is *read* | `grep -rnE "req\.[a-zA-Z]+"` over authored `.js` → **no matches**. The application never reads the body, query, headers, cookies, IP, or params. There is no body parser mounted, so a body is not even deserialized. |
| No PII is *stored* | No database, ORM, cache, or filesystem write exists (`grep` for `fs`, `path`, `.query(`, SQL keywords → all exit 1). No module-level mutable state. Nothing survives the request, and nothing survives the process. |
| No PII is *logged* | `console` appears exactly once repo-wide, at `server.js:5`, printing the resolved port at boot. No request data can reach it. No logging framework is installed. |
| No PII is *emitted* | The complete emitted value set is `"ok"`, `new Date().toISOString()`, `"not found"`, `"internal server error"`. Verified on the wire across 23 live probes; no response body ever varied from these literals plus the timestamp. |
| Encryption at rest is not applicable | There is no "at rest" — no persistence layer of any kind (requirements §2.1). |
| Role-based masking is not applicable | One role exists (requirements §6: anonymous). Masking requires two roles that see different projections of the same field; there is neither a second role nor a field. |
| Audit-before-read is not applicable | There is no PII read to audit and no audit subsystem (out of scope, requirements §2.4). |

The one value the service emits that has any information content is the host clock reading. It is not personal data, and it is already disclosed by the mandatory HTTP `Date` header on every response, so `/ping` adds no disclosure over an empty 404.

**Conclusion: nothing to classify, mask, encrypt, tokenize, or retain. The empty inventory is correct, and design §5's claim holds against the code.**

---

## 8. Recommendations if this service were ever exposed publicly

**NOT REQUIRED FOR THIS RUN'S ACCEPTANCE.** Every item here is explicitly out of scope for the approved design and none of it should be treated as a gap, a blocker, or a refinement packet. This section exists only so that the accepted risks in §5 come with a stated remediation path if the deployment context ever changes. Adding any of this now would violate the approved scope.

If this service were promoted beyond a local demo, revisit in roughly this order:

1. **Terminate TLS in front of it.** Plain HTTP is fine on loopback and not fine on a network. Put it behind a reverse proxy (nginx, Caddy, or a cloud load balancer) that terminates TLS and forwards over the loopback. Do not add TLS to `server.js` — key handling belongs at the ingress.
2. **Rate-limit at the ingress, not in the app.** The DoS residual in §5 is best answered where connection state already lives. An in-process `express-rate-limit` would break NFR-9's dependency count for a weaker mitigation.
3. **Add `helmet`, or at minimum disable `x-powered-by`** (`app.disable('x-powered-by')` — one line, no dependency). This closes the fingerprinting item in §5 at near-zero cost, and is the single cheapest item on this list.
4. **Add a `clientError` handler on the `http.Server` in `server.js`** if a strict "every response is JSON" contract is ever required externally. This is the remediation for SEC-01, and it belongs in `server.js` so `app.js` stays portless and testable per ADR-001.
5. **Add structured request logging** if any operational or forensic requirement appears. Note the interaction with SEC-02: once a log collector exists, the `finalhandler` stderr stack becomes collected data, so scrub or route it deliberately.
6. **Add a `.gitignore` before the first commit** if this tree is ever version-controlled, so the 347-package `node_modules/` is not committed. No secret exposure is at stake — this is repository hygiene.
7. **Pin dependencies and add automated advisory scanning** (`npm ci` in CI plus a scheduled `npm audit --omit=dev`), since caret ranges will re-resolve the 68-package production graph on any fresh install.
8. **Add a health/readiness distinction** if this sits behind an orchestrator — `/ping` currently answers `200` unconditionally and reports nothing about actual readiness, which would make it a misleading liveness probe for a service that later grows dependencies.

---

## Sign-off

**PASS WITH ACCEPTED RISKS.** No security defects. No blocking findings. No refinement packets required.

The design's central security claim — a JSON-only response surface with Express's HTML error page unreachable by construction (FR-11 / AC-8 / ADR-003) — is **confirmed by execution**, across four distinct failure modes and all three `NODE_ENV` settings. Secrets: none present, and the absence of `.env` fixtures is the approved state, verified consistent with the total absence of a config layer. Dependencies: `npm audit --omit=dev` reports **0 vulnerabilities**, on a well-provenanced lockfile with zero install-time execution hooks. Input handling: there is genuinely no untrusted input reaching any sink, because the application reads no property off `req` at all.
