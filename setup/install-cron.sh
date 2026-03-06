#!/bin/bash
# Install cron jobs for Claude Telegram Relay
# Run this on your VPS: bash setup/install-cron.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

if [ ! -f "$BUN_PATH" ]; then
  echo "Error: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "Project: $PROJECT_DIR"
echo "Bun: $BUN_PATH"

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Build cron entries
CRON_BLOCK="# === Claude Telegram Relay (all times UTC, user is America/New_York UTC-4 DST) ===
# Smart check-ins every 30 min, 7am-10pm ET
*/30 11-23 * * * cd $PROJECT_DIR && $BUN_PATH run examples/smart-checkin.ts >> logs/smart-checkin.log 2>&1
*/30 0-2 * * * cd $PROJECT_DIR && $BUN_PATH run examples/smart-checkin.ts >> logs/smart-checkin.log 2>&1
# Morning briefing daily at 7am ET = 11:00 UTC
0 11 * * * cd $PROJECT_DIR && $BUN_PATH run examples/morning-briefing.ts >> logs/morning-briefing.log 2>&1
# Crypto price update hourly, 7am-11pm ET
0 11-23 * * * cd $PROJECT_DIR && $BUN_PATH run examples/crypto-price-update.ts >> logs/crypto-price-update.log 2>&1
0 0-3 * * * cd $PROJECT_DIR && $BUN_PATH run examples/crypto-price-update.ts >> logs/crypto-price-update.log 2>&1
# === End Claude Telegram Relay ==="

# Remove old relay cron entries if any, then append new ones
(crontab -l 2>/dev/null | sed '/=== Claude Telegram Relay/,/=== End Claude Telegram Relay ===/d'; echo "$CRON_BLOCK") | crontab -

echo ""
echo "Cron jobs installed:"
crontab -l | grep -A1 "Claude Telegram"
echo ""
echo "Done! Check logs in: $PROJECT_DIR/logs/"
