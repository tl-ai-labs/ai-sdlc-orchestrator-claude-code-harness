# Zero-touch — a plain-words request starts its `/mmo:` workflow

Zero-touch is the part of the plugin that works while you chat with Claude Code as usual. You type a normal sentence; if it clearly asks for one of the eight `/mmo:` jobs, that job's workflow runs exactly as if you had typed the command. Every other message is an ordinary Claude Code chat: nothing is added to it, nothing is refused. It is switched by its own plugin, **`zero-touch`**, listed beside `mmo` in the same marketplace: install and enable it and every new chat has zero-touch; disable it and new chats have none. Without it the `mmo` plugin behaves exactly as it did before this page existed.

(The file keeps its old name, `ambient-mode.md`, so existing links still work.)

## What changed in 0.8.4: routing only

Until 0.8.3 zero-touch had a second half, the **generic orchestrator** (ask 1): in a chat whose message was not a recognised job it sent a start-of-chat note, turned big Reads into code-built outlines, refused by-hand typing above a break-even and handed it to a Flash or Sonnet worker through ten extra server tools, drew a control arm for measurement, could lock the chat's model, and kept a savings board. **0.8.4 removes all of it.** A zero-touch chat whose message is not a recognised job is now plain Claude Code. Its code is kept on the branch `archive/generic-orchestrator` (tag `generic-orchestrator-0.8.3`).

What went, concretely:
- Of 0.8.3's 22 zero-touch hooks, six stay (`session-start`, `prompt`, `pre-skill`, `pre-any`, `post-skill`, `pre-agent`) and 16 are gone: Read, Bash, Write, Edit, the worker tools, model switch, compaction, helper start, the old turn end, and the command-expansion hook, whose work the prompt hook now does. Two are new, for the second-job question: `post-question` and `turn-end` (a `Stop` hook again, now for the queue). Eight in all (below).
- The ten worker tools the server listed in every chat (`fix_from_analysis`, `write_files_from_specs`, `write_tests_from_cases`, `repeat_edit_across_files`, `scout_repo`, `job_result`, `undo_job`, `consent_to_send`, `lookup`, `write_files`). The server's tool list is the pipeline's and the executor's again (`plugin/mcp/model-dispatch/test/toolList.test.mjs`).
- The job runner, the apply and lookup scripts, the census, the board, `setup.mjs`, the prompt labels and 27 library modules under `plugin/scripts/ambient/`, and `tools/ambient-preflight.mjs`.
- Every setting of theirs (see "Settings").

Tests: `tools/test/zero-touch-a-only.test.mjs` (an ordinary message gets nothing; every tool passes untouched; only the eight hooks are registered; no file is left that the hook does not use).

What 0.8.4 added to routing, each with its tests:
- **A second job while a workflow runs** is held and the person chooses "Queue it" or "Replace it" (see "A second job while a workflow runs"; `tools/test/zero-touch-queue.test.mjs`).
- **One workflow at a time in one project**, across chats (same section).
- **A typed one-off command** (`/mmo:setup`, `/mmo:policy`, `/mmo:revert`) no longer makes the chat a workflow run. Until 0.8.4 it did, and since those commands write no run log, routing stayed silent for the rest of that chat.
- **"below" / "above"** block a job only when they point at text in the message ("the code below"), not as a comparison ("…can go below zero"); see Recognition.
- **The start-of-chat line** (see "Turn it on and off").
- **The pipeline's own links** to its manual and files use the installed plugin's path (see "What zero-touch leaves alone").

## Turn it on and off

| How | Effect |
|---|---|
| Install the `zero-touch` plugin (`/plugin install zero-touch@tilicho-ai-labs`, or from the plugin browser; it brings `mmo` with it) and leave it enabled | Every new chat has zero-touch. |
| Disable it in Claude Code's plugin list: in the desktop app **+** next to the prompt box → **Plugins** → **Manage plugins**; in a terminal chat `/plugin` → **Installed**; from a shell `claude plugin disable zero-touch@tilicho-ai-labs` | New chats have none. The `/mmo:` workflows are untouched: they are the `mmo` plugin. |
| `MMO_AMBIENT=on` or `MMO_AMBIENT=observe` in the environment | For one run, without the plugin: a developer or a measuring setup. `observe` records the chat's events and starts nothing. |
| `MMO_AMBIENT=off` | Off for this run, plugin or not. |

**The person sees it.** Three kinds of message come from zero-touch's own code, as a hook's `systemMessage`: Claude Code shows it in the chat and does not give it to the model, so it appears every time and the model cannot reword it.

- **The start message**, from the zero-touch plugin's start hook (`zero-touch/scripts/start-chat.mjs`): at a fresh start (a new chat or `/clear`), and again after a compaction or when a chat is reopened (the chat keeps its mode; its first lines may be out of view). It says workflow mode is on, what to ask for, that anything else is a normal Claude chat, which policy the chat's workflows will use (this project's `routing-policy.yaml`, else the project's saved choice, else the person's default, else the shipped one) and how to turn zero-touch off.
- **Off:** the person's mode file `~/.mmo-ambient/mode` holding `off` leaves a new chat without zero-touch, and the start message says so and how to turn it on. A missing file or any other value is workflow mode. A disabled plugin shows nothing: its hooks do not run.
- **One line after each typed message**, from the prompt hook (`lib/route-flow.mjs` `PERSON_LINE`), always starting with `Zero-touch:`:

| What happened | Line |
|---|---|
| A recognised job starts | `Zero-touch: starting the bug-fix workflow.` (the job's own name; a new app is `the new-app workflow`) |
| A queued job's turn comes (end of a turn) | `Zero-touch: starting the queued documentation workflow.` |
| A second job while a workflow runs | `Zero-touch: a workflow is already running. Choose Queue it or Replace it.` |
| A recognised job that cannot start | `Zero-touch: not started.` plus the cause in one sentence (another chat in this folder is running a workflow; the project's saved settings cannot be read; …) |
| A message while a gate is open | `Zero-touch: taken as your answer to the open gate.` (before the workflow has logged its run: `…to the running workflow.`) |
| Any other message while a workflow runs | `Zero-touch: not a new workflow job; the running workflow carries on.` |
| Any other message | `Zero-touch: not a workflow job, handled as a normal chat.` |

Nothing is shown for a message nobody typed (a machine notice), for a typed `/mmo:` command (the person named the workflow; only the Queue-or-Replace line can follow it), for a message sent while Claude is still working (it joins the running task), under `MMO_AMBIENT=off` or `observe`, or in a chat without zero-touch. What the model reads is unchanged: the start instruction for a recognised job, nothing for an ordinary message.

**No settings file switches it.** Until 29 Sep 2026 `{"mode": "on"}` in `~/.mmo-ambient/ambient.json` did, a file in the home folder nobody knew about; a `mode` key in any settings file is now ignored.

**Each chat is decided once, when it starts** (29 Sep 2026; `plugin/scripts/ambient/lib/chat-mode.mjs`). At the chat's start moment (`SessionStart` with source `startup`, or `clear`, which begins a fresh conversation) the zero-touch plugin's one hook (`zero-touch/scripts/start-chat.mjs`) writes the chat's record, `sessions/<id>/chat_mode`. Every moment of that chat acts on the record, so a change of plugin state reaches new chats only: a chat with no record is off (it started while the plugin was disabled, or before it was installed), and a reopened chat (`resume`) and a compaction keep what they have. Claude Code itself applies a plugin enable or disable to new sessions, and to an open one only on `/reload-plugins`; a plugin loaded that way into an open chat finds no record there and does nothing.

**Why the switch plugin holds no code of its own.** Claude Code gives each plugin its own copy of any file it links to at install, so a zero-touch plugin carrying `mmo`'s code would need a second copy of it on every machine. All of zero-touch's code and hooks stay in `mmo`; `zero-touch` depends on `mmo` and only marks chats.

**The two start hooks run at once.** Claude Code runs both plugins' `SessionStart` hooks at the same moment, so `mmo`'s can run before the record exists (seen live on 29 Sep 2026: the chat's start was logged `late`). `mmo`'s start work (its log line and the old-records sweep) then runs at the chat's first moment that has the record.

Without a record (and without `MMO_AMBIENT`), the shell shim in front of every zero-touch hook (`plugin/hooks/ambient.sh`) exits before `node` even starts: it reads the chat id from the start of the hook input, and an id it cannot read with certainty goes on to `node`, which decides. Tests: `tools/test/zero-touch-plugin.test.mjs`, `tools/test/ambient-chat-decision.test.mjs`.

## The eight hooks

All in `plugin/hooks/hooks.json`, all through the POSIX shim with a 5-second timeout, all exit 0 (a decision travels as JSON on stdout, never as an exit code), all handled by `plugin/scripts/ambient/hook.mjs`:

| Hook | Moment | Does |
|---|---|---|
| `session-start` | `SessionStart` | The chat's log line and the once-a-day sweep of old records; after `/clear`, forgets the earlier run and route. |
| `prompt` | `UserPromptSubmit` | Reads the message with fixed rules ($0, no model). A recognised job gets the instruction to start its workflow; a typed `/mmo:` workflow command makes the chat that workflow's run; a new job while a workflow runs gets the Queue-or-Replace question; any other message gets nothing. |
| `pre-skill` | `PreToolUse` on `Skill` | Guard B: a `/mmo:` workflow starts only when routing recognised the message, the person typed it, or the queue or a replace starts it; the chat starting a second one mid-run is held for the question. |
| `pre-any` | `PreToolUse` on every tool | Guard A: while a recognised job waits for its workflow to start, while the question waits for its answer, and while "Queue it" holds a typed command's steps, tools that change something wait. |
| `post-skill` | `PostToolUse` on `Skill` | Confirms a routed workflow's start once its command ran. |
| `post-question` | `PostToolUse` on `AskUserQuestion` | Reads the person's answer to the Queue-or-Replace question and acts on it. |
| `pre-agent` | `PreToolUse` on `Agent` / `Task` | The five mmo agents run only inside a workflow, and not while the question waits; the chat hiring one by itself is refused. |
| `turn-end` | `Stop` | Ends a queued typed command's hold; once the chat's workflow has ended, continues the turn with the first queued job. |

The pipeline's own hooks (the write contract, the foreground-helpers guard, telemetry, the executor guard) are not zero-touch's and keep their own settings, with no short timeout: Claude Code lets a tool call through when its guard hook times out.

## What is stored, and where

Everything lives under `~/.mmo-ambient/` (override with `MMO_HOME`), directories `0700`, files `0600`, nothing inside your repository.

| Path | Holds |
|---|---|
| `sessions/<id>/chat_mode` | The chat's on/off decision, written once at its start by the zero-touch plugin (or by `MMO_AMBIENT`): "on" or "observe"; no file means off. |
| `sessions/<id>/events.jsonl` | One record per event: the chat's start, each prompt's length, each route decision and why, each refusal. |
| `sessions/<id>/started` | The chat's start work has run (at its start, or late at its first moment with a record). |
| `sessions/<id>/route.json` | The job the rules recognised in the latest message (or the queue or a replace started): `pending` until its workflow starts, then `started`. |
| `sessions/<id>/pipeline` | The chat is running a `/mmo:` workflow, typed or started by routing: `{since, job, args}` (a bare time before 0.8.4). Dropped when the workflow's own log shows it ended (see "The hand-off"), when it is replaced, or at `/clear`. |
| `sessions/<id>/choice.json` | The Queue-or-Replace question waiting for its answer: the new job, how it came (words, typed, the chat's own start), the running job, the exact question. It belongs to the message that raised it. |
| `sessions/<id>/queue.json` | The chat's queued jobs, first in first out. |
| `sessions/<id>/hold` | "Queue it" was chosen for a typed command: its steps may not run until the turn ends. |
| `sessions/<id>/typed.json` | The plugin command typed in the latest message, so its own Skill call (in modes where a typed command makes one) passes Guard B. |
| `projects/<key>/workflow.json` | The project's lock: the chat running a workflow in that project (`key` is a hash of the project's real path). |
| `sessions/<id>/failures.log` | A hook that failed; three failures in one chat switch zero-touch off for the rest of that chat. |
| `ambient.json` | Your settings (below). |

No prompt text is stored, ever. The event writer drops fields named `prompt`, `content`, `stdout` and `stderr` and caps every string. Session folders older than `retention_days` (default 30) are removed once a day.

**Left behind by 0.8.3** and no longer read: `sessions/<id>/arm.json`, `note_sent`, `off_thinker`, `last_label`, `git_baseline`, and at the top `jobs/`, `locks/`, `verify/`, `consent/`, `evidence.json`, `measured.json`, `receipts.json`, `board-token`, `repos/`, `logs/`. Old session folders age out with the sweep (`logs/` too); the rest can be moved to the Trash by hand.

## Settings and who may change them

Layers, weakest first: shipped defaults (`plugin/config/ambient.default.json`), then `~/.mmo-ambient/ambient.json`, then `<project>/.sdlc/ambient.json`, then `MMO_AMBIENT`. None of the files switches zero-touch on or off (the zero-touch plugin does).

| Setting | Values | Default |
|---|---|---|
| `routing` | on / off | on. Off: no workflow is ever started from chat, and the chat may not start one by itself |
| `routing_defaults` | `{policy, auth}` | `opus-plus-flash-v38`, `estimated`: what a routed workflow starts with when the project has saved no policy of its own |
| `retention_days` | a whole number of days | 30 |

A project file is anyone's input: anyone who can land a commit can edit it. It may only switch `routing` off, never on, and nothing else. (Keeping zero-touch out of one project entirely is Claude Code's own job: disable the zero-touch plugin at project scope.) A value of the wrong type is ignored; an unknown `routing` value means off; a policy name that is not a plain name is never passed to a script. A settings file from 0.8.3 still reads: its other keys (valves, cost, prices, workers, jobs, offers, delegation, control, thinker, lock_model, closed cells, never-delegate paths) are ignored, and so is `receipts.json`, which let a trusted project file set them.

## Routing a recognised task to its workflow

With zero-touch on, an ordinary chat message that asks for one of the eight `/mmo:` jobs runs that job's workflow exactly as typing the command would. The jobs are greenfield, docs, bugfix, feature-extend, feature-new, refactor, test and deps. Every other message is an ordinary chat.

**What the person sees.** Nothing in zero-touch's own words names the plugin, a command or a model:
- **A clear request** ("fix the /login endpoint returning 500"): one plain line, "Running this as a full bug-fix workflow.", then the workflow's own steps and approvals. Two of the workflow's own setup questions are answered from the settings instead of asked: the cost-recording mode (`routing_defaults.auth`), and, for a new app, the brief (the person's message is the brief, written in the Project Brief layout). The saved policy is the project's own, or `routing_defaults.policy` for a folder with none. Every phase, gate and approval is the workflow's own.
- **An unclear request** (typos, casual wording, anything the rules do not recognise): an ordinary chat. No question is asked and no workflow starts on the chat model's guess (a project decision, 26 Sep 2026); the person can still type the command.
- **Anything else:** an ordinary chat.

Nothing has to be set first. A workflow's helpers name their model in the plugin's own agent files, so the first chat after install can start one, and switching the chat to another model does not move them.

**What the app shows is not zero-touch's to change.** Once a workflow starts, the app lists the command start ("Ran skill /mmo:greenfield") and the workflow's helper agents in its activity rows, and the workflow's own messages keep its own wording: exactly what a typed run shows. A plugin cannot rename those rows, for two reasons, both checked on 25 Sep in the Claude Code build the desktop app ran (2.1.281):
- Claude Code starts a plugin command only by its full `plugin:command` name. A bare `greenfield` is refused with "Did you mean mmo:greenfield?".
- Command aliases exist only for Claude Code's built-in skills. A plugin's command file cannot declare one.

Only renaming the plugin would change those rows, and a rename changes every typed `/mmo:` command too.

### Recognition (`lib/route.mjs`)

Fixed patterns, no model. Two signals must agree.

**The message** must be an instruction whose job verb opens it.
- **A project job** must also name something in the software: a path or file, a code identifier, an HTTP status, an error type, or a word of the trade (bug, test, endpoint, module, …). This is a positive requirement, never a list of exceptions.
- **A new app:** the app word must head what is built. "A haiku about a bot" is a poem: no preposition may sit between the article and the app word.
- **A pasted brief** counts only in `/mmo:greenfield`'s own layout (`# Project Brief`), and not when it ends with a question.
- **Clauses:** a message is cut at "and", "then" or ";" only where a new instruction follows (a verb such as run, add, fix, or one of the eight jobs). Any other part after "and" is still part of what the first clause names (since 26 Sep 2026): "write unit tests for the discount and tax functions in src/cart.js" is one test job about `src/cart.js`. The "it / this", small-edit and negation checks still read only what comes before the "and", so "fix it and the tests" stays a follow-up. A word that can be a verb or a noun counts as a verb, so an unsure part is cut, and the worst case stays a missed route.
- **Two jobs** route anyway, because each is part of its own job: a bugfix plus its regression test, and an upgrade plus fixing what the upgrade broke.
- **Never routed:**
  - questions (a `?` without "can you");
  - negations, including a self-negating object ("fix nothing yet");
  - "fix" as a noun;
  - follow-ups (also / as well / too / again);
  - a bare "fix it";
  - text in the message: "the code below", "the error above", "described below", "the following", "the attached log". "below" and "above" count as pointers only when they close the noun they follow; followed by an amount or a determiner they are a comparison and part of the bug ("…can go below zero", "quantities above 99", "prices above the limit"). What may follow a comparison is a closed class of English words (numbers and determiners), so this is a grammar rule, not a list of cases (0.8.4; until then every "below"/"above" blocked the job). Replayed over all 7,692 distinct messages typed on the author's machine (361 with one of the two words in the request line): no answer changed;
  - small edits: typo, spelling, grammar, formatting, lint or a commit message as the thing named (the head of the object). "The bug where comments are not saved" and a brief listing "ticket comments" are not small edits;
  - two different jobs.

**The folder** (`lib/route.mjs` `folderKind`, `lib/repo-kind.mjs`):
- **Existing:** `/mmo:greenfield`'s own four signals of an existing repo, or any source file of its own (dependencies, build output and docs do not count; a file counts whatever the case of its extension).
- **New:** everything else.
- A new folder can only be greenfield; an existing project only a brownfield job.
- Nouns that can be a whole app (api, service, dashboard) are unsure in an existing project.

**Checked offline** against 6,958 messages typed on the author's machine: 6 route, all real new-app prompts and briefs, none by mistake. The independent review's 19 look-alike wrong routes are now test cases.

Then every chat on that machine was replayed through the real hooks, routing on, at $0: 497 chat files, 18,012 prompts, each chat as if in a new folder and as if in an existing project.
- 32 routes, all to those 6 new-app prompts, at the chat's first to fourth message, before any work.
- None in an existing project.
- After each route, the next tool that would change something was held (29), and read-only tools ran (2).
- Of 676 typed commands (98 of them `/mmo:`) and 26 workflow starts, none was refused.
- 0 hook failures. About 55 ms per hook call (95th percentile 76 ms).

The messages stay on that machine.

After the clause change (26 Sep 2026), every distinct message typed on that machine (7,072) was routed by the old and the new rules at $0: exactly one answer changed, a real new-app brief ("Build an inventory and order management REST API in TypeScript with Express: …") that now routes to greenfield; before, the "and" cut it to "Build an inventory", which names no app. No other message moved.

### The hand-off (`hook.mjs`, `lib/route-flow.mjs`)

Every workflow start, typed or model-started, reaches the hooks as a `PreToolUse` on the `Skill` tool. This was probed live on Claude Code 2.1.282. A typed `/mmo:bugfix`, or `/bugfix` where Claude Code allows the plugin's command without its prefix, makes the chat a workflow run before any tool runs.

1. **Like typing the command, whenever the chat is idle** (29 Sep 2026). A job message starts its workflow at any point in a chat, as often as the person asks, one workflow at a time. Nothing is routed:
   - **while a workflow is running in the chat** (then a new job gets the Queue-or-Replace question, below). Running means from the moment the chat starts it (typed or routed) until the workflow's own log (`<project>/.sdlc/runs/<run-id>/orchestrator.log`, written through `mmo-log.mjs`) shows it ended: every gate it opened answered after its `run.end`, an answer of `abort` at any gate, or a `run.end` that says aborted or failed. The run is the latest one whose `run.start` is not earlier than the chat's start of the workflow (`lib/workflow-log.mjs`). A workflow with no logged run yet (stopped at its first questions, or still asking them) keeps the chat, so an answer to one of its questions is never taken for a new job. Once it has ended, the next message is judged afresh: a job starts its own workflow (or the first queued one starts by itself), anything else is an ordinary message;
   - **for a message typed while Claude is still working, when no workflow runs.** Claude Code records such a message in the transcript as a `queued_command` and delivers it into the running task; an ordinary message is a plain user entry (seen live on Claude Code 2.1.284). The prompt hook reads the newest transcript entry carrying the message (`lib/transcript.mjs`, `sentWhileWorking`); a queued one joins the running task, never starts a workflow and never ends a start that task has pending (logged as `route.none` with the reason "sent while Claude was working");
   - **for a notice nobody typed** (a background command's completion notice, which Claude Code delivers through the same hook, tagged): logged as a prompt nobody typed, never judged.
   Work the chat has already done does not hold a job back, exactly as it would not stop the person from typing the command.
2. **A clear route.** The prompt hook tells the chat which workflow to start (the Skill call and its one-line description), the plain line to say, and the settings already chosen. A route belongs to its prompt, and the next prompt drops it.
3. **Guard A** (one catch-all `PreToolUse` hook, `pre-any`). Until that Skill call, only tools that change nothing run (Read, Glob, Grep, ToolSearch, TodoWrite, the web tools, Skill). Everything else waits with "Start the workflow first", including every other MCP server's tools and helpers already running.
4. **Guard B** (`pre-skill`), for a `mmo:` Skill call (a leading `/` is the same command):
   - **Allowed:** a command the person typed (its own Skill call, in modes where a typed command makes one), the routed workflow, and a queued or replacing one the hook itself started; while a workflow runs, any of the plugin's non-workflow skills (its manual) and one-off commands.
   - **Refused:** a helper agent starting the chat's workflow, a one-off command (setup, policy, revert) or workflow the chat starts by itself outside a workflow run, a second workflow beside the routed one, and one the folder rule forbids.
   - **Held for the question:** the chat starting a second workflow by itself while one runs (0.8.4). Until 0.8.4 Guard B stood down while a workflow ran, so such a start ran over the first one.
   - **A start the chat makes by itself** (no route from the rules): always refused with "Full workflows start only when the plugin recognises the request or the person types the command. Carry on with your own tools."
5. **Starting.**
   - A route made by the prompt hook was already checked there, so the chat is marked a workflow run first. The policy is then saved, only for a folder with none, as `/mmo:setup`'s scripted path saves it: never overwritten, and never into an enclosing project.
   - The after-hook (`post-skill`) marks the start too, so a start hook that timed out cannot leave the workflow blocked.
6. **When a workflow cannot start,** nothing starts and the chat tells the person the real cause, with the fix for that cause:

   | Cause | Fix offered |
   |---|---|
   | This project's saved choice is an older policy whose judgment model is not the one the helpers' agent files name (the Opus 4.7 policies) | The person's choice of policy, never changed automatically |
   | Anything else the workflow's own model check refuses (the rare `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` switch, or agent files that do not name one model) | The check's own reason, passed on |
   | The plugin is not fully installed | `verify-setup.mjs --fix` |
   | `.sdlc/project.json` does not read | Shown to the person |
   | The folder is inside another project with no saved choice | Said plainly |
   | Another chat in this project is running a workflow (0.8.4, the project lock) | Finish it in that chat, or type /clear there, then ask again |

   Under `vendor` the helpers'-model check is skipped, as the workflow itself skips it.
7. **Around it:** `/clear` starts a fresh conversation: an earlier workflow run, route, question and queue no longer count. Three failures of zero-touch's hooks in one chat switch it off for the rest of that chat.

Tests: `tools/test/ambient-route.test.mjs` (recognition) and `tools/test/ambient-routing-hooks.test.mjs` (the hand-off, end to end through the shell shim); `tools/test/zero-touch-lines.test.mjs` (the line after each message) and `tools/test/zero-touch-plugin.test.mjs` (the start message, the mode file, the repeat after a compaction).

### A second job while a workflow runs (0.8.4, `lib/queue.mjs`)

Zero-touch chats only; a chat without zero-touch keeps mmo's own behaviour. Why: on 29 Sep a chat typed `/mmo:bugfix`, then `/mmo:docs` while the bug fix ran; docs started and the bug fix was dropped without a word.

**When it asks.** While this chat runs a workflow, a new job is held and the person is asked, in plain words, "Queue it" or "Replace it", when it comes as:
- **plain words** the rules recognise as a job, unless the workflow is waiting for an answer: then the message is that answer, never a new job (one of its gates is open, or it has not logged its run yet and is still asking its first questions);
- **a typed `/mmo:` workflow command** (a typed command is never a gate's answer). Its text stays with the model, which is told to ask first;
- **the chat starting a workflow by itself** (Guard B refuses the start, with the question as the reason).

The model is told the exact question and the two labels and must ask with Claude Code's multiple-choice tool (`AskUserQuestion`); if the running workflow is waiting for its own answer, both questions may go in the same call. Until the person answers, nothing that changes anything runs (Guard A), the workflow's helpers included. The answer reaches the hook as `tool_response.answers[<question>] = <label>` (read from real transcripts, 29 Sep), so the hook acts on the exact label, never on a guess (`post-question`). A person who types the answer instead is understood only when the message is one of the two labels; any other message drops the question, so nothing stays blocked.

**Queue it.** The job joins the chat's queue, first in first out; the same job (same command, same description) is not added twice. After a typed command, whose text the model still holds, nothing that changes anything runs until that turn ends (the hold). At the end of the turn in which the running workflow's own log shows it ended, the turn continues with the first queued job (the `Stop` hook's `block` reason tells the model to start it with the Skill tool, one plain line first); Guard A holds everything else until it starts. A start the model does not make is not pushed again in the same turn (`stop_hook_active`): the job stays queued for the next turn's end. The queue ends with the chat or `/clear`.

**Replace it.** The running workflow is stopped the way its own abort stops it (`lib/workflow-log.mjs` `abortRun`): its run log records `run.end outcome=aborted reason=replaced`, in the format `mmo-log.mjs` writes, and a brownfield write lock (`.sdlc/local/write-contract.json`) that belongs to that run is switched off, as the brownfield manual's abort step does; the run folder is kept. Then the new workflow starts: a typed command carries on as the chat's workflow; any other is routed like a recognised job.

**One workflow at a time in one project** (`lib/project-lock.mjs`). Two chats running workflows in one folder would write into the same `.sdlc/runs/` and read each other's run. A zero-touch chat that starts a workflow takes the project's lock (`projects/<key>/workflow.json` under `MMO_HOME`); a second chat's recognised job gets the cause "busy" (below), and its typed workflow command is kept from the model (the prompt hook blocks it; the person sees why). Whether a lock holds is decided from facts each time, never from its age: the owning chat must still have its workflow record and that workflow's own log must not show it ended; a lock that fails either test is replaced. The busy cause is in the table of step 6.

**Facts it rests on**, probed on Claude Code 2.1.283 on 29 Sep through the desktop app's own transport (stream-json; `Zero-touch-harness-tasks-ask/ask-2-routing/probes-step3/`): a `/command` sent while Claude works waits and runs as its own turn after the running one; plain words sent while Claude works join the running turn at its next step; a `UserPromptSubmit` block keeps a typed command from the model and shows the person the reason; the prompt hook of a typed command sees the typed line, with the same `prompt_id` as its expansion. A command typed with "Send now" interrupts the running turn on purpose: the question is then asked at once, and "Queue it" leaves the interrupted workflow to be resumed by the person.

Tests: `tools/test/zero-touch-queue.test.mjs`.

## What zero-touch leaves alone: everything 0.7.7 does

From 0.8.3 zero-touch sits on top of the pipeline (0.7.7, and from 0.8.4 the greenfield executor of 0.7.12), and nothing the pipeline does changes. That covers every `/mmo:` command, typed or started by the model: the same phases, gates, policies, routing, worker launches, output caps and hooks.

**One deliberate exception, for every run, typed or routed, zero-touch on or off (25 Sep 2026, a project decision):** which model the five driver agents run on under `--auth=estimated`.
- **0.7.7:** the user's `CLAUDE_CODE_SUBAGENT_MODEL`, which had to be set before launch (in the desktop app only in `~/.claude/settings.json`, and read only when a chat starts); the run-start check stopped a run without it.
- **0.8.3 and later:** each agent file names `model: claude-opus-5`, which Claude Code (2.1.251 and later) puts above that setting and above the chat's model, checked live in the desktop app on 25 Sep (chat on Sonnet 5: the pinned helper ran Opus 5, an unpinned one Sonnet 5). The run-start check compares the pin with the policy, so a mismatch still stops the run and the report never prices a model that did not run.
- **What a person notices:** nothing to set, no new chat, and the chat's model picker cannot move the helpers. The older Opus 4.7 policies (`opus-plus-flash`, `opus-only`) stop in estimated mode.

**One text change for every run, typed or routed (0.8.4):** the commands, the brownfield manual and the orchestrator's instructions name the files they send the model to by the installed plugin's own path, `${CLAUDE_PLUGIN_ROOT}/…`, which Claude Code fills in with the plugin's real folder (probed on 2.1.283 for commands, skills and agents). Until 0.8.4 they said `/plugin/skills/brownfield-guide/SKILL.md`, a path that exists only in a clone of this repository, so a model that followed it literally on an installed plugin found nothing (the Sonnet 4.6 bug-fix chat of 26 Sep). Links to the repository's own `SETUP.md` and `docs/`, which an installed plugin does not carry, now name `/mmo:setup` or `/mmo:policy` instead. What the files say is otherwise unchanged (`tools/test/plugin-paths.test.mjs`).

**With zero-touch off (the plugin disabled or not installed), the plugin behaves as the pipeline alone:** the commands, skills and agents read exactly as in 0.7.7, the tool list is the pipeline's, and every zero-touch hook returns at once.

**With zero-touch on, a typed `/mmo:` session sees none of it:** from the `/mmo:` prompt on, zero-touch stands down until the run ends, and the pipeline's own agents get their explicit tool lists. One change in ordinary chat only: the chat may start just the workflow the rules recognised (Guard B), where 0.7.7 lets it start any. Which workflow may start changes; how a workflow runs does not.

The zero-touch branch (`ed8e701`, 22 Sep 2026) also changed things 0.7.7 does, and those changes are **not in 0.8.3 or 0.8.4**:
- **Static text** that made every command and skill typed-only (`disable-model-invocation`) and added a sentence to every agent's description. With zero-touch on, its hooks decide which `/mmo:` command the model may start.
- **Timeouts** on the pipeline's hooks.
- **Pipeline-only repairs**, each to ship as its own pipeline change with its own pipeline check: `hard_cost_cap_usd` enforcement; policy reload on edit; the adapter cache key; crash handlers; dropping credential-shaped variables from the agent worker; safety switches on the pipeline's `claude` worker; model-chosen path checks; `project_root` defaulting to `CLAUDE_PROJECT_DIR`; symlink checks in the write contract; migrations falling through to premium.

Their code is in `git show ed8e701`, and `docs/methodology.md` (v0.8.3) lists them.

## After a Claude Code update

Routing relies on these behaviours of the app: a note the prompt hook adds reaches the model; a `PreToolUse` deny on the `Skill` tool stops a command and the model reads the reason; a message typed while Claude works is recorded in the transcript as a `queued_command`; both plugins' `SessionStart` hooks run for a new chat and after `/clear`, and a start hook's `systemMessage` is shown to the person; a multiple-choice answer reaches `PostToolUse` as `answers[<question>]`; a `Stop` hook's `block` continues the turn with its reason; and `${CLAUDE_PLUGIN_ROOT}` is filled in inside commands, skills and agents (probed on 2.1.283). An update can change any of them silently. After every update, in one new chat with zero-touch on: the start line shows; a clear job message starts its workflow; a second job during it gets the Queue-or-Replace question; and a `/mmo:` command the chat tries by itself is refused with its reason. `tools/test/ambient-routing-hooks.test.mjs` proves the plugin's side; the live chat proves the app's.

## Status

**0.8.4 (29 Sep 2026): the generic orchestrator removed; the second-job question, the project lock, the start line, the below/above rule, the one-off command fix and the installed-path links added.** Built and tested offline (root and server suites), the platform facts probed live on 2.1.283. Not yet checked live end to end; the live checks, in the desktop app and in a terminal, are the next step.

Routing (25 Sep 2026): built and tested offline, with the platform facts it rests on probed live on Claude Code 2.1.282 (a Skill call for every command start; the prompt hooks fire before any tool in headless runs; a PreToolUse deny stops a command).

Live on the pinned version, 26 Sep 2026, nothing set on the machine:
- **New app, chat on Sonnet 5:** the workflow started from a plain message; its run-start check printed "the driver agents run on claude-opus-5, named in this plugin's agent files"; the plan showed Opus 5 for the thinking and Flash 3.8 for the typing; requirements were written and the run stopped at Gate 1.
- **Bug fix, chat on Opus 5.5:** the chat loaded the brownfield rulebook by its skill name, read the project's saved policy (`opus-plus-flash-v38`), ran the pre-check, and the discovery helper ran on Opus 5 without touching the source.
- **Bug fix, chat on Sonnet 4.6:** the chat could not open the rulebook (the brownfield commands pointed at it by a repository path, a bug since 19 Aug 2026) and worked without it. Fixed in 0.8.4: every such link is the installed plugin's own path (`${CLAUDE_PLUGIN_ROOT}/…`, `tools/test/plugin-paths.test.mjs`); not yet re-run live.

Live, 29 Sep 2026 (0.8.3, the zero-touch plugin installed alone brought `mmo` with it): a new chat was marked at its start; with the plugin disabled, a new chat had no record and nothing acted.

## Tests

```bash
node --test tools/test/ambient-*.test.mjs tools/test/zero-touch-*.test.mjs
node --test plugin/mcp/model-dispatch/test/toolList.test.mjs   # after npm run build in plugin/mcp/model-dispatch
```

All offline, no credential read, no model call. They run as part of `npm test`.
