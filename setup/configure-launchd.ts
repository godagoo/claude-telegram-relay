/**
 * Claude Telegram Relay — Configure launchd (macOS)
 *
 * Generates and loads launchd plist files with correct paths
 * for the current user and project location.
 *
 * Usage: bun run setup/configure-launchd.ts [--service relay|checkin|briefing|all]
 */

import { writeFile } from "fs/promises";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { generateRelayPlist, type RelayPlistOptions } from "./launchd-plist.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");
const RELAY_DIR = process.env.RELAY_DIR || join(HOME, ".claude-relay");
const LOGS_DIR = process.env.RELAY_LOG_DIR || join(RELAY_DIR, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

// Find bun path; resolve to realpath so the launchd job points at the
// concrete versioned binary rather than the ~/.bun/bin/bun symlink, which
// is what TCC/FDA grants attach to.
async function findBun(): Promise<string> {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  let resolved = "";
  for (const p of candidates) {
    if (existsSync(p)) {
      resolved = p;
      break;
    }
  }
  if (!resolved) {
    const proc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    resolved = out.trim() || "bun";
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function generatePlist(opts: {
  label: string;
  script: string;
  keepAlive: boolean;
  calendarIntervals?: { Hour: number; Minute: number }[];
}): string {
  const env: Record<string, string> = {
    PATH: `${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME,
    RELAY_DIR,
    RELAY_LOG_DIR: LOGS_DIR,
    CLAUDE_PATH: `${HOME}/.local/bin/claude`,
    CLAUDE_TIMEOUT_MS: "90000",
    CLAUDE_RESUME: "0",
  };
  if (process.env.RELAY_PYTHON) env.RELAY_PYTHON = process.env.RELAY_PYTHON;

  const baseOptions: RelayPlistOptions = {
    label: opts.label,
    script: opts.script,
    bunRealpath: findBunSync,
    projectRoot: PROJECT_ROOT,
    home: HOME,
    logsDir: LOGS_DIR,
    env,
    keepAlive: opts.keepAlive ? { successfulExit: false, crashed: true } : false,
    throttleInterval: 30,
    exitTimeOut: 20,
    calendarIntervals: opts.calendarIntervals,
  };

  return generateRelayPlist(baseOptions);
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
      { Hour: 9, Minute: 0 },
      { Hour: 10, Minute: 30 },
      { Hour: 12, Minute: 0 },
      { Hour: 14, Minute: 0 },
      { Hour: 16, Minute: 0 },
      { Hour: 18, Minute: 0 },
    ],
    description: "Smart check-ins (runs during work hours)",
  },
  briefing: {
    label: "com.claude.morning-briefing",
    script: "examples/morning-briefing.ts",
    keepAlive: false,
    calendarIntervals: [{ Hour: 9, Minute: 0 }],
    description: "Morning briefing (daily at 9am)",
  },
};

function isBenignUnloadMiss(stderr: string): boolean {
  return stderr.includes("Could not find specified service") ||
    stderr.includes("No such process") ||
    stderr.includes("service already unloaded");
}

async function unloadExistingService(
  config: ServiceConfig,
  plistPath: string,
): Promise<boolean> {
  // Try the modern `launchctl bootout` first; fall back to the legacy
  // remove + unload path so older macOS versions and stale jobs registered
  // from a different plist path still get cleaned up.
  const uid = process.getuid?.() ?? -1;
  if (uid >= 0) {
    const bootout = Bun.spawn(
      ["launchctl", "bootout", `gui/${uid}/${config.label}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bootoutErr = await new Response(bootout.stderr).text();
    const bootoutCode = await bootout.exited;
    if (bootoutCode !== 0 && !isBenignUnloadMiss(bootoutErr)) {
      // fall through to legacy path
    }
  }

  const remove = Bun.spawn(["launchctl", "remove", config.label], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Response(remove.stderr).text();
  await remove.exited;

  const unload = Bun.spawn(["launchctl", "unload", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const unloadErr = await new Response(unload.stderr).text();
  const unloadCode = await unload.exited;

  if (unloadCode !== 0 && !isBenignUnloadMiss(unloadErr)) {
    console.log(`  ${FAIL} Failed to unload ${config.label}: ${unloadErr.trim()}`);
    return false;
  }

  const list = Bun.spawn(["launchctl", "list", config.label], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const listCode = await list.exited;
  if (listCode === 0) {
    console.log(`  ${FAIL} ${config.label} is still loaded after unload`);
    return false;
  }

  return true;
}

async function lintPlist(plistPath: string): Promise<boolean> {
  const lint = Bun.spawn(["plutil", "-lint", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [lintOut, lintErr, lintCode] = await Promise.all([
    new Response(lint.stdout).text(),
    new Response(lint.stderr).text(),
    lint.exited,
  ]);

  if (lintCode !== 0) {
    console.log(`  ${FAIL} Invalid plist: ${(lintErr || lintOut).trim()}`);
    return false;
  }

  return true;
}

async function installService(name: string, config: ServiceConfig): Promise<boolean> {
  const plistPath = join(LAUNCH_AGENTS, `${config.label}.plist`);

  // Generate plist
  const content = generatePlist(config);
  await writeFile(plistPath, content);
  console.log(`  ${PASS} Generated ${config.label}.plist`);

  if (!(await lintPlist(plistPath))) return false;
  if (!(await unloadExistingService(config, plistPath))) return false;

  // Prefer `launchctl bootstrap`; fall back to legacy `load` on older macOS
  // or when bootstrap isn't permitted from this shell context.
  const uid = process.getuid?.() ?? -1;
  let loaded = false;
  if (uid >= 0) {
    const bootstrap = Bun.spawn(
      ["launchctl", "bootstrap", `gui/${uid}`, plistPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bootstrapErr = await new Response(bootstrap.stderr).text();
    const bootstrapCode = await bootstrap.exited;
    if (bootstrapCode === 0) {
      loaded = true;
    } else if (!bootstrapErr.includes("Bootstrap failed") && !bootstrapErr.includes("Operation not permitted")) {
      // surface the bootstrap error before falling back so it isn't silently swallowed
      console.log(`  ${dim("(bootstrap failed; falling back to legacy load)")} ${bootstrapErr.trim()}`);
    }
  }

  if (!loaded) {
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
  }

  console.log(`  ${PASS} Loaded — ${config.description}`);
  return true;
}

async function unloadService(config: ServiceConfig): Promise<boolean> {
  const plistPath = join(LAUNCH_AGENTS, `${config.label}.plist`);
  if (!existsSync(plistPath)) {
    console.log(`  ${PASS} ${config.label} not installed`);
    return true;
  }

  if (!(await unloadExistingService(config, plistPath))) return false;
  console.log(`  ${PASS} Unloaded ${config.label}`);
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
  const shouldUnload = args.includes("--unload");
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "relay";

  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure launchd Services"));
  console.log(dim(`  Bun: ${findBunSync}`));
  console.log(dim(`  Project: ${PROJECT_ROOT}`));
  console.log("");

  let allOk = true;
  if (shouldUnload) {
    for (const name of toInstall) {
      const config = SERVICES[name];
      if (!config) {
        console.log(`  ${FAIL} Unknown service: ${name}`);
        console.log(`      ${dim("Available: relay, checkin, briefing, all")}`);
        allOk = false;
        continue;
      }
      const ok = await unloadService(config);
      if (!ok) allOk = false;
    }
    console.log("");
    if (allOk) console.log(`  ${green("Done!")} Requested services are unloaded.`);
    console.log("");
    process.exit(allOk ? 0 : 1);
  }

  // Ensure private launchd log directory exists. These logs can contain local
  // paths, contact names, and operational errors.
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
  chmodSync(LOGS_DIR, 0o700);

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
    console.log(`  ${dim("Stop all:")}      bun run setup/configure-launchd.ts --unload --service all`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
