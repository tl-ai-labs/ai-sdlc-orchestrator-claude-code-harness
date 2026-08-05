## Task tp_codegen_003 — codegen / module_wiring
Module: server
### Working directory
You are running as an agent inside `/workspace/ping-service/src`. You may list, read,
edit and create files there, and run commands there. That directory is the
only place you can act; nothing outside it is reachable.
### Instruction
Create the file server.js in the working directory - the process entrypoint, four statements total. Start with 'use strict';. CommonJS. const app = require('./app'); then const port = process.env.PORT || 3000; then app.listen(port, () => { console.log(`listening on port ${port}`); });. This is the ONLY file in the project permitted to read process.env, and it reads exactly one variable: PORT, defaulting to 3000, unvalidated. Do NOT add dotenv, do NOT add a validation schema, do NOT add signal handlers or graceful shutdown, do NOT export anything. Do not modify any other file.
### Provided excerpts
These are extracts, not whole files. The paths are real — open them in the
working directory when you need more than the excerpt shows.

#### .sdlc/design.md#6.1
_Included because: The complete environment inventory for the project - one variable._

```
PORT: read by src/server.js in one line, not validated, not coerced, not required at boot, default 3000. Resolution is exactly: const port = process.env.PORT || 3000;
```
### Acceptance criteria
- File begins with 'use strict';.
- Requires ./app.
- Reads process.env.PORT with a default of 3000.
- Calls app.listen(port, callback).
- Exports nothing and adds no dependency.
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