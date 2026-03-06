#!/bin/bash
# Install cron jobs for Claude Telegram Relay
# Run this on your VPS: bash setup/install-cron.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
CLAUDE_PATH="$(which claude 2>/dev/null || echo "")"
WRAPPER="$PROJECT_DIR/setup/cron-wrapper.sh"

if [ ! -f "$BUN_PATH" ]; then
  echo "Error: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Read USER_TIMEZONE from .env (default to America/New_York)
USER_TZ="$(grep '^USER_TIMEZONE=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "America/New_York")"
if [ -z "$USER_TZ" ]; then
  USER_TZ="America/New_York"
fi

echo "Project:  $PROJECT_DIR"
echo "Bun:      $BUN_PATH"
echo "Claude:   ${CLAUDE_PATH:-not found (smart check-ins may not work)}"
echo "Timezone: $USER_TZ"

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Build cron block with environment header
# TZ= tells cron to interpret times in the user's timezone (supported by Vixie/cronie cron)
CRON_BLOCK="# === Claude Telegram Relay ===
HOME=$HOME
SHELL=/bin/bash
PATH=$HOME/.bun/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
TZ=$USER_TZ
CLAUDE_PATH=${CLAUDE_PATH:-claude}
# Smart check-ins every 30 min, 7am-10pm
*/30 7-22 * * * cd $PROJECT_DIR && bash $WRAPPER logs/smart-checkin.log $BUN_PATH run examples/smart-checkin.ts
# Morning briefing daily at 7am
0 7 * * * cd $PROJECT_DIR && bash $WRAPPER logs/morning-briefing.log $BUN_PATH run examples/morning-briefing.ts
# Crypto price update hourly, 7am-11pm
0 7-23 * * * cd $PROJECT_DIR && bash $WRAPPER logs/crypto-price-update.log $BUN_PATH run examples/crypto-price-update.ts
# === End Claude Telegram Relay ==="

# Remove old relay cron entries if any, then append new ones
(crontab -l 2>/dev/null | sed '/=== Claude Telegram Relay/,/=== End Claude Telegram Relay ===/d'; echo "$CRON_BLOCK") | crontab -

echo ""
echo "Cron jobs installed:"
crontab -l | grep -A1 "Claude Telegram"
echo ""
echo "Done! Check logs in: $PROJECT_DIR/logs/"
