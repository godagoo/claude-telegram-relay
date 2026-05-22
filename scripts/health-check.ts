// Thin CLI wrapper around setup/health-check.ts. All logic lives in the
// shared module so setup/verify.ts can reuse it without re-implementing
// process scanning, token-lock verification, or log scanning.
//
// Exit codes:
//   0  no failures
//   1  runtime health failure (multiple relays, stale heartbeat, recent
//      crash signatures, etc.)
//   2  configuration error (missing TELEGRAM_BOT_TOKEN)

import { formatHealthLine, runHealthCheck } from "../setup/health-check.ts";

const report = await runHealthCheck({ mode: "standalone" });
for (const line of report.lines) {
  console.log(formatHealthLine(line));
}
process.exit(report.standaloneExitCode);
