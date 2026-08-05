# Contributing

Thanks for your interest in improving this study.

## What contributions we welcome

- **Bug fixes** in the setup wizard, report tool, or plugin code.
- **Documentation improvements** — typos, unclear phrasing, additional troubleshooting entries.
- **Additional policies** under `plugin/config/policies/`. If you add one, include a short comment header describing what it demonstrates and what keys it needs.
- **Portability fixes** for Windows/WSL, non-mac Linux distributions, or other environments.

## What we would rather not merge without discussion first

- Wholesale rewrites of the orchestrator agent or the state machine.
- New model adapters — happy to review, but the two shipped are what the two shipped policies need. Additional adapters mean additional deps and additional maintenance surface.
- Changes that add reporting or telemetry surface without adding a corresponding entry in `docs/methodology.md`.

Open an issue to discuss before writing a large PR — saves everyone time.

## How to submit

1. Fork the repo, create a feature branch off `main`.
2. Make your change. Keep the diff focused; one topic per PR.
3. Run `npm test` from the repo root. It runs the tooling suite and then the MCP server's own, and every one of them is offline and free — no credential is read and no API call is made, so there is no reason not to run it.
4. Run `node tools/setup.mjs` on a clean clone to verify it still passes.
5. If you touched the plugin code, run a full pass locally and confirm the report still renders sensibly.
6. Open a pull request. Describe what changed and why in one or two paragraphs.

## Commit messages

Sentence case, present tense, no emojis. The body wraps at 72 characters and explains *why*, not *what* — the diff shows the what. Keep them short and readable.

Do not add `Co-Authored-By:` trailers for AI assistants. The committer identity is a bot on purpose; AI-attribution trailers add noise on a public repo. This applies to all commits, whether or not a Claude Code / other AI session helped author the change.

## Code style

The tooling scripts under `tools/` (`setup.mjs`, `report.mjs`, `logfmt.mjs`, and the tests beside them in `tools/test/`) are plain ES modules. No TypeScript there, no build step; keep them that way so someone can read and modify them without a compiler.

The same goes for `plugin/scripts/` (`verify-setup.mjs`, `probe-agent-worker.mjs`), and there the reason is stronger than preference: those two have to run on a machine that installed the plugin with `/plugin install` and therefore has no `tools/` directory, no `node_modules/`, and no build output. Anything they import has to be either a Node builtin or something they can find inside the plugin. Their tests still live in `tools/test/`, where `npm test` picks them up — a test file may import from `plugin/scripts/`, but not the other way round.

The MCP server (`plugin/mcp/gemini-flash-server/`) is TypeScript with a build step. Follow the existing conventions in that directory.

There is one Python file, `plugin/mcp/gemini-flash-server/worker/gemini_worker.py`, because the Antigravity SDK it drives is a Python package and there is no other way to reach it. It is deliberately the only one, and it is only ever installed on machines that opted into the agent path — a plugin that quietly required Python of everyone would be a worse trade than the feature is worth. Keep it that way: new work belongs in TypeScript unless it, too, can only be done from Python.
