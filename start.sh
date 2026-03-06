#!/usr/bin/env -S env -i HOME=/root PATH=/root/.bun/bin:/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash
# Clean startup — env -i strips ALL inherited env vars (including proxy)
# Only HOME and PATH are set via the shebang line above.

cd /home/user/claude-telegram-relay

# Source .env into the environment
set -a
source .env
set +a

exec /root/.bun/bin/bun run src/bot.ts
