# Docs restructure — v2 plan

> **Status:** design draft, not active work. Ship when triggering conditions below are met.
> **Owner:** whichever contributor picks this up. Self-contained; no other doc has to be read first.
> **Companion:** [docs/README.md](../README.md) is the Level 1 landing page this plan builds on. Read it first if the current shape of `docs/` isn't in your head.

## Purpose

Move the docs from a flat folder of 14 Markdown files into a proper information architecture, and stand up a hosted docs site backed by that source. The goal is to give a first-time visitor the same craft in the docs as the README already gives them at the entry point — landing → category → doc — with sidebar navigation, search, and a version toggle that the GitHub Markdown renderer cannot provide on its own.

Level 1 (already shipped when this file was written) covered: a landing page at `docs/README.md`, a missing tutorial, and a "For: … · Also see: …" chip on every existing doc. Level 2 is the deeper move.

## When to trigger this

Not now. Do this when at least two of these are true:

- External adoption is real — 100+ stars, non-Tilicho contributors filing issues that touch multiple docs.
- Support burden justifies search — the same "where is X documented?" question shows up in issues three times in a month.
- A team member has bandwidth for a two-week focused pass — this is not a weekend refactor.
- The project ships a hosted product surface (`docs.tilicho.io` or similar) that a docs site can live alongside.

Until then, Level 1 covers 70% of the value at 20% of the effort.

## What changes

### 1. Directory structure

Move from flat `docs/*.md` to four subdirectories keyed on reader intent (Diátaxis quadrants):

```
docs/
├── README.md                        — unchanged: the landing page
│
├── tutorial/                        — learning-oriented
│   ├── first-run.md                 (from: tutorial-first-run.md at docs root)
│   └── first-brownfield.md          (NEW — analog for /mmo:brownfield)
│
├── how-to/                          — task-oriented
│   ├── install.md                   (from: setup.md)
│   ├── run-a-pass.md                (from: running.md)
│   ├── bring-your-own-brief.md      (from: brief-template.md)
│   ├── change-policy.md             (NEW — extracted from setup.md's policy section)
│   ├── revert-a-run.md              (NEW — small how-to for /mmo:revert)
│   └── run-in-ci.md                 (NEW — headless / auto-approve / auto-abort)
│
├── reference/                       — information-oriented
│   ├── commands.md                  (NEW — every /mmo:* command in one page)
│   ├── flags.md                     (NEW — every flag on every command)
│   ├── policies.md                  (NEW — policy YAML schema + shipped presets)
│   ├── output-files.md              (from: understanding-output.md)
│   ├── env-vars.md                  (NEW — extracted from setup.md)
│   ├── troubleshooting.md           (unchanged)
│   └── setup-issues.md              (from: brownfield-setup-issues.md)
│
├── concepts/                        — understanding-oriented
│   ├── architecture.md              (unchanged)
│   ├── two-gemini-paths.md          (unchanged)
│   ├── methodology.md               (unchanged)
│   ├── brownfield-mode.md           (from: brownfield.md)
│   ├── write-contract.md            (from: brownfield-write-contract.md)
│   ├── model-routing.md             (from: brownfield-routing.md)
│   ├── data-privacy.md              (from: brownfield-privacy.md)
│   └── coexistence.md               (from: brownfield-coexistence.md)
│
├── planning/                        — design scratch (unchanged)
│   └── docs-restructure-v2.md       (this file — should be deleted after execution)
│
└── walkthroughs/                    — historical records (unchanged)
```

Total: 14 existing files → 22 files across four categories, with 6 new files.

### 2. New content (6 net-new files)

| File | Purpose | Rough length |
|---|---|---|
| `tutorial/first-brownfield.md` | 10-minute walkthrough of running `/mmo:brownfield` on a small existing repo. Same shape as the greenfield tutorial. | ~150 lines |
| `how-to/change-policy.md` | Wraps `/mmo:policy` — show, change via browser, silent set, per-run override. | ~60 lines |
| `how-to/revert-a-run.md` | Wraps `/mmo:revert` — the interactive picker and by-id form; explains the dirty-tree refusal. | ~50 lines |
| `how-to/run-in-ci.md` | `--gates=auto-approve`, `--gates=auto-abort`, `--from-config`, headless invocation via `claude --print`. | ~80 lines |
| `reference/commands.md` | Every `/mmo:*` command with a one-line description and a link to its how-to. Alphabetized. | ~40 lines |
| `reference/flags.md` | Table: flag × command × meaning × default. Sorted by flag name. | ~120 lines |
| `reference/policies.md` | Policy YAML schema, shipped presets side-by-side, custom-policy walkthrough. | ~150 lines |
| `reference/env-vars.md` | Every env var the plugin reads. Extracted from `setup.md`; leaves setup.md focused on the credential flow. | ~80 lines |

