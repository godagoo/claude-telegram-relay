/**
 * Claude Telegram Relay — Configure Services (Windows/Linux)
 *
 * Sets up PM2 for the always-on relay and installs cron entries
 * for scheduled tasks (check-ins, briefing, crypto).
 *
 * Usage: bun run setup/configure-services.ts [--service relay|checkin|briefing|crypto|all]
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const WRAPPER_PATH = join(PROJECT_ROOT, "setup", "cron-wrapper.sh");

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

interface ServiceDef {
  name: string;
  script: string;
  cron?: string;
  description: string;
}

const SERVICES: Record<string, ServiceDef> = {
  relay: {
    name: "claude-telegram-relay",
    script: "src/bot.ts",
    description: "Main bot (always running)",
  },
  checkin: {
    name: "claude-smart-checkin",
    script: "examples/smart-checkin.ts",
    cron: "*/30 7-22 * * *",
    description: "Smart check-ins (every 30 min, 7am-11pm)",
  },
  briefing: {
    name: "claude-morning-briefing",
    script: "examples/morning-briefing.ts",
    cron: "0 7 * * *",
    description: "Morning briefing (daily at 7am)",
  },
  crypto: {
    name: "claude-crypto-update",
    script: "examples/crypto-price-update.ts",
    cron: "0 7-23 * * *",
    description: "Crypto price report (hourly, 7am-11pm)",
  },
};

// ============================================================
// HELPERS
// ============================================================

async function findBun(): Promise<string> {
  const home = homedir();
  const candidates = [
    join(home, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const result = await run(["which", "bun"]);
  return result.ok ? result.stdout.trim() : "bun";
}

function readUserTimezone(): string {
  try {
    const envContent = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
    const match = envContent.match(/^USER_TIMEZONE=(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  return "America/New_York";
}

// ============================================================
// PM2 MANAGEMENT
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

async function cleanupDuplicatePm2(config: ServiceDef): Promise<void> {
  // Remove any PM2 process running the same script, regardless of name
  const listResult = await run(["npx", "pm2", "jlist"]);
  if (!listResult.ok) return;

  try {
    const processes = JSON.parse(listResult.stdout);
    for (const proc of processes) {
      const scriptPath: string = proc.pm2_env?.pm_exec_path || "";
      const procName: string = proc.name || "";
      if (
        scriptPath.endsWith(config.script) ||
        procName === config.name
      ) {
        console.log(`  Removing existing process: ${procName} (id: ${proc.pm_id})`);
        await run(["npx", "pm2", "delete", String(proc.pm_id)]);
      }
    }
  } catch {}
}

async function installPm2Service(config: ServiceDef): Promise<boolean> {
  // Clean up duplicates first
  await cleanupDuplicatePm2(config);

  const result = await run([
    "npx", "pm2", "start", config.script,
    "--interpreter", "bun",
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

// ============================================================
// CRON MANAGEMENT
// ============================================================

async function installCronEntry(config: ServiceDef, bunPath: string): Promise<boolean> {
  if (!config.cron) return false;

  const userTz = readUserTimezone();
  const logFile = join(LOGS_DIR, `${config.name}.log`);
  const cronLine = `${config.cron} cd ${PROJECT_ROOT} && bash ${WRAPPER_PATH} ${logFile} ${bunPath} run ${config.script}`;

  // Read current crontab
  const existing = await run(["crontab", "-l"]);
  const currentLines = existing.ok ? existing.stdout.split("\n") : [];

  // Remove any existing entry for this script and its comment
  const filtered = currentLines.filter(
    (line) => !line.includes(config.script) && !line.includes(`# ${config.name}:`)
  );

  // Ensure env header exists at the top of crontab
  ensureCronEnvHeader(filtered, userTz, bunPath);

  // Add comment + cron entry
  filtered.push(`# ${config.name}: ${config.description}`);
  filtered.push(cronLine);

  const newCrontab = filtered.join("\n") + "\n";

  // Write to crontab via stdin
  const proc = Bun.spawn(["crontab", "-"], {
    cwd: PROJECT_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(newCrontab));
  await writer.close();
  const code = await proc.exited;

  if (code === 0) {
    console.log(`  ${PASS} ${config.name} — cron installed: ${config.cron}`);
    return true;
  }

  const stderr = await new Response(proc.stderr).text();
  console.log(`  ${FAIL} Failed to install cron for ${config.name}: ${stderr}`);
  return false;
}

function ensureCronEnvHeader(lines: string[], userTz: string, bunPath: string): void {
  const home = homedir();
  const bunDir = dirname(bunPath);

  // Check if header already exists
  if (lines.some((line) => line.startsWith("TZ="))) return;

  // Prepend environment header
  const header = [
    `HOME=${home}`,
    `SHELL=/bin/bash`,
    `PATH=${bunDir}:${home}/.local/bin:${home}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    `TZ=${userTz}`,
    "",
  ];
  lines.unshift(...header);
}

// ============================================================
// SERVICE INSTALLATION
// ============================================================

async function installService(config: ServiceDef, bunPath: string): Promise<boolean> {
  if (config.cron) {
    return await installCronEntry(config, bunPath);
  }
  return await installPm2Service(config);
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

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "relay";
  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure Services (PM2 + Cron)"));
  console.log("");

  const pm2Ok = await checkPm2();
  if (!pm2Ok) process.exit(1);

  const bunPath = await findBun();
  console.log(`  ${PASS} Bun: ${bunPath}`);

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  console.log("");
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      continue;
    }
    await installService(config, bunPath);
  }

  // Save PM2 config for auto-restart on reboot
  await run(["npx", "pm2", "save"]);
  console.log("");
  console.log(`  ${dim("Auto-start on boot:")} npx pm2 startup`);
  console.log(`  ${dim("Check status:")}        npx pm2 status`);
  console.log(`  ${dim("View logs:")}           npx pm2 logs`);
  console.log(`  ${dim("Cron jobs:")}           crontab -l`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
