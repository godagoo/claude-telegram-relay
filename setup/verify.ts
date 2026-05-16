/**
 * Claude Telegram Relay — Verify Setup
 *
 * Runs all health checks in sequence: env, Telegram, Supabase,
 * services, and reports overall status.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import {
  DEFAULT_SHORTCUT_NAME,
  defaultICloudDriveDraftDir,
  ICLOUD_DRIVE_DRAFT_FILE_NAME,
} from "../src/icloud-drive-draft.ts";
import {
  readInstalledShortcutActions,
  readSignedShortcutFileActions,
  validateClaudeDraftShortcutActions,
} from "./shortcut-verify.ts";
import { getSupabaseFeatureConfig } from "../src/supabase-config.ts";
import { checkRelayBinaries, archLabel } from "../src/arch-check.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");

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
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: options.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
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
  const proc = Bun.spawn(["/bin/sh", "-lc", `command -v "$1" >/dev/null 2>&1`, "sh", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
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

  if (!token || token.includes("your_")) {
    fail("TELEGRAM_BOT_TOKEN not set");
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json() as any;
      data.ok ? pass(`Bot: @${data.result.username}`) : fail(`Invalid token: ${data.description}`);
    } catch (e: any) {
      fail(`Telegram API unreachable: ${e.message}`);
    }
  }

  if (!userId || userId.includes("your_")) {
    fail("TELEGRAM_USER_ID not set");
  } else if (!/^\d+$/.test(userId)) {
    fail("TELEGRAM_USER_ID must be numeric");
  } else {
    pass(`User ID: ${userId}`);
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
      const proc = Bun.spawn(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      code === 0 ? pass(`${label} loaded`) : warn(`${label} not loaded`);
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

    draftDir.includes("iCloud~is~workflow~my~workflows")
      ? fail("RELAY_ICLOUD_DRAFT_DIR points at the non-syncing Shortcuts container")
      : pass("Relay iCloud draft dir avoids the Shortcuts container");

    existsSync(draftPath)
      ? pass(`Latest iCloud draft exists: ${draftPath}`)
      : warn(`Latest iCloud draft missing: ${draftPath} — send one draft to create it`);

    if (existsSync(draftPath)) {
      try {
        const payload = JSON.parse(await Bun.file(draftPath).text()) as Record<string, unknown>;
        typeof payload.recipient === "string" && typeof payload.body === "string" &&
          typeof payload.ts === "string" && /^[a-f0-9]{64}$/.test(String(payload.body_sha256 ?? ""))
          ? pass("Latest iCloud draft payload shape OK")
          : fail("Latest iCloud draft payload is missing recipient/body/ts/body_sha256");
      } catch (e: any) {
        fail(`Latest iCloud draft is not valid JSON: ${e.message}`);
      }
    }

    existsSync(legacyShortcutsPath)
      ? warn(`Legacy Shortcuts-container draft still exists: ${legacyShortcutsPath}`)
      : pass("No stale Shortcuts-container draft file");

    console.log(`\n${bold("  iMessage Contact Resolver")}`);
    const resolverPath = join(PROJECT_ROOT, "scripts", "resolve-contact.py");
    const launchdPath = `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
    const resolverEnv = { ...process.env, PATH: launchdPath, HOME: homedir() };

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
        pass(`python3 ${version.stdout.trim()} available`);
      } else {
        fail(`python3 must be >= 3.7 for scripts/resolve-contact.py; got ${version.stdout.trim() || version.stderr.trim() || "unknown"}`);
      }
    }

    const launchdPython = await runCommand(
      [
        "/bin/sh",
        "-c",
        "command -v python3 && python3 -c 'import sys; print(f\"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\")'",
      ],
      { env: resolverEnv },
    );
    if (launchdPython.code === 0) {
      pass(`launchd PATH resolves python3: ${launchdPython.stdout.trim().replace(/\n/g, " ")}`);
    } else {
      fail(`launchd PATH cannot resolve python3 from ${launchdPath}`);
    }

    if (existsSync(resolverPath) && launchdPython.code === 0) {
      const compile = await runCommand(["python3", "-m", "py_compile", resolverPath], {
        cwd: PROJECT_ROOT,
        env: resolverEnv,
      });
      compile.code === 0
        ? pass("Contact resolver compiles with launchd python3")
        : fail(`Contact resolver does not compile with launchd python3: ${(compile.stderr || compile.stdout).trim()}`);

      const directResolution = await runCommand(
        ["python3", resolverPath, "+15555550123"],
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
