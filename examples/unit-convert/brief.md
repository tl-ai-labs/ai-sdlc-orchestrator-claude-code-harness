# Project Brief — Unit Convert Service

## One-line summary
An HTTP service with one endpoint that converts Celsius to Fahrenheit.

## Business context
An internal utility other teams call from shell scripts. Nothing reads it by
hand, so every response — success or failure — has to be JSON a script can
branch on.

## Scope

### 1. Convert
- `GET /convert?c=<number>` returns HTTP 200 and `{ "fahrenheit": <number> }`,
  rounded to two decimal places. Zero and negative values are temperatures,
  not errors.
- A missing or non-numeric `c` returns HTTP 400 and `{ "error": "<reason>" }`.
- Any other path returns HTTP 404 and `{ "error": "not found" }`.

## Cross-cutting requirements
Errors return JSON, never an HTML page or a stack trace. Nothing else — no
auth, no logging, no rate limiting, no API documentation.

## Tech stack (fixed)
**Express** (JavaScript, CommonJS) on **Node 20+**, tested with **Jest** and
**supertest**. No database, no ORM, no build step.

## Non-functional
One test file covering the three responses above. A README documenting
`npm install`, `npm test`, `npm start`, and one `curl`. `npm test` is green on
a clean clone.

## Explicitly OUT of scope
1. Any database or persistence.
2. Authentication, users, and roles.
3. Fahrenheit-to-Celsius, Kelvin, and every unit other than the one above.

## Acceptance criteria
1. `npm install` succeeds and `npm test` is green.
2. `npm start` listens on port 3000.
3. `curl "localhost:3000/convert?c=100"` returns 200 with `fahrenheit` equal to 212.
4. `curl "localhost:3000/convert"` returns 400 with a JSON body, not HTML.
5. `curl localhost:3000/nope` returns 404 with a JSON body, not HTML.
