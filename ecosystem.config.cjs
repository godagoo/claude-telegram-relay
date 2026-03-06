/**
 * PM2 Ecosystem Config — Claude Telegram Relay
 *
 * Usage (run from SSH terminal, NOT Claude Code):
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup systemd   # then run the command PM2 outputs
 */
module.exports = {
  apps: [
    {
      name: "claude-telegram-relay",
      script: "./start-bot.sh",
      cwd: __dirname,
      out_file: "./logs/claude-telegram-relay.log",
      error_file: "./logs/claude-telegram-relay.error.log",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
    },
  ],
};
