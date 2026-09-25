# Opus + Flash vs Opus-only — cost study, in plain English

This page records every cost measurement we made on the plugin between 16 and 25 Sep 2026. It covers what each fix changed, what it cost, and what we learned. It is written for anyone on the team, not only people who know the plugin's internals.

The same study as a formatted page: [opus-flash-cost-study.html](opus-flash-cost-study.html) (open it in a browser). The technical plan behind the fixes is [../planning/opus-plus-flash-cost-plan.md](../planning/opus-plus-flash-cost-plan.md).

## The short answer (25 Sep)

**On the newest plugin versions (0.8.8 and 0.8.9), Opus + Flash is cheaper than Opus-only, by about 20%.**

- We ran three same-version pairs. On the full bill, Opus + Flash was cheaper all three times:

  | Pair | Opus + Flash | Opus-only | Result |
  |---|---|---|---|
  | 0.8.8 (Runs 30 / 31) | $9.79 | $13.98 | Flash 30% cheaper |
  | 0.8.9 (Runs 32 / 33b) | $9.36 | $9.55 | tie |
  | 0.8.9 (Runs 34 / 35) | $8.37 | $11.28 | Flash 26% cheaper |
  | **Average** | **$9.17** | **$11.60** | **Flash ≈ 21% cheaper** |

- Counting only the work itself (leaving out chat that happened in the same time window), the averages are $8.14 against $10.07, about 19% less. On that measure Opus-only won the middle pair by a little ($7.37 against $8.15).
- Caveats:
  - This rests on three pairs, and two identical runs can differ by about $2.50. Treat 20% as a clear trend, not a final number.
  - Averaged over **every** run since 23 Sep, the two setups are about even ($12.08 against $12.14). Flash only pulled ahead after the 0.8.8 fixes stopped Opus wasting money around it.
  - Every measurement uses one task on one existing codebase. We have no results yet for a bigger task or for a project built from scratch.

## What was measured

- **The task.** Every run did the same job on the Kaneo codebase (an open-source project-management app): *"add a new public profile page with default profile image"*. Each run changed about 11–17 files: an API endpoint, a web page, tests, and translations. It started with `/mmo:brownfield` and ran start to finish with no human stepping in.
- **The two setups.**
  - **Opus-only**: Claude Opus plans, writes all the code, and reviews it.
  - **Opus + Flash**: Opus plans and reviews, and hands the code-writing to Google's much cheaper Gemini Flash model.
- **Same conditions each time.** Same laptop, same starting code, same wording of the task, same review steps, and the same cache setting ("1-hour memory") on both sides from 23 Sep onwards.
- **What "cost" means.** The full bill for the run: every Opus message (the manager plus its helpers: planner, reviewers) plus what Flash cost. The plugin's collector prices each message at the public list price from the Claude Code logs. Where our own chat landed inside a run's time window, we give both the **full bill** and **the work itself**.

### A quick picture of where the money goes

Think of Opus as an expensive project lead who re-reads the whole project notebook before every single action. Flash is a cheap contractor.

- Flash cost **$0.05–$0.66 a run**, under 10 cents in the latest runs.
- **Over 90% of every bill is Opus** reading, re-reading, and planning.
- So the question was never "how do we make Flash cheaper". It was "how do we stop Opus spending so much preparing work for Flash and cleaning up after it". Almost every fix below is about that.

## Every run

"Full bill" is everything in the run's time window. "Work itself" leaves out our own chat that landed in the same window. Where the two are equal, no separate figure was taken.

