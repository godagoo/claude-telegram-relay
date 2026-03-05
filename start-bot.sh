#!/bin/bash
cd /home/user/claude-telegram-relay
export $(grep -v '^#' .env | xargs)
exec /root/.bun/bin/bun run src/bot.ts
