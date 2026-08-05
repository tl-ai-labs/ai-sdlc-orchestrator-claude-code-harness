# Ping Service

A minimal Express ping service.

## Prerequisites

Node.js 20 or newer.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Run

```bash
npm start
```

The service listens on port 3000 by default. The `PORT` environment variable overrides it.

## Endpoints

| Endpoint | Status |
| :--- | :--- |
| `GET /ping` | 200 |
| Everything else | 404 |

## Examples

```bash
curl localhost:3000/ping
```

Response:
```json
{"status":"ok","time":"2026-08-05T14:23:07.412Z"}
```

```bash
curl localhost:3000/nope
```

Response:
```json
{"error":"not found"}
```

## Not Included

* no database
* no authentication
* no logging
* no rate limiting
* no Docker