| Run | Date | Plugin | Setup | Full bill | Work itself | Minutes | Note |
|---|---|---|---|---|---|---|---|
| — | 16–17 Sep | 0.7.3 | Opus-only | $19.16 | — | 48 | starting point |
| — | 16–17 Sep | 0.7.3 | Opus + Sonnet | $23.36 | — | 53 | trial of Sonnet as the worker |
| — | 16–17 Sep | 0.7.3 | Opus + Flash | $26.02 | — | 60 | starting point |
| A | 18 Sep | 0.7.4 | Opus-only | $22.91 | — | 71 | |
| B | 18 Sep | 0.7.4 | Opus + Flash | $20.75 | — | 51 | first Flash win |
| 9 | 18 Sep | 0.7.5 | Opus + Flash | ($24.76) | — | — | invalid: laptop froze mid-run |
| 10 | 18 Sep | 0.7.5 | Opus-only | $17.96 | — | 50 | |
| 11 | 18 Sep | 0.7.5 | Opus + Flash | $17.41 | — | 53 | |
| 12 | 21 Sep | 0.7.7 | Opus + Flash | — | — | — | invalid: an old helper server was running |
| 13 | 21 Sep | 0.7.7 | Opus + Flash | $18.77 | — | 65 | |
| 14 | 21 Sep | 0.7.8 | Opus + Flash | $17.05 | ≈ $15.42 | 38 | |
| 15 | 21 Sep | 0.7.8 | Opus-only | $21.06 | ≈ $20.50 | 36 | unfair: ran Flash-only steps |
| 16 | 21 Sep | 0.7.9 | Opus-only | $14.86 | ≈ $13.70 | 41 | |
| 17 | 21 Sep | 0.8.0 | Opus + Flash | $15.93 | ≈ $14.60 | 43 | setup bug cost ≈ $1.10 |
| 18 | 21 Sep | 0.8.0 | Opus-only | $17.40 | ≈ $16.10 | 45 | same setup as 16: shows the noise |
| 19 | 23 Sep | 0.8.1 | Opus + Flash | $16.12 | ≈ $14.65 | 71 | |
| 20 | 23 Sep | 0.8.1 | Opus + Flash | $13.90 | ≈ $13.33 | 59 | |
| 21 | 23 Sep | 0.8.1 | Opus-only | $17.43 | ≈ $16.47 | 79 | 5-minute memory trial |
| 22 | 23 Sep | 0.8.2 | Opus-only | $10.78 | ≈ $9.93 | 47 | |
| 23 | 23 Sep | 0.8.2 | Opus + Flash | $12.67 | ≈ $11.96 | 53 | |
| 24 | 23 Sep | 0.8.3 | Opus-only | $13.17 | ≈ $11.27 | 57 | |
| 25 | 23 Sep | 0.8.4 | Opus + Flash | $17.52 | ≈ $16.10 | 65 | 3 import-repair rounds |
| 26b | 24 Sep | 0.8.4 | Opus-only | $11.60 | ≈ $10.79 | 50 | Run 26 died after 1 minute |
| 27b | 24 Sep | 0.8.5 | Opus + Flash | $11.94 | ≈ $11.61 | 59 | Run 27 lost to a network outage |
| 28 | 24 Sep | 0.8.6 | Opus + Flash | $15.32 | ≈ $14.91 | 64 | manager paused 3× (≈ $4.10) |
| 29 | 24 Sep | 0.8.6 | Opus-only | $14.18 | ≈ $12.84 | 69 | |
| 30 | 24 Sep | 0.8.8 | Opus + Flash | $9.79 | ≈ $8.79 | 46 | |
| 31 | 24 Sep | 0.8.8 | Opus-only | $13.98 | ≈ $12.65 | 77 | |
| 32 | 24 Sep | 0.8.9 | Opus + Flash | $9.36 | ≈ $8.15 | 61 | Google "too busy" 8× |
| 33b | 24 Sep | 0.8.9 | Opus-only | $9.55 | ≈ $7.37 | 71 | Run 33 stopped by hand |
| 34 | 25 Sep | 0.8.9 | Opus + Flash | **$8.37** | ≈ $7.47 | 47 | cheapest full bill |
| 35 | 25 Sep | 0.8.9 | Opus-only | $11.28 | ≈ $10.20 | 64 | |

Every valid run passed its tests. From Row 4 onwards no run finished with a serious review issue left open; where a reviewer raised one, the run fixed it before finishing.

## What we fixed, row by row

Each "row" is one round of fixes to the plugin, followed by runs to measure it. Each row lists the problem it tackled, what changed, and what the measurements showed.

### Starting point — plugin 0.7.3 (16–17 Sep)

- **Setup:** Opus plans and reviews; a cheaper model (Flash, or Sonnet as a trial) writes the code.
- **Result:** Opus-only $19.16, Opus + Sonnet $23.36, Opus + Flash $26.02. Handing work to Flash made the run **36% more expensive**, even though Flash itself cost 12 cents.
- **Why:** the planner wrote the whole program into its plan (1,011 lines, 62 code blocks). Flash copied it out, and then Opus re-typed and re-read Flash's files. The code was effectively written three times.
- **Earlier findings (before this study):** delegating saved 25–60% on the delegated work itself, not the 10× hoped for. Sonnet was cheaper ($9.91 on a small task) but missed a requirement once, so Opus stayed on planning.

### Rows 1–3 — plugin 0.7.4 (18 Sep): Flash saves and checks its own work

