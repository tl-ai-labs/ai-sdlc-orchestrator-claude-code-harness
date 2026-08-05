#!/usr/bin/env bash
# PostToolUse backup heartbeat: the MCP server already writes full telemetry
# inline. This just records that the tool ran, for cross-checking.

set -euo pipefail

LOG_DIR="${CLAUDE_PROJECT_DIR:-.}/.hook-logs"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PAYLOAD_SIZE=$(wc -c | awk '{print $1}')

echo "{\"ts\":\"$STAMP\",\"event\":\"mcp_tool_postuse\",\"payload_bytes\":$PAYLOAD_SIZE}" \
  >> "$LOG_DIR/hook.jsonl"