Source of truth for `commands.md` and `flags.md`: `plugin/commands/*.md`. The reference pages are derived views — consider a small script under `tools/` that regenerates them from the frontmatter so they can't drift.

### 3. Content edits beyond the move

Every moved file needs a light pass:

- **Rename links inside the file** to point at the new sibling locations. Especially for `brownfield.md` → `concepts/brownfield-mode.md`, which currently links to the other brownfield-*.md files at the same directory level; all those links need `../concepts/write-contract.md`-style rewrites.
- **Drop the "For:" chip added in Level 1** — the directory location now signals the role, so the chip is redundant. Keep the "Also see:" tail.
- **Add a category header** to every doc: right after the H1, a small breadcrumb (`Concepts · Architecture`) that mirrors the sidebar the hosted site will render.
- **Split `setup.md`**: the extraction of env vars into `reference/env-vars.md` leaves the how-to focused on the credential-and-policy flow. The env-var reference is where readers who already understand the flow but need one specific variable land.

### 4. Style test updates

`tools/test/style.test.mjs` currently walks `docs/*.md` non-recursively (see the `userFacingDocs()` function). After the move, it needs to walk `docs/**/*.md` recursively, still excluding `planning/` and `walkthroughs/` (which are already excluded intent).

Suggested change:

```js
// Recursive walk of docs/, excluding planning/ and walkthroughs/.
function userFacingDocs() {
  const paths = [
    join(ROOT, "README.md"),
    join(ROOT, "CONTRIBUTING.md"),
    join(ROOT, "CLAUDE.md"),
  ];
  const walk = (dir, relDir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (rel === "planning" || rel === "walkthroughs") continue;
        walk(full, rel);
      } else if (entry.name.endsWith(".md")) {
        paths.push(full);
      }
    }
  };
  walk(join(ROOT, "docs"), "");
  return paths.filter(existsSync);
}
```

Verify the changed test still passes on every moved file. The Level 1 pass got every current doc clean of style violations, so the moves themselves shouldn't introduce new hits.

### 5. Inbound link migration

Every rename breaks incoming links. Two classes:

**Inside the repo** — a full audit:

```bash
# Find every doc-to-doc link that will need rewriting.
grep -rE '\]\(([^)]+\.md)' docs/ README.md CONTRIBUTING.md CLAUDE.md
```

Every hit needs a rewrite. Approximate count from Level 1: ~40 internal links across the repo.

**Outside the repo** — 302 redirects. If the docs are served via GitHub only (no hosted site yet), broken links are just 404s in the wild. If a hosted site is up by execution time, configure the static-site host (Netlify `_redirects`, Vercel `vercel.json`, Cloudflare Pages `_redirects`) with a rule per rename:

```
/docs/setup.md              /docs/how-to/install
/docs/running.md            /docs/how-to/run-a-pass
/docs/brownfield.md         /docs/concepts/brownfield-mode
… (one line per renamed file, ~10 total)
```

**Historical records** — `docs/walkthroughs/*.html` currently reference the old paths in prose. They're frozen historical records, so leave them alone; add a note to their frontmatter noting the paths were current as of the walkthrough's date.

### 6. Hosted docs site

Pick one static-site generator. Constraints:

- Must consume plain Markdown from `docs/` — no rewriting the source to some proprietary format.
- Must support sidebar nav from a `sidebar.json`-style config or directory-inferred.
- Must render `mermaid` fences and inline SVG.
- Must support light + dark themes.
- Bonus: version toggle for future v2.0.

Candidates in decreasing order of fit:

| Tool | Fit | Trade |
|---|---|---|
| **Nextra** (Next.js) | Very good — MDX-native, mermaid, dark mode, versioning via directories. | Next.js runtime overhead; deploys on Vercel cleanly. |
| **Docusaurus** | Very good — the de facto standard for OSS docs, huge ecosystem. | Feels heavy for a small doc set; opinionated theme. |
| **Mintlify** | Excellent output, hosted for you. | Vendor lock-in; monthly cost. |
| **VitePress** | Clean, fast, minimal. | Sidebar is manual; less polish out of the box. |
| **Astro + Starlight** | Newest, growing fast, well-tuned for docs. | Younger ecosystem. |

