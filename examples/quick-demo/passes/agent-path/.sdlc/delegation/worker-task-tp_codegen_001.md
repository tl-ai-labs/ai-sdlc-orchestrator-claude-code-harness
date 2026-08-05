## Task tp_codegen_001 — codegen / module_wiring
Module: manifest
### Working directory
You are running as an agent inside `/workspace/ping-service/src`. You may list, read,
edit and create files there, and run commands there. That directory is the
only place you can act; nothing outside it is reachable.
### Instruction
Create the file package.json in the working directory, for a minimal Express ping service. Requirements, all mandatory: name "ping-service", version "1.0.0", "private": true, a one-line "description", "main": "app.js", "license": "MIT". Do NOT include a "type" field (CommonJS is the default and "type": "module" is forbidden). "engines": { "node": ">=20" }. Scripts: EXACTLY two entries, "start": "node server.js" and "test": "jest" - no build, lint, dev, or prepare script. "dependencies": exactly one entry, { "express": "^5.1.0" }. "devDependencies": exactly two entries, { "jest": "^29.7.0", "supertest": "^7.1.1" }. Do NOT add a "jest" configuration key - Jest's defaults already find app.test.js and already default testEnvironment to node. Do not add any other dependency for any reason. Write valid JSON only.
### Provided excerpts
These are extracts, not whole files. The paths are real — open them in the
working directory when you need more than the excerpt shows.

#### .sdlc/design.md#6.4
_Included because: Exact manifest contract; dependency counts are capped by NFR-9._

```
package.json contract: private true, no "type" field, main app.js, scripts start=node server.js and test=jest only, dependencies {express ^5.1.0}, devDependencies {jest ^29.7.0, supertest ^7.1.1}, no jest key, engines node >=20.
```
### Acceptance criteria
- File parses as valid JSON.
- dependencies has exactly one key: express.
- devDependencies has exactly two keys: jest and supertest.
- scripts has exactly two keys: start and test.
- No "type" key is present anywhere in the file.
- No "jest" key is present at the top level.
- engines.node is ">=20".
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