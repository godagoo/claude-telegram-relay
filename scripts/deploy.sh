#!/bin/bash
# Claude Telegram Relay — VPS Deploy Script
#
# Run after each Claude Code session to update your VPS:
#   cd /home/user/claude-telegram-relay
#   bash scripts/deploy.sh
#
# What it does:
#   1. Pulls latest code from master
#   2. Installs/updates dependencies
#   3. Restarts PM2 services (if running)
#   4. Updates cron jobs

set -e
cd "$(dirname "$0")/.."

echo "==> Pulling latest code from master..."
git pull origin master

echo "==> Installing dependencies..."
bun install

echo "==> Restarting PM2 services (if any)..."
npx pm2 restart all 2>/dev/null || echo "    No PM2 services running (that's ok)"

echo "==> Updating cron jobs..."
bun run setup:cron 2>/dev/null || echo "    Cron setup skipped"

echo ""
echo "==> Done! Run 'bun run setup:verify' to check health."
