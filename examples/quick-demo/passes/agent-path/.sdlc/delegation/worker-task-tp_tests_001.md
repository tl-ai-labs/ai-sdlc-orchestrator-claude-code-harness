## Task tp_tests_001 — tests / test_integration
Module: ping
### Working directory
You are running as an agent inside `/workspace/ping-service/src`. You may list, read,
edit and create files there, and run commands there. That directory is the
only place you can act; nothing outside it is reachable.
### Instruction
Create the file app.test.js in the working directory - the single Jest + supertest suite. 'use strict'; CommonJS. Require supertest and ./app. NEVER require ./server and NEVER call app.listen() - supertest mounts the exported app on an ephemeral port so no handle leaks.
Write exactly three it() blocks:
BLOCK 1, GET /ping returns 200: capture const before = Date.now() immediately before the request and const after = Date.now() immediately after, then assert (a) status is 200; (b) res.headers['content-type'] matches the REGEX /application\/json/ - res.json() emits 'application/json; charset=utf-8', so a strict equality assertion against 'application/json' WILL FAIL; (c) res.body.status is exactly 'ok' via toBe; (d) Object.keys(res.body).sort() toEqual ['status','time'] proving exactly two keys; (e) typeof res.body.time is 'string'; (f) Number.isNaN(Date.parse(res.body.time)) is false; (g) res.body.time equals new Date(res.body.time).toISOString() proving canonical ISO-8601; (h) res.body.time.endsWith('Z') is true; (i) Date.parse(res.body.time) is >= before - 1000 and <= after + 1000, proving the timestamp is per-request not module-load.
BLOCK 2, unknown path returns 404 JSON: GET /nope, assert status 404, content-type matches /application\/json/, res.body toEqual { error: 'not found' }, and res.text.trim().startsWith('<') is false - this last assertion proves the body is JSON and not Express's HTML error page.
BLOCK 3, wrong method returns 404: POST /ping with no body, assert status 404 and res.body toEqual { error: 'not found' }. Add a comment naming FR-9 so nobody later 'fixes' this to 405.
Do not modify any other file. Do not create a jest.config.js.
### Provided excerpts
These are extracts, not whole files. The paths are real — open them in the
working directory when you need more than the excerpt shows.

#### .sdlc/design.md#7.2
_Included because: The full assertion specification._

```
Three it blocks with the assertion lists above. Supertest mounts the exported app rather than a listening server so the suite binds no fixed port and Jest exits cleanly.
```

#### .sdlc/design.md#4-note
_Included because: The single most likely way this generated test breaks._

```
res.json() emits Content-Type: application/json; charset=utf-8. Assert with a regex. Strict equality against 'application/json' will fail.
```

#### src/app.js
_Included because: The exact module under test, already generated._

```
'use strict';
const express = require('express');
const app = express();
app.get('/ping', (req, res) => { res.status(200).json({ status: 'ok', time: new Date().toISOString() }); });
app.use((req, res) => { res.status(404).json({ error: 'not found' }); });
app.use((err, req, res, next) => { if (res.headersSent) { return next(err); } res.status(500).json({ error: 'internal server error' }); });
module.exports = app;
```
### Acceptance criteria
- Exactly three it() blocks are present.
- The suite requires ./app and supertest; it never requires ./server and never calls listen(.
- Every Content-Type assertion uses a regex, never strict equality against 'application/json'.
- Block 1 asserts status toBe('ok'), exactly two body keys, canonical ISO-8601 round-trip, trailing Z, and per-request freshness bounds.
- Block 2 asserts res.text.trim().startsWith('<') is false.
- Block 3 asserts 404 for POST /ping and cites FR-9 in a comment.
### Your final message
Your final message must be a single JSON object and nothing else — no
prose before it, no summary after it, no ``` fence around it. It must
conform to this schema:

```json
{
  "type": "object",
  "required": [
    "artifact_path",
    "content"
  ],
  "properties": {
    "artifact_path": {
      "type": "string"
    },
    "content": {
      "type": "string"
    }
  }
}
```