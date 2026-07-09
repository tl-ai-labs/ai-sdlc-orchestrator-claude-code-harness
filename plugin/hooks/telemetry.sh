#!/usr/bin/env bash
# PostToolUse hook: every successful execute_with_model call already writes
# telemetry inline via the MCP server (which has the exact token counts).
# This hook is a backup heartbeat — it just records that the tool ran, so
# we can cross-check tool invocations against the JSONL log.
#
# Reads the tool result from stdin (Claude Code hook contract) and writes
# a one-line summary to <project>/.hook-logs/hook.jsonl.

set -euo pipefail

LOG_DIR="${CLAUDE_PROJECT_DIR:-.}/.hook-logs"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Hook payload arrives on stdin (JSON); we just timestamp + size it.
PAYLOAD_SIZE=$(wc -c | awk '{print $1}')

echo "{\"ts\":\"$STAMP\",\"event\":\"mcp_tool_postuse\",\"payload_bytes\":$PAYLOAD_SIZE}" \
  >> "$LOG_DIR/hook.jsonl"
