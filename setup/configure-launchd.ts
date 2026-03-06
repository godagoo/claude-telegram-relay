/**
 * Claude Telegram Relay — Configure launchd (macOS)
 *
 * Generates and loads launchd plist files with correct paths
 * for the current user and project location.
 *
 * Usage: bun run setup/configure-launchd.ts [--service relay|checkin|briefing|all]
 */

import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const USERNAME = HOME.split("/").pop() || "user";
const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

// Find bun path
async function findBun(): Promise<string> {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: which bun
  const proc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim() || "bun";
}

function generatePlist(opts: {
  label: string;
  script: string;
  keepAlive: boolean;
  calendarIntervals?: { Hour: number; Minute: number }[];
}): string {
  const bunPath = findBunSync;

  let scheduling = "";
  if (opts.calendarIntervals) {
    scheduling = `
    <key>StartCalendarInterval</key>
    <array>${opts.calendarIntervals
      .map(
        (ci) => `
        <dict>
            <key>Hour</key>
            <integer>${ci.Hour}</integer>
            <key>Minute</key>
            <integer>${ci.Minute}</integer>
        </dict>`
      )
      .join("")}
    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${opts.label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${opts.script}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
${opts.keepAlive ? `
    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>
` : ""}${scheduling}
    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/${opts.label}.log</string>

    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/${opts.label}.error.log</string>
</dict>
</plist>`;
}

let findBunSync = "";

interface ServiceConfig {
  label: string;
  script: string;
  keepAlive: boolean;
  calendarIntervals?: { Hour: number; Minute: number }[];
  description: string;
}

const SERVICES: Record<string, ServiceConfig> = {
  relay: {
    label: "com.claude.telegram-relay",
    script: "src/relay.ts",
    keepAlive: true,
    description: "Main bot (always running, restarts on crash)",
  },
  checkin: {
    label: "com.claude.smart-checkin",
    script: "examples/smart-checkin.ts",
    keepAlive: false,
    calendarIntervals: [
      { Hour: 7, Minute: 0 },
      { Hour: 8, Minute: 0 },
      { Hour: 9, Minute: 0 },
      { Hour: 10, Minute: 0 },
      { Hour: 11, Minute: 0 },
      { Hour: 12, Minute: 0 },
      { Hour: 13, Minute: 0 },
      { Hour: 14, Minute: 0 },
      { Hour: 15, Minute: 0 },
      { Hour: 16, Minute: 0 },
      { Hour: 17, Minute: 0 },
      { Hour: 18, Minute: 0 },
      { Hour: 19, Minute: 0 },
      { Hour: 20, Minute: 0 },
      { Hour: 21, Minute: 0 },
      { Hour: 22, Minute: 0 },
    ],
    description: "Smart check-ins (hourly, 7am-11pm)",
  },
  briefing: {
    label: "com.claude.morning-briefing",
    script: "examples/morning-briefing.ts",
    keepAlive: false,
    calendarIntervals: [{ Hour: 7, Minute: 0 }],
    description: "Morning briefing (daily at 7am)",
  },
  crypto: {
    label: "com.claude.crypto-update",
    script: "examples/crypto-price-update.ts",
    keepAlive: false,
    calendarIntervals: [
      { Hour: 7, Minute: 0 },
      { Hour: 8, Minute: 0 },
      { Hour: 9, Minute: 0 },
      { Hour: 10, Minute: 0 },
      { Hour: 11, Minute: 0 },
      { Hour: 12, Minute: 0 },
      { Hour: 13, Minute: 0 },
      { Hour: 14, Minute: 0 },
      { Hour: 15, Minute: 0 },
      { Hour: 16, Minute: 0 },
      { Hour: 17, Minute: 0 },
      { Hour: 18, Minute: 0 },
      { Hour: 19, Minute: 0 },
      { Hour: 20, Minute: 0 },
      { Hour: 21, Minute: 0 },
      { Hour: 22, Minute: 0 },
    ],
    description: "Crypto price report (hourly, 7am-11pm)",
  },
};

async function installService(name: string, config: ServiceConfig): Promise<boolean> {
  const plistPath = join(LAUNCH_AGENTS, `${config.label}.plist`);

  // Generate plist
  const content = generatePlist(config);
  await writeFile(plistPath, content);
  console.log(`  ${PASS} Generated ${config.label}.plist`);

  // Unload if already loaded
  const unload = Bun.spawn(["launchctl", "unload", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await unload.exited;

  // Load
  const load = Bun.spawn(["launchctl", "load", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const loadErr = await new Response(load.stderr).text();
  const loadCode = await load.exited;

  if (loadCode !== 0) {
    console.log(`  ${FAIL} Failed to load: ${loadErr.trim()}`);
    return false;
  }

  console.log(`  ${PASS} Loaded — ${config.description}`);
  return true;
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`\n  ${FAIL} This script is for macOS only.`);
    console.log(`      ${dim("On Linux/Windows, use: bun run setup/configure-services.ts")}`);
    process.exit(1);
  }

  findBunSync = await findBun();

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "relay";

  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure launchd Services"));
  console.log(dim(`  Bun: ${findBunSync}`));
  console.log(dim(`  Project: ${PROJECT_ROOT}`));
  console.log("");

  // Ensure logs directory exists
  if (!existsSync(LOGS_DIR)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  let allOk = true;
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      console.log(`      ${dim("Available: relay, checkin, briefing, all")}`);
      allOk = false;
      continue;
    }
    const ok = await installService(name, config);
    if (!ok) allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log(`  ${green("Done!")} Services are running.`);
    console.log("");
    console.log(`  ${dim("Check status:")}  launchctl list | grep com.claude`);
    console.log(`  ${dim("View logs:")}     tail -f ${LOGS_DIR}/com.claude.telegram-relay.log`);
    console.log(`  ${dim("Stop all:")}      bun run setup/configure-launchd.ts --unload`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
