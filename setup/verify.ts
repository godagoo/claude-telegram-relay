/**
 * Claude Telegram Relay — Verify Setup
 *
 * Runs all health checks in sequence: env, Telegram, Supabase,
 * services, and reports overall status.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync, readFileSync, statSync } from "fs";
import { mkdtemp, readFile, realpath, rm } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import * as os from "os";
import {
  WRAPPER_BUNDLE_ID,
  isWrapperInstalled,
  wrapperPaths,
} from "./wrapper-bundle.ts";
import { tokenHash, tokenLockPath } from "../src/token-lock.ts";
import { redactBotToken } from "../src/redact-token.ts";
import {
  bunRealpathDriftCheck,
  launchdPathDriftCheck,
  parseLaunchdPlistJson,
  selectResolverPython,
  type LaunchdPolicy,
} from "./verify-checks.ts";
import {
  buildHealthReport,
  findRelayProcesses,
  loadErrorLogState,
  loadTokenLockState,
  resolveRelayErrorLogPath,
} from "./health-check.ts";
import { launchdPath } from "./launchd-env.ts";
import { runCommandWithTimeout } from "./process-timeout.ts";
import { getSupabaseFeatureConfig } from "../src/supabase-config.ts";
import { checkRelayBinaries, archLabel } from "../src/arch-check.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const COMMAND_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const LAUNCHD_PATH = launchdPath(homedir());
const MANAGED_LAUNCHD_SERVICES = [
  { name: "relay", label: "com.claude.telegram-relay" },
  { name: "checkin", label: "com.claude.smart-checkin" },
  { name: "briefing", label: "com.claude.morning-briefing" },
] as const;

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

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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

function commandFailureText(result: { code: number; stdout: string; stderr: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
}

async function loadLaunchdPolicyFromPlist(
  plistPath: string,
): Promise<{ policy?: LaunchdPolicy; error?: string }> {
  const plutil = await runCommand(
    ["plutil", "-convert", "json", "-o", "-", plistPath],
    { timeoutMs: 5_000 },
  );
  if (plutil.code !== 0) {
    return { error: plutil.stderr.trim() || plutil.stdout.trim() || `exit ${plutil.code}` };
  }
  const policy = parseLaunchdPlistJson(plutil.stdout);
  if (!policy) {
    return { error: "plist JSON did not parse into a recognizable policy" };
  }
  return { policy };
}

function reportLaunchdPathDrift(
  label: string,
  serviceName: string,
  policy: LaunchdPolicy,
): void {
  const drift = launchdPathDriftCheck(policy.environment.PATH, LAUNCHD_PATH);
  if (drift.ok) {
    pass(`${label} plist PATH matches launchdPath() helper`);
  } else if (drift.reason === "missing") {
    fail(`${label} plist EnvironmentVariables.PATH is unset. Re-run: bun run setup:launchd -- --service ${serviceName}`);
  } else {
    fail(
      `${label} plist PATH drift: plist has \`${drift.actual}\`, expected \`${drift.expected}\`. ` +
        `Re-run: bun run setup:launchd -- --service ${serviceName}`,
    );
  }
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
    // Compute the FDA target string once. Both the chat.db failure
    // message and the FDA target report below use this same string so
    // operators never see two different "grant FDA to: ..." instructions
    // in one verify run. PLAN5: replace shell `readlink -f` with
    // fs.promises.realpath and unify the target across all callers.
    const wrapperAppRoot = process.env.RELAY_WRAPPER_APP_ROOT ||
      join(homedir(), "Applications", "ClaudeRelay.app");
    const wrapperExecPath = wrapperPaths(wrapperAppRoot).executable;
    const wrapperInstalled = isWrapperInstalled(wrapperAppRoot);
    const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
    const plistPathForLabel = (label: string) => join(launchAgentsDir, `${label}.plist`);
    const plistPath = plistPathForLabel("com.claude.telegram-relay");
    let fdaTargetDescription = "";
    let fdaTargetWarning = "";
    {
      let launchdFirstArg = "";
      if (existsSync(plistPath)) {
        const plutilFda = await runCommand(
          ["plutil", "-convert", "json", "-o", "-", plistPath],
          { timeoutMs: 5_000 },
        );
        if (plutilFda.code === 0) {
          try {
            const parsed = JSON.parse(plutilFda.stdout) as { ProgramArguments?: unknown };
            const args = Array.isArray(parsed?.ProgramArguments)
              ? (parsed.ProgramArguments as unknown[])
              : [];
            launchdFirstArg = typeof args[0] === "string" ? (args[0] as string) : "";
          } catch {
            // ignore; fall through to realpath
          }
        }
      }

      if (launchdFirstArg === wrapperExecPath && wrapperInstalled) {
        fdaTargetDescription = `${WRAPPER_BUNDLE_ID} (wrapper at ${wrapperAppRoot})`;
      } else {
        const symlinkPath = launchdFirstArg || process.execPath;
        try {
          const resolved = await realpath(symlinkPath);
          fdaTargetDescription = resolved !== symlinkPath
            ? `${resolved} (launchd ProgramArguments[0]=${symlinkPath})`
            : resolved;
        } catch (err) {
          fdaTargetDescription = symlinkPath;
          fdaTargetWarning =
            `Could not resolve realpath of ${symlinkPath}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            "FDA grants attached to this path may break after Bun upgrades.";
        }
      }
    }

    console.log(`\n${bold("  Services (launchd)")}`);
    let launchdRelayLoaded = false;
    for (const { label } of MANAGED_LAUNCHD_SERVICES) {
      const result = await runCommand(["launchctl", "list", label], { timeoutMs: 5_000 });
      result.code === 0 ? pass(`${label} loaded`) : warn(`${label} not loaded`);
      if (label === "com.claude.telegram-relay" && result.code === 0) {
        launchdRelayLoaded = true;
      }
    }
    let launchdPlistStandardErrorPath: string | undefined;
    let launchdEnvLogDir: string | undefined;
    let launchdEnvRelayDir: string | undefined;
    let launchdEnvRelayPython: string | undefined;

    let launchdLiveStandardErrorPath: string | undefined;
    const launchdPrint = await runCommand(
      ["launchctl", "print", `gui/${process.getuid()}/com.claude.telegram-relay`],
      { timeoutMs: 5_000 },
    );
    if (launchdPrint.code === 0) {
      const stdoutPath = launchdPrint.stdout.match(/^\s*stdout path = (.+)$/m)?.[1]?.trim();
      const stderrPath = launchdPrint.stdout.match(/^\s*stderr path = (.+)$/m)?.[1]?.trim();
      if (stdoutPath) pass(`Relay launchd stdout log: ${stdoutPath}`);
      if (stderrPath) {
        // launchctl prints "(null)" when the bootstrapped job has no
        // StandardErrorPath; treat that as no live path so the resolver
        // falls back to the plist tier.
        if (stderrPath !== "(null)") launchdLiveStandardErrorPath = stderrPath;
        pass(`Relay launchd stderr log: ${stderrPath}`);
      }
    } else {
      warn(`Could not inspect relay launchd log paths: ${launchdPrint.stderr.trim() || launchdPrint.stdout.trim() || `exit ${launchdPrint.code}`}`);
    }

    // launchd plist policy check (plistPath declared above with the FDA target).
    if (existsSync(plistPath)) {
      const loaded = await loadLaunchdPolicyFromPlist(plistPath);
      if (loaded.error || !loaded.policy) {
        fail(`Could not read launchd plist: ${loaded.error}`);
      } else {
        const policy = loaded.policy;
        launchdPlistStandardErrorPath = policy.standardErrorPath;
        launchdEnvLogDir = policy.environment.RELAY_LOG_DIR;
        launchdEnvRelayDir = policy.environment.RELAY_DIR;
        launchdEnvRelayPython = policy.environment.RELAY_PYTHON;
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
        reportLaunchdPathDrift("com.claude.telegram-relay", "relay", policy);
      }
    } else {
      warn(`launchd plist not installed at ${plistPath}`);
    }

    for (const { name, label } of MANAGED_LAUNCHD_SERVICES) {
      if (label === "com.claude.telegram-relay") continue;
      const path = plistPathForLabel(label);
      if (!existsSync(path)) continue;
      const loaded = await loadLaunchdPolicyFromPlist(path);
      if (loaded.error || !loaded.policy) {
        fail(`Could not read ${label} plist: ${loaded.error}`);
      } else {
        reportLaunchdPathDrift(label, name, loaded.policy);
      }
    }

    const serviceProcessLines = processLines || await getProcessLines();
    let relayProcessCount = 0;
    if (serviceProcessLines) {
      const relayProcesses = findRelayProcesses(serviceProcessLines);
      relayProcessCount = relayProcesses.length;

      // Long-lived `claude --dangerously-skip-permissions` shells are not
      // the launchd relay but can confuse operators looking at ps output.
      // This is not part of the read-only health check; verify owns it.
      const claudeShells = serviceProcessLines.filter((line) =>
        /\bclaude --dangerously-skip-permissions\b/.test(line)
      );
      if (claudeShells.length > 0) {
        warn(`Long-lived Claude Code shell process found (${claudeShells.length}); not the launchd relay`);
      }

      // Shared health checks: singleton, token-lock, recent error log.
      // Embedded mode keeps zero relays advisory unless launchd reports
      // the job is loaded, in which case zero relays is a hard fail.
      if (token) {
        const lockPath = tokenLockPath(token);
        const errorLogPath = resolveRelayErrorLogPath({
          launchdLiveStandardErrorPath,
          launchdPlistStandardErrorPath,
          launchdEnvLogDir,
          launchdEnvRelayDir,
          dotenvLogDir: env.RELAY_LOG_DIR,
          dotenvRelayDir: env.RELAY_DIR,
          homeDir: homedir(),
        });
        const report = buildHealthReport({
          mode: "embedded",
          launchdRelayLoaded,
          tokenConfigured: true,
          processLines: serviceProcessLines,
          tokenLockState: loadTokenLockState(lockPath),
          lockPath,
          expectedHost: os.hostname(),
          expectedTokenHash: tokenHash(token),
          now: new Date(),
          errorLog: loadErrorLogState(errorLogPath),
          errorLogPath,
        });
        for (const line of report.lines) {
          if (line.severity === "pass") pass(line.message);
          else if (line.severity === "warn") warn(line.message);
          else fail(line.message);
        }
      } else {
        warn("Cannot run relay health checks without TELEGRAM_BOT_TOKEN");
      }

      // Legacy bot.lock must not exist after the token-lock cutover.
      // PLAN6: this is a hard FAIL — the file is a stale artifact from
      // the pre-PLAN-A relay code. The operator runbook removes it
      // before bootstrap; if it survives, the cutover wasn't completed.
      const legacyLockPath = join(RELAY_DIR, "bot.lock");
      if (existsSync(legacyLockPath)) {
        fail(`Legacy ${legacyLockPath} still present. Remove it: rm ${legacyLockPath}`);
      }
    } else {
      warn("Could not inspect local relay processes");
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
      } else if (probe.code === 124) {
        warn("iMessage chat.db read probe timed out (database likely locked by Messages or mds). Close Messages and re-run setup:verify.");
      } else {
        fail(
          `iMessage chat.db read failed: ${commandFailureText(probe)}. ` +
          `Grant Full Disk Access to: ${fdaTargetDescription}`,
        );
      }
    } else {
      warn(`No chat.db at ${chatDbPath}; FDA probe skipped`);
    }

    // Bun realpath stability — verify is READ-ONLY. The recorded baseline
    // is written by setup:launchd at install time (see configure-launchd.ts).
    // PLAN3: "setup:verify writes... verification should be read-only."
    let currentBunRealpath = "";
    try {
      currentBunRealpath = await realpath(process.execPath);
    } catch (err) {
      warn(`Could not resolve Bun realpath: ${err instanceof Error ? err.message : String(err)}; FDA target may drift unnoticed`);
    }
    if (currentBunRealpath) {
      const recordPath = join(RELAY_DIR, "state", "bun-realpath");
      const previousRealpath = existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim() : null;
      const drift = bunRealpathDriftCheck(currentBunRealpath, previousRealpath);
      if (!drift.ok && drift.drifted) {
        fail(
          `Bun realpath drifted: was ${previousRealpath}, now ${currentBunRealpath}. ` +
          "Re-grant Full Disk Access to the new realpath, then rerun: bun run setup:launchd",
        );
      } else if (previousRealpath === null) {
        warn(
          `No baseline Bun realpath recorded at ${recordPath}. ` +
          "Run: bun run setup:launchd to record it.",
        );
      } else {
        pass(`Bun realpath stable: ${currentBunRealpath}`);
      }
    }

    pass(`FDA responsible target: ${fdaTargetDescription}`);
    if (fdaTargetWarning) warn(fdaTargetWarning);
    if (currentBunRealpath) {
      const tccDb = join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
      if (existsSync(tccDb)) {
        // tccd.app can hold a writer lock against TCC.db while a permission
        // sheet is open; bound the probe so verify never wedges.
        const automationGrant = await runCommand(
          [
            "sqlite3",
            "-readonly",
            tccDb,
            [
              "SELECT auth_value FROM access",
              "WHERE service='kTCCServiceAppleEvents'",
              `AND client=${sqlQuote(currentBunRealpath)}`,
              "AND client_type=1",
              "AND indirect_object_identifier='com.apple.MobileSMS'",
              "ORDER BY last_modified DESC LIMIT 1;",
            ].join(" "),
          ],
          { timeoutMs: 5_000 },
        );
        const authValue = automationGrant.stdout.trim();
        if (automationGrant.code === 0 && authValue === "2") {
          pass("Automation grant present for launchd bun -> Messages");
        } else if (automationGrant.code === 124) {
          warn(`TCC Automation probe timed out for launchd bun -> Messages (TCC.db locked by tccd?): ${currentBunRealpath}`);
        } else if (automationGrant.code !== 0) {
          warn(`TCC Automation probe failed for launchd bun -> Messages: ${commandFailureText(automationGrant)}`);
        } else {
          warn(`Automation grant missing for launchd bun -> Messages: ${currentBunRealpath}`);
        }
      } else {
        warn(`TCC database not readable for Automation check: ${tccDb}`);
      }
    }
    // PLAN6: the shell-script wrapper is experimental — it has not been
    // verified to bind TCC to its bundle id on this macOS version. Do not
    // push operators toward it. The documented path is direct Bun realpath
    // FDA, which is the same realpath we report above. The wrapper is
    // tracked for a future native-Mach-O or SMAppService rollout.
    pass(`Launchd label: com.claude.telegram-relay`);
    // PID-count line tracks the singleton-relay policy: a count of 1 is
    // a pass; a count of 0 is a fail when launchd thinks the job is
    // loaded and a warning otherwise; >1 is a fail (already covered by
    // the singleton check above, repeated here for the summary).
    const pidCountMsg = `Active relay PID count: ${relayProcessCount}`;
    if (relayProcessCount === 1) {
      pass(pidCountMsg);
    } else if (relayProcessCount === 0) {
      launchdRelayLoaded ? fail(pidCountMsg) : warn(pidCountMsg);
    } else {
      fail(pidCountMsg);
    }

    console.log(`\n${bold("  iMessage Staging Handoff")}`);
    const stageScript = join(PROJECT_ROOT, "scripts", "stage-imessage.sh");
    const stagingHandle = env.RELAY_IMESSAGE_STAGING_HANDLE || process.env.RELAY_IMESSAGE_STAGING_HANDLE || "";

    if (!existsSync(stageScript)) {
      fail(`Staging helper missing: ${stageScript}`);
    } else {
      const stat = statSync(stageScript);
      (stat.mode & 0o111) !== 0
        ? pass("Staging helper is executable")
        : fail(`Staging helper is not executable: chmod +x ${stageScript}`);
    }

    stagingHandle.trim()
      ? pass("RELAY_IMESSAGE_STAGING_HANDLE is set")
      : warn("RELAY_IMESSAGE_STAGING_HANDLE not set - iMessage draft staging is disabled until configured");

    if (existsSync(stageScript)) {
      const dryRunRoot = await mkdtemp(join(os.tmpdir(), "relay-stage-verify-"));
      const dryRunPayload = join(dryRunRoot, "payload.txt");
      try {
        const dryRun = await runCommand(
          [
            "/bin/sh",
            "-lc",
            "printf '%s' 'setup verify body' | \"$1\" '+15555550123' 'Setup Verify'",
            "sh",
            stageScript,
          ],
          {
            cwd: PROJECT_ROOT,
            env: {
              ...process.env,
              RELAY_IMESSAGE_STAGING_HANDLE: stagingHandle.trim() || "+15555550000",
              RELAY_STAGE_IMESSAGE_DRY_RUN_PATH: dryRunPayload,
            },
          },
        );
        if (dryRun.code === 0) {
          const payload = await readFile(dryRunPayload, "utf8");
          try {
            const parsed = JSON.parse(payload) as {
              version?: string;
              to?: string;
              label?: string;
              body?: string;
            };
            if (
              parsed.version === "CLDRAFT/1" &&
              parsed.to === "+15555550123" &&
              parsed.label === "Setup Verify" &&
              parsed.body === "setup verify body"
            ) {
              pass("Staging helper dry-run payload validates");
            } else {
              fail(`Staging helper dry-run payload mismatch: ${JSON.stringify(payload)}`);
            }
          } catch {
            fail(`Staging helper dry-run payload is not JSON: ${JSON.stringify(payload)}`);
          }
        } else {
          fail(`Staging helper dry-run failed: ${(dryRun.stderr || dryRun.stdout).trim()}`);
        }
      } finally {
        await rm(dryRunRoot, { recursive: true, force: true });
      }
    }

    if (await commandExists("shortcuts")) {
      pass("shortcuts CLI installed");
    } else {
      fail("shortcuts CLI not found");
    }

    const shortcutsDb = join(homedir(), "Library", "Shortcuts", "Shortcuts.sqlite");
    if (existsSync(shortcutsDb)) {
      const stageShortcutCheckScript = String.raw`
import plistlib
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
row = conn.execute(
    """
    SELECT s.ZNAME, t.ZDATA, a.ZDATA, s.ZHASSHORTCUTINPUTVARIABLES, s.ZINPUTCLASSESDATA
    FROM ZTRIGGER t
    JOIN ZSHORTCUT s ON s.Z_PK=t.ZSHORTCUT
    JOIN ZSHORTCUTACTIONS a ON a.ZSHORTCUT=s.Z_PK
    WHERE t.ZENABLED=1
      AND t.ZSHOULDPROMPT=0
    ORDER BY s.ZMODIFICATIONDATE DESC
    """
).fetchall()
if not row:
    raise SystemExit("ClaudeStageDraft automation is missing or not set to Run Immediately")

matching = [r for r in row if b"CLDRAFT/1" in (r[1] or b"")]
if not matching:
    raise SystemExit("Shortcuts Message automation is not filtered on CLDRAFT/1")

shortcut_name, trigger_blob, actions_blob, has_shortcut_input, input_classes_blob = matching[0]
if shortcut_name != "ClaudeStageDraft":
    raise SystemExit(
        f"Mac CLDRAFT/1 automation points to {shortcut_name!r}; "
        "iPhone production should run ClaudeDraft from its own Personal Automation. "
        "Disable this Mac automation if it opens unwanted Mac compose sheets."
    )

if b"CLDRAFT/1" not in trigger_blob:
    raise SystemExit("ClaudeStageDraft Message automation is not filtered on CLDRAFT/1")

if has_shortcut_input != 1:
    raise SystemExit("ClaudeStageDraft must be saved as a shortcut that receives Shortcut Input; otherwise Run Shortcut passes an empty value")

try:
    input_classes = plistlib.loads(input_classes_blob or b"")
except Exception:
    input_classes = []
if not input_classes:
    raise SystemExit("ClaudeStageDraft accepted input classes are empty; reinstall or re-save it so the iPhone can pass the Message automation input")

actions = plistlib.loads(actions_blob)

def params(action):
    return action.get("WFWorkflowActionParameters", {})

def action_id(action):
    return action.get("WFWorkflowActionIdentifier")

def output_uuid(value):
    if not isinstance(value, dict):
        return None
    wrapped = value.get("Value")
    if isinstance(wrapped, dict):
        return wrapped.get("OutputUUID")
    return value.get("OutputUUID")

def input_uuid(action):
    return output_uuid(params(action).get("WFInput"))

def has_content_shortcut_input(action):
    wf_input = params(action).get("WFInput", {})
    value = wf_input.get("Value", {}) if isinstance(wf_input, dict) else {}
    if value.get("Type") != "ExtensionInput":
        return False
    aggrandizements = value.get("Aggrandizements", [])
    return any(
        isinstance(item, dict)
        and item.get("Type") == "WFPropertyVariableAggrandizement"
        and item.get("PropertyName") == "Content"
        for item in aggrandizements
    )

text_action = next((a for a in actions if action_id(a) == "is.workflow.actions.detect.text"), None)
if not text_action:
    raise SystemExit("ClaudeStageDraft is missing Get Text from Shortcut Input")
if not has_content_shortcut_input(text_action):
    raise SystemExit("Get Text must read Shortcut Input > Content; otherwise Send Message opens with no recipient")
text_uuid = params(text_action).get("UUID")

dict_action = next((a for a in actions if action_id(a) == "is.workflow.actions.detect.dictionary"), None)
if not dict_action:
    raise SystemExit("ClaudeStageDraft is missing Get Dictionary from Text")
dict_uuid = params(dict_action).get("UUID")
if input_uuid(dict_action) != text_uuid:
    raise SystemExit("Get Dictionary must read the Text output")

lookups = [
    a for a in actions
    if action_id(a) == "is.workflow.actions.getvalueforkey"
]
lookup_by_key = {params(a).get("WFDictionaryKey"): a for a in lookups}
to_action = lookup_by_key.get("to")
body_action = lookup_by_key.get("body")
if not to_action or not body_action:
    raise SystemExit("ClaudeStageDraft must look up both to and body from the payload")
if input_uuid(to_action) != dict_uuid or input_uuid(body_action) != dict_uuid:
    raise SystemExit("to/body lookups must read the parsed CLDRAFT dictionary")

send_action = next((a for a in actions if action_id(a) == "is.workflow.actions.sendmessage"), None)
if not send_action:
    raise SystemExit("ClaudeStageDraft is missing Send Message")
send_params = params(send_action)
if send_params.get("ShowWhenRun") is not True:
    raise SystemExit("Send Message must have Show When Run enabled")
recipient_uuid = output_uuid(send_params.get("WFSendMessageActionRecipients"))
if recipient_uuid != params(to_action).get("UUID"):
    raise SystemExit("Send Message recipient must be the to dictionary value")
content = send_params.get("WFSendMessageContent", {})
body_uuid = None
if isinstance(content, dict):
    value = content.get("Value", {})
    if isinstance(value, dict):
        attachments = value.get("attachmentsByRange", {})
        if isinstance(attachments, dict) and len(attachments) == 1:
            body_uuid = output_uuid(next(iter(attachments.values())))
if body_uuid != params(body_action).get("UUID"):
    raise SystemExit("Send Message body must be the body dictionary value")

print("ok")
`;

      // Shortcuts.app holds a writer lock while open; without a timeout the
      // verify script blocks indefinitely. Match the chat.db / TCC probe
      // budget (5s) so a busy DB surfaces a warn-level message instead.
      const shortcutCheck = await runCommand(
        [
          "python3",
          "-c",
          stageShortcutCheckScript,
          shortcutsDb,
        ],
        { timeoutMs: 5_000 },
      );
      if (shortcutCheck.code === 0) {
        pass("Shortcuts Message automation installed for CLDRAFT/1 -> ClaudeStageDraft");
      } else if (shortcutCheck.code === 124) {
        warn(`Shortcuts.sqlite query timed out (DB likely locked by Shortcuts.app). Close Shortcuts.app and re-run setup:verify.`);
      } else if (shortcutCheck.code !== 0) {
        warn(`Shortcuts Message automation check failed: ${commandFailureText(shortcutCheck)}`);
      } else {
        warn("Manual check: Shortcuts.app Automation must have Message Contains=CLDRAFT/1, Run Immediately, Shortcut Input > Content, and Send Message Show When Run=ON");
      }
      // The above only covers the Mac diagnostic copy. The iPhone production
      // Shortcut (ClaudeDraft) lives on the phone and is not reachable from
      // here. Surface the manual requirement on every run so an accidental
      // toggle on iPhone can never silently turn the relay into an auto-send.
      // The user explicitly accepted in PR 2 planning that contact ambiguity
      // is resolved silently by most-recent-activity, which makes this flag
      // the load-bearing safety net.
      warn("Manual check (iPhone): the ClaudeDraft Shortcut's Send Message action must have Show When Run = ON. The Mac check above does not reach the phone.");
    } else {
      warn(`Shortcuts database not found: ${shortcutsDb}`);
    }

    console.log(`\n${bold("  iMessage Contact Resolver")}`);
    const resolverPath = join(PROJECT_ROOT, "scripts", "resolve-contact.py");
    const resolverEnv = { ...process.env, PATH: LAUNCHD_PATH, HOME: homedir() };
    const pythonSelection = selectResolverPython({
      launchdPython: launchdEnvRelayPython,
      envPython: env.RELAY_PYTHON,
    });
    const effectivePython = pythonSelection.command;

    if (pythonSelection.source === "launchd_plist") {
      pass(`RELAY_PYTHON pinned by launchd plist: ${effectivePython}`);
    } else if (pythonSelection.source === "env") {
      pass(`RELAY_PYTHON pinned by .env: ${effectivePython}`);
    } else {
      warn("RELAY_PYTHON not set in launchd plist or .env - using python3 on launchd PATH (may differ from your shell)");
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
      pythonSelection.pinned
        ? [effectivePython, "-c", pythonVersionCode]
        : ["/bin/sh", "-c", `command -v python3 && python3 -c ${JSON.stringify(pythonVersionCode)}`],
      { env: resolverEnv },
    );
    if (launchdPython.code === 0) {
      pass(`${pythonSelection.label} resolves python3: ${launchdPython.stdout.trim().replace(/\n/g, " ")}`);
    } else {
      fail(pythonSelection.pinned
        ? `${pythonSelection.label}=${effectivePython} is not executable or not found`
        : `launchd PATH cannot resolve python3 from ${LAUNCHD_PATH}`);
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
