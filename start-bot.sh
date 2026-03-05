#!/bin/bash
cd /root/claude-telegram-relay/claude-telegram-relay
export $(grep -v '^#' .env | xargs)
exec /root/.bun/bin/bun run src/bot.ts
