# Zero-touch — workflows from plain words, and hand-off mode

Zero-touch is the part of the plugin that works while you chat with Claude Code as usual. It is switched by its own plugin, **`zero-touch`**, listed beside `mmo` in the same marketplace: install and enable it and new chats have zero-touch; disable it and new chats have none. Without it no zero-touch hook acts, and the `mmo` plugin runs its `/mmo:` commands and nothing else.

It has two modes, and an Off setting, all chosen in the chat (below):

- **Workflow mode** (Workflows): you type a normal sentence; if it clearly asks for one of the eight `/mmo:` jobs, that job's workflow runs exactly as if you had typed the command, on the models you chose. Every other message is an ordinary Claude Code chat.
- **Hand-off mode** (Hand-off): the chat's own model does the development, and new documents, specs, plans, tests and one change repeated in many files go to the model you chose for that kind of work, and are checked before they reach your project. It has its own section, "Hand-off mode", below; everything before that section describes workflow mode unless it says otherwise.
- **Off**: the plugin stays installed, and Claude works as normal.

(The file keeps its old name, `ambient-mode.md`, so existing links still work.)

## Choosing: the settings box, in the chat

Since 1 Oct 2026 a person sets zero-touch up only in the chat, in Claude Code's own question box (the `AskUserQuestion` tool), never by editing a file or typing a command. It is the one picker a plugin can put in front of a person in the desktop app and the terminal alike: the desktop app has no plugin settings form, and it declines an MCP server's pop-up form (both checked 30 Sep – 1 Oct 2026).

- **The first chat after install** asks before anything else. The start message says so; Claude opens the box; tools that change anything wait until the box has been **shown** (whatever the person then does). The hold lasts about one turn: if the box was never shown by the person's next message typed while the chat is idle (Claude did not open it, or the question tool is not available there), zero-touch gives up in that chat and says so, and the next new chat asks again. A message the transcript does not show yet (possibly typed mid-turn) is not taken as a new turn; after three messages the hold ends anyway, so nothing is held for ever. Settings saved meanwhile in another chat end a waiting first chat's questions and hold at once; that chat carries on without zero-touch, like any open chat, and says so. The answers apply to that chat at once. After choosing Workflows, the person is asked to send their request again, because it arrived before zero-touch could judge it: if it asks for one of the eight jobs, its workflow starts; anything else gets a normal answer.
- **Any later chat, in any mode, Off included:** the person types `change zero-touch settings` (any wording works: Claude understands it and only opens the box; every choice is a click).
- **Always the same order:** the mode question (Workflows / Hand-off / Off); after Workflows, the models question (Opus 5 + Flash 3.8, Opus 5 + Sonnet 5, Opus 5 only: the shipped policies `opus-plus-flash-v38`, `opus-plus-sonnet`, `opus-only-v5`); after Hand-off, four questions in one box: the chat model (Opus 5, recommended, or Sonnet 5), and who writes new documents, specs and plans; new tests; and one change repeated across many files (Flash 3.8, Sonnet 5, or Keep in chat). Off needs nothing more.
- **The choice in force is marked** "(your current choice)". The other mode's choices are kept when the mode changes.
- **All or nothing:** the settings are saved only when the sequence is complete. An answer typed in the box's "Other" line saves nothing and says so. A closed box reaches no hook (probe of 1 Oct 2026), so it is noticed at the person's next message, and only at a message the transcript shows as typed while the chat was idle: a notice Claude Code queues, a message typed while Claude works, or one the transcript does not show yet, never ends a sequence that is half done (`zero-touch/scripts/prompt-kind.mjs`, a copy of mmo's own rule, kept identical by `tools/test/zero-touch-prompt-kind.test.mjs`).
- **What is saved reaches new chats** (a new chat in the desktop app; in the terminal, a restart or `/clear`, which Claude Code gives a new chat id). An open chat keeps what it started with.
- **Enforced, not trusted:** the zero-touch plugin's hooks refuse a zero-touch box that is not exactly the one expected now, with the exact box in the refusal (the probes: Haiku, Sonnet and Opus then all open the exact one). A box counts as a zero-touch box when it names zero-touch AND offers a settings choice (a mode, a model, keeping work in the chat); every other box (Claude's own questions, one that merely mentions zero-touch, a workflow's approval step) is never touched. The rule is lexical, so a question of Claude's own that names zero-touch and offers such a word ("Which zero-touch mode should the README explain first?" with "Workflows first") is still caught; its refusal tells Claude to ask again without the word "zero-touch", so nothing is stuck. Every box a note gives Claude (at a chat's start, after a compaction, after a save, after a closed box) is built by the one rule the check uses (`settings.mjs` `boxCurrent`), so Claude's first try is the right one. A helper agent never opens the settings.

The settings live in the zero-touch plugin's own data folder, `${CLAUDE_PLUGIN_DATA}/settings.json` (Claude Code keeps it across updates and deletes it when the plugin is removed; without that variable, `~/.mmo-ambient/zero-touch/`). Code: `zero-touch/scripts/settings.mjs` (the file), `boxes.mjs` (the boxes, word for word), `settings-hook.mjs` (the hooks around the box), `messages.mjs` (every text the plugin shows). Tests: `tools/test/zero-touch-settings.test.mjs`, `zero-touch-settings-box.test.mjs`.

**The rule for models: the person's pick, or the standard one, nothing else.** A project's own `routing-policy.yaml` and its saved choice in `.sdlc/project.json` are not used by zero-touch (the start message says when the folder has such a file). A `/mmo:` command the person types keeps following them.

## Turn it on and off

| How | Effect |
|---|---|
| Install the `zero-touch` plugin (`/plugin install zero-touch@tilicho-ai-labs` in a terminal chat, or the plugin browser in the desktop app; Claude Code installs and enables `mmo` with it) and leave it enabled | New chats have zero-touch; the first one asks for the settings. |
| Choose Off in the settings box | New chats have no zero-touch work, and say so; the settings box still works in them. |
| Disable it in Claude Code's plugin list (desktop: **+** next to the prompt box → **Plugins** → **Manage plugins**; terminal chat: `/plugin` → **Installed**; shell: `claude plugin disable zero-touch@tilicho-ai-labs`) | New chats have none, and nothing is shown. The `/mmo:` workflows are untouched: they are the `mmo` plugin. Claude Code refuses to disable `mmo` while `zero-touch` needs it (documented for the terminal). |
| `MMO_AMBIENT=on` or `MMO_AMBIENT=observe` in the environment | For one run, without the settings: a developer or a measuring setup. `on` is workflow mode on the person's workflow models; `observe` records the chat's events and starts nothing. |
| `MMO_AMBIENT=off` | Off for this run, plugin or not. |

**The person sees it.** Zero-touch's messages come from its own code, as a hook's `systemMessage`: Claude Code shows it in the chat and does not give it to the model, so it appears every time and the model cannot reword it. The words are the final proposal of 1 Oct 2026, written for someone with no context and no technical knowledge.

- **The start message**, from the zero-touch plugin's start hook (`zero-touch/scripts/start-chat.mjs`): in the desktop app when the first message is sent, in the terminal when Claude opens; again after a compaction or when a chat is reopened (the chat keeps its mode; its first lines may be out of view). It says which mode is on, what to ask for, which models run, what a workflow costs and asks, and how to change it. Extra lines when they apply: the settings could not be read (the standard ones are used), the folder has its own `routing-policy.yaml` (not used by zero-touch), Google is not connected and the models need it (see "Google" below). A chat with no screen (`claude -p`) and no settings yet does nothing and says where to choose.
- **One line after each typed message**, from the prompt hook (`lib/route-flow.mjs` `PERSON_LINE`), always starting with `Zero-touch:`:

| What happened | Line |
|---|---|
| A recognised job starts | `Zero-touch: you asked for a bug fix, so Claude is starting the bug-fix workflow. It will wait for your approval at each main step.` |
| A queued job's turn comes (end of a turn) | `Zero-touch: the bug-fix workflow has finished, so the documentation workflow you queued is starting now.` |
| A workflow has finished (end of a turn; also after it was stopped) | `Zero-touch: the bug-fix workflow has finished. From here, asking for a job in your own words starts a new workflow; anything else gets a normal answer.` In a Hand-off chat (a typed workflow): `… has finished. From here, Claude works in this chat in Hand-off mode again.` |
| A second job while a workflow runs | `Zero-touch: a bug-fix workflow is still running in this chat. In the box, choose whether the documentation workflow you asked for should wait its turn or replace the running one.` Then, after the answer: `queued. …`, `… was stopped, and … is starting now.`, or `nothing new was started; … carries on.` |
| A recognised job that cannot start | `Zero-touch: the bug-fix workflow didn't start, because …` with the real cause and what to do: another chat in this folder is running a workflow; Google is not connected; part of zero-touch is not set up (the model server is not built); the start-up check failed (its own words). |
| A message while a gate is open | `Zero-touch: the workflow is waiting for your approval, so this message is taken as your answer to it, not as a new request.` (before the workflow has logged its run: `the workflow asked you a question, …`) |
| Any other message while a workflow runs | `Zero-touch: this isn't a new job, so the running bug-fix workflow carries on, taking your message into account.` |
| Any other message | `Zero-touch: this isn't one of the jobs that get a full workflow, so Claude answers it normally.` |

Nothing is shown for a message nobody typed (a machine notice), for a typed `/mmo:` command (the person named the workflow; only the Queue-or-Replace line can follow it), for a message sent while Claude is still working (it joins the running task), under `MMO_AMBIENT=off` or `observe`, or in a chat without zero-touch.

**Google.** The workflow models "Opus 5 + Flash 3.8" and a hand-off typist "Flash 3.8" need Google. Whether this computer is connected is answered by mmo's own rule (`plugin/scripts/verify-setup.mjs`, which zero-touch carries a copy of in `zero-touch/scripts/google.mjs`; `tools/test/zero-touch-google.test.mjs` proves the two agree): an API key (`GEMINI_API_KEY`), or a Google login file that is readable and complete (the one `gcloud auth application-default login` writes, or `GOOGLE_APPLICATION_CREDENTIALS`); a project name alone is not a login; a configured file that cannot be used is "broken". It is checked offline at every chat's start, before zero-touch starts a workflow, and when Flash is chosen in the settings box; at that moment one real request is made too (`gcloud auth application-default print-access-token`, at most 3 seconds), so an expired login is said at once. Its line says what will happen: with no login, workflows won't start (the start refuses); with a login Google refused, workflows still start (the offline check passes, and a workflow's start-up check builds the model's connection without calling it), so the line says their Flash 3.8 steps can't run and they may stop or use a more expensive model for them. In hand-off mode the same rule is asked at every use, never kept (`lib/handoff.mjs`): while Google is not connected, a kind of work set to Flash 3.8 is done by the chat's own model. The line after the message says so, its tool is refused before it reaches the server, and a new file of that kind may be typed by hand; other kinds are handed off as usual, and connecting Google mid-chat counts from the next message. A login that stops working later is reported at the first real call, where the workflow's pre-flight or the hand-off receipt says so (a hand-off's last attempt is the chat's own model).

**Each chat is decided once, when it starts** (`plugin/scripts/ambient/lib/chat-mode.mjs`). At the chat's start moment (`SessionStart` with source `startup`, `clear` or `fork`, each a new chat id) the zero-touch plugin's start hook writes the chat's marks (`zero-touch/scripts/mark.mjs`): its record `sessions/<id>/chat_mode` and its models. Every moment of that chat acts on them, so a change of settings or plugin state reaches new chats only: a chat with no record is off (it started while the plugin was disabled, or before it was installed, or in Off), and a reopened chat (`resume`) and a compaction keep what they have. Claude Code applies a plugin enable or disable to new sessions, and to an open one only on `/reload-plugins`; a plugin loaded that way into an open chat finds no record there and does nothing.

**Why the zero-touch plugin holds none of mmo's code.** Claude Code gives each plugin its own copy of any file it links to at install, so a zero-touch plugin carrying `mmo`'s code would need a second copy of it on every machine. All of zero-touch's workflow and hand-off code stays in `mmo`; `zero-touch` depends on `mmo`, keeps the settings and marks chats. Where it needs one of mmo's rules (the chat-record paths, the Google check) it carries a copy, and a test proves the copy equal.

**The two start hooks run at once.** Claude Code runs both plugins' `SessionStart` hooks at the same moment, so `mmo`'s can run before the record exists (seen live on 29 Sep 2026: the chat's start was logged `late`). `mmo`'s start work (its log line and the old-records sweep) then runs at the chat's first moment that has the record.

Without a record (and without `MMO_AMBIENT`), the shell shim in front of every mmo zero-touch hook (`plugin/hooks/ambient.sh`) exits before `node` even starts: it reads the chat id from the start of the hook input, and an id it cannot read with certainty goes on to `node`, which decides. The zero-touch plugin's own settings hooks (`zero-touch/hooks/settings.sh`) do the same for every tool call and message, and start `node` only in a chat that waits for its first settings or has a settings box open. Tests: `tools/test/zero-touch-plugin.test.mjs`, `tools/test/ambient-chat-decision.test.mjs`.

## The fourteen hooks

mmo's zero-touch hooks are all in `plugin/hooks/hooks.json`, all through the POSIX shim with a 5-second timeout, all exit 0 (a decision travels as JSON on stdout, never as an exit code), all handled by `plugin/scripts/ambient/hook.mjs`:

| Hook | Moment | Does |
|---|---|---|
| `session-start` | `SessionStart` | The chat's log line and the once-a-day sweep of old records. |
| `prompt` | `UserPromptSubmit` | Reads the message with fixed rules ($0, no model). A recognised job gets the instruction to start its workflow, with the person's models in its arguments; a typed `/mmo:` workflow command makes the chat that workflow's run; a new job while a workflow runs gets the Queue-or-Replace question; any other message gets nothing. |
| `pre-skill` | `PreToolUse` on `Skill` | Guard B: a `/mmo:` workflow starts only when routing recognised the message, the person typed it, or the queue or a replace starts it; the chat starting a second one mid-run is held for the question. |
| `pre-any` | `PreToolUse` on every tool | Guard A: while a recognised job waits for its workflow to start, while the question waits for its answer, and while "Queue it" holds a typed command's steps, tools that change something wait. It claims the chat's run: the run id in the orchestrator's own logging calls (`mmo-log.mjs` / `write-provenance.mjs --run-id=…`) is this chat's run, so stopping a run never guesses. In a run zero-touch started, the run-start check's command gets the person's policy file, as the model-server calls do, but only when it is one plain `node …/driver-model-check.mjs …` call that names no file yet (`lib/run-check.mjs`); any other command (two calls, a pipe, `sed` or `grep` on the script) is left exactly as written. In a hand-off chat it also carries the safety net: a new document or test file typed by hand is refused, unless the person keeps that kind of work in the chat or it cannot be handed off (Google not connected). |
| `pre-dispatch` | `PreToolUse` on `load_policy`, `preflight_dispatch`, `execute_with_model`, `simulate_policy` | Inside a workflow zero-touch started: stamps the call with the person's policy as an explicit file (`policy_path`), which the server and the run-start check put ahead of everything, a project's `routing-policy.yaml` included. Helpers' calls too. A workflow the person typed is left to its own rules. (`execute_stage` takes no policy: it reuses the one pre-flight recorded.) |
| `post-skill` | `PostToolUse` on `Skill` | Confirms a routed workflow's start once its command ran. |
| `post-question` | `PostToolUse` on `AskUserQuestion` | Reads the person's answer to the Queue-or-Replace question, acts on it, and shows them what happened. |
| `pre-agent` | `PreToolUse` on `Agent` / `Task` | The five mmo agents run only inside a workflow, and not while the question waits; the chat hiring one by itself is refused. |
| `turn-end` | `Stop` | Ends a queued typed command's hold; once the chat's workflow has ended, says so, and continues the turn with the first queued job. |
| `session-end` | `SessionEnd`, reason `clear` | `/clear` gives the conversation a new chat id, and Claude Code ends the old one first (read in Claude Code's own code, 1 Oct 2026). A workflow abandoned that way is recorded as stopped (as "Replace it" stops one), only if the chat has claimed its run (never a run found by time, which may be another chat's), and its project is freed either way. Before, it held the project forever, and every later workflow there was refused. Other endings keep it: that chat can be reopened and carry on. |
| `pre-model-switch` | `PreModelSwitch` | Hand-off mode only: refuses a switch away from the chat's model. Answers nothing in a workflow-mode chat. |
| `post-model-switch` | `PostModelSwitch` | Hand-off mode only: keeps the model the chat is on now, so each line names the model really in use. Decides nothing. |
| `pre-handoff` | `PreToolUse` on the hand-off tools | In a hand-off chat: stamps the call with the chat, the project folder and who pays, after making sure the chat's models are resolved; refuses a call for work the person keeps in the chat. In a workflow-mode chat and inside a workflow run: refuses the call with the reason. |
| `post-handoff` | `PostToolUse` on the hand-off tools | Shows the person one line written from the tool's receipt. Decides nothing, adds nothing for the model. |

In a hand-off chat the same `prompt` hook recognises hand-off work instead of workflow jobs, and `pre-skill` lets a workflow start only from a typed command ("Hand-off mode" below).

**The zero-touch plugin's own hooks** (`zero-touch/hooks/hooks.json`): `SessionStart` (the chat's marks and start message), and around the settings box `UserPromptSubmit`, `PreToolUse` on `AskUserQuestion` and on every tool, `PostToolUse` on `AskUserQuestion` (all through `hooks/settings.sh`; see "Choosing" above). They run in every chat, Off included, which is what lets the settings be changed from any chat.

The pipeline's own hooks (the write contract, the foreground-helpers guard, telemetry, the executor guard) are not zero-touch's and keep their own settings, with no short timeout: Claude Code lets a tool call through when its guard hook times out.

## What is stored, and where

Everything lives under `~/.mmo-ambient/` (override with `MMO_HOME`), directories `0700`, files `0600`, nothing inside your repository, except the person's settings, which the zero-touch plugin keeps in its own data folder.

| Path | Holds |
|---|---|
| `${CLAUDE_PLUGIN_DATA}/settings.json` (zero-touch's data folder) | The person's settings from the box: `mode`, `workflows.models`, `handoff.{chat_model, documents, tests, repeats}`. Only the fixed choices are ever stored; written whole, atomically. Deleted by Claude Code when the plugin is removed. |
| `sessions/<id>/chat_mode` | The chat's mode, written once at its start by the zero-touch plugin (or by `MMO_AMBIENT`): "on" (workflow mode), "b" (hand-off mode) or "observe"; no file means off. |
| `sessions/<id>/workflow.json` | Workflow mode: the chat's models, `{policy}` (the person's pick), written once at its start. A chat marked before 1 Oct 2026 has none and runs on the standard pick. |
| `sessions/<id>/zt_off` | An Off chat (so a compaction can show its message again). |
| `sessions/<id>/zt_setup.json` | The first chat after install, until its settings are saved: `{asked}` (whether the box has been shown). |
| `sessions/<id>/zt_flow.json` | A settings box sequence in progress: `{pending, shown, first}`. |
| `sessions/<id>/handoff.json` | Hand-off mode: the chat's stamp, written once at its start: the model it is kept on (`chat_model`, and `pin`: setting or admin), and who types each kind (`typists.documents / tests / repeats`: `{typist, policy}`, typist flash / sonnet / chat). |
| `sessions/<id>/handoff_models.json` | Hand-off mode: per kind, the model and the shipped policy that route it, or `{kept: true}`, asked of the workflows' router once per chat. |
| `sessions/<id>/model_now` | Hand-off mode: the model Claude Code last said the chat is on (at its start, at a model switch). |
| `sessions/<id>/handoff-telemetry.jsonl` | Hand-off mode: the chat's hand-off bill, one line per typist call (failed ones included), in the shape of a workflow's telemetry. Written by the server. |
| `sessions/<id>/handoff_released.json` | Hand-off mode: the files a failed hand-off handed back, which the chat's model may write by hand. Written by the server. |
| `sessions/<id>/handoff_landings.json` | Hand-off mode: every hand-off that changed the project, in order, each with its id (`h1`, `h2`, …), its tool and its files (whether each existed before, and a hash of what was written). Written by the server. |
| `sessions/<id>/handoff_undo/<id>/<n>` | Hand-off mode: the earlier text of a landing's n-th file, for the undo. |
| `sessions/<id>/events.jsonl` | One record per event: the chat's start, each prompt's length, each route decision and why, each refusal, each stamped call. |
| `sessions/<id>/started` | The chat's start work has run (at its start, or late at its first moment with a record). |
| `sessions/<id>/route.json` | The job the rules recognised in the latest message (or the queue or a replace started): `pending` until its workflow starts, then `started`. |
| `sessions/<id>/pipeline` | The chat is running a `/mmo:` workflow, typed or started by routing: `{since, job, args}`, plus `policy` for a run zero-touch started (what `pre-dispatch` stamps; never for a command the person typed, queued or not), plus `run_id` once the chat has claimed its run. Dropped when the workflow's own log shows it ended (see "Starting the workflow"), when it is replaced, or when `/clear` ends the chat. |
| `sessions/<id>/choice.json` | The Queue-or-Replace question waiting for its answer: the new job, how it came (words, typed, the chat's own start), the running job, the exact question. It belongs to the message that raised it. |
| `sessions/<id>/queue.json` | The chat's queued jobs, first in first out. |
| `sessions/<id>/hold` | "Queue it" was chosen for a typed command: its steps may not run until the turn ends. |
| `sessions/<id>/typed.json` | The plugin command typed in the latest message, so its own Skill call (in modes where a typed command makes one) passes Guard B. |
| `projects/<key>/workflow.json` | The project's lock: the chat running a workflow in that project (`key` is a hash of the project's real path). |
| `sessions/<id>/failures.log` | A hook that failed; three failures in one chat switch zero-touch off for the rest of that chat. |
| `ambient.json` | mmo's own settings (below): not the person's zero-touch choices. |

No prompt text is stored, ever. The event writer drops fields named `prompt`, `content`, `stdout` and `stderr` and caps every string. Session folders older than `retention_days` (default 30) are removed once a day.

**Left behind by builds before this release** (they ran on the author's machines only) and no longer read: `~/.mmo-ambient/mode` (the mode file, until 1 Oct 2026), `sessions/<id>/arm.json`, `note_sent`, `off_thinker`, `last_label`, `git_baseline`, and at the top `jobs/`, `locks/`, `verify/`, `consent/`, `evidence.json`, `measured.json`, `receipts.json`, `board-token`, `repos/`, `logs/`. Old session folders age out with the sweep (`logs/` too); the rest can be moved to the Trash by hand.

## Settings and who may change them

The person's zero-touch choices are made in the settings box (above), not here. What remains is mmo's own, in layers, weakest first: shipped defaults (`plugin/config/ambient.default.json`), then `~/.mmo-ambient/ambient.json`, then `<project>/.sdlc/ambient.json`, then `MMO_AMBIENT`. None of the files switches zero-touch on or off, or chooses its models.

| Setting | Values | Default |
|---|---|---|
| `routing` | on / off | on. Off: no workflow is ever started from chat, and the chat may not start one by itself |
| `routing_defaults` | `{auth}` | `estimated`: the cost recording a routed workflow starts with (it travels in the start arguments). It also says how a hand-off's Claude typist is paid for |
| `retention_days` | a whole number of days | 30 |

A project file is anyone's input: anyone who can land a commit can edit it. It may only switch `routing` off, never on, and nothing else. (Keeping zero-touch out of one project entirely is Claude Code's own job: disable the zero-touch plugin at project scope.) A value of the wrong type is ignored; an unknown `routing` value means off. A key the plugin does not know is ignored, so a settings file written for an earlier build still reads: a `handoff` block or a `routing_defaults.policy` in it is ignored since 1 Oct 2026.

## Routing a recognised task to its workflow

With zero-touch on, an ordinary chat message that asks for one of the eight `/mmo:` jobs runs that job's workflow exactly as typing the command would. The jobs are greenfield, docs, bugfix, feature-extend, feature-new, refactor, test and deps. Every other message is an ordinary chat.

**What the person sees.** Nothing in zero-touch's own words names the plugin, a command or a model:
- **A clear request** ("fix the /login endpoint returning 500"): one plain line, "Running this as a full bug-fix workflow.", then the workflow's own steps and approvals. Three of the workflow's own setup questions are answered instead of asked: the models (the person's pick in the settings box, carried in the start tag), the cost-recording mode (`routing_defaults.auth`, in the same tag), and, for a new app, the brief (the person's message is the brief, written in the Project Brief layout). Every phase, gate and approval is the workflow's own.
- **An unclear request** (typos, casual wording, anything the rules do not recognise): an ordinary chat. No question is asked and no workflow starts on the chat model's guess (a project decision, 26 Sep 2026); the person can still type the command.
- **Anything else:** an ordinary chat.

Nothing has to be set in a file first: the first chat after install asks for the settings in the box. A workflow's helpers name their model in the plugin's own agent files, so switching the chat to another model does not move them.

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
  - text in the message: "the code below", "the error above", "described below", "the following", "the attached log". "below" and "above" count as pointers only when they close the noun they follow; followed by an amount or a determiner they are a comparison and part of the bug ("…can go below zero", "quantities above 99", "prices above the limit"). What may follow a comparison is a closed class of English words (numbers and determiners), so this is a grammar rule, not a list of cases. Replayed over all 7,692 distinct messages typed on the author's machine (361 with one of the two words in the request line): no answer changed;
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

### Starting the workflow (`hook.mjs`, `lib/route-flow.mjs`)

Every workflow start, typed or model-started, reaches the hooks as a `PreToolUse` on the `Skill` tool. This was probed live on Claude Code 2.1.282. A typed `/mmo:bugfix`, or `/bugfix` where Claude Code allows the plugin's command without its prefix, makes the chat a workflow run before any tool runs. Only the ten workflow commands do (`greenfield`, `brownfield` and its seven per-job commands, `pass`): a typed one-off command (`/mmo:setup`, `/mmo:policy`, `/mmo:revert`) writes no run log, so nothing could ever end its run, and it leaves the chat as it was.

1. **Like typing the command, whenever the chat is idle** (29 Sep 2026). A job message starts its workflow at any point in a chat, as often as the person asks, one workflow at a time. Nothing is routed:
   - **while a workflow is running in the chat** (then a new job gets the Queue-or-Replace question, below). Running means from the moment the chat starts it (typed or routed) until the workflow's own log (`<project>/.sdlc/runs/<run-id>/orchestrator.log`, written through `mmo-log.mjs`) shows it ended: every gate it opened answered after its `run.end`, an answer of `abort` at any gate, or a `run.end` that says aborted or failed. The run is the one the chat claimed (the run id in its orchestrator's own logging calls, seen by `pre-any`); until then, the latest one whose `run.start` is not earlier than the chat's start of the workflow (`lib/workflow-log.mjs`). A run in the same folder that another chat started later (a chat without zero-touch takes no project lock) is therefore never taken for this chat's once it has claimed its own. A workflow with no logged run yet (stopped at its first questions, or still asking them) keeps the chat, so an answer to one of its questions is never taken for a new job. Once it has ended, the next message is judged afresh: a job starts its own workflow (or the first queued one starts by itself), anything else is an ordinary message;
   - **for a message typed while Claude is still working, when no workflow runs.** Claude Code records such a message in the transcript as a `queued_command` and delivers it into the running task; an ordinary message is a plain user entry (seen live on Claude Code 2.1.284). The prompt hook reads the newest transcript entry carrying the message (`lib/transcript.mjs`, `sentWhileWorking`); a queued one joins the running task, never starts a workflow and never ends a start that task has pending (logged as `route.none` with the reason "sent while Claude was working");
   - **for a notice nobody typed** (a background command's completion notice, which Claude Code delivers through the same hook, tagged): logged as a prompt nobody typed, never judged.
   Work the chat has already done does not hold a job back, exactly as it would not stop the person from typing the command.
2. **A clear route.** The prompt hook tells the chat which workflow to start (the Skill call, and its arguments: the tag `[zero-touch policy=<name> auth=<vendor|estimated>]` with the person's models and the cost recording, then the person's own words for the job), and the plain line to say. The workflow commands read the tag as this run's choice, which wins over the project's saved choice and over a repo-local `routing-policy.yaml`, as `/mmo:pass --policy` does (`plugin/commands/greenfield.md`, the existing-project guide's Gate 0, and the seven job commands). It is a tag and not flags on purpose: a person typing a command gets exactly the surface they had. A route belongs to its prompt, and the next prompt drops it.
3. **Guard A** (one catch-all `PreToolUse` hook, `pre-any`). Until that Skill call, only tools that change nothing run (Read, Glob, Grep, ToolSearch, TodoWrite, the web tools, Skill). Everything else waits with "Start the workflow first", including every other MCP server's tools and helpers already running.
4. **Guard B** (`pre-skill`), for a `mmo:` Skill call (a leading `/` is the same command):
   - **Allowed:** a command the person typed (its own Skill call, in modes where a typed command makes one), the routed workflow, and a queued or replacing one the hook itself started; while a workflow runs, any of the plugin's non-workflow skills (its manual) and one-off commands.
   - **Refused:** a helper agent starting the chat's workflow, a one-off command (setup, policy, revert) or workflow the chat starts by itself outside a workflow run, a second workflow beside the routed one, and one the folder rule forbids.
   - **Held for the question:** the chat starting a second workflow by itself while one runs.
   - **A start the chat makes by itself** (no route from the rules): always refused with "Full workflows start only when the plugin recognises the request or the person types the command. Carry on with your own tools."
5. **Starting.**
   - A route made by the prompt hook was already checked there, so the chat is marked a workflow run first, with the person's policy on its record. Nothing is written into the project (since 1 Oct 2026; before, the policy was saved into `.sdlc/project.json`): the models travel in the start arguments, and `pre-dispatch` stamps them on every model-server call of the run.
   - The after-hook (`post-skill`) marks the start too, so a start hook that timed out cannot leave the workflow blocked.
6. **When a workflow cannot start,** nothing starts and the chat tells the person the real cause, with the fix for that cause:

   | Cause | Fix offered |
   |---|---|
   | The person's models use Flash and this computer has no Google login (mmo's own rule, "Google" above) | Connect Google (Claude can walk them through `gcloud auth application-default login`), or choose models without Flash in the settings box |
   | The model server is not built (the only case called "not set up") | `verify-setup.mjs --fix` |
   | The policy's judgment model is not the one the helpers' agent files name | Choose other models in the settings box (none of the three offered has this) |
   | Anything else the workflow's own model check refuses (the rare `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` switch, or agent files that do not name one model) | The check's own reason, passed on. Until 1 Oct 2026 every failure of the check's first step was wrongly called "not fully installed" |
   | Another chat in this project is running a workflow (the project lock) | Finish it in that chat, or type /clear there, then ask again |

   The check is asked with the person's policy as an explicit file (`--policy-path`), so a project's own `routing-policy.yaml` decides nothing here either. Under `vendor` the helpers'-model check is skipped, as the workflow itself skips it. A project's saved choice, or a saved file that does not read, no longer blocks a start: zero-touch does not read it.
7. **Around it:** `/clear` starts a fresh conversation under a new chat id: an earlier workflow run, route, question and queue no longer count, and a workflow `/clear` abandons is recorded as stopped (its claimed run only) and frees its project (`session-end`). A start zero-touch still has pending ends at the person's next message, typed command or plain words: a typed command never takes over such a start, so a run the person types never carries zero-touch's models. Three failures of zero-touch's hooks in one chat switch it off for the rest of that chat.

Tests: `tools/test/ambient-route.test.mjs` (recognition) and `tools/test/ambient-routing-hooks.test.mjs` (the start, end to end through the shell shim); `tools/test/zero-touch-lines.test.mjs` (the line after each message); `tools/test/zero-touch-routing-stamp.test.mjs` (the stamped policy, `/clear` freeing a project, the Queue-or-Replace lines); `tools/test/zero-touch-workflow-tag.test.mjs` (the tag, on both sides); `tools/test/zero-touch-plugin.test.mjs` (the start message, the settings deciding the chat, the repeat after a compaction).

### A second job while a workflow runs (`lib/queue.mjs`)

Zero-touch chats only; a chat without zero-touch keeps mmo's own behaviour. Why: on 29 Sep 2026 a chat typed `/mmo:bugfix`, then `/mmo:docs` while the bug fix ran; docs started and the bug fix was dropped without a word.

**When it asks.** While this chat runs a workflow, a new job is held and the person is asked, in plain words, "Queue it" or "Replace it", when it comes as:
- **plain words** the rules recognise as a job, unless the workflow is waiting for an answer: then the message is that answer, never a new job (one of its gates is open, or it has not logged its run yet and is still asking its first questions);
- **a typed `/mmo:` workflow command** (a typed command is never a gate's answer). Its text stays with the model, which is told to ask first;
- **the chat starting a workflow by itself** (Guard B refuses the start, with the question as the reason).

The model is told the exact question and the two labels and must ask with Claude Code's multiple-choice tool (`AskUserQuestion`); if the running workflow is waiting for its own answer, both questions may go in the same call. Until the person answers, nothing that changes anything runs (Guard A), the workflow's helpers included. The answer reaches the hook as `tool_response.answers[<question>] = <label>` (read from real transcripts, 29 Sep), so the hook acts on the exact label, never on a guess (`post-question`). A person who types the answer instead is understood only when the message is one of the two labels; any other message drops the question, so nothing stays blocked.

**Queue it.** The job joins the chat's queue, first in first out; the same job (same command, same description) is not added twice. A command the person typed is queued as typed (also when the same job was already queued from their words: their typing wins) and starts exactly as typed, with its own questions and rules: no zero-touch models, no zero-touch start checks, nothing stamped; only a job zero-touch recognised starts with the person's zero-touch models. After a typed command, whose text the model still holds, nothing that changes anything runs until that turn ends (the hold). At the end of the turn in which the running workflow's own log shows it ended, the turn continues with the first queued job (the `Stop` hook's `block` reason tells the model to start it with the Skill tool, one plain line first); Guard A holds everything else until it starts. A start the model does not make is not pushed again in the same turn (`stop_hook_active`): the job stays queued for the next turn's end. The queue ends with the chat or `/clear`.

**Replace it.** The running workflow is stopped the way its own abort stops it (`lib/workflow-log.mjs` `abortRun`): the chat's claimed run, or, when the chat has no claim (a run id the model left as a shell variable), the run found by time, as before 1 Oct 2026, unless another chat has claimed that one: its run log records `run.end outcome=aborted reason=replaced`, in the format `mmo-log.mjs` writes, and a brownfield write lock (`.sdlc/local/write-contract.json`) that belongs to that run is switched off, as the brownfield manual's abort step does; the run folder is kept. Then the new workflow starts: a typed command carries on as the chat's workflow; any other is routed like a recognised job.

**One workflow at a time in one project** (`lib/project-lock.mjs`). Two chats running workflows in one folder would write into the same `.sdlc/runs/` and read each other's run. A zero-touch chat that starts a workflow takes the project's lock (`projects/<key>/workflow.json` under `MMO_HOME`); a second chat's recognised job gets the cause "busy" (below), and its typed workflow command is kept from the model (the prompt hook blocks it; the person sees why). Whether a lock holds is decided from facts each time, never from its age: the owning chat must still have its workflow record and that workflow's own log must not show it ended; a lock that fails either test is replaced. The busy cause is in the table of step 6.

**Facts it rests on**, probed on Claude Code 2.1.283 on 29 Sep through the desktop app's own transport (stream-json; `Zero-touch-harness-tasks-ask/ask-2-routing/probes-step3/`): a `/command` sent while Claude works waits and runs as its own turn after the running one; plain words sent while Claude works join the running turn at its next step; a `UserPromptSubmit` block keeps a typed command from the model and shows the person the reason; the prompt hook of a typed command sees the typed line, with the same `prompt_id` as its expansion. A command typed with "Send now" interrupts the running turn on purpose: the question is then asked at once, and "Queue it" leaves the interrupted workflow to be resumed by the person.

Tests: `tools/test/zero-touch-queue.test.mjs`.

## Hand-off mode

Workflow mode runs a whole gated workflow for a job. Hand-off mode is for ordinary development in the chat: **the chat's own model does the work** (reading, deciding, new code, bug fixes, refactors, reviews), and only work that is mostly typing AND has a check code can run on the result goes to the model the person chose for it. Choose Hand-off in the settings box ("Choosing" above) and start a new chat.

| Kind | What it covers | The box's question | Typed by |
|---|---|---|---|
| docs | a new document of the project: a README, a guide, an API reference, a changelog | Documents | the chosen typist's policy, its `docs` stage |
| spec | a new spec: requirements, a design document, an API spec, a data-model write-up | Documents | the same |
| plan | planning text: a plan, a task breakdown or tickets, a status report, release notes | Documents | the same |
| tests | new tests for code that exists | Tests | the chosen typist's policy, its `tests` stage |
| repeat | the same change repeated across files (the chat's model makes it once) | Repeats | the chosen typist's policy, its `codegen` stage |

For each of the three questions the person picks **Flash 3.8** (the shipped policy `opus-plus-flash-v38`), **Sonnet 5** (`opus-plus-sonnet`), or **Keep in chat**: that kind is not handed off at all, and the chat's model does it with its own tools.

New code, a bug fix and a refactor are never handed off: a wrong answer there is hard to spot. **Plain words start no workflow in a hand-off chat**; a workflow starts only when the person types its command, and then runs as in any chat.

### The chat's start (`zero-touch/scripts/start-chat.mjs`, `mark.mjs`)

The start hook reads the person's settings **once** and stamps them on the chat (`sessions/<id>/handoff.json`): the chat model, and who types each kind of work, each with the shipped policy that routes it. Everything later reads the stamp, never the settings: a setting changed in the middle of a chat would leave its start message, its model guard and its hand-offs disagreeing, and would split one chat's costs across two sets of models. A change reaches the next new chat (or `/clear`, a new chat id).

| The box's question | Controls | Standard |
|---|---|---|
| Chat model | the model a hand-off chat is kept on: it does the development, decides what to hand off, and makes the last attempt when the typist fails twice | Opus 5 (`claude-opus-5`) |
| Documents / Tests / Repeats | who types that kind of work: Flash 3.8, Sonnet 5, or Keep in chat | Flash 3.8 |

**An organisation's pinned model** (managed settings `model`) outranks the person's chat model; written as an alias it cannot be compared with a model id, so the plugin then pins nothing and the organisation's setting is what holds the chat (and the typist's own policy then gives the last attempt, as before). **A project's own `routing-policy.yaml` is not used by zero-touch** (since 1 Oct 2026; the start message says when the folder has one).

The person sees the start message: Hand-off mode is on; who does what, kind by kind; that a failed hand-off is retried by the chat's model and then done in the chat; that anything a hand-off adds can be undone; which model the chat is kept on and whether it is on it; that plain words start no full workflow; how to change it. The chat's model gets the hand-off rules (the hook's `additionalContext`), built from the settings: work kept in the chat is listed as its own, and that kind's tool is not named. A compaction drops the rules from what the model reads, so the message and the rules are both given again after a compaction and when a chat is reopened, from the stamp. A chat stamped before 1 Oct 2026 (one policy for every kind) reads as that policy for every kind.

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
| A new document, spec or plan | `Zero-touch: Opus 5 will collect the facts and give Flash 3.8 instructions to write the new document. It's checked automatically before it's added to your project.` |
| New tests | `Zero-touch: Opus 5 will decide what to test, and Flash 3.8 will write the tests. They're run in a test copy of your project first, and only added if they pass.` |
| A repeated change | `Zero-touch: Opus 5 will make the change in one file, and Flash 3.8 will repeat it in the others. If your project has an automatic check (such as its tests), it's run on a test copy first, and nothing is changed unless it passes.` |
| A kind the person keeps in the chat | `Zero-touch: new tests are set to stay in this chat (your setting), so Opus 5 writes them directly.` |
| Work set to Flash 3.8, and this computer is not connected to Google | `Zero-touch: this can't be handed off right now, because this computer isn't connected to Google. So Opus 5 does it directly.` When other work in the same message is handed off: `the new document can't be handed off right now, because this computer isn't connected to Google, so Opus 5 writes it directly.` beside the usual sentence for the rest. (How to connect Google is in the start message.) |
| Hand-off work beside other work | the line above, then `Opus 5 does the rest directly.` |
| Anything else | `Zero-touch: this isn't the kind of work zero-touch hands off (new documents, specs, plans, tests, or one change repeated in many files), so Opus 5 does it directly.` |
| Hand-off work that cannot run | `Zero-touch: this can't be handed off right now, because <why>. So Opus 5 does it directly.` |
| Tests or a repeated change in a project not set up with git (after the call) | `Zero-touch: this can't be handed off here, because the test copy it needs only works in a project set up with git. So Opus 5 does it directly. (New documents can still be handed off.)` (the last sentence only when documents hand off; the server's receipt carries `cause: "no-git"`) |
| While a typed workflow runs | workflow mode's own lines (the open gate's answer; the running workflow carries on) |

The names are never guessed. **The hand-off model** is the one the chosen typist's policy gives that kind of work, asked of the workflows' own router once per chat (`plugin/scripts/handoff-models.mjs`, the same routing code the server uses) and kept for the chat. **The chat's model** is the one the chat is on now: what Claude Code last reported (the start moment, a model switch) or, when newer, the model the chat's transcript shows it last answered with; when nothing says, the line says "the chat's model". The chat's model also gets a reminder naming the tool for each recognised kind it should hand off, and, for a kind kept in the chat, that it does it itself.

### The safety net: a new document or test file is not typed by hand (`lib/handoff-net.mjs`)

Being told to hand work off is not enough. A model that types the file itself has done the expensive typing, and nothing checked the result. So in a hand-off chat the hook refuses such a write and names the tool that takes it, with its form's fields, so the next call is the right one. It rides on the catch-all `pre-any` hook, so no extra hook runs in any chat.

What is refused is narrow on purpose:

| | Refused | Left alone |
|---|---|---|
| Which file | one that does not exist yet | any file that exists: a change to it is the chat model's own edit |
| Where | inside the project | outside it; any folder whose name starts with a dot (a tool's own); an agent's instruction file (`CLAUDE.md`, `AGENTS.md`, …) |
| What kind | a document by its file type (`.md`, `.mdx`, `.rst`, `.adoc`); a test file by its name (`cart.test.js`, `test_cart.py`, `cart_test.go`, `CartTest.java`, a code file under `__tests__/`) | code, configuration, fixtures and helpers beside the tests; a spec kept as YAML or JSON, which cannot be told from configuration |
| How it is written | the Write tool; a shell redirect (`>`, `>>`, `>|`, `&>`) or `tee`, with every `cd` before it followed | a here-document's text and anything inside quotes (never read as a redirect); a path the command computes (a variable, a substitution); a file a program writes (a script, `cp`, `mv`) |

The shell is covered because a model in an auto-approving permission mode usually writes through it. The last row's right-hand side is the net's known limit: those writes are not seen.

It stands down when handing off is not possible or not wanted: a kind the person keeps in the chat, a file a failed hand-off handed back (`handoff_released.json`), a hand-off that cannot run here (the policy cannot be read, the server is not built), a kind set to Flash 3.8 while this computer is not connected to Google, a chat that is running a workflow (which has its own rules for what is written), and any chat in workflow mode. A helper the chat started is held to the same rule as the chat.

The person sees `Zero-touch: Opus 5 started writing the new document docs/setup.md itself. In Hand-off mode that work goes to Flash 3.8, so zero-touch stopped it and told Opus 5 to hand it off.` (or `the new test file`).

### The chat stays on its model

Hand-off mode keeps the chat on the chat model the person chose, because the chat's own model does the development and decides the hand-offs: which model that is decides the quality and the cost of everything that is not handed off. (Workflow mode never pins the chat: its thinking helpers name their model in their own agent files.) A plugin cannot set a chat's model, so:

- the start message asks the person to switch with the model menu next to the message box (in the terminal, `/model <chat model>`) when the chat is on another model, or may be;
- a switch to another model is refused (`PreModelSwitch`, Claude Code 2.1.251 and later), and the person reads why and that "change zero-touch settings" changes the chat model for new chats. A switch to the chat model always passes, and a switch whose target the hook cannot read is never refused: a guard that misreads its input must not lock anyone out of their model picker;
- while the chat is on another model anyway, every line adds `This chat is on <model>, not <chat model>: switch it using the model menu next to the message box (in the terminal, type /model <chat model>).`

### A hand-off, step by step

The hand-off tools are the `mmo` server's (`plugin/mcp/model-dispatch/src/handoff/`). The server lists them in every chat, because it cannot know a chat's mode when its tools are listed; a call works only in a hand-off chat.

1. **The chat's model fills in the tool's form and makes one call.** The form is a brief, never the finished text. (For a repeated change it first makes the change itself, in one file.)
2. **The hook stamps the call** (`pre-handoff`): the chat's id, the project folder and who pays for a Claude typist. The server takes nothing else about the chat from the call: the policy and the model for this kind of work are read from the chat's own records, so nothing the model writes in a call can choose them. A call with no stamp, or whose chat is not a hand-off chat, is refused, and so is a call for work the person keeps in the chat (the hook refuses it first, the server again). So is a call inside a workflow run.
3. **Code checks the form** before anything is sent. Every problem is listed at once, by field.
4. **The typist writes.** The ladder is the executor's: two attempts by the model the person chose for this work (the second with the reason the first was refused), then one by **the chat's own model** (the person's chat model, or the organisation's; since 1 Oct 2026, so no model the person did not choose works on their project; before, the policy's Claude model). A chat with no one chat model (an organisation's alias) keeps the policy's Claude model for it. A vendor or network failure waits and is not an attempt. A refused login (HTTP 401 or 403) skips that model's second attempt. Every call is billed and logged, failed ones included.
5. **Code checks the answer**, and only a checked answer reaches the project. Tests and a repeated change are also run, in a scratch copy of the project (below).
6. **The receipt** goes to the chat's model (status, who wrote it, attempts, cost, what was checked, what to do next), and the person sees one line (`post-handoff`):

| Outcome | Line |
|---|---|
| A file written by the chosen typist | `Zero-touch: docs/setup.md was written by Flash 3.8 and checked automatically. Cost: $0.0041. To undo it, ask Claude to undo hand-off h1.` |
| The typist failed, the chat's model wrote it | `Zero-touch: Flash 3.8 couldn't write docs/setup.md, so Opus 5 wrote it. It was checked automatically. Cost: $0.10. …` |
| Every attempt failed | `Zero-touch: the hand-off of docs/setup.md didn't work (cost so far: $0.01), and nothing was added to your project. Opus 5 will write it directly now.` (the file is handed back to the chat's model) |
| Tests that ran and did not pass | `Zero-touch: the new tests in tests/cart.test.js didn't pass in the test copy (cost: $0.10), so nothing was added. Opus 5 will look at why: if a test was wrong, it fixes the test; if the code has a real bug, it tells you.` |
| A repeated change, landed | `Zero-touch: Flash 3.8 made the change in 3 files, and your project's check passed on a test copy. Cost: $0.01. To undo it, ask Claude to undo hand-off h2.` (`no automatic check was available` when none was given; `2 files still need the change, and Opus 5 will do them.` when some targets failed) |
| A repeated change that failed its check | `Zero-touch: the change couldn't be repeated safely (your project's check failed on the test copy; cost: $0.01), so nothing was changed. Opus 5 will make the change directly.` |
| An undo | `Zero-touch: hand-off h2 was undone: 2 files are back as they were.` |
| The brief was not complete | `Zero-touch: Opus 5's instructions for the hand-off were missing 2 things, so nothing was sent and nothing was charged. Opus 5 is fixing them and will try again.` |

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

Then every changed file is written into the scratch copy (which already holds the example as changed) and the check command runs there. When it passes, the files are written into the project as one landing; when it fails, nothing is changed and the output comes back. A target whose edits never pass is named back to the chat's model, which changes that file itself; the others still land. A file that needs no change is reported unchanged. Just before landing, every file is read again: if one changed in the project while the hand-off ran (the person in their editor, another chat), nothing lands and the person reads why, because the edits were made against the old text and the check ran on all of them together (documents and test files are new files, and one that appears meanwhile is never overwritten either).

`undo_hand_off` takes a landing back by its id: a file it changed gets its earlier text, a file it created is removed. A file that no longer holds what the hand-off wrote was changed since; it is left alone and named.

Tests: `tools/test/zero-touch-handoff-start.test.mjs` (the start, the stamp, the settings), `tools/test/zero-touch-handoff-words.test.mjs` (recognition), `tools/test/zero-touch-handoff-chat.test.mjs` (the lines, no workflow from plain words, typed workflows, the model guard), `tools/test/zero-touch-handoff-tools.test.mjs` (the stamp, the refusals, the receipt line), `tools/test/zero-touch-handoff-net.test.mjs` (the safety net: which files, which shell writes, when it stands down), `plugin/mcp/model-dispatch/test/handoffDocument.test.mjs` (the form, the brief, the answer's checks, the ladder, the receipt), `plugin/mcp/model-dispatch/test/handoffScratch.test.mjs` (the scratch copy, a command run in it, the landing record and the undo), `plugin/mcp/model-dispatch/test/handoffTestsAndEdits.test.mjs` (the tests tool and the repeated change, with real commands run in real scratch copies), `plugin/mcp/model-dispatch/test/toolList.test.mjs` (the listing, and a call through the real server).

## What zero-touch leaves alone: every `/mmo:` command

Zero-touch sits on top of the pipeline and changes nothing the pipeline does. That covers every `/mmo:` command, typed or started by routing: the same phases, gates, policies, routing, typists, worker launches, output caps and hooks of its own.

**With zero-touch off (the plugin disabled or not installed), the `mmo` plugin is the pipeline alone:** every zero-touch hook returns at once (the shell shim exits before `node` starts), and the four hand-off tools in the server's list refuse every call.

**With zero-touch on, a typed `/mmo:` session sees none of it:** from the `/mmo:` prompt on, zero-touch stands down until the run ends, and the pipeline's own agents get their explicit tool lists. One thing differs, in ordinary chat only: which workflow the chat's model may start by itself. Without zero-touch it may start any; in workflow mode only the one the rules recognised in the person's message (Guard B); in hand-off mode none. Which workflow may start changes; how a workflow runs does not.

**Three changes to the pipeline's own files came with zero-touch. The first two hold for every run, typed or routed, zero-touch on or off; the third applies only to a run zero-touch started:**

- **Which model the five driver agents run on under `--auth=estimated`** (25 Sep 2026, a project decision). Before, it was the person's `CLAUDE_CODE_SUBAGENT_MODEL`, which had to be set before launch (in the desktop app only in `~/.claude/settings.json`, and read only when a chat starts), so a plain-words request in a fresh install could not start a workflow. Now each agent file names `model: claude-opus-5`, which Claude Code (2.1.251 and later) puts above that setting and above the chat's model, checked live in the desktop app on 25 Sep 2026 (chat on Sonnet 5: the pinned helper ran Opus 5, an unpinned one Sonnet 5). The run-start check compares the pin with the policy, so a mismatch still stops the run and the report never prices a model that did not run. What a person notices: nothing to set, no new chat, and the chat's model picker cannot move the helpers. The older Opus 4.7 policies (`opus-plus-flash`, `opus-only`) stop in estimated mode.
- **Where the commands, the brownfield manual and the orchestrator's instructions point the model.** They name their files by the installed plugin's own path, `${CLAUDE_PLUGIN_ROOT}/…`, which Claude Code fills in with the plugin's real folder (probed on 2.1.283 for commands, skills and agents). Before, they said `/plugin/skills/brownfield-guide/SKILL.md`, a path that exists only in a clone of this repository, so a model that followed it literally on an installed plugin found nothing (a bug-fix chat on Sonnet 4.6, 26 Sep 2026). Links to the repository's own `SETUP.md` and `docs/`, which an installed plugin does not carry, name `/mmo:setup` or `/mmo:policy` instead. What the files say is otherwise unchanged (`tools/test/plugin-paths.test.mjs`).

- **A run zero-touch started learns the person's models from a tag** (1 Oct 2026). The new-app command, the existing-project guide's Gate 0 and the seven job commands read a leading `[zero-touch policy=<name> auth=<vendor|estimated>]` in their arguments as this run's policy and cost recording: the policy wins over the project's saved choice and over a repo-local `routing-policy.yaml` (the explicit-file rule `/mmo:pass --policy` already follows), is passed as `policy_path` on every policy call and to the run-start check, and neither question is asked. Without the tag, which is every command a person types, the text reads and runs exactly as before (`tools/test/zero-touch-workflow-tag.test.mjs`, `tools/test/command.test.mjs`).

The version notes list all three beside the price list's one new row ([methodology.md](methodology.md), v0.8.4).

## After a Claude Code update

Routing relies on these behaviours of the app: a note the prompt hook adds reaches the model; a `PreToolUse` deny on the `Skill` tool stops a command and the model reads the reason; a message typed while Claude works is recorded in the transcript as a `queued_command`; both plugins' `SessionStart` hooks run for a new chat and after `/clear`, and a start hook's `systemMessage` is shown to the person; a multiple-choice answer reaches `PostToolUse` as `answers[<question>]`; a `Stop` hook's `block` continues the turn with its reason; and `${CLAUDE_PLUGIN_ROOT}` is filled in inside commands, skills and agents (probed on 2.1.283). Hand-off mode also relies on these: a start hook's `additionalContext` reaches the model, at a fresh start and after a compaction; a `PreModelSwitch` deny stops a model switch and the person reads the reason; the start moment or the transcript names the chat's model; a `PreToolUse` hook's `updatedInput` replaces the input of one of the plugin's own server tools (the hand-off stamp, and since 1 Oct 2026 the workflow policy stamp); and a `PostToolUse` hook's `systemMessage` is shown after such a tool answered. The settings box relies on these (probed on 2.1.283, 1 Oct 2026, in `claude -p` runs with a stand-in person): a `PreToolUse` hook fires on `AskUserQuestion` before the box is shown and its deny keeps the box from the person, with the reason reaching the model; the clicks reach `PostToolUse` as `tool_response.answers[<question>] = <label>`; a closed box reaches no hook; a run with no screen is labelled `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (a run started from inside another Claude chat inherits that chat's label); `${CLAUDE_PLUGIN_DATA}` reaches the plugin's hooks. And the `/clear` fix relies on this, read in Claude Code's own code: `/clear` fires `SessionEnd` with reason `clear` for the old chat id, then starts the cleared conversation under a new id. An update can change any of them silently. After every update, in one new chat with zero-touch on: the start line shows; "change zero-touch settings" opens the exact box and a click is saved; a clear job message starts its workflow; a second job during it gets the Queue-or-Replace question; and a `/mmo:` command the chat tries by itself is refused with its reason. `tools/test/ambient-routing-hooks.test.mjs` proves the plugin's side; the live chat proves the app's.

## Status

**Built and tested offline (1 Oct 2026): the settings box, and both modes on it.** The settings box: the three boxes word for word, their order, the current-choice marker, the check of a zero-touch box (and leaving other boxes alone), all-or-nothing saving, the first chat's hold, a closed box noticed at the next message, the Google check (mmo's own rule, and one real test when Flash is chosen). Workflow mode: recognition, the start with the person's models in a tag, the policy stamped on every model-server call of the run, the two guards, the second-job question and its lines, the project lock and its release at `/clear`, the start message, the line after each message and the one at a workflow's end. Hand-off mode: the chat's start from the settings (chat model, a typist per kind, Keep in chat), recognition, the lines, the model guard, the four tools (`write_document`, `write_tests_from_cases`, `repeat_edit_across_files`, `undo_hand_off`) with the scratch copy, the landings and the undo, the last attempt by the chat's own model, and the safety net. The tests call no model and read no credential.

**Probed with real models (1 Oct 2026, 20 `claude -p` runs on Haiku 4.5, Sonnet 5 and Opus 5 with a stand-in person, about $0.87 of subscription use):** asked in plain words to change the settings, every model opened the exact settings box, first try (9 of 9); none opened it for an unrelated question; with a vague note Haiku opened none and Sonnet and Opus a reworded one, which the check refused and they then opened exactly, so the note gives the exact box; an over-broad first check refused Claude's own "which editor?" box, so only boxes about zero-touch are checked.

**Not yet checked live:**
- **The settings box in the desktop app and in an interactive terminal**, and the first chat after install end to end.
- **Hand-off mode, all of it.** No real model has written anything through it. The app behaviours it rests on that no offline test can prove are listed under "After a Claude Code update".
- **Workflow mode's newer parts:** the policy stamp on a real run, `/clear` freeing a project, the second-job question, the start message after a compaction, and the installed-path links (the fix for the third chat below).
- **The desktop app's plugin switch for `mmo`** while `zero-touch` needs it (its code writes the switch with no dependency check; Claude Code's documented refusal is the terminal's).

**Checked live, workflow mode,** on the Claude Code version the desktop app ran on 26 Sep 2026, nothing set on the machine:
- **New app, chat on Sonnet 5:** the workflow started from a plain message; its run-start check printed "the driver agents run on claude-opus-5, named in this plugin's agent files"; the plan showed Opus 5 for the thinking and Flash 3.8 for the typing; requirements were written and the run stopped at Gate 1.
- **Bug fix, chat on Opus 5.5:** the chat loaded the brownfield rulebook by its skill name, read the project's saved policy (`opus-plus-flash-v38`), ran the pre-check, and the discovery helper ran on Opus 5 without touching the source.
- **Bug fix, chat on Sonnet 4.6:** the chat could not open the rulebook (the brownfield commands pointed at it by a repository path, a bug since 19 Aug 2026) and worked without it. Fixed since: every such link is the installed plugin's own path (`${CLAUDE_PLUGIN_ROOT}/…`, `tools/test/plugin-paths.test.mjs`); not yet re-run live.

**The switch, live on 29 Sep 2026:** the zero-touch plugin installed alone brought `mmo` with it; a new chat was marked at its start; with the plugin disabled, a new chat had no record and nothing acted.

**The platform facts** routing rests on were probed live: a Skill call for every command start, the prompt hooks firing before any tool in headless runs, and a `PreToolUse` deny stopping a command (Claude Code 2.1.282, 25 Sep 2026); the facts behind the second-job question (2.1.283, 29 Sep 2026).

**Where it came from.** Zero-touch was built over several unreleased builds. One of them also acted inside ordinary chats (a generic orchestrator: outlines in place of big file reads, worker jobs, a savings board); that part was removed before this release and is kept on the branch `archive/generic-orchestrator` (tag `generic-orchestrator-0.8.3`). `tools/test/zero-touch-a-only.test.mjs` holds the line: an ordinary message in a workflow-mode chat gets nothing, every tool passes untouched, only zero-touch's own hooks are registered, and no file is left that the hook does not use.

## Tests

```bash
node --test tools/test/ambient-*.test.mjs tools/test/zero-touch-*.test.mjs
node --test plugin/mcp/model-dispatch/test/handoff*.test.mjs       # after npm run build in plugin/mcp/model-dispatch
node --test plugin/mcp/model-dispatch/test/toolList.test.mjs   # after npm run build in plugin/mcp/model-dispatch
```

All offline, no credential read, no model call. They run as part of `npm test`.