Recommendation: **Nextra or Astro Starlight.** Both let you keep the Markdown as source of truth. Docusaurus is the safe choice if you want maximum stability.

### 7. README update

The main `README.md` currently links directly at `docs/setup.md`, `docs/running.md`, etc. After the move, these links need to point at the new locations. A find/replace pass:

```
docs/setup.md              → docs/how-to/install.md
docs/running.md            → docs/how-to/run-a-pass.md
docs/architecture.md       → docs/concepts/architecture.md
docs/methodology.md        → docs/concepts/methodology.md
docs/two-gemini-paths.md   → docs/concepts/two-gemini-paths.md
docs/understanding-output.md → docs/reference/output-files.md
docs/troubleshooting.md    → docs/reference/troubleshooting.md
docs/brownfield.md         → docs/concepts/brownfield-mode.md
docs/brief-template.md     → docs/how-to/bring-your-own-brief.md
```

## Migration steps (order matters)

1. **Freeze docs edits** — post a message in the repo issue tracker that docs are being restructured; ask for no new PRs against `docs/*.md` until the move lands.
2. **Create new subdirectories** — `mkdir docs/{tutorial,how-to,reference,concepts}`.
3. **Move existing files with git mv** — preserves history. `git mv docs/setup.md docs/how-to/install.md`, etc. Do all 14 moves in one commit so history-following works.
4. **Write the 8 new files** — commit each as its own commit for reviewability.
5. **Rewrite links inside every moved file** — pass through each with `sed` or an editor macro; verify with `grep -rE '\]\([^)]+\.md\)' docs/`.
6. **Rewrite links in README.md, CONTRIBUTING.md, CLAUDE.md** — the same audit, wider net.
7. **Update `tools/test/style.test.mjs`** — recursive walk, keep exclusions.
8. **Run `npm test`** — should pass. If any doc fails style checks now (a slop word, a bare `the user`), fix in the same commit.
9. **Add category headers** — the small breadcrumb block right after each H1.
10. **Stand up the hosted docs site** — Nextra or Astro Starlight scaffolded, `docs/` mounted, deployed to a subdomain.
11. **Configure redirects** — one per rename, on the hosting layer.
12. **Delete this planning doc** — the plan is executed; `git rm docs/planning/docs-restructure-v2.md`.

## Verification

After execution, every one of these should pass:

- `npm test` — 205+ passing, no new failures beyond the two pre-existing lockfile issues.
- `grep -rE '\]\((?!http)[^)]+\.md\)' docs/ README.md CONTRIBUTING.md CLAUDE.md | grep -v 'planning/' | xargs -I{} test -f {}` — every relative Markdown link resolves.
- Every renamed file's history is preserved: `git log --follow docs/how-to/install.md` shows the setup.md history.
- The hosted docs site builds cleanly and renders every page.
- Every mermaid fence and inline SVG renders in the hosted theme (both light and dark).

## Rollback

If the move needs to be reverted (external adoption stalls, or the hosted site turns out to be more maintenance than the folder was):

- `git revert` the move commit — restores the flat structure, keeps history intact.
- Take the hosted site down; keep the domain.
- The 8 new content files (`tutorial/first-brownfield.md`, the how-to and reference pages) are still valuable — move them to the docs root under kebab-case names.

The move is designed to be reversible for at least six months after execution; after that, external references to the new paths make the rollback a breaking change of its own.

## Out of scope

- Translation / i18n. If this becomes needed, revisit the tooling choice — Docusaurus has the best i18n story.
- Interactive tutorials / embedded playgrounds. Real product work; not a docs refactor.
- Auto-generated API reference. There's no exported API to generate from; the plugin's surface is slash commands and MCP tools, both already documented by hand.
- Versioned docs before there's a v2.0 to version. Premature. Add when needed.

## Notes for whoever picks this up

- The 14 existing docs are individually well-written after the Level 1 pass. Don't rewrite them during the move — just relocate and relink. Content edits are a separate PR.
- The "For: … · Also see: …" chip added in Level 1 is on every doc as of this plan's creation. Drop it during the move — the new directory location signals the role, and the "Also see:" tail is redundant with the sidebar the hosted site provides.
- `brownfield-v1-planning/` is a sibling directory of `planning/` — same "scratch not shipped" role, older milestone. Leave it alone in this refactor; it's owned by the brownfield-v1 work and will be deleted when that ships.
- If you're reading this and Level 1 isn't obviously in place (no `docs/README.md`, no `docs/tutorial-first-run.md`, no chips on existing docs), do Level 1 first. The two are additive, not parallel.
