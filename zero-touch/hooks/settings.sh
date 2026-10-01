#!/bin/sh
# The zero-touch settings box (scripts/settings-hook.mjs): $1 is the moment, pre-ask | post-ask | prompt | pre-any.
# POSIX sh only. Exits 0 whatever happens (the trap), so a failure never blocks the chat.
#
# Speed: "pre-any" runs before every tool call and "prompt" before every message, in every chat. Both have work to
# do only in a chat waiting for its first settings (zt_setup.json) or in the middle of a settings box sequence
# (zt_flow.json), so they leave before starting node unless one of those files is there. The chat id is read from the
# first 512 bytes of the input, where Claude Code puts it; when it cannot be read, node decides.
trap "exit 0" EXIT

event="$1"
home="${MMO_HOME:-$HOME/.mmo-ambient}"
input=$(cat)

if [ "$event" = "pre-any" ] || [ "$event" = "prompt" ]; then
  sid=$(printf '%s' "$input" | head -c 512 | sed -n 's/^{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,80\}\)".*/\1/p' | head -n 1)
  if [ -n "$sid" ]; then
    if [ "$event" = "pre-any" ] && [ ! -f "$home/sessions/$sid/zt_setup.json" ]; then exit 0; fi
    if [ "$event" = "prompt" ] && [ ! -f "$home/sessions/$sid/zt_setup.json" ] && [ ! -f "$home/sessions/$sid/zt_flow.json" ]; then exit 0; fi
  fi
fi

command -v node >/dev/null 2>&1 || exit 0
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$input" | node "$dir/../scripts/settings-hook.mjs" "$event"
