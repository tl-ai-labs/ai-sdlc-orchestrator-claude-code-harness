# Ping Service

A simple microservice that provides a health check ping endpoint.

## Requirements

Node.js 20 or newer is required to run this service.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Start

```bash
npm start
```

The service listens on port 3000 by default and honors a PORT environment variable override.

## Example

```bash
curl -s localhost:3000/ping
```

Output:
```json
{"status":"ok","time":"2026-08-05T12:34:56.789Z"}
```

## Endpoints

| Endpoint | Response |
| --- | --- |
| GET /ping | 200 `{"status":"ok","time":"..."}` |
| Any other method/path | 404 `{"error":"not found"}` |
