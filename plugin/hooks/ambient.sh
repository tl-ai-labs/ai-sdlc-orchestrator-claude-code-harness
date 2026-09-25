#!/bin/sh
# Front door for every ambient-mode hook. POSIX sh only: this runs on machines
# where bash may be missing or old.
#
# The trap is the first line on purpose. Whatever happens below (node missing,
# a crash, a kill) this script exits 0, and exit 0 with no output means "carry
# on as plain Claude Code". Decisions travel as JSON on stdout, never as an
# exit code, so nothing here can block a prompt, a tool call or a model switch
# by accident.
trap "exit 0" EXIT

event="$1"
home="${MMO_HOME:-$HOME/.mmo-ambient}"

# Cheap exits before node starts. Ambient mode ships switched off; it turns on
# through MMO_AMBIENT or a user-level file. A project file alone can only
# tighten, so it never needs node when neither of these is present.
[ "${MMO_AMBIENT:-}" = "off" ] && exit 0
if [ -z "${MMO_AMBIENT:-}" ] && [ ! -f "$home/ambient.json" ]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  # Say it once per machine, at a session start, and stay quiet afterwards.
  if [ "$event" = "session-start" ] && [ ! -f "$home/node-missing-said" ]; then
    mkdir -p "$home" 2>/dev/null && : > "$home/node-missing-said" 2>/dev/null
    printf '%s' '{"systemMessage":"mmo ambient mode is on but node was not found on PATH, so it is doing nothing. Plain Claude Code is unaffected."}'
  fi
  exit 0
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$dir/../scripts/ambient/hook.mjs" "$event"
