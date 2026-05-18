/**
 * Claude Telegram Relay — Verify Setup
 *
 * Runs all health checks in sequence: env, Telegram, Supabase,
 * services, and reports overall status.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import * as os from "os";
import {
  DEFAULT_SHORTCUT_NAME,
  defaultICloudDriveDraftDir,
  ICLOUD_DRIVE_DRAFT_FILE_NAME,
  isCloudDocsDraftDir,
  validateICloudDriveDraftPayload,
} from "../src/icloud-drive-draft.ts";
import { tokenLockPath } from "../src/token-lock.ts";
import { redactBotToken } from "../src/redact-token.ts";
import {
  bunRealpathDriftCheck,
  parseLaunchdPlistJson,
  scanRelayLogForRecentFailures,
} from "./verify-checks.ts";
import {
  readInstalledShortcutActions,
  readSignedShortcutFileActions,
  validateClaudeDraftShortcutActions,
} from "./shortcut-verify.ts";
import { runCommandWithTimeout } from "./process-timeout.ts";
import { getSupabaseFeatureConfig } from "../src/supabase-config.ts";
import { checkRelayBinaries, archLabel } from "../src/arch-check.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const COMMAND_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const LAUNCHD_PATH = `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg: string) { console.log(`  ${PASS} ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ${FAIL} ${msg}`); failed++; }
function warn(msg: string) { console.log(`  ${WARN} ${msg}`); warned++; }

async function runCommand(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  return {
    code: result.timedOut ? 124 : result.code,
    stdout: result.stdout,
    stderr: result.timedOut
      ? `Command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms: ${args[0]}`
      : result.stderr,
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await response.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function privateDirOk(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isDirectory() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  const result = await runCommand(["/bin/sh", "-lc", `command -v "$1" >/dev/null 2>&1`, "sh", cmd], {
    timeoutMs: 5_000,
  });
  return result.code === 0;
}

async function getProcessLines(): Promise<string[] | undefined> {
  const result = await runCommand(["/bin/ps", "axww", "-o", "pid=,etime=,command="]);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function pidFromProcessLine(line: string): number | undefined {
  const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Load .env
async function loadEnv(): Promise<Record<string, string>> {
  try {
    const content = await Bun.file(join(PROJECT_ROOT, ".env")).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Claude Telegram Relay — Health Check"));
  console.log("");

  const env = await loadEnv();

  // 1. Files
  console.log(bold("  Files"));
  existsSync(join(PROJECT_ROOT, ".env")) ? pass(".env exists") : fail(".env missing — run: bun run setup");
  existsSync(join(PROJECT_ROOT, "node_modules")) ? pass("Dependencies installed") : fail("node_modules missing — run: bun install");
  existsSync(join(PROJECT_ROOT, "config", "profile.md")) ? pass("Profile configured") : warn("No profile.md — copy config/profile.example.md");
  for (const dir of ["logs", "temp", "uploads", "state"]) {
    const path = join(RELAY_DIR, dir);
    privateDirOk(path)
      ? pass(`${path} private`)
      : warn(`${path} missing or not 0700 — run: bun run setup`);
  }

  // 2. Telegram
  console.log(`\n${bold("  Telegram")}`);
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const userId = env.TELEGRAM_USER_ID || "";
  let telegramTokenValid = false;

  if (!token || token.includes("your_")) {
    fail("TELEGRAM_BOT_TOKEN not set");
  } else {
    try {
      const data = await fetchJsonWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
      if (data.ok) {
        telegramTokenValid = true;
        pass(`Bot: @${data.result.username}`);
      } else {
        fail(`Invalid token: ${redactBotToken(String(data.description ?? ""), token)}`);
      }
    } catch (e: any) {
      fail(`Telegram API unreachable: ${redactBotToken(e.message, token)}`);
    }
  }

  if (!userId || userId.includes("your_")) {
    fail("TELEGRAM_USER_ID not set");
  } else if (!/^\d+$/.test(userId)) {
    fail("TELEGRAM_USER_ID must be numeric");
  } else {
    pass(`User ID: ${userId}`);
  }

  // Check for competing official Telegram plugin.
  // If ~/.claude/channels/telegram/.env exists the plugin may be configured
  // to poll the same bot token, causing 409 getUpdates crash loops.
  // Do NOT print file contents — it may contain the bot token.
  const claudePluginEnvPath = join(homedir(), ".claude", "channels", "telegram", ".env");
  if (existsSync(claudePluginEnvPath)) {
    fail(
      `Claude Telegram plugin config found at ${claudePluginEnvPath}. ` +
      "If it shares this bot token it will cause 409 getUpdates conflicts. " +
      `Disable it: mv ${claudePluginEnvPath} ${claudePluginEnvPath}.disabled-$(date +%Y-%m-%d)`,
    );
  } else {
    pass("No competing Claude Telegram plugin config found");
  }

  const processLines = await getProcessLines();
  if (processLines) {
    const pluginProcesses = processLines.filter((line) =>
      line.includes("claude-plugins-official/telegram") ||
      line.includes("telegram/0.0.6")
    );
    if (pluginProcesses.length > 0) {
      fail(`Competing Claude Telegram plugin process found (${pluginProcesses.length})`);
    } else {
      pass("No competing Claude Telegram plugin process found");
    }
  } else {
    warn("Could not inspect local process list for Telegram plugin conflicts");
  }

  if (telegramTokenValid) {
    try {
      const data = await fetchJsonWithTimeout(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const webhookUrl = typeof data?.result?.url === "string" ? data.result.url : "";
      const pendingCount = Number.isInteger(data?.result?.pending_update_count)
        ? data.result.pending_update_count
        : 0;
      if (!data.ok) {
        warn(`Telegram getWebhookInfo failed: ${redactBotToken(String(data.description ?? "unknown error"), token)}`);
      } else if (webhookUrl) {
        fail(
          "Telegram webhook is configured for this bot token; getUpdates polling will conflict. " +
          `Pending updates: ${pendingCount}`,
        );
      } else {
        pass(`Telegram webhook inactive; pending updates: ${pendingCount}`);
      }
    } catch (e: any) {
      warn(`Telegram getWebhookInfo unreachable: ${redactBotToken(e.message, token)}`);
    }
  }

  // 3. Supabase
  console.log(`\n${bold("  Supabase")}`);
  const supaUrl = env.SUPABASE_URL || "";
  const supaKey = env.SUPABASE_ANON_KEY || "";
  const supabaseFeatures = getSupabaseFeatureConfig(env);

  if (!supaUrl || supaUrl.includes("your_")) {
    warn("SUPABASE_URL not set (Supabase history/search disabled; Obsidian memory remains active)");
  } else if (!supaKey || supaKey.includes("your_")) {
    warn("SUPABASE_ANON_KEY not set");
  } else {
    const requiredTables = new Set<string>();
    if (supabaseFeatures.messageHistory || supabaseFeatures.relevantContext) {
      requiredTables.add("messages");
    }
    if (supabaseFeatures.durableMemory) requiredTables.add("memory");

    for (const table of requiredTables) {
      try {
        const res = await fetch(`${supaUrl}/rest/v1/${table}?select=*&limit=1`, {
          headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        res.status === 200 ? pass(`Table "${table}" OK`) : fail(`Table "${table}": ${res.status}`);
      } catch (e: any) {
        fail(`Supabase unreachable: ${e.message}`);
        break;
      }
    }
    if (!supabaseFeatures.durableMemory) {
      pass("Obsidian is durable memory authority; Supabase memory table not required");
    }
    for (const table of ["logs", ...(!supabaseFeatures.durableMemory ? ["memory"] : [])]) {
      try {
        const res = await fetch(`${supaUrl}/rest/v1/${table}?select=*&limit=1`, {
          headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status === 200) pass(`Optional table "${table}" OK`);
        else warn(`Optional table "${table}" unavailable: ${res.status}`);
      } catch (e: any) {
        warn(`Optional table "${table}" unreachable: ${e.message}`);
      }
    }
  }

  // 4. Services (macOS only)
  if (process.platform === "darwin") {
    console.log(`\n${bold("  Services (launchd)")}`);
    for (const label of ["com.claude.telegram-relay", "com.claude.smart-checkin", "com.claude.morning-briefing"]) {
      const result = await runCommand(["launchctl", "list", label], { timeoutMs: 5_000 });
      result.code === 0 ? pass(`${label} loaded`) : warn(`${label} not loaded`);
    }

    const launchdPrint = await runCommand(
      ["launchctl", "print", `gui/${process.getuid()}/com.claude.telegram-relay`],
      { timeoutMs: 5_000 },
    );
    if (launchdPrint.code === 0) {
      const stdoutPath = launchdPrint.stdout.match(/^\s*stdout path = (.+)$/m)?.[1]?.trim();
      const stderrPath = launchdPrint.stdout.match(/^\s*stderr path = (.+)$/m)?.[1]?.trim();
      if (stdoutPath) pass(`Relay launchd stdout log: ${stdoutPath}`);
      if (stderrPath) pass(`Relay launchd stderr log: ${stderrPath}`);
    } else {
      warn(`Could not inspect relay launchd log paths: ${launchdPrint.stderr.trim() || launchdPrint.stdout.trim() || `exit ${launchdPrint.code}`}`);
    }

    // launchd plist policy check
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.claude.telegram-relay.plist");
    if (existsSync(plistPath)) {
      const plutil = await runCommand(
        ["plutil", "-convert", "json", "-o", "-", plistPath],
        { timeoutMs: 5_000 },
      );
      if (plutil.code !== 0) {
        fail(`Could not read launchd plist: ${plutil.stderr.trim() || plutil.stdout.trim()}`);
      } else {
        const policy = parseLaunchdPlistJson(plutil.stdout);
        if (!policy) {
          fail("Launchd plist JSON did not parse into a recognizable policy");
        } else {
          policy.throttleInterval === 30
            ? pass("Launchd ThrottleInterval=30")
            : fail(`Launchd ThrottleInterval=${policy.throttleInterval ?? "unset"}, expected 30`);
          policy.exitTimeOut === 20
            ? pass("Launchd ExitTimeOut=20")
            : fail(`Launchd ExitTimeOut=${policy.exitTimeOut ?? "unset"}, expected 20`);
          if (typeof policy.keepAlive === "object") {
            const ka = policy.keepAlive as Record<string, unknown>;
            ka.SuccessfulExit === false && ka.Crashed === true
              ? pass("Launchd KeepAlive = { SuccessfulExit=false, Crashed=true }")
              : fail(`Launchd KeepAlive dict has unexpected shape: ${JSON.stringify(ka)}`);
          } else {
            fail("Launchd KeepAlive is a boolean; expected { SuccessfulExit=false, Crashed=true } dict");
          }
          for (const key of ["RELAY_DIR", "RELAY_LOG_DIR"] as const) {
            policy.environment[key]
              ? pass(`Launchd env has ${key}=${policy.environment[key]}`)
              : fail(`Launchd env missing ${key}`);
          }
          if (policy.environment.RELAY_PYTHON) {
            pass(`Launchd env pins RELAY_PYTHON=${policy.environment.RELAY_PYTHON}`);
          } else {
            warn("Launchd env does not pin RELAY_PYTHON (PATH-dependent python3)");
          }
        }
      }
    } else {
      warn(`launchd plist not installed at ${plistPath}`);
    }

    const serviceProcessLines = processLines || await getProcessLines();
    if (serviceProcessLines) {
      const relayProcesses = serviceProcessLines.filter((line) =>
        line.includes("bun run src/relay.ts") ||
        /\/bun(?:\s|.*\s)run\s+src\/relay\.ts/.test(line)
      );
      if (relayProcesses.length > 1) {
        fail(`Multiple local relay processes found (${relayProcesses.length})`);
      } else if (relayProcesses.length === 1) {
        pass("Exactly one local relay process found");
      } else {
        warn("No local relay process found");
      }

      const claudeShells = serviceProcessLines.filter((line) =>
        /\bclaude --dangerously-skip-permissions\b/.test(line)
      );
      if (claudeShells.length > 0) {
        warn(`Long-lived Claude Code shell process found (${claudeShells.length}); not the launchd relay`);
      }

      const tokenLock = token ? tokenLockPath(token, RELAY_DIR) : undefined;
      if (!tokenLock) {
        warn("Cannot check token lock without TELEGRAM_BOT_TOKEN");
      } else if (!existsSync(tokenLock)) {
        warn(`Token lock not found at ${tokenLock}; relay may not be running`);
      } else {
        try {
          const payload = JSON.parse(readFileSync(tokenLock, "utf8")) as Record<string, unknown>;
          const lockPid = typeof payload.pid === "number" ? payload.pid : NaN;
          const lockHost = typeof payload.host === "string" ? payload.host : "?";
          const relayPids = relayProcesses
            .map(pidFromProcessLine)
            .filter((pid): pid is number => pid !== undefined);
          if (lockHost && lockHost !== os.hostname()) {
            fail(`Token lock host=${lockHost} differs from this host=${os.hostname()}`);
          }
          if (relayPids.length > 0 && !relayPids.includes(lockPid)) {
            fail(`Token lock PID ${lockPid} does not match the running relay process(es) [${relayPids.join(",")}]`);
          } else if (Number.isInteger(lockPid) && lockPid > 0) {
            pass(`Token lock PID ${lockPid} is consistent with local relay state (${tokenLock})`);
          } else {
            fail("Token lock payload missing valid pid");
          }
        } catch (err) {
          fail(`Token lock not parseable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Legacy bot.lock should no longer exist after the token-lock cutover.
      const legacyLockPath = join(RELAY_DIR, "bot.lock");
      if (existsSync(legacyLockPath)) {
        warn(`Legacy ${legacyLockPath} still present; remove after the next launchd bootstrap`);
      }
    } else {
      warn("Could not inspect local relay processes");
    }

    // Recent error-log scan: 409, 401, ERR_INVALID_ARG_VALUE
    const errorLogPath = join(RELAY_DIR, "logs", "com.claude.telegram-relay.error.log");
    if (existsSync(errorLogPath)) {
      try {
        const log = readFileSync(errorLogPath, "utf8");
        const scan = scanRelayLogForRecentFailures(log, { lineLimit: 200 });
        if (scan.hits.length === 0) {
          pass(`Recent relay error log clean (no 409/401/NUL crash) — ${errorLogPath}`);
        } else {
          const summary = scan.hits.reduce<Record<string, number>>((acc, h) => {
            acc[h.kind] = (acc[h.kind] ?? 0) + 1;
            return acc;
          }, {});
          for (const [kind, count] of Object.entries(summary)) {
            fail(`Recent relay error log has ${count} ${kind} hits`);
          }
        }
      } catch (err) {
        warn(`Could not read relay error log: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      warn(`Relay error log not present at ${errorLogPath} (relay may not have run yet)`);
    }

    // chat.db read probe — fail with exact FDA guidance instead of a vague hint
    const chatDbPath = join(homedir(), "Library", "Messages", "chat.db");
    if (existsSync(chatDbPath)) {
      const probe = await runCommand(
        ["sqlite3", "-readonly", chatDbPath, "SELECT 1 FROM chat LIMIT 1"],
        { timeoutMs: 5_000 },
      );
      if (probe.code === 0) {
        pass("iMessage chat.db read probe succeeded (Full Disk Access granted)");
      } else {
        const bunRealpath = await runCommand(["readlink", "-f", process.execPath], { timeoutMs: 5_000 });
        const target = bunRealpath.code === 0 ? bunRealpath.stdout.trim() : process.execPath;
        fail(
          `iMessage chat.db read failed: ${probe.stderr.trim() || probe.stdout.trim()}. ` +
          `Grant Full Disk Access to: ${target}`,
        );
      }
    } else {
      warn(`No chat.db at ${chatDbPath}; FDA probe skipped`);
    }

    // Bun realpath stability — record current realpath under
    // ~/.claude-relay/state/bun-realpath and fail when it drifts.
    const bunRealpathProbe = await runCommand(["readlink", "-f", process.execPath], { timeoutMs: 5_000 });
    if (bunRealpathProbe.code === 0) {
      const currentRealpath = bunRealpathProbe.stdout.trim();
      const recordPath = join(RELAY_DIR, "state", "bun-realpath");
      const previousRealpath = existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim() : null;
      const drift = bunRealpathDriftCheck(currentRealpath, previousRealpath);
      if (!drift.ok && drift.drifted) {
        fail(
          `Bun realpath drifted: was ${previousRealpath}, now ${currentRealpath}. ` +
          "Re-grant Full Disk Access to the new realpath, then update the record.",
        );
      } else {
        pass(`Bun realpath stable: ${currentRealpath}`);
        try {
          require("fs").mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
          require("fs").writeFileSync(recordPath, currentRealpath, "utf8");
        } catch {
          // Recording is best-effort; the check still passes for current run.
        }
      }
    } else {
      warn("Could not resolve Bun realpath; FDA target may drift unnoticed");
    }

    console.log(`\n${bold("  iMessage Handoff")}`);
    const shortcutName = env.RELAY_IMESSAGE_SHORTCUT_NAME || DEFAULT_SHORTCUT_NAME;
    const draftDir = env.RELAY_ICLOUD_DRAFT_DIR || defaultICloudDriveDraftDir();
    const draftPath = join(draftDir, ICLOUD_DRIVE_DRAFT_FILE_NAME);
    const iCloudDriveRoot = join(
      homedir(),
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
    );
    const pendingIPhoneShortcutPaths = [
      join(iCloudDriveRoot, `${shortcutName}.shortcut`),
      join(iCloudDriveRoot, `${shortcutName}-install.shortcut`),
    ];
    const legacyShortcutsPath = join(
      homedir(),
      "Library",
      "Mobile Documents",
      "iCloud~is~workflow~my~workflows",
      "Documents",
      "claude-relay-drafts",
      ICLOUD_DRIVE_DRAFT_FILE_NAME,
    );

    if (!isCloudDocsDraftDir(draftDir, iCloudDriveRoot)) {
      fail(`RELAY_ICLOUD_DRAFT_DIR must be inside the CloudDocs iCloud Drive root: ${iCloudDriveRoot}`);
    } else if (draftDir.includes("iCloud~is~workflow~my~workflows")) {
      fail("RELAY_ICLOUD_DRAFT_DIR points at the non-syncing Shortcuts container");
    } else {
      pass("Relay iCloud draft dir targets the CloudDocs iCloud Drive container");
    }

    existsSync(draftPath)
      ? pass(`Latest iCloud draft exists: ${draftPath}`)
      : warn(`Latest iCloud draft missing: ${draftPath} — send one draft to create it`);

    if (existsSync(draftPath)) {
      try {
        const payload = JSON.parse(await Bun.file(draftPath).text()) as Record<string, unknown>;
        const validation = validateICloudDriveDraftPayload(payload, { now: new Date() });
        if (validation.ok) {
          pass("Latest iCloud draft payload validates (schema, sha256, not expired)");
        } else {
          for (const error of validation.errors) fail(`Latest iCloud draft: ${error}`);
        }
      } catch (e: any) {
        fail(`Latest iCloud draft is not valid JSON: ${e.message}`);
      }
    }

    existsSync(legacyShortcutsPath)
      ? warn(`Legacy Shortcuts-container draft still exists: ${legacyShortcutsPath}`)
      : pass("No stale Shortcuts-container draft file");

    console.log(`\n${bold("  iMessage Contact Resolver")}`);
    const resolverPath = join(PROJECT_ROOT, "scripts", "resolve-contact.py");
    // If RELAY_PYTHON is set, use it — it pins the interpreter across Terminal/launchd
    // PATH differences. Otherwise default to python3 on the launchd-style PATH.
    const pinnedPython = env.RELAY_PYTHON || "";
    const launchdPath = LAUNCHD_PATH;
    const resolverEnv = { ...process.env, PATH: launchdPath, HOME: homedir() };
    const effectivePython = pinnedPython || "python3";

    if (pinnedPython) {
      pass(`RELAY_PYTHON pinned: ${pinnedPython}`);
    } else {
      warn("RELAY_PYTHON not set — using python3 on launchd PATH (may differ from your shell)");
    }

    if (!existsSync(resolverPath)) {
      fail(`Contact resolver missing: ${resolverPath}`);
    } else {
      const stat = statSync(resolverPath);
      (stat.mode & 0o111) !== 0
        ? pass("Contact resolver is executable")
        : fail(`Contact resolver is not executable: chmod +x ${resolverPath}`);
    }

    if (!(await commandExists("python3"))) {
      fail("python3 not found in current PATH");
    } else {
      const version = await runCommand([
        "python3",
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'); raise SystemExit(0 if sys.version_info >= (3, 7) else 1)",
      ]);
      if (version.code === 0) {
        pass(`python3 ${version.stdout.trim()} available (interactive PATH)`);
      } else {
        fail(`python3 must be >= 3.7 for scripts/resolve-contact.py; got ${version.stdout.trim() || version.stderr.trim() || "unknown"}`);
      }
    }

    const pythonVersionCode = "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')";
    const launchdPython = await runCommand(
      pinnedPython
        ? [pinnedPython, "-c", pythonVersionCode]
        : ["/bin/sh", "-c", `command -v python3 && python3 -c ${JSON.stringify(pythonVersionCode)}`],
      { env: resolverEnv },
    );
    if (launchdPython.code === 0) {
      pass(`${pinnedPython ? "RELAY_PYTHON" : "launchd PATH"} resolves python3: ${launchdPython.stdout.trim().replace(/\n/g, " ")}`);
    } else {
      fail(pinnedPython
        ? `RELAY_PYTHON=${pinnedPython} is not executable or not found`
        : `launchd PATH cannot resolve python3 from ${launchdPath}`);
    }

    if (existsSync(resolverPath) && launchdPython.code === 0) {
      const compile = await runCommand([effectivePython, "-m", "py_compile", resolverPath], {
        cwd: PROJECT_ROOT,
        env: resolverEnv,
      });
      compile.code === 0
        ? pass(`Contact resolver compiles with ${effectivePython}`)
        : fail(`Contact resolver does not compile with ${effectivePython}: ${(compile.stderr || compile.stdout).trim()}`);

      const directResolution = await runCommand(
        [effectivePython, resolverPath, "+15555550123"],
        { cwd: PROJECT_ROOT, env: resolverEnv },
      );
      directResolution.code === 0 && directResolution.stdout.trim() === "+15555550123"
        ? pass("Contact resolver smoke test returns direct phone identifiers")
        : fail(
          `Contact resolver smoke test failed: code=${directResolution.code} stdout=${JSON.stringify(directResolution.stdout.trim())} stderr=${JSON.stringify(directResolution.stderr.trim())}`,
        );
    }

    if (await commandExists("shortcuts")) {
      pass("shortcuts CLI installed");
      const read = await readInstalledShortcutActions(shortcutName);
      if (!read.ok) {
        fail(read.error ?? `Could not inspect Shortcut: ${shortcutName}`);
      } else {
        const validation = validateClaudeDraftShortcutActions(read.actions, { draftDir });
        if (validation.ok) {
          pass(`Mac-installed ${shortcutName} reads the CloudDocs latest.json handoff and preserves Show When Run`);
        } else {
          for (const error of validation.errors) fail(error);
        }
        for (const warning of validation.warnings) warn(warning);
      }
    } else {
      fail("shortcuts CLI not found");
    }

    const existingPendingShortcutPaths = pendingIPhoneShortcutPaths.filter(existsSync);
    if (existingPendingShortcutPaths.length > 0) {
      for (const shortcutPath of existingPendingShortcutPaths) {
        const read = await readSignedShortcutFileActions(shortcutPath);
        if (!read.ok) {
          fail(`Pending iPhone Shortcut install file is unreadable: ${read.error}`);
          continue;
        }

        const validation = validateClaudeDraftShortcutActions(read.actions, { draftDir });
        if (!validation.ok) {
          for (const error of validation.errors) {
            fail(`Pending iPhone Shortcut install file is invalid: ${error}`);
          }
        } else if (basename(shortcutPath) !== `${shortcutName}.shortcut`) {
          fail(
            `Pending iPhone Shortcut file ${shortcutPath} imports as ${basename(shortcutPath, ".shortcut")}; install ${join(iCloudDriveRoot, `${shortcutName}.shortcut`)} to replace the relay target, then delete both files`,
          );
        } else {
          fail(
            `Fixed ${shortcutName} iPhone install file still exists at ${shortcutPath}; install it on iPhone, confirm the body appears, then delete the file`,
          );
        }

        for (const warning of validation.warnings) warn(warning);
      }
    } else {
      pass(`No pending ${shortcutName} iPhone install artifact`);
    }
  }

  // 5. Optional
  console.log(`\n${bold("  Optional")}`);
  const voiceProvider = env.VOICE_PROVIDER || "";
  if (!voiceProvider) {
    warn("VOICE_PROVIDER not set — voice messages are disabled");
  } else if (voiceProvider === "groq") {
    env.GROQ_API_KEY && !env.GROQ_API_KEY.includes("your_")
      ? pass("Voice transcription (Groq) configured")
      : warn("VOICE_PROVIDER=groq but GROQ_API_KEY is not set");
  } else if (voiceProvider === "local") {
    const whisperBinary = env.WHISPER_BINARY || "whisper-cpp";
    const modelPath = env.WHISPER_MODEL_PATH || "";
    (await commandExists("ffmpeg")) ? pass("ffmpeg installed") : warn("ffmpeg not found — local voice transcription will fail");
    (await commandExists(whisperBinary)) ? pass(`${whisperBinary} installed`) : warn(`${whisperBinary} not found — local voice transcription will fail`);
    modelPath && existsSync(modelPath)
      ? pass(`Whisper model found: ${modelPath}`)
      : warn("WHISPER_MODEL_PATH missing or not found — local voice transcription will fail");
  } else {
    warn(`Unknown VOICE_PROVIDER: ${voiceProvider}`);
  }

  env.USER_NAME && !env.USER_NAME.includes("Your ")
    ? pass(`Name: ${env.USER_NAME}`)
    : warn("USER_NAME not set in .env");

  env.USER_TIMEZONE && env.USER_TIMEZONE !== "UTC"
    ? pass(`Timezone: ${env.USER_TIMEZONE}`)
    : warn("USER_TIMEZONE is UTC — update to your local timezone");

  // Binary Architecture (macOS 28 Rosetta end-of-life warning)
  if (process.platform === "darwin") {
    console.log(`\n${bold("  Binary Architecture")}`);
    const claudePath =
      env.CLAUDE_PATH ||
      join(homedir(), ".local", "bin", "claude");
    try {
      const archReport = checkRelayBinaries(claudePath);

      const bunMsg = `bun (${archReport.bun.path}): ${archLabel(archReport.bun.arch)}`;
      archReport.bun.rosettaWarning ? fail(bunMsg) : pass(bunMsg);

      const claudeMsg = `claude (${archReport.claude.path}): ${archLabel(archReport.claude.arch)}`;
      archReport.claude.rosettaWarning ? fail(claudeMsg) : pass(claudeMsg);

      if (archReport.currentProcessRosetta) {
        fail(
          "bun is currently running under Rosetta — this relay stops working in macOS 28. " +
          "Fix: curl -fsSL https://bun.sh/install | bash",
        );
      } else if (!archReport.bun.rosettaWarning && !archReport.claude.rosettaWarning) {
        pass("No Intel-only binaries detected — relay is macOS 28 ready");
      }
    } catch (err) {
      warn(`Arch check failed (macOS 28 readiness check): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  console.log(`\n${bold("  Summary")}`);
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? red(`${failed} failed`) : ""}  ${warned > 0 ? yellow(`${warned} warnings`) : ""}`);

  if (failed === 0) {
    console.log(`\n  ${green("Your bot is ready!")} Run: bun run start`);
  } else {
    console.log(`\n  ${red("Fix the failures above, then re-run:")} bun run setup:verify`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
