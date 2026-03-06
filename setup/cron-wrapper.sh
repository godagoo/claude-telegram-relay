#!/bin/bash
# Cron wrapper: rotates logs (>5MB) and runs the given command
# Usage: bash setup/cron-wrapper.sh logs/example.log bun run examples/example.ts

LOG_FILE="$1"; shift
MAX_LOG_BYTES=5242880  # 5MB

if [ -z "$LOG_FILE" ] || [ $# -eq 0 ]; then
  echo "Usage: cron-wrapper.sh <log-file> <command...>"
  exit 1
fi

# Rotate if log exceeds max size
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1"
  fi
fi

# Run the command with output redirected to log
exec "$@" >> "$LOG_FILE" 2>&1
