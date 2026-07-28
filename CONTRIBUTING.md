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
3. Run `node tools/setup.mjs` on a clean clone to verify it still passes.
4. If you touched the plugin code, run a full pass locally and confirm the report still renders sensibly.
5. Open a pull request. Describe what changed and why in one or two paragraphs.

## Commit messages

Sentence case, present tense, no emojis. The body wraps at 72 characters and explains *why*, not *what* — the diff shows the what. Keep them short and readable.

Do not add `Co-Authored-By:` trailers for AI assistants. The committer identity is a bot on purpose; AI-attribution trailers add noise on a public repo. This applies to all commits, whether or not a Claude Code / other AI session helped author the change.

## Code style

The tooling scripts (`tools/setup.mjs`, `tools/report.mjs`) are plain ES modules. No TypeScript there, no build step; keep them that way so someone can read and modify them without a compiler.

The MCP server (`plugin/mcp/gemini-flash-server/`) is TypeScript with a build step. Follow the existing conventions in that directory.
