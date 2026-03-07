#!/bin/bash
# Start the Telegram bot with .env loaded
# Works from any install location — no hardcoded paths

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

cd "$SCRIPT_DIR"

# Load .env safely — splits only on the first '=' to preserve JWTs with base64 padding
while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  export "$key=$value"
done < .env

exec "$BUN_PATH" run src/bot.ts