- **Problem:** Opus copied every Flash file into place itself, and re-read it to check it.
- **Fixes:**
  1. Flash's output is written straight to disk by the plugin's server; Opus only reads a short note.
  2. The server runs the checks on Flash's code and asks Flash to retry, without involving Opus.
  3. Opus's memory (the prompt cache) is kept for 1 hour instead of 5 minutes.
- **Runs:** Opus-only $22.91 · Opus + Flash $20.75.
- **Result:** the first win for Flash (9% cheaper). Opus stopped re-typing Flash's files.
- **Still wrong:** Opus-only got dearer (the 1-hour memory costs more for short-lived helpers). Flash could only rewrite whole files, so big files (28 KB and 82 KB) couldn't use it. The plan still carried the code.

### Row 4 — plugin 0.7.5 (18 Sep): the plan describes the code instead of containing it

- **Problem:** the plan was 1,041 lines, 714 of them code.
- **Fix:** the planner writes short per-file instructions (what the file exports, how it behaves, which existing file to copy the style from, where to edit). A plan checker rejects plans that contain too much code.
- **Runs:** Opus-only $17.96 · Opus + Flash $17.41 (one earlier attempt was invalid: the laptop froze mid-run).
- **Result:** plan down to 419 lines, code in it 714 → 12 lines. Flash's setup fell 16%, but Opus-only fell too, so they ended about even.
- **Learned:** a sleeping or frozen laptop ruins a run, so keep the machine awake.

### Row 5 — planned, not built: shared starting plan

- **Idea:** both setups start from the same plan, to remove planning noise from the comparison. Skipped in favour of Rows 6–7.

### Rows 6–7 — plugin 0.7.7 (21 Sep): automatic task splitting, small edits, Flash reads the code first

- **Problems:** Opus spent turns turning the plan into a task list. Every edit sent a whole file through Flash. The planner spent a long time finding which files to copy.
- **Fixes:**
  - A script turns the plan into the task list at no AI cost (`plan-to-packets.mjs`).
  - Flash sends only the lines that change ("edits" mode), not whole files.
  - Flash scans up to 40 files and gives the planner a map (the "scout").
- **Run:** Opus + Flash $18.77 (two attempts before it were killed by laptop sleep, and one was invalid because an old helper server was still running).
- **Result:** no net gain. Planning got lighter (95 → 56 steps), but Flash needed far more retries (right first try fell from 87% to 57%), hit its output limit 4 times, and 6 tasks needed hand fixes because of a line-number format mismatch.

### Row 8 — plugin 0.7.8 (21 Sep): more reliable edits

- **Fixes:**
  - A retry starts from the original file, not the half-edited one.
  - Whole-project checks run once at the end, instead of after every task.
  - Large edit lists are split into smaller tasks.
  - Flash is told to think less, because its thinking was being billed as output.
- **Runs:** Opus + Flash $17.05 · Opus-only $21.06.
- **Result:** Flash's own waste was gone: Flash cost $0.66 → $0.14, right first try 57% → 76%, hand fixes 6 → 1, output-limit hits 4 → 0.
- **Still wrong:** the comparison was unfair. Opus-only was still paying for steps only Flash needs (the code scan and a strict plan format).

### Row 9 — plugins 0.7.9 and 0.8.0 (21 Sep): a fair Opus-only, batched Flash

- **Fixes:**
  - Opus-only skips the code scan and writes a short plan.
  - Flash receives all its tasks in one call and works on four at a time (`execute_batch`).
- **Runs:** Opus-only $14.86 · Opus + Flash $15.93 · Opus-only again $17.40.
- **Result:** both setups got cheaper and ended about even. Running Opus-only twice with nothing changed gave $14.86 and $17.40, which showed **runs vary by about $2.50** on their own.
- **Still wrong:** the batch tool was missing from the manager's tool list, so a helper relayed it (≈ $1.10 wasted). The task splitter also crashed on a folder name ($0.37 to redo).

### Row 10 — plugin 0.8.1 (23 Sep): setup and planning cleanup

- **Fixes:** batch tool added to the manager's list, shorter Flash plan, and the planner corrects its plan in place instead of rewriting it.
- **Runs:** Opus + Flash $16.12 and $13.90 · Opus-only with 5-minute memory $17.43.
- **Result:** Flash about 9% cheaper on average. The 5-minute memory trial did **not** save money, because long test waits let the memory expire, and reloading it costs more.
- **Still wrong:** the splitter rejected one valid plan layout and silently dropped 9 of 15 tasks in another run.

### Row 11 — plugin 0.8.2 (23 Sep): task splitter improvements

