#!/bin/bash
# Clean startup — strips inherited env vars, then sources .env
# Used by systemd/PM2 for a predictable environment

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

cd "$SCRIPT_DIR"

# Load .env safely — handles unquoted JWTs and special characters
while IFS='=' read -r key value; do
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  export "$key=$value"
done < .env

exec "$BUN_PATH" run src/bot.ts
