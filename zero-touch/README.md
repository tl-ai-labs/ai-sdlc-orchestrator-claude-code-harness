# zero-touch

The switch for zero-touch in the `mmo` plugin. Install it and every new chat has zero-touch: a request typed in
plain words that clearly asks for one of the eight `/mmo:` jobs starts that job's workflow; every other message is
an ordinary chat, exactly as without the plugin. Disable it and new chats have none; the `/mmo:` workflows are
untouched.

```
/plugin install zero-touch@tilicho-ai-labs
```

- **What you see:** a start message when a chat begins (again after `/clear`, a compaction or reopening the chat)
  saying workflow mode is on, which policy your workflows will use and how to turn it off; then one line after each
  message you type, starting with `Zero-touch:`, saying what it did with it ("starting the bug-fix workflow", or "not
  a workflow job, handled as a normal chat").
- **Turn it off for new chats, keeping the plugin:** put `off` in `~/.mmo-ambient/mode`; a new chat then says
  zero-touch is off and how to turn it on (`a` in that file, or remove it).
- **Turn it off:** disable it in Claude Code's plugin list (desktop app: **+** next to the prompt box → **Plugins** →
  **Manage plugins**; terminal chat: `/plugin` → **Installed**; shell: `claude plugin disable zero-touch@tilicho-ai-labs`).
  It takes effect in new chats; an open chat keeps what it started with.
- **What it contains:** one hook. At the start of each chat (and after `/clear`) it writes the chat's record,
  `~/.mmo-ambient/sessions/<chat id>/chat_mode`, and shows you the start message. All of zero-touch's code and hooks live in the `mmo` plugin and act
  only in a chat with that record. It has no code of `mmo`'s because Claude Code gives each plugin its own
  copy of any file it links to, which would mean a second build of the server.
- **Needs:** the `mmo` plugin (declared as a dependency) and Node.js.

How it works and what it stores: [docs/ambient-mode.md](../docs/ambient-mode.md).
