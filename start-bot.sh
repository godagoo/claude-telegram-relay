#!/bin/bash
cd /root/claude-telegram-relay/claude-telegram-relay
set -a
source .env
set +a
exec /root/.bun/bin/bun run src/bot.ts
