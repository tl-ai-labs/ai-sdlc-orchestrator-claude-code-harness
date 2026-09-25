# Ambient mode — savings in ordinary chat, no `/mmo:` command

Ambient mode is the part of the plugin that works while you chat with Claude Code as usual. You type a normal sentence. No command, no interview, no gate. It ships **switched off**, and when it is off the plugin behaves exactly as it did before this page existed.

This page covers what is built today, how to turn it on, what it stores, and what is still to come.

## The idea in six lines

1. The session model stays the thinker. Nothing here picks a model from your prompt or switches the chat's model.
2. Code makes what the thinker reads smaller and removes wasted round trips.
3. Cheaper models do typing jobs; code checks their work; the thinker never re-types it. (The checks and the apply step are built; the worker call itself is not yet, see [Status](#status).)
4. You type one normal sentence.
5. If anything fails, the session is plain Claude Code. Cost rules fail open. Safety checks fail closed. Both end in plain Claude Code, never in "send it anyway".
6. Plugin-on is measured against plugin-off, and only what pays is kept.

## Turn it on

| How | Effect |
|---|---|
| `MMO_AMBIENT=observe` in the environment | Records what each rule would have done. Changes nothing the model sees. |
| `MMO_AMBIENT=on` | Rules act, in sessions drawn into the `on` arm. |
| `~/.mmo-ambient/ambient.json` with `{"mode": "on"}` | Same, without an environment variable. This is the file for the Desktop app, which does not inherit your shell's variables. |
| `MMO_AMBIENT=off` | Off for this run, whatever the files say. |

Until one of these exists, the shell shim in front of every ambient hook exits before `node` even starts.

For a demo pair, `MMO_AMBIENT_ARM=on` or `MMO_AMBIENT_ARM=control` forces the arm. A forced session is marked `forced` and stays out of randomised estimates.

## What each rule does

| Rule | Hook | What happens | Shipped state |
|---|---|---|---|
| Read valve | `PostToolUse` on `Read` | A large plain `Read` of a source file is replaced by a code-built outline: declaration names with `L<first>-<last>` line ranges. No comments, and string literals are blanked, so an outline cannot carry text planted in a file. | acts |
| Partial-view guard | `PreToolUse` on `Write` | A whole-file `Write` to a file the session only saw as an outline is refused. Claude Code itself would allow it. | acts |
| File-dump valve | `PreToolUse` on `Bash` | `cat`, `sed -n 'A,Bp'`, `head` or `tail` printing one large repo file, with no pipe or redirect, is refused with the outline and a pointer to `Read` with a range. Running the same command again prints the file. | acts (`"act": true` since 0.8.2: the model in this app prints files with `cat` far more than it uses `Read`) |
| Bundled lookup | the `lookup` tool (model-chosen, named in the start-of-chat note) | One call, up to eight literal search strings, optional path patterns: every matching line comes back with the exact `Read offset/limit` that shows it and the declaration it sits in (the read valve's own outline builder), capped at `max_hits` (default 40, at most 60) and 8,000 characters. Replaces a grep plus a read per file with one round trip; each use is recorded (`lookup.used`) and counted as an action. Searches the git repository only (tracked and untracked); secret-bearing and hard-denied files are never searched or named; outside a repository it refuses. The same on both sides of a pair. | acts in mode `on` |
| Batch write (both sides) | the `write_files` tool (model-chosen, named in the start-of-chat note on both sides) | The thinker's OWN files, many in one call, with its test command: the plugin writes them into the project (paths checked like a landing, atomic writes, never a secret or hard-denied file) and runs the tests in the same call. One request instead of one per file. No worker: an optimization, not a delegation, so it runs with delegation off and inside helper agents. It exists for parity: a hand-over lands many files in one request, and without this a pair would credit delegation with a saving that is really batching (23 Sep). The partial-view guard and the landed-file rule apply to each path as to a `Write`; the files it creates count for the new-files and tests moments. Recorded as `write_files.used`, counted as an action. | acts in mode `on` |
| Model lock | `PreModelSwitch` | With `lock_model: true`, a switch away from the policy's thinker model is refused with a one-line reason. | acts in mode `on` |
| Typed-only agents | `PreToolUse` on `Agent` | The five `mmo:` agents run only in a session where someone typed a `/mmo:` command. | acts in mode `on` |
| Enforced hand-over | `PreToolUse` on `Write`, `Bash`, `Edit` and the batch write | The thinker does not type what a worker types cheaper. A by-hand write of NEW code files, NEW test files, or the same edit repeated in yet another file, whose typing is above this chat's break-even (about 800 characters with Flash, 2,000 with Sonnet), is refused with the hand-over tool's full name; below it, it runs. The typing measured is the text of the call itself: the Write's content, the Bash command, the batch write's files, the replacement times the files git still finds the old text in. Never a trap: a file whose job failed, or was refused by the gate as too small, is released and typed by the thinker; a file refused twice goes through the third time, logged; no worker reachable or the cell closed, nothing is refused; never on the rules-only side, in the control arm, in observe mode or in a pipeline session. Why (23 Sep): twelve pairs showed that asking does not work; told in the note and in a line at the right moment, the thinker typed everything itself. Off with `offers.enforce_handover: false`. | acts in mode `on` |
| The two lines that remain | `PostToolUse` on `Read`, `Bash`; `PostToolUseFailure` on `Bash` | The scout, offered once when the reads so far cost more than a scout job would (the chat's size against the worker reading its byte budget), and the bug fix, offered once when a test the chat wrote fails. Nothing else is asked about. | acts in mode `on` |
| Helper agents | `SubagentStart`, and every hook inside an agent | A helper agent Opus started (the Agent tool) is a chat of its own: every rule above runs inside it, its counters and offers are its own (per agent, under the chat's folder), the note reaches it on its first tool result, and its events, costs and jobs are recorded under the parent chat, marked with the agent. Inside the batch pipeline's own agents (a typed `/mmo:` command) nothing runs. Seen live on 22 Sep: the plain side's four helpers typed 44 test files with nothing watching. | acts in mode `on` |
| Start-of-chat note | `UserPromptSubmit` (the chat's first prompt that is not a `/mmo:` command); `SessionStart` again after a compaction | Where the plugin acts, one note names the worker tools by their full names, says they are loaded with `ToolSearch`, and says how the plugin decides. Never at session start, when nobody can know yet whether the chat is a typed `/mmo:` run; never in a chat that opened with a `/mmo:` command. Nothing in observe mode or the control arm. | acts in mode `on` |
| Tool stamp and the gate | `PreToolUse` on the plugin's job tools | Adds `_mmo: {session_id, prompt_id, arm, mode, agent, break_even_chars, context_tokens}` to the call: the last two are this chat's numbers from the typing rule and the transcript. The server refuses an unstamped call, and it refuses a job whose expected typing (declared files × the characters one file of that kind really holds, learned from every staged answer and seeded by `cost.expected_chars_per_file`) is below the break-even, naming both numbers and saying "bundle more files into one call, or type them yourself". That gate is the ONLY thing that decides a hand-over. Start tools are also refused in the control arm, a pipeline session, and while the chat is off the thinker. | acts in mode `on` |
| Marker edits | `PreToolUse` and `PostToolUse` on `Edit` | An `Edit` whose `old_string` is `mmo-apply:<job>:<n>` is swapped for the checked find/replace of that staged job, in order, or refused. You still get Claude Code's own diff, approval and rewind. | always (only fires on a marker) |
| Job tools in the tool list | the MCP server's tool list | The job tools are listed only when the mode is on for the project (read when a session starts; a mode switched mid-session applies from the next session), so with the mode off the tool list is 0.7.7's. | mode `on` |

Escapes that need no setting: a `Read` with its own `offset` or `limit` always passes. A second plain `Read` of an outlined file returns the whole file. Running the same dump command twice runs it. A prompt that says "whole file" or "show me the output" stands every valve down for that turn.

Ambient mode stands down completely in a session where a `/mmo:` command was typed (its own agents included) and in the control arm. In each case it records what it would have done.

## The cost rule

Every valve asks the same question before it acts: is the expected money saved larger than the expected money lost?

```
net = (1-p-q) * (F-K)*(w + r*N)
    +  q      * ((F-K-R)*(w + r*N) - C*r - L)
    -  p      * (C*r + K*(w + r*N) + L)
```

`F` full size, `K` kept size, `R` a ranged follow-up, `C` context size now, `w` cache-write price, `r` cache-read price, `N` expected later requests in this context, `p` chance of a full re-read, `q` chance of a ranged follow-up, `L` the dollar value of one extra request of your time. All sizes in tokens.

The size floors in the settings (8k characters for a `Read`, 6k for a file dump) only skip work that can never pay; above them this rule decides. A fixed size threshold cannot express this. The same file is worth shrinking in a 40k context and not worth it in a 600k one, where one extra request costs more than the file does.

- `p` and `q` are **measured** per repository and per valve (`~/.mmo-ambient/repos/<id>/valves.jsonl`). A repository where outlines keep being undone stops getting them.
- `C` and the current model come from the last 256 KB of the session transcript.
- `w` follows the login: one-hour cache writes on a subscription, five-minute writes with an API key or a cloud route.
- `N` defaults to 23 and is replaced by your machine's own median when you run the census with `--write`.

## The typing rule

The sum behind every refusal and every gate is worker write against thinker write, for the same files. A hand-over is one call that waits and lands, and the thinker writing a file itself is one call too, so the re-read of the chat cancels (given equal batching, which the tools give: all the files of a phase in one call). What is left: the thinker types a one-paragraph spec, the worker reads the spec and some context, the worker types the file at its own price instead of the thinker's. That overhead is why a break-even exists at all, about 800 characters with Flash and 2,000 with Sonnet, at any chat size; above it the worker wins, and the bigger the file the more it wins. Only a job that runs past the wait adds a request, the collect call, and that is measured: the requests per hand-over minus the start call, a decayed mean kept in `~/.mmo-ambient/evidence.json`. Until 23 Sep the rule charged every hand-over one or two extra round trips and produced break-evens of 9,000 to 14,000 characters; the same file holds what this machine learned about its workers:

```
saved = typed * out
cost  = 2 * C * r  +  spec * out  +  (typed + spec + context) * w_in  +  typed * w_out  +  typed * in
```

`typed` the characters the worker would type, `C` the chat's size in tokens, `r` cache-read price, `out` and `in` the thinker's output and input prices, `w_in` and `w_out` the worker's. With the official price cards a 120k-token chat has a break-even near 32,000 characters and a 20k chat near 6,000. Measured on 387 past chats on the author's Mac: handing over paid for 3 of 7,233 writes, because the median chat is 120k tokens and the median fix is under 3,000 characters. So the rule fires for a fresh build of many files and stays silent for a fix late in a long chat, whatever the task is called. Every offer line states the break-even; the refuse-once push fires only above it.

## Measuring: arms, ledger, census

**Arms.** Each session is drawn once into `on` or `control` (default 50/50) and the draw probability is stored beside the answer. The arm is a marker file created with exclusive create, so concurrent hooks cannot disagree.

**Like for like.** To measure the hand-overs alone, the plain side of a pair must run the same reading rules with only the hand-overs removed: `"delegation": "off"` (a project file may set it without a receipt, since it makes the plugin do less). Every reading rule acts, no offer is made, no file is refused, the start tools are refused, and the start-of-chat note says so in one sentence. The board calls such a chat "rules only", prefers it as side B, and its verdict says the gap is the delegation alone; against an `observe` chat it says the gap mixes the reading rules in.

**Ledger.** `plugin/scripts/ambient/lib/ledger.mjs` prices every action afterwards from what really happened:

```
saved = (F-K)*(w + r*n_a)  -  SUM over follow-ups [ X_j*(w + r*n_j) + C_j*r ]
```

`n` is the count of real later requests in the same context. A full re-read in a large context comes out negative and is reported as a loss. Sessions that left the thinker model, typed a pipeline command, or ran in the control arm add nothing to the saved total.

**Census.** Before building on a task mix, measure it, at no cost:

```bash
node plugin/scripts/ambient/census.mjs            # aggregates for ~/.claude/projects
node plugin/scripts/ambient/census.mjs --write    # also store the measured n_hat
```

It prints episodes and cost by label, the share of tool-result characters each rule could touch, the pause histogram (cache expiry exposure), and the median requests left before a context reset. Aggregates only. If the share the rules could touch is under about 8% of spend, routing work is not worth building on that mix and the native settings are the whole win.

Prompt labels (`plugin/config/ambient-labels.json`) are for reports. No decision reads them: over half of real prompts match no rule.

## What is stored, and where

Everything lives under `~/.mmo-ambient/` (override with `MMO_HOME`), directories `0700`, files `0600`, nothing inside your repository.

| Path | Holds |
|---|---|
| `sessions/<id>/events.jsonl` | One record per event: rule ids, sizes, paths, numbers. |
| `sessions/<id>/arm.json` | The arm and its draw probability. |
| the `session.start` record | Also says whether the folder held any source file when the chat began (`repo_kind`: greenfield or brownfield). Decided from the folder, never from the prompt. |
| `repos/<id>/valves.jsonl` | Per-repository act and follow-up counts. |
| `jobs/<id>/` | A staged worker change, its pre-images, and the apply record. |
| `measured.json`, `receipts.json`, `ambient.json` | The census result, verified policy hashes, your settings. |

No prompt text is stored, ever. The event writer drops fields named `prompt`, `content`, `stdout` and `stderr` and caps every string. Session folders older than `retention_days` (default 30) are removed once a day.

## Settings and who may change them

Layers, weakest first: shipped defaults (`plugin/config/ambient.default.json`), then `~/.mmo-ambient/ambient.json`, then `<project>/.sdlc/ambient.json`, then `MMO_AMBIENT`.

A project file is attacker input: anyone who can land a commit can edit it. It applies in full only when its SHA-256 is listed in `~/.mmo-ambient/receipts.json`, a file a repository cannot write. Without a receipt it may only **tighten**: lower the mode, switch a valve off, close cells, add `never_delegate_paths`. Every other key is ignored.

The fixed lineup is part of the settings: thinker `claude-opus-5`, and `workers` maps each worker to its model (`flash`: `gemini-3.8-flash`, `sonnet`: `claude-sonnet-5`) and names the `default` one, which only breaks a tie (see Picking the worker). If a session is not on the thinker anyway (lock off, `--model` at launch), reads keep getting smaller, no new worker job starts, and the session stays out of the savings numbers.

## Worker jobs: what is built

A worker job hands TYPING to a cheaper model and keeps the thinking with the session model. Everything below is built and tested offline with canned worker answers; no test reaches a vendor.

**The flow of one job** (`plugin/scripts/ambient/jobs.mjs`): stamp, session still on the thinker, the cell's verdict, the gate (expected typing against the stamp\'s break-even), the rate-limit breaker, consent, one job per repository, a git snapshot, the brief, a record of what leaves the machine, ONE worker call with generous patience, all of it settings (a dropped connection or a vendor 500, which bill nothing, is retried four times: `jobs.network_retries`; a rate limit is retried with growing pauses, 5, 10, 20, 40, 60 and 120 seconds by default: `jobs.rate_limit_backoff_ms`; only when every pause is refused do new jobs pause for `jobs.breaker_minutes`, one minute; the call may take up to `jobs.worker_timeout_ms`, thirty minutes (the pipeline's completion door, in earlier external runs, had no per-call cap and its longest live call took 22 minutes at the vendor's default depth; a deeper thinking pair needs the same room; the start call's own wait is `jobs.block_ms`, separate); and a job whose call chain died of something transient, no answer in time, a vendor error after the retries, a rate limit after every pause, gets one more whole attempt, `jobs.job_retries`, before the thinker is told to do it itself; a Gemini worker types with `reasoning: {tier: "low"}` unless the policy leaf sets a tier, because with the vendor's default thinking whole-file jobs took three to five minutes and the reasoning tokens were billed as output), a strict reading of the answer, the text-only checks (an answer that cannot be read or fails a check is sent back to the worker up to twice with the reason: `jobs.answer_retries`; a change to a file outside the declared list is DROPPED and reported as `dropped_files` while the declared files go on, because nothing outside scope lands either way; a change to a protected file (the reproduce test, a held-out test, a read-only context file) or to a never-delegate path is dropped the same way and named with its reason in `next`; an unchanged repeat of a read-only file is ignored; only secret and hard-denied paths still fail the answer; every rejected answer is kept next to the job as `rejected-<worker>-<n>.txt`, first 16 kB, so a dead job can be read afterwards), a staged change of the kept files only. A start tool returns a job id at once; `job_result` collects MANY jobs in one call (`job_ids`): it waits up to 90 s until at least one is ready and reports each one as ready, failed or still running, so the model never polls one job at a time (seen live: 18 polls in one chat, each re-reading the chat). Jobs that touch different files run side by side, up to `jobs.max_parallel` (4); a job that shares a file with a running one is queued (`status: queued`) and starts by itself when that file is free, so it is never sent twice. On any failure the evidence goes back to the session model, which does the work itself.

| Tool | Hands over | Keeps |
|---|---|---|
| `fix_from_analysis` | the code of a bug fix | the diagnosis. Needs all nine analysis fields; refuses an analysis that leaves a decision open or already contains the code. The reproduce test is shown to the worker and can never be changed by it; a held-out test is never shown. |
| `repeat_edit_across_files` | one edit you already made, applied to other existing files | the decision what the edit is |
| `write_files_from_specs` | new files from one-paragraph specs | the specs |
| `write_tests_from_cases` | ALL the test files of a phase, each from its own list of cases, in one call (one file per call never clears the break-even) | the cases |
| `scout_repo` | reading the likely files of an existing project (chosen by code from your search terms, at most 40 files, 300 kB) and reporting where to look or edit: each place with an exact `Read` range and a quoted line, both checked by code against the files; unverifiable places are dropped | the question, and every read that follows |
| `job_result`, `undo_job` | collect the receipt of a job that ran past the wait (many ids in one call; `show_diff: true` for the diff), take a landed change back | |
| `write_files` (both sides) | nothing: the thinker's own files, written and tested in one call | everything |
| `consent_to_send` | | asks you, once per repository and vendor. Marked so Claude Code asks even in auto-accept modes; a model cannot grant it. A worker at the same vendor as the chat needs no consent. To allow a vendor for every repository once, put `"vendors_allowed_everywhere": ["google"]` in `~/.mmo-ambient/ambient.json`; a repository's own file cannot set that key. Until consent exists every job start is refused, and the start-of-chat note says to ask first. |

Workers never execute anything: a door takes text and returns text. The completion door uses the server's existing adapters and refuses the executing agent adapter by name. The policy files it reads are listed under Picking the worker.

**One hand-over, one request.** The start call waits for the whole job (`jobs.block_ms`, nine minutes; Claude Code allows a plugin tool call thirty idle minutes) and, when the checks and the declared tests pass, the server writes the files into the project itself (`jobs.landing`: `auto`; `manual` keeps the landing with the thinker). One answer comes back. A change whose tests failed is never written: the thinker gets the manual landing and decides. A job still running at the limit returns its id, lands itself when done, and its receipt is collected with `job_result`. The wait never outlives the chat's prompt cache: the stamp carries the cache tier, and on the five-minute tier the call returns at `jobs.block_cap_5m_ms` (4.5 minutes), because a longer wait would let the cache expire and the next request would rewrite the whole chat at the cache-write price. Before this (22 Sep), a hand-over cost four requests: start, collect, land, test; pair 7 lost on exactly that.

**What the thinker gets back.** A receipt, not the code: file names, sizes, whether each parsed, how many edits and creates, whether the tests passed in the scratch copy, and that the files are written (or, when they are not, the landing instruction). The diff is kept aside and returned only on `show_diff: true` (the checks proved scope and exact match; the tests prove correctness). **Verification before hand-back:** with a declared test command (`jobs.verify_before_handback`, on), the checked change is written into a scratch copy of the snapshot (a detached git worktree with the repository's ignored top-level folders linked in, so dependencies are there) and the tests run; a failing run goes back to the worker with the tail of the output, up to `jobs.verify_retries` (2), and only then is the thinker told, with the tail; the real tree is never touched. Each attempt is applied to a FRESH copy of the snapshot, so the resend asks for the whole answer again, not a patch of the file the output named (23 Sep: a fourteen-file job whose third answer held one file was then tested in a project missing the other thirteen).

**A job may only commission what a worker may write.** Lock files, test-runner configs (jest, vitest, playwright and the like), CI files, env files, `.git`, `.claude`, `CLAUDE.md` and the plugin's own `.sdlc` folder are never written by a worker, because a worker that can edit the test config can make its own broken work look green to the scratch-copy tests that judge it. A job that lists such a file is refused at the door, naming it, before any worker is paid (`job.refused_forbidden`); the tool descriptions and the start note say so up front, so the thinker types those files itself. 23 Sep, pair 10: nothing refused such a job, so five worker calls were paid to discover a contradiction readable from the file list.

**A create job is a design written once, plus a short entry per file.** The thinker writes the design to ONE file on disk and names it; the harness reads it and inlines it at the top of the worker's brief, once, read-only. Per file it sends only what the design cannot say: the exported names, one line of behaviour, and an existing file whose style to copy. The same gate a bug fix has since applied to those entries — no code, no undecided choice, at most twenty exports. Why (23 Sep, pair 11): with a free-prose spec of any length, the architecture was restated inside all seven hand-overs, 124,500 characters of specs for 185,175 characters of files, and the thinker paid for them twice, once as output and again on every later request that re-read the chat.

**The gate weighs the specs the thinker really wrote, and sizes the files from this project.** The cost rule's `specChars` term used to be a guess of 400 per job while real specs ran to 9,720–42,456, so four hand-overs whose specs were 81–99% of the files they described all passed a judge that could not see them. It now takes the real figure. The other half of the sum, how big the files will be, is measured from the project's own files of the same kind (median size, tests measured against tests, only paths git tracks or does not ignore), weighed against the size learned elsewhere: a few files nudge it, forty decide it, a project with none keeps the learned number. That is what lets a task nobody has seen be sized from itself. The refusal names both figures and where the size came from.

**A test command that dies before any test runs is the thinker's.** A runner that fails in its own setup reports a failed run while judging nothing. When a job's contract expects the suite green beforehand (every job but a bug fix, whose repro command must fail by design), the same command is run once on the untouched tree; if it already fails there, the change was never judged, so nothing lands, no worker is retried, no cascade starts and no worker is marked wrong. 23 Sep: six attempts, one Flash and five Sonnet, all on the same crash in a setup file the thinker had written.

**A retry repairs what failed, not the phase.** The files an attempt got right carry into the next one, and the resend asks only for what the tests implicate; a file left out keeps the version already accepted, and the completeness rule counts it as written. Before this a twenty-one file job that failed on one compiler error retyped all twenty-one.

**A create job answers in a shape that cannot be empty.** The worker is held to Google's enforced response schema. For `write_files_from_specs` and `write_tests_from_cases` that schema requires `creates` and offers no `edits`; under the shared schema both were optional, so `{"edits":[]}` was a legal answer, and Gemini 3.8 Flash gave exactly that six times to fourteen-file commissions (23 Sep) while Sonnet wrote the files. The brief's footer says the same in words. Replayed with the corrected contract, the same commission came back with all fourteen files. The orchestrator pipeline's packet schema requires `files` the same way, which is why it never saw this.

**A commissioned job is finished only when every file is there.** `write_files_from_specs` and `write_tests_from_cases` declare one file per spec or per list of cases, so the checks refuse an answer that leaves any of them out, naming the missing ones for the resend (`missing-files`). The edit tools commission nothing, so a file that needs no edit is rightly absent.

**When nothing lands, the files go back to the thinker.** A job whose tests failed at hand-back, or whose project moved underneath it, writes nothing; its declared files are released, so the hook stops refusing the thinker typing them. This used to happen only when a job CRASHED, never when it handed back politely with a bad verdict. The marker is keyed on the resolved path, because the hook sees the spelling the editor gave it and the server sees the one git reports. **Worker cascade** (`jobs.worker_cascade`, on): when the first worker's whole chain fails, the next worker whose cell for this job and language is not closed, and whose vendor is consented, gets one chain before the thinker is told; both ways (Flash then Sonnet, or Sonnet then Flash), never into a closed cell.

**Landing a change by hand** (`jobs.landing: "manual"`, or a change the server did not write). Up to five edits and no new files: the result lists marker edits, and each lands as a native `Edit`; then you run the tests. Anything larger: one `node apply.mjs <job> <sha256>` command, and when the job declared a test command (`test_command` on the tool call, or the analysis's `test_command` for a fix) the command is `... --test`: the same command writes the files, runs the tests in the repository and prints pass or fail with the last lines, so landing and testing cost one turn, not two, and the landing's verdict reaches the evidence file at once. The files stay written on a failing run; `--undo` takes them back. The checks prove scope and exact match, not correctness; the tests do.

- **Picking the worker** (`lib/offers.mjs`, `pickWorker`). The files named in the job give its language (`python`, `go`, `js_ts`, `docs`, or `any` when mixed or unknown). Each worker is weighed on its own cell for that job and language, and the job goes to the worker whose cell is not closed, open before explored, with the larger expected net saving per job; on a tie, `workers.default`. A cell uses the evidence rows measured on its own language; a language with no rows of its own uses the rows pooled over all languages. Only workers the chat policy can really call are weighed (a model of that name with a text-only adapter); a refusal names any worker left out for that reason. Chat jobs reach their workers through two shipped policy files, used only for their model lists: Flash through Google (`opus-plus-flash-v38`) and Sonnet through the Claude login on your machine (`opus-plus-sonnet-max`, the local `claude` program, no API key; a call uses your plan's usage, not a per-token bill, and the board prices it at list price like every other model). `MMO_AMBIENT_POLICY` replaces the list, comma-separated. The Sonnet worker is started with no tools (`--tools ""`) and with plugins, hooks and project settings off (`--safe-mode`), so it can only answer in text, as Flash does; a `claude` whose `--help` lists no `--tools` is refused and never started.

  For bug-fix code the rows come from our own SWE-bench Pro runs, the same bugs given to Opus alone, Opus with Flash and Opus with Sonnet:

  | Language | Flash | Sonnet | Goes to |
  |---|---|---|---|
  | Python | open | closed: 15 bugs lost, 3 won, not worth 7.8% cheaper | Flash |
  | JS/TS | open | open, smaller expected saving | Flash |
  | Go | closed: cost 1.8% more than Opus alone | open | Sonnet |
  | other or mixed | open | open, smaller expected saving | Flash |

- **The value rule** (`lib/value-rule.mjs`). One rule per cell (job × file kind × worker × door): `net = g*S - (1-g)*C_retry - g*(e_w - e_t)*C_bad`. Only the *difference* between the worker's and the thinker's error rate costs anything, so the bar is "as good as the thinker". The rule returns `P(net > 0)` by exact integration over Beta posteriors: open at 0.8, closed at 0.2, in between delegate with that probability, drawn once per session and cell. A cell whose *expected* value is negative is closed whatever the odds say. `cost_of_bad_result_usd` is the one organisation number; the default, 9, is the measured cost of one fixed bug. **This machine's own jobs feed the rule** (`lib/evidence.mjs`, `~/.mmo-ambient/evidence.json`, user-level, never writable by a repository): every job's checks outcome (pass, or fail, a call that never answered counting as fail) and every landed job's fate (undone, or the next test run in that chat failing, is wrong; a passing run is held) are counted per cell, aged by `DECAY` on every new outcome so old results fade, and passed to the rule's `local` slot with the same one-sided caution as the seed rows. The board row shows the local counts. A landed job waits for its verdict as one marker under the chat's folder (`landed-pending/<job>`), settled by the next test run or by `undo_job`.
- **Seeds** (`plugin/config/ambient-seeds.json`). The bug-fix rows are derived from the published SWE-bench Pro exports by a script kept outside the repository, one paired row and one cost row per language and worker, plus the pooled rows. Evidence is one-sided where it is weak: a row under a weaker success definition may close a cell and never open it; a row from an older model version may open and never close; another door counts at a quarter weight. `tools/test/ambient-seeds.test.mjs` audits the file on every `npm test`.
- **The brief** (`lib/snapshot.mjs`). Built from git objects of one snapshot tree, written through a throwaway index that includes files git does not track yet (in a new project every file the model just wrote is untracked), never from the working tree and never touching your own index or stash list; `.gitignore` still applies. Symlinks, submodules, secret-bearing files, anything under a `Read(...)` deny rule, binaries and any file holding a secret shape end the job.
- **The checks** (`lib/gates.mjs`). Changed paths must be inside the declared files; a hard-deny list covers lockfiles, test-runner config, CI, `.claude/`, `CLAUDE.md` and the policy; the reproduce test is protected; every `find` must match exactly once; JavaScript and JSON get a parser check. Passing these does **not** mean a change is correct. Whether it is right is decided by the thinker running the tests afterwards.
- **Landing it** (`apply.mjs <job> <sha256>`). The hash on the command line is the contract: what was reviewed is what is applied. Every file must still be the exact base the worker was shown, or nothing is written. Pre-images are saved, writes are atomic, `--undo` restores a file only while it still holds what the job wrote.

## The board

```bash
node plugin/scripts/ambient/board/server.mjs                    # prints one local URL
node plugin/scripts/ambient/board/server.mjs --pair <A> <B>     # choose the two sessions shown side by side
node plugin/scripts/ambient/board/server.mjs --new-token        # a new link; the old one stops working
```

A local page over the real records: the realised ledger as the headline, the share of spend that went to the worker, a side-by-side pair (plugin on against either the same plugin with hand-overs off, the like-for-like B, or plain Claude Code; the page says which from the records) whose difference appears only when BOTH sides have finished, every session with when it finished and what it cost (the thinker's dollars include the chat's Claude Code helper agents, the Agent tool, whose transcripts sit next to the main one under `<session id>/subagents/`; the row says how many of its requests and dollars they were; a re-opened chat is priced from the moment its record starts, and a record where nobody typed a prompt is not listed; a worker call that never answered is counted as unpriced, never shown as costing nothing; a step from inside a helper agent says so), and the seed table with its sources, with this machine's own counts on every row (a language or job kind the seed never measured still gets its counts, its verdict and, if need be, its own row: "Nothing was measured before install"). It binds `127.0.0.1` on a random port (`--port` fixes one), needs its token and the right `Host` header on every request (the token is kept in `~/.mmo-ambient/board-token`, readable only by you, so the printed link keeps working after a restart; `--new-token` replaces it), serves three fixed routes, sends a strict Content-Security-Policy, and writes every value as plain text.

## Setup

```bash
node plugin/scripts/ambient/setup.mjs                   # dry run: shows what WOULD change
node plugin/scripts/ambient/setup.mjs --apply=mode --mode=on
node plugin/scripts/ambient/setup.mjs --apply=cache,bash,model
node plugin/scripts/ambient/setup.mjs --receipt <project>   # trust that project's .sdlc/ambient.json as it is now
node plugin/scripts/ambient/setup.mjs --status
```

The Claude Code settings it can propose (`promptCacheTtl`, `subagentPromptCacheTtl`, `bashOutputMaxChars`, `model`) were each checked in the Claude Code 2.1.270 program. Your settings file is merged, never replaced; a timestamped copy is written first; a file that does not parse is left untouched. One-hour cache writes cost more per token than five-minute ones, so keep the cache group only if your own on/off numbers say it pays.

## What ambient mode leaves alone: everything 0.7.7 does

From 0.8.3 ambient mode sits on top of 0.7.7 (0.7.6 plus one policy per run, not per chat), and nothing 0.7.7 does changes. That covers every `/mmo:` command, typed or started by the model: the same phases, gates, policies, routing, worker launches, output caps and hooks.

**With the mode off (the shipped default), the plugin behaves as 0.7.7:**
- the commands, skills and agents read exactly as in 0.7.7;
- the job tools are not in the tool list;
- every ambient hook returns at once.

**With the mode on, a typed `/mmo:` session sees none of it:**
- the start-of-chat note goes out at the chat's first prompt that is not a `/mmo:` command, never at session start;
- from the `/mmo:` prompt on, every rule stands down;
- the pipeline's own agents get their explicit 0.7.7 tool lists.

The pipeline's own hooks (the write contract, the foreground-helpers guard, telemetry) keep 0.7.7's settings, with no short timeout. Claude Code lets a tool call through when its guard hook times out.

Where ambient mode needs something from code that the pipeline also uses, it takes a copy for itself:
- a hand-over's Flash worker may answer up to 32,768 tokens on the hand-over's copy of the policy leaf, and the policy file keeps 0.7.7's 8,192;
- a hand-over's Claude-login worker starts with no tools and the CLI's safety switches, and the pipeline's worker starts as on 0.7.7.

The zero-touch branch (`ed8e701`, 22 Sep 2026) also changed things 0.7.7 does, and those changes are **not in 0.8.3**:
- **Static text** that made every command and skill typed-only (`disable-model-invocation`) and added a sentence to every agent's description. With the mode on, the zero-touch hooks decide which `/mmo:` command the model may start.
- **Timeouts** on the pipeline's hooks.
- **Pipeline-only repairs**, each to ship as its own pipeline change with its own pipeline check:
  - `hard_cost_cap_usd` enforcement;
  - policy reload on edit;
  - the adapter cache key;
  - crash handlers;
  - dropping credential-shaped variables from the agent worker;
  - safety switches on the pipeline's `claude` worker;
  - model-chosen path checks;
  - `project_root` defaulting to `CLAUDE_PROJECT_DIR`;
  - symlink checks in the write contract;
  - migrations falling through to premium.

Their code is in `git show ed8e701`, and `docs/methodology.md` (v0.8.3) lists them.

## After a Claude Code update

The hooks rely on three behaviours of the app, each verified in Claude Code 2.1.270: a note a hook adds before or after a tool call reaches the model; a `Read` result can be replaced by the outline; a refusal reaches the model with its reason. An update can change any of them silently. After every update, run one chat with the mode on and confirm on the board's live feed that a file read was shortened (`valve.act`), an offer line was delivered, and a refusal was delivered with its reason; `tools/test/ambient-hooks.test.mjs` proves the plugin's side, the live chat proves the app's.

## Status

Built and tested offline: everything on this page.

Checked on a live Desktop session (22 Sep 2026, with a stand-alone test hook, not the plugin): hooks fire in the Desktop app and receive `scratchpad_dir`, `prompt_id` and `effort`; a replaced `Read` result is what the model sees; `PreModelSwitch` blocks the Desktop model picker with a clear message; and Claude Code DOES allow a whole-file `Write` after a replaced `Read`, which is why the partial-view guard exists.

Run live on the zero-touch branch, 22–23 Sep 2026: paired chats with the plugin's own hooks on and real workers (Flash through Google, Sonnet through the Claude login). Pair 12 (one pair, receivables brief): $12.50 with hand-overs against $15.59 without (−19.8%); pair 11 lost (+52.8%) and taught the design-file rule. On 0.8.3 (the same code on top of 0.7.6's pipeline) nothing has run live yet.

## What the past chats on this machine say

Every rule was replayed against 847 past chats on the author's Mac, at no cost. A whole big file read with the Read tool happens in 3.4% of chats (on those reads the outline drops 96% of the text); a whole big file dumped with `cat` or `sed` in 11.5%; a test written and then a failing run in 6.3%; the same edit landing in a second file in 0.5%; a third new file in 1.7%; a finished plan in 0%. One test-file write in four goes through Bash rather than the Edit tool, which is why the Bash hook reads commands for writes. A rule that trimmed passing test logs could act in 1 chat of 847 and was removed. The plugin's reach on this kind of work is a few percent of chats per rule; the numbers above are the honest ceiling before anything goes wrong.

## Tests

```bash
node --test tools/test/ambient-*.test.mjs
```

All offline, no credential read, no model call. They run as part of `npm test`.
