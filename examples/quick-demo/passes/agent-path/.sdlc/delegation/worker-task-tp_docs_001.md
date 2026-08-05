## Task tp_docs_001 — docs / readme_section
Module: docs
### Working directory
You are running as an agent inside `/workspace/ping-service/src`. You may list, read,
edit and create files there, and run commands there. That directory is the
only place you can act; nothing outside it is reachable.
### Instruction
Create the file README.md in the working directory for the ping service. Required sections in order: (1) title and a one-line description; (2) Prerequisites - Node.js 20 or newer; (3) Install - a fenced bash block with `npm install`; (4) Test - a fenced bash block with `npm test`; (5) Run - a fenced bash block with `npm start`, noting the service listens on port 3000 by default and that the PORT environment variable overrides it; (6) an Endpoints markdown table with two rows: `GET /ping` -> 200 and everything else -> 404; (7) Examples - a worked `curl localhost:3000/ping` fenced block showing the exact response {"status":"ok","time":"2026-08-05T14:23:07.412Z"}, and a second `curl localhost:3000/nope` fenced block showing the exact response {"error":"not found"}; (8) a short 'Not included' list: no database, no authentication, no logging, no rate limiting, no Docker. Keep it tight - this is a five-file project. Do not document environment variables other than PORT. Do not invent endpoints. Do not modify any other file.
### Provided excerpts
These are extracts, not whole files. The paths are real — open them in the
working directory when you need more than the excerpt shows.

#### .sdlc/design.md#4
_Included because: The exact contract the README must document._

```
GET /ping -> 200 {"status":"ok","time":"<ISO-8601 UTC>"}. Any other method/path -> 404 {"error":"not found"}. Content-Type application/json; charset=utf-8.
```

#### acceptance
_Included because: The acceptance criterion this artifact satisfies._

```
AC-7: the README documents npm install, npm test, npm start, and one curl example.
```
### Acceptance criteria
- Documents npm install, npm test, and npm start each in a fenced code block.
- Contains at least one worked curl example with its exact JSON response.
- Contains an endpoints table covering GET /ping and the 404 catch-all.
- Mentions the 3000 default port and the PORT override.
- Documents no endpoint that does not exist and no environment variable other than PORT.
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