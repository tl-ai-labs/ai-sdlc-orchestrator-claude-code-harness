# Zero-touch — a plain-words request starts its `/mmo:` workflow

Zero-touch is the part of the plugin that works while you chat with Claude Code as usual. You type a normal sentence; if it clearly asks for one of the eight `/mmo:` jobs, that job's workflow runs exactly as if you had typed the command. Every other message is an ordinary Claude Code chat: nothing is added to it, nothing is refused. It is switched by its own plugin, **`zero-touch`**, listed beside `mmo` in the same marketplace: install and enable it and every new chat has zero-touch; disable it and new chats have none. Without it the `mmo` plugin behaves exactly as it did before this page existed.

That is **workflow mode**, the default. The same plugin has a second mode, **hand-off mode**, chosen in the person's mode file: the chat's own model does the development, and new docs, specs, plans, tests and repeated edits go to a cheaper model. It has its own section, "Hand-off mode", below; everything before that section describes workflow mode.

(The file keeps its old name, `ambient-mode.md`, so existing links still work.)

## What changed in 0.8.4: routing only

Until 0.8.3 zero-touch had a second half, the **generic orchestrator** (ask 1): in a chat whose message was not a recognised job it sent a start-of-chat note, turned big Reads into code-built outlines, refused by-hand typing above a break-even and handed it to a Flash or Sonnet worker through ten extra server tools, drew a control arm for measurement, could lock the chat's model, and kept a savings board. **0.8.4 removes all of it.** A zero-touch chat whose message is not a recognised job is now plain Claude Code. Its code is kept on the branch `archive/generic-orchestrator` (tag `generic-orchestrator-0.8.3`).

What went, concretely:
- Of 0.8.3's 22 zero-touch hooks, six stay (`session-start`, `prompt`, `pre-skill`, `pre-any`, `post-skill`, `pre-agent`) and 16 are gone: Read, Bash, Write, Edit, the worker tools, model switch, compaction, helper start, the old turn end, and the command-expansion hook, whose work the prompt hook now does. Two are new, for the second-job question: `post-question` and `turn-end` (a `Stop` hook again, now for the queue). Eight in all for workflow routing; hand-off mode adds two (below).
- The ten worker tools the server listed in every chat (`fix_from_analysis`, `write_files_from_specs`, `write_tests_from_cases`, `repeat_edit_across_files`, `scout_repo`, `job_result`, `undo_job`, `consent_to_send`, `lookup`, `write_files`). The server's tool list is the pipeline's and the executor's again (`plugin/mcp/model-dispatch/test/toolList.test.mjs`).
- The job runner, the apply and lookup scripts, the census, the board, `setup.mjs`, the prompt labels and 27 library modules under `plugin/scripts/ambient/`, and `tools/ambient-preflight.mjs`.
- Every setting of theirs (see "Settings").

Tests: `tools/test/zero-touch-a-only.test.mjs` (an ordinary message gets nothing; every tool passes untouched; only zero-touch's own hooks are registered; no file is left that the hook does not use).

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
- **The mode file:** the person's `~/.mmo-ambient/mode` holds `a` (workflow mode), `b` (hand-off mode) or `off`. `off` leaves a new chat without zero-touch, and the start message says so and how to turn it on. A missing file or any other value is workflow mode. Every start message says how to reach the other modes. A disabled plugin shows nothing: its hooks do not run.
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

## The twelve hooks

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
| `pre-model-switch` | `PreModelSwitch` | Hand-off mode only: refuses a switch away from the chat's pinned model. Answers nothing in a workflow-mode chat. |
| `post-model-switch` | `PostModelSwitch` | Hand-off mode only: keeps the model the chat is on now, so each line names the model really in use. Decides nothing. |
| `pre-handoff` | `PreToolUse` on the hand-off tools | In a hand-off chat: stamps the call with the chat, the project folder and who pays, after making sure the chat's models are resolved. In a workflow-mode chat and inside a workflow run: refuses the call with the reason. |
| `post-handoff` | `PostToolUse` on the hand-off tools | Shows the person one line written from the tool's receipt. Decides nothing, adds nothing for the model. |

In a hand-off chat the same `prompt` hook recognises hand-off work instead of workflow jobs, and `pre-skill` lets a workflow start only from a typed command ("Hand-off mode" below).

The pipeline's own hooks (the write contract, the foreground-helpers guard, telemetry, the executor guard) are not zero-touch's and keep their own settings, with no short timeout: Claude Code lets a tool call through when its guard hook times out.

## What is stored, and where

Everything lives under `~/.mmo-ambient/` (override with `MMO_HOME`), directories `0700`, files `0600`, nothing inside your repository.

| Path | Holds |
|---|---|
| `sessions/<id>/chat_mode` | The chat's mode, written once at its start by the zero-touch plugin (or by `MMO_AMBIENT`): "on" (workflow mode), "b" (hand-off mode) or "observe"; no file means off. |
| `sessions/<id>/handoff.json` | Hand-off mode: the chat's stamp, written once at its start: the model it is pinned to (`chat_model`, and `pin`: default, setting or admin), the hand-off policy (`policy`, or `policy_file` for a project's own) and any setting that was set aside. |
| `sessions/<id>/handoff_models.json` | Hand-off mode: the model the policy gives each kind of hand-off work, asked of the workflows' router once per chat. |
| `sessions/<id>/model_now` | Hand-off mode: the model Claude Code last said the chat is on (at its start, at a model switch). |
| `sessions/<id>/handoff-telemetry.jsonl` | Hand-off mode: the chat's hand-off bill, one line per typist call (failed ones included), in the shape of a workflow's telemetry. Written by the server. |
| `sessions/<id>/handoff_released.json` | Hand-off mode: the files a failed hand-off handed back, which the chat's model may write by hand. Written by the server. |
| `sessions/<id>/handoff_landings.json` | Hand-off mode: every hand-off that changed the project, in order, each with its id (`h1`, `h2`, …), its tool and its files (whether each existed before, and a hash of what was written). Written by the server. |
| `sessions/<id>/handoff_undo/<id>/<n>` | Hand-off mode: the earlier text of a landing's n-th file, for the undo. |
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
| `handoff` | `{chat_model, policy}` | `claude-opus-5`, `opus-plus-flash-v38`: hand-off mode's two settings, read once per chat at its start ("Hand-off mode" below) |

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

## Hand-off mode

Workflow mode runs a whole gated workflow for a job. Hand-off mode is for ordinary development in the chat: **the chat's own model does the work** (reading, deciding, new code, bug fixes, refactors, reviews), and only work that is mostly typing AND has a check code can run on the result goes to a cheaper model. Put `b` in `~/.mmo-ambient/mode` and start a new chat.

| Kind | What it covers | Goes to |
|---|---|---|
| docs | a new document of the project: a README, a guide, an API reference, a changelog | the policy's `docs` stage |
| spec | a new spec: requirements, a design document, an API spec, a data-model write-up | the policy's `docs` stage |
| plan | planning text: a plan, a task breakdown or tickets, a status report, release notes | the policy's `docs` stage |
| tests | new tests for code that exists | the policy's `tests` stage |
| repeat | the same change repeated across files (the chat's model makes it once) | the policy's `codegen` stage |

New code, a bug fix and a refactor are never handed off: a wrong answer there is hard to spot. **Plain words start no workflow in a hand-off chat**; a workflow starts only when the person types its command (`/mmo:greenfield`, `/mmo:bugfix`, …), and then runs as in any chat.

### The chat's start (`zero-touch/scripts/start-chat.mjs`)

The start hook reads the mode file and, for `b`, hand-off mode's two settings, **once**, and stamps them on the chat (`sessions/<id>/handoff.json`). Everything later reads the stamp, never the files: a setting changed in the middle of a chat would leave its start note, its model guard and its hand-offs disagreeing, and would split one chat's costs across two sets of models. A change reaches the next new chat, or `/clear`.

| Setting (in `~/.mmo-ambient/ambient.json`) | Controls | Default |
|---|---|---|
| `handoff.chat_model` | the model a hand-off chat is pinned to; an exact model id, never an alias such as `opus` | `claude-opus-5` |
| `handoff.policy` | the shipped policy whose models do the hand-offs; its `select` slot decides how a Gemini model is reached | `opus-plus-flash-v38` |

Two things outrank them. **An organisation's pinned model** (managed settings `model`) is the chat's pin; written as an alias it cannot be compared with a model id, so the plugin then pins nothing and the organisation's setting is what holds the chat. **A policy file in the project** (`routing-policy.yaml`) wins over `handoff.policy`, as it does for a workflow: a project uses it to say which models may see its code. A setting that is not a model id or a policy name is set aside for the default, and the start message says so.

The person sees the start message (hand-off mode is on, what is handed off, the chat model and whether the chat is on it, the hand-off policy, where the settings live, that workflows start only from a typed command, how to change the mode). The chat's model gets a note with the hand-off rules (the hook's `additionalContext`). A compaction drops that note from what the model reads, so the message and the note are both given again after a compaction and when a chat is reopened, from the stamp.

### Recognition (`lib/handoff-route.mjs`)

Fixed patterns, no model. The message is read the way workflow mode reads it (the first line, polite openers removed, questions and requests to explain set aside), sentence by sentence and clause by clause. A clause is hand-off work when a creating verb opens it (write, create, draft, generate, prepare, add, …) and the thing it names **is** one of the documents above, not something that mentions one: the document word must close its noun phrase.

| Message | Recognised as | Why |
|---|---|---|
| `write a README for this project` | docs | |
| `draft a design doc for the cache layer` | spec | |
| `write a test plan for the checkout flow` | plan | the most specific word wins: a test plan is a plan |
| `add tests and docs for the parser` | tests and docs | one verb, two things, each judged on its own |
| `fix the login bug and write tests for it` | tests, beside the chat's own work | |
| `rename getUser to fetchUser everywhere` | repeat | a mechanical change verb plus where it is repeated |
| `do the same in the other three services` | repeat | |
| `add a changelog entry for this fix` | none | the thing named is an entry: an edit to a file that exists |
| `update the README with the new setup steps` | none | an update, not a new document |
| `add docstrings to the scheduler package` | none | documentation inside code files is an edit to code |
| `document the auth module` | none | unsure: a document of its own, or comments in the code |
| `fix the failing tests across the repo` | none | each failure is its own fix |

Precision first: recognition decides only the line the person sees and the reminder the chat's model gets. The model can still hand off work the patterns missed. Unlike workflow mode, a follow-up is fine here ("also add tests", "write tests for it"): nothing is started. The labelled set is `tools/test/zero-touch-handoff-words.test.mjs`.

### What the person sees after each message (`lib/handoff.mjs`)

| What happened | Line |
|---|---|
| A new document, spec or plan | `Zero-touch: this goes to Flash (docs).` (or `spec`, `plans and reports`) |
| New tests | `Zero-touch: the tests go to Flash.` |
| A repeated change | `Zero-touch: Opus makes the change once; Flash repeats it in the other files.` |
| Hand-off work beside other work | the line above, then `Opus handles the rest in the chat.` |
| Anything else | `Zero-touch: Opus handles this in the chat.` |
| Hand-off work that cannot run | `Zero-touch: hand-off cannot run (<why>); Opus handles this in the chat.` |
| While a typed workflow runs | workflow mode's own lines (the open gate's answer; the running workflow carries on) |

The names are never guessed. **The hand-off model** is the one the policy gives that kind of work, asked of the workflows' own router once per chat (`plugin/scripts/handoff-models.mjs`, the same routing code the server uses) and kept for the chat, so a policy that sends docs to Sonnet shows `Sonnet`. **The chat's model** is the one the chat is on now: what Claude Code last reported (the start moment, a model switch) or, when newer, the model the chat's transcript shows it last answered with; when nothing says, the line reads `Zero-touch: handled in the chat; nothing is handed off.` The chat's model also gets a reminder naming the tool for each recognised kind.

### The chat stays on its model

Hand-off mode pins the chat, because the chat's own model does the development: which model that is decides the quality and the cost of everything that is not handed off. (Workflow mode never pins the chat: its thinking helpers name their model in their own agent files.) A plugin cannot set a chat's model, so:

- the start message asks for `/model <handoff.chat_model>` when the chat is on another model, or may be;
- a switch to another model is refused (`PreModelSwitch`, Claude Code 2.1.251 and later), and the person reads why and how to use another model. A switch to the pinned model always passes, and a switch whose target the hook cannot read is never refused: a guard that misreads its input must not lock anyone out of their model picker;
- while the chat is on another model anyway, every line adds `This chat is on <model>; hand-off mode expects <pinned>: type /model <pinned>.`

### A hand-off, step by step

The hand-off tools are the `mmo` server's (`plugin/mcp/model-dispatch/src/handoff/`). The server lists them in every chat, because it cannot know a chat's mode when its tools are listed; a call works only in a hand-off chat.

1. **The chat's model fills in the tool's form and makes one call.** The form is a brief, never the finished text. (For a repeated change it first makes the change itself, in one file.)
2. **The hook stamps the call** (`pre-handoff`): the chat's id, the project folder and who pays for a Claude typist. The server takes nothing else about the chat from the call: the policy and the model for this kind of work are read from the chat's own records, so nothing the model writes in a call can choose them. A call with no stamp, or whose chat is not a hand-off chat, is refused. So is a call inside a workflow run.
3. **Code checks the form** before anything is sent. Every problem is listed at once, by field.
4. **The typist writes.** The ladder is the executor's: two attempts by the model the policy routes this work to (the second with the reason the first was refused), then one by the policy's Claude model. A vendor or network failure waits and is not an attempt. A refused login (HTTP 401 or 403) skips that model's second attempt. Every call is billed and logged, failed ones included.
5. **Code checks the answer**, and only a checked answer reaches the project. Tests and a repeated change are also run, in a scratch copy of the project (below).
6. **The receipt** goes to the chat's model (status, who wrote it, attempts, cost, what was checked, what to do next), and the person sees one line (`post-handoff`):

| Outcome | Line |
|---|---|
| A file written by the routed model | `Zero-touch: docs/setup.md written by Flash, checked ($0.0041).` |
| The routed model failed, the Claude model wrote it | `Zero-touch: Flash failed, done by Opus: docs/setup.md written, checked ($0.10).` |
| Every attempt failed | `Zero-touch: hand-off failed for docs/setup.md ($0.01 spent); Opus writes it in the chat.` (the file is handed back to the chat's model) |
| Tests that ran and did not pass | `Zero-touch: the tests in tests/cart.test.js did not pass in a scratch copy ($0.10 spent); nothing was written. Opus looks at the output.` |
| A repeated change, landed | `Zero-touch: the change repeated in 3 files by Flash, checked ($0.01).` (`no check command run` when none was given; `2 left for Opus to change.` when some targets failed) |
| A repeated change that failed its check | `Zero-touch: the repeated change failed its check in a scratch copy ($0.01 spent); nothing was changed. Opus makes the change in the chat.` |
| An undo | `Zero-touch: hand-off h2 undone (2 files restored).` |
| The form was not complete | `Zero-touch: hand-off form not complete (2 to fix); nothing was sent.` |

Every hand-off that changes the project is one **landing** with an id on its receipt (`h1`, `h2`, …), recorded with what each file held before (`handoff/landing.ts`).

### `write_document` (docs, spec, plan)

The form (`handoff/document.ts`):

| Field | Holds | Checked |
|---|---|---|
| `kind` | `docs`, `spec` or `plan` | one of the three |
| `file` | the NEW file, from the project folder | inside the project (symlinks followed), not under `.git`, and not there yet: a change to a file that exists is the chat model's own edit |
| `purpose`, `readers` | what the document is for; who reads it | filled, one line |
| `sections` | each `heading` and `must_say` | at least one; no heading twice; every string one line |
| `facts` | everything the document may state about the project: each `statement`, its `source` (a project file, or `chat` for something the person said) and, for a file, a `quote` | at least one; a file source exists; **the quote is in that file word for word**; a fact from the chat has no quote |
| `style_from` | optional: a document whose tone and layout to follow | a file of the project |

Every string is one line: a field holding several lines or a code block is the finished text, which would mean the chat's model did the typing and the hand-off saved nothing. The typist is told it cannot see the project and may state only the facts.

The answer's checks refuse only what is certainly wrong whatever the document is about:

- a listed section has no heading of its own (in Markdown a heading line, so "Installation notes" is no "Install" section);
- a shell command is not one of the facts (commands joined with `&&` or `;` are each checked; a labelled shell block is commands throughout, an unlabelled block only where a line carries a `$` prompt);
- inline code naming a path under one of the project's own top-level folders, or a relative link, leads to nothing in the project. A word with a slash that is no project path (`text/html`) is left alone.

Whether the prose is right is the chat model's reading of the written file, which the receipt asks for.

### The scratch copy (`handoff/scratch.ts`)

Tests and a repeated change are **run** before they reach the project, in a copy of it, with a command the chat's model names in the form. The project is never the place a hand-off is tried out.

- The copy holds the project's own files as they are on disk now (tracked files and new ones, uncommitted work included) as real copies, copy-on-write where the file system has it, so whatever the command writes over them stays in the copy.
- What git ignores (installed dependencies, build output, caches) is linked in, not copied: it can be large, and the command needs it. A command that writes inside such a folder (a cache under `node_modules`) writes to the real one, as it does when the person runs it.
- Git is what tells the two apart, so **a project that is not a git repository gets no copy and the hand-off is refused**; the chat's model does the work itself. Nothing is written into the repository to make the copy (no commit, no worktree).
- The command runs through `sh -c`, as typed, with `CI=1` (runners do not wait for a person), both output streams together; the end of a long output is kept (8,000 characters, a stated bound). A command past ten minutes is stopped, its process group with it.
- **The command is the chat model's, run with the person's own rights**, as when the model runs it with Bash; Claude Code's permission prompt for the tool call shows it. Before anything is sent, the form check asks the shell that its program exists, and for `npm run <script>` / `npm test` that package.json has the script.

### `write_tests_from_cases`

Deciding what to test is judgment; typing the test file is not. The form (`handoff/tests.ts`):

| Field | Holds | Checked |
|---|---|---|
| `file` | the NEW test file | inside the project, not there yet |
| `target` | the file under test | a file of the project; its text travels with the brief |
| `functions` | the names the tests exercise | at least one; each is in the target as a whole name |
| `cases` | each `name`, `given`, `expect` | at least one; no name twice; every string one line |
| `style_from` | optional: a test file to follow | a file of the project; its text travels with the brief |
| `test_command` | the command that runs the new file | its program is on the machine; an npm script exists |
| `notes` | optional | one line |

The answer is checked in two steps: every case has a test with exactly its name (however the file quotes it), then the file is written into the scratch copy and the test command runs there. **Only a file whose tests pass is written into the project.**

**A case's expected result is the specification.** The typist is told never to change it, or weaken an assertion, to make a test pass. So when the code under test does something else than a case expects, the tests keep failing, nothing is written, and the chat's model gets the run's output: a wrong case it corrects and hands off again; a real bug it tells the person. A hand-off that bent the tests until they passed would hide exactly the bugs tests exist to find.

### `repeat_edit_across_files` and `undo_hand_off`

The chat's model makes a change **once, by hand**, in one file. The form (`handoff/repeat.ts`): `example` (that file; it must differ from the last commit, and its diff is the pattern), `targets` (the files to repeat it in), `change` (the change in words) and `check_command` (optional but wanted: the project's build or test command).

Each target is one job, a few at a time, answered as exact edits. Code checks each answer before any file is touched:

- every edit's search text is in the file exactly once (the executor's own rule), so an edit lands where it was meant or not at all;
- **an edit removes only lines the change is about.** The words the example's change took away (in its removed lines and in none of its added ones: `getUser` for a rename to `fetchUser`, `moment` for a move to another library) mark such a line. An edit that removes a line carrying none of them is rewriting something else and is refused. A change that only added lines took no word away, so its repeats may add lines and remove none. A line that only changes its indentation is not removed.

Then every changed file is written into the scratch copy (which already holds the example as changed) and the check command runs there. When it passes, the files are written into the project as one landing; when it fails, nothing is changed and the output comes back. A target whose edits never pass is named back to the chat's model, which changes that file itself; the others still land. A file that needs no change is reported unchanged.

`undo_hand_off` takes a landing back by its id: a file it changed gets its earlier text, a file it created is removed. A file that no longer holds what the hand-off wrote was changed since; it is left alone and named.

Tests: `tools/test/zero-touch-handoff-start.test.mjs` (the start, the stamp, the settings), `tools/test/zero-touch-handoff-words.test.mjs` (recognition), `tools/test/zero-touch-handoff-chat.test.mjs` (the lines, no workflow from plain words, typed workflows, the model guard), `tools/test/zero-touch-handoff-tools.test.mjs` (the stamp, the refusals, the receipt line), `plugin/mcp/model-dispatch/test/handoffDocument.test.mjs` (the form, the brief, the answer's checks, the ladder, the receipt), `plugin/mcp/model-dispatch/test/handoffScratch.test.mjs` (the scratch copy, a command run in it, the landing record and the undo), `plugin/mcp/model-dispatch/test/handoffTestsAndEdits.test.mjs` (the tests tool and the repeated change, with real commands run in real scratch copies), `plugin/mcp/model-dispatch/test/toolList.test.mjs` (the listing, and a call through the real server).

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

Routing relies on these behaviours of the app: a note the prompt hook adds reaches the model; a `PreToolUse` deny on the `Skill` tool stops a command and the model reads the reason; a message typed while Claude works is recorded in the transcript as a `queued_command`; both plugins' `SessionStart` hooks run for a new chat and after `/clear`, and a start hook's `systemMessage` is shown to the person; a multiple-choice answer reaches `PostToolUse` as `answers[<question>]`; a `Stop` hook's `block` continues the turn with its reason; and `${CLAUDE_PLUGIN_ROOT}` is filled in inside commands, skills and agents (probed on 2.1.283). Hand-off mode also relies on these: a start hook's `additionalContext` reaches the model, at a fresh start and after a compaction; a `PreModelSwitch` deny stops a model switch and the person reads the reason; the start moment or the transcript names the chat's model; a `PreToolUse` hook's `updatedInput` replaces the input of one of the plugin's own server tools; and a `PostToolUse` hook's `systemMessage` is shown after such a tool answered. An update can change any of them silently. After every update, in one new chat with zero-touch on: the start line shows; a clear job message starts its workflow; a second job during it gets the Queue-or-Replace question; and a `/mmo:` command the chat tries by itself is refused with its reason. `tools/test/ambient-routing-hooks.test.mjs` proves the plugin's side; the live chat proves the app's.

## Status

**Hand-off mode (30 Sep 2026), being built on 0.8.4:** the chat's start, its two settings, recognition, the lines, the model pin and the four hand-off tools (`write_document`, `write_tests_from_cases`, `repeat_edit_across_files`, `undo_hand_off`) are built and tested offline. **Not built yet:** the refusal of a new document or test file typed by hand in a hand-off chat; until it is, the start note tells the chat's model that such typing is refused while nothing refuses it. Nothing of hand-off mode has been checked live, and no real model has written anything through it yet.

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