- **Fixes:** the splitter reads more plan layouts, and drops tasks outside the allowed files with a warning. The cost collector learned to price the newest Opus model.
- **Runs:** Opus-only $10.78 · Opus + Flash $12.67.
- **Result:** Opus-only was the cheapest run so far. Flash wrote 19 / 19 tasks in one 47-second batch, but Opus spent extra fixing the plan by hand, so the Flash run was 18% dearer.
- **Found:** the Flash plan was 766 lines against 407 for Opus-only, and line numbers in ordinary sentences were read as edit spots (one would have edited sign-in code).

### Row 12 — plugin 0.8.3 (23 Sep): shorter Flash plan, automatic formatting

- **Fixes:**
  - The Flash plan must be the same size as the Opus-only plan.
  - Line numbers in sentences are ignored.
  - Code is formatted automatically before each check, at no AI cost.
- **Run:** Opus-only $13.17 (about $1.90 of it was unrelated chat).
- **Still wrong:** the splitter didn't recognise the planner's "Edit" layout on 5 files.

### Row 13 — plugin 0.8.4 (23–24 Sep): the splitter reads every edit layout

- **Fix:** the splitter understands the "Edit" sections, so small edits stay small instead of becoming whole-file rewrites.
- **Runs:** Opus + Flash $17.52 · Opus-only $11.60.
- **Result:** the splitter fix worked (0 hand fixes, 0 formatting retries, one batch). But Flash **guessed how the new files import each other** and got it wrong, which took 3 repair rounds. Opus-only was 34% cheaper.

### Row 14 — plugin 0.8.5 (24 Sep): exact imports and an import checker

- **Fixes:**
  - The plan writes out exactly how each file imports the others.
  - A free script checks every import before Opus looks at the result (`check-imports.mjs`).
  - The Flash code scan was dropped, because the planner reads the code itself.
- **Run:** Opus + Flash $11.94 (the first attempt was lost to a network outage).
- **Result:** import errors 3 rounds → 0, and Opus re-read less than half as much. Opus + Flash drew level with Opus-only for the first time.
- **Still wrong:** a "depends on" line that wrapped onto a second line was misread, so 10 of 15 links between tasks were lost and repaired by hand.

### Row 15 — plugin 0.8.6 (24 Sep): line-wrap bug fixed

- **Fix:** the splitter reads a wrapped "depends on" line, and warns when a task has none.
- **Runs:** Opus + Flash $15.32 · Opus-only $14.18.
- **Result:** the fix held and Flash was near perfect (17 / 17 tasks, 7 cents). But the **manager stopped 3 times to wait** for reviewers and tests. Each time it woke up it had to reload its whole memory, about **$4.10** in total. That is more than Flash cost across the entire study. Without it, the Flash run would have cost about $10.80.

### Rows 16–17 — plugins 0.8.7 and 0.8.8 (24 Sep): leaner reviewers, no pauses, cheaper hand-off

This was the turning point.

- **Fixes:**
  - **Leaner reviewers (both setups):** reviewers load all the changes in one step instead of file by file, have a step limit (about 12 for code review and 10 for security), and don't re-run tests the manager already ran. There are still two separate review steps; the pipeline is unchanged.
  - **The manager never stops to wait (both setups):** it keeps checking, within the same step, until the result is ready. This removed the $4.10 reload cost.
  - **Cheaper hand-off to Flash:** the manager gives Flash a file location instead of re-typing the whole task list, and Flash reports back in one line per task (full detail only when something went wrong).
  - **Cost counter works on Opus-only runs** without hand help.
- **Runs:** Opus + Flash $9.79 · Opus-only $13.98.
- **Result:** first clear win for Flash on a same-version pair, **30% cheaper**. The manager never paused, and Flash did all 14 tasks in one 52-second batch. Opus-only typed all its tasks itself and re-read about twice as much.

### Row 18 — plugin 0.8.9 (24–25 Sep): Flash can delete lines, and the splitter accepts everyday words

- **Fixes:**
  - Flash can delete or replace several lines, so small clean-ups stay with Flash instead of Opus.
  - Words like "create" or "modify" in a plan no longer force a redo; they're accepted with a warning.
  - The cost counter finds the run's name on Opus-only runs.
  - The web-test command in the launch instructions was corrected.
- **First pair:** Opus + Flash $9.36 · Opus-only $9.55, a tie. Flash got 19 / 19 tasks right first time, but Google's Flash service was "too busy" 8 times (about 4 minutes lost, almost no cost). Measured on the work itself, Opus-only was about 10% cheaper ($7.37 against $8.15).
- **Second pair:** Opus + Flash **$8.37**, the cheapest run in the study · Opus-only $11.28. Flash wrote all 14 pieces of code in one 50-second batch with no busy errors. Opus-only wrote its 16 pieces one by one, and its page test took 3 tries.
- **Result:** averaged over both 0.8.9 pairs, Opus + Flash $8.87 against Opus-only $10.42 (15% less).

