#!/bin/sh
# The zero-touch plugin's start hook (SessionStart): it marks the chat with the person's zero-touch mode and models
# and shows the start message (scripts/start-chat.mjs). POSIX sh only: this runs on machines where bash may be
# missing or old.
#
# The trap is the first line on purpose. Whatever happens below (node missing, a crash, a kill) this script exits 0
# and prints nothing else, which Claude Code reads as "carry on": a failure here can only leave the chat without
# zero-touch, never block it.
trap "exit 0" EXIT

home="${MMO_HOME:-$HOME/.mmo-ambient}"

if ! command -v node >/dev/null 2>&1; then
  # Said once per computer, then quiet: zero-touch cannot run without Node.js, so the chat stays plain. The words are
  # scripts/messages.mjs NODE_MISSING (tools/test/zero-touch-plugin.test.mjs keeps the two the same).
  if [ ! -f "$home/node-missing-said" ]; then
    mkdir -p "$home" 2>/dev/null && : > "$home/node-missing-said" 2>/dev/null
    # Each apostrophe is written '\'' (close the quote, a quoted apostrophe, reopen): a bare one would end the quoting
    # and run the words together (found 1 Oct 2026; the test runs this script without node and reads what it prints).
    printf '%s' '{"systemMessage":"Zero-touch can'\''t run on this computer, because a program it needs, Node.js, isn'\''t installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat."}'
  fi
  exit 0
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$dir/../scripts/start-chat.mjs"
