#!/bin/bash
# Start the Telegram bot with .env loaded
# Works from any install location — no hardcoded paths

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

cd "$SCRIPT_DIR"
set -a
source .env
set +a
exec "$BUN_PATH" run src/bot.ts
