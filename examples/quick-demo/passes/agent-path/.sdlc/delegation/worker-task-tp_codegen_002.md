## Task tp_codegen_002 — codegen / controller_handler
Module: ping
### Working directory
You are running as an agent inside `/workspace/ping-service/src`. You may list, read,
edit and create files there, and run commands there. That directory is the
only place you can act; nothing outside it is reachable.
### Instruction
Create the file app.js in the working directory - the Express application module. Start with 'use strict';. CommonJS only. Require express and NOTHING else. Construct the app, then register EXACTLY three handlers in THIS EXACT ORDER, because the order is load-bearing:
(1) app.get('/ping', (req, res) => ...) responding res.status(200).json({ status: 'ok', time: new Date().toISOString() }). The timestamp MUST be computed inside the handler at call time, never at module load.
(2) A catch-all 404: app.use((req, res) => { res.status(404).json({ error: 'not found' }); }); - with NO path argument. Do NOT write app.all('*', ...) or app.use('*', ...): under Express 5 / path-to-regexp v8 a bare '*' throws TypeError: Missing parameter name at module load and kills the process.
(3) A terminal error handler registered LAST: app.use((err, req, res, next) => { if (res.headersSent) { return next(err); } res.status(500).json({ error: 'internal server error' }); }); - it MUST declare all four parameters, because Express identifies error middleware solely by fn.length === 4. Never include err.message, err.stack, or any HTML in the body.
End with module.exports = app;. This file must NOT call listen(), must NOT read process.env, must NOT mount a body parser, and must NOT console.log.
### Provided excerpts
These are extracts, not whole files. The paths are real — open them in the
working directory when you need more than the excerpt shows.

#### .sdlc/design.md#3.2
_Included because: Ordering and arity are the two failure modes that silently break FR-1 and AC-8._

```
Registration order: (1) app.get('/ping') (2) path-less app.use() 404 catch-all (3) 4-arity error handler LAST. Catch-all after route or it swallows GET /ping. Error handler last so a throw inside the 404 handler still lands on JSON. Arity 4 is the detection mechanism.
```

#### .sdlc/design.md#4
_Included because: Exact response bodies and status codes._

```
GET /ping -> 200 {"status":"ok","time":"<ISO-8601 UTC>"} exactly two keys. Catch-all -> 404 {"error":"not found"}. Unexpected error -> 500 {"error":"internal server error"}, fixed literal, no stack trace.
```
### Acceptance criteria
- File begins with 'use strict';.
- Requires express and no other module.
- app.get('/ping', ...) is registered before the catch-all.
- The catch-all is app.use(fn) with no path argument; the literal '*' appears nowhere as a route path.
- The error handler is the last registration and declares exactly four parameters (err, req, res, next).
- The error handler guards on res.headersSent and delegates via next(err).
- new Date().toISOString() is evaluated inside the /ping handler, not at module scope.
- The file contains no listen( call, no process.env reference, and no console call.
- The file ends with module.exports = app;.
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