#!/bin/sh
# The zero-touch plugin's only hook, at the start of each chat (SessionStart): it marks the chat as having
# zero-touch on (scripts/start-chat.mjs). POSIX sh only: this runs on machines where bash may be missing or old.
#
# The trap is the first line on purpose. Whatever happens below (node missing, a crash, a kill) this script exits 0
# and prints nothing, which Claude Code reads as "carry on": a failure here can only leave the chat without
# zero-touch, never block it.
trap "exit 0" EXIT

home="${MMO_HOME:-$HOME/.mmo-ambient}"

if ! command -v node >/dev/null 2>&1; then
  # Say it once per machine and stay quiet afterwards: zero-touch cannot run without Node.js, so the chat stays plain.
  if [ ! -f "$home/node-missing-said" ]; then
    mkdir -p "$home" 2>/dev/null && : > "$home/node-missing-said" 2>/dev/null
    printf '%s' '{"systemMessage":"Cost-saving mode is on but cannot run here (Node.js was not found), so it is doing nothing. Everything else works as normal."}'
  fi
  exit 0
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$dir/../scripts/start-chat.mjs"
