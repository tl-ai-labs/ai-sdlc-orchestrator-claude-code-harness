# zero-touch

The switch and the settings for zero-touch in the `mmo` plugin. Install it and every new chat has zero-touch, in the
mode you choose; disable it and new chats have none. The `/mmo:` workflows are untouched either way.

```
/plugin install zero-touch@tilicho-ai-labs
```

(In the desktop app: the plugin browser. Claude Code installs and enables `mmo` with it.)

- **Choosing, in the chat:** the first chat after install asks before anything else, in Claude's own question box;
  you click, nothing to type or edit. Later, in any chat, type `change zero-touch settings` (any wording works) and
  the same box opens. Always the same order: the mode first, then the models for that mode.
  - **Workflows** (workflow mode): a request typed in plain words that clearly asks for one of the eight `/mmo:` jobs
    starts that job's workflow, on the models you pick (Opus 5 + Flash 3.8, Opus 5 + Sonnet 5, or Opus 5 only);
    every other message is an ordinary chat.
  - **Hand-off** (hand-off mode): the chat's own model (Opus 5 or Sonnet 5, your pick; the chat is kept on it) does
    the development, and new documents, specs and plans, new tests, and one change repeated across files each go to
    the model you pick for that kind of work (Flash 3.8, Sonnet 5, or Keep in chat) through the `mmo` plugin's
    hand-off tools, which check the result before it reaches your project. Plain words start no workflow there; a
    typed `/mmo:` command still does.
  - **Off:** the plugin stays installed and Claude works as normal; the settings box still works.
- **When a choice applies:** in new chats (a new chat in the desktop app; in the terminal, a restart or `/clear`).
  An open chat keeps what it started with. The first chat after install uses its answers at once.
- **Your models, nothing else:** a project's own `routing-policy.yaml` and its saved choice in `.sdlc/project.json`
  are not used by zero-touch (the start message says when the folder has one). A `/mmo:` command you type keeps
  following them.
- **What you see:** a start message when a chat begins (again after a compaction or reopening the chat) saying which
  mode is on, which models run and how to change it; if the models need Google and this computer is not connected,
  it says so. Then one line after each message you type, starting with `Zero-touch:`, saying what it did with it.
- **Turn it off:** choose Off in the settings box, or disable the plugin in Claude Code's plugin list (desktop app:
  **+** next to the prompt box → **Plugins** → **Manage plugins**; terminal chat: `/plugin` → **Installed**; shell:
  `claude plugin disable zero-touch@tilicho-ai-labs`). Either takes effect in new chats.
- **What it contains:** the settings box and the chat's start, in five hooks and the scripts in `scripts/`. Your
  choices are kept in the plugin's own data folder (`${CLAUDE_PLUGIN_DATA}/settings.json`), which Claude Code keeps
  across updates and deletes when the plugin is removed, so installing it again asks again. At the start of each
  chat the start hook writes the chat's record, `~/.mmo-ambient/sessions/<chat id>/chat_mode`, and the chat's
  models, and shows the start message. All of zero-touch's workflow and hand-off code lives in the `mmo` plugin and
  acts only in a chat with that record. This plugin has no code of `mmo`'s because Claude Code gives each plugin its
  own copy of any file it links to, which would mean a second build of the server; the one rule both need, whether
  this computer is connected to Google, is a copy of `mmo`'s own, and a test keeps the two identical.
- **Not checked live yet:** the settings box in the desktop app and an interactive terminal, and hand-off mode with a
  real model. The box itself was probed with real models in `claude -p` runs.
- **Needs:** the `mmo` plugin (declared as a dependency) and Node.js.

How it works and what it stores: [docs/ambient-mode.md](../docs/ambient-mode.md).