## Cost after each stage

| Stage | Opus-only | Opus + Flash | Result |
|---|---|---|---|
| Starting (0.7.3) | $19.16 | $26.02 | Flash 36% dearer |
| Rows 1–3 (0.7.4) | $22.91 | $20.75 | Flash cheaper by $2.16 |
| Row 4 (0.7.5) | $17.96 | $17.41 | about even |
| Rows 6–7 (0.7.7) | — | $18.77 | no change |
| Row 8 (0.7.8) | $21.06 * | $17.05 | Flash cheaper, but unfair |
| Row 9 (0.7.9 / 0.8.0) | $14.86 / $17.40 | $15.93 | about even |
| Row 10 (0.8.1) | $17.43 ** | $16.12 / $13.90 | Flash ≈ 9% cheaper |
| Row 11 (0.8.2) | $10.78 | $12.67 | Opus cheaper by $1.89 |
| Row 12 (0.8.3) | $13.17 | — | Opus-only only |
| Row 13 (0.8.4) | $11.60 | $17.52 | Opus cheaper by $5.92 |
| Row 14 (0.8.5) | — | $11.94 | level with Row 13 Opus-only |
| Row 15 (0.8.6) | $14.18 | $15.32 | Opus cheaper by $1.14 |
| Rows 16–17 (0.8.8) | $13.98 | $9.79 | **Flash 30% cheaper** |
| Row 18 (0.8.9) | $9.55 / $11.28 | $9.36 / $8.37 | **Flash 15% cheaper on average** |

\* Opus-only was still running steps meant only for Flash. \*\* 5-minute memory trial.

**Since the start:** Opus + Flash went from $26.02 to $8.37 (−68%). Opus-only went from $19.16 to $9.55 at its best (−50%).

## What each setup is good and bad at

**Opus-only**
- Good: simple (one model, nothing to hand over), needs no second AI provider, and often gets every task right first time.
- Bad: writes every task one after another, so its session grows and it re-reads more. It also swings a lot between identical runs ($9.55 and $11.28 on the same version).

**Opus + Flash**
- Good: Flash is nearly free, and it writes all the code in one parallel batch in under a minute. On the newest versions it was cheaper in all three pairs. Quality was the same: all tests passed and no serious review issues were left.
- Bad: it has more moving parts, so a bug in the hand-over (a missing tool, a misread plan) costs Opus money to repair. It also depends on Google's service being available (it was "too busy" 8 times in one run).

## What we learned

1. **Flash's own price is not what matters.** It is under 10 cents a run. What matters is how much Opus spends around it.
2. **The single biggest saving was the manager not stopping to wait.** Each pause forced a full memory reload, and three pauses cost about $4.10 in one run.
3. **Most fixes helped both setups.** Leaner reviewers and no pauses cut Opus-only's cost as much as Flash's, so the target Flash had to beat kept moving.
4. **Flash pulled ahead only once the hand-over was clean:** exact imports, an import checker, a correct task split, one batch call, and short reports.
5. **Noise is large.** Identical runs differ by up to $2.50, so a single gap smaller than that means little. Only repeated pairs count.
6. **Practical rules for measuring:** keep the laptop awake, don't chat with Claude during a run (it lands in the bill), and give both setups the same memory setting.

## Next

| Step | Why |
|---|---|
| Repeat on a medium-sized task | Shows whether Flash saves more when there is more code to write. |
| Measure a project built from scratch (`/mmo:greenfield`) | Every run so far used an existing codebase. |
| Build the "shared starting plan" (Row 5) | Takes planning noise out of the comparison, so fewer runs are needed. |

## Where the raw data lives

- **Per-run records** are in the Kaneo repo under `.sdlc/runs/<run-id>/`: the task brief, plan, task list, test results, reviews, `notes.md`, `telemetry.jsonl`, and the code change as `change.patch`.
- **Summaries** are in Kaneo's `.sdlc/ledger.md` (one entry per run) and `.sdlc/policy-study.md`.
- **Cost collector:** `plugin/scripts/collect-orchestrator-usage.mjs`. Figures are priced from the Claude Code logs at list prices, not checked against an invoice.
- **Version notes** are in [../methodology.md](../methodology.md), and the technical plan is in [../planning/opus-plus-flash-cost-plan.md](../planning/opus-plus-flash-cost-plan.md).
