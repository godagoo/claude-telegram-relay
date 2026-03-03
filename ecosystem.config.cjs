const { join } = require("path");

// Resolve bun binary path from installer env var, or fall back to $HOME/.bun/bin/bun
const BUN = process.env.BUN_INSTALL
  ? join(process.env.BUN_INSTALL, "bin", "bun")
  : join(process.env.HOME || "/root", ".bun", "bin", "bun");

module.exports = {
  apps: [
    {
      name: "claude-telegram-relay",
      script: BUN,
      args: "run src/relay.ts",
      interpreter: "none",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: join(__dirname, "logs", "relay.log"),
      error_file: join(__dirname, "logs", "relay.error.log"),
    },
    {
      name: "claude-crypto-report",
      script: BUN,
      args: "run examples/crypto-report.ts",
      interpreter: "none",
      cwd: __dirname,
      watch: false,
      autorestart: false,            // one-shot: run and exit, don't respawn on exit
      cron_restart: "0 7-22 * * *", // 7am–10pm ET — matches active hours, avoids quiet period
      out_file: join(__dirname, "logs", "crypto-report.log"),
      error_file: join(__dirname, "logs", "crypto-report.error.log"),
    },
  ],
};
