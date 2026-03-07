/**
 * Claude Telegram Relay — Configure Services (Windows/Linux)
 *
 * Sets up PM2 for always-on services and crontab for scheduled tasks.
 *
 * Usage: bun run setup/configure-services.ts [--service relay|checkin|briefing|all] [--unload]
 */

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const CRON_MARKER = "claude-telegram-relay";

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

// ============================================================
// CRONTAB HELPERS
// ============================================================

async function readCrontab(): Promise<string> {
  const result = await run(["crontab", "-l"]);
  if (result.ok) return result.stdout;
  // "no crontab for user" is normal
  return "";
}

async function writeCrontab(content: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["crontab", "-"], {
      cwd: PROJECT_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(content);
    proc.stdin.end();
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

function removeCronBlock(crontab: string, serviceName: string): string {
  const beginMarker = `# BEGIN ${CRON_MARKER}: ${serviceName}`;
  const endMarker = `# END ${CRON_MARKER}: ${serviceName}`;
  const lines = crontab.split("\n");
  const result: string[] = [];
  let inside = false;

  for (const line of lines) {
    if (line.trim() === beginMarker) {
      inside = true;
      continue;
    }
    if (line.trim() === endMarker) {
      inside = false;
      continue;
    }
    if (!inside) result.push(line);
  }

  return result.join("\n");
}

function addCronBlock(crontab: string, serviceName: string, cronLine: string): string {
  // Remove existing block first (idempotent)
  let cleaned = removeCronBlock(crontab, serviceName);

  // Remove trailing empty lines then add one
  cleaned = cleaned.replace(/\n+$/, "");
  if (cleaned) cleaned += "\n";

  const block = [
    `# BEGIN ${CRON_MARKER}: ${serviceName}`,
    cronLine,
    `# END ${CRON_MARKER}: ${serviceName}`,
  ].join("\n");

  return cleaned + block + "\n";
}

// ============================================================
// SERVICE DEFINITIONS
// ============================================================

interface ServiceDef {
  name: string;
  script: string;
  cron?: string;
  description: string;
}

const SERVICES: Record<string, ServiceDef> = {
  relay: {
    name: "claude-telegram-relay",
    script: "src/relay.ts",
    description: "Main bot (always running)",
  },
  checkin: {
    name: "claude-smart-checkin",
    script: "examples/smart-checkin.ts",
    cron: "*/30 9-18 * * *",
    description: "Smart check-ins (every 30 min, 9am-6pm)",
  },
  briefing: {
    name: "claude-morning-briefing",
    script: "examples/morning-briefing.ts",
    cron: "0 9 * * *",
    description: "Morning briefing (daily at 9am)",
  },
};

// ============================================================
// INSTALL / UNLOAD
// ============================================================

async function checkPm2(): Promise<boolean> {
  const result = await run(["npx", "pm2", "--version"]);
  if (result.ok) {
    console.log(`  ${PASS} PM2: v${result.stdout}`);
    return true;
  }
  console.log(`  ${FAIL} PM2 not found`);
  console.log(`      ${dim("Install: npm install -g pm2")}`);
  return false;
}

async function findBun(): Promise<string> {
  const candidates = [
    join(process.env.HOME || "", ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const result = await run(["which", "bun"]);
  return result.ok ? result.stdout : "bun";
}

async function installService(config: ServiceDef): Promise<boolean> {
  if (config.cron) {
    // Scheduled service — write to crontab automatically
    const bunPath = await findBun();
    const cronCmd = `${config.cron} cd ${PROJECT_ROOT} && ${bunPath} run ${config.script} >> ${LOGS_DIR}/${config.name}.log 2>&1`;

    const existing = await readCrontab();
    const updated = addCronBlock(existing, config.name, cronCmd);
    const ok = await writeCrontab(updated);

    if (ok) {
      console.log(`  ${PASS} ${config.name} — ${config.description}`);
      console.log(`      ${dim(config.cron)}`);
      return true;
    }
    console.log(`  ${FAIL} Failed to write crontab for ${config.name}`);
    return false;
  }

  // Always-on service — use PM2
  // Stop existing first
  await run(["npx", "pm2", "delete", config.name]);

  // Use "bun run <script>" as a shell command instead of --interpreter bun,
  // because PM2's bun fork container doesn't support async modules.
  const bunPath = await findBun();
  const result = await run([
    "npx", "pm2", "start", `${bunPath} run ${config.script}`,
    "--name", config.name,
    "--cwd", PROJECT_ROOT,
    "-o", join(LOGS_DIR, `${config.name}.log`),
    "-e", join(LOGS_DIR, `${config.name}.error.log`),
  ]);

  if (result.ok) {
    console.log(`  ${PASS} ${config.name} started — ${config.description}`);
    return true;
  }
  console.log(`  ${FAIL} Failed to start ${config.name}: ${result.stderr}`);
  return false;
}

async function unloadService(config: ServiceDef): Promise<boolean> {
  if (config.cron) {
    const existing = await readCrontab();
    const updated = removeCronBlock(existing, config.name);
    const ok = await writeCrontab(updated);
    if (ok) {
      console.log(`  ${PASS} Removed ${config.name} from crontab`);
      return true;
    }
    console.log(`  ${FAIL} Failed to update crontab`);
    return false;
  }

  const result = await run(["npx", "pm2", "delete", config.name]);
  if (result.ok) {
    console.log(`  ${PASS} Stopped ${config.name} (PM2)`);
    return true;
  }
  console.log(`  ${FAIL} Failed to stop ${config.name}: ${result.stderr}`);
  return false;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (process.platform === "darwin") {
    console.log(`\n  You're on macOS. Use launchd instead:`);
    console.log(`      ${dim("bun run setup/configure-launchd.ts")}`);
    process.exit(0);
  }

  // Parse flags
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "relay";
  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];
  const shouldUnload = args.includes("--unload");

  console.log("");
  console.log(bold(shouldUnload ? "  Remove Services" : "  Configure Services (PM2 + Cron)"));
  console.log("");

  if (!shouldUnload) {
    const pm2Ok = await checkPm2();
    if (!pm2Ok) process.exit(1);
  }

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  console.log("");
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      console.log(`      ${dim("Available: relay, checkin, briefing, all")}`);
      continue;
    }
    if (shouldUnload) {
      await unloadService(config);
    } else {
      await installService(config);
    }
  }

  if (!shouldUnload) {
    // Save PM2 config for auto-restart on reboot
    await run(["npx", "pm2", "save"]);
    console.log("");
    console.log(`  ${dim("Auto-start on boot:")} npx pm2 startup`);
    console.log(`  ${dim("Check status:")}        npx pm2 status`);
    console.log(`  ${dim("View cron:")}           crontab -l`);
    console.log(`  ${dim("View logs:")}           npx pm2 logs`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
