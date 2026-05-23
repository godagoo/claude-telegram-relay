/**
 * Claude Telegram Relay — Setup
 *
 * Checks prerequisites, installs dependencies, creates directories,
 * and prepares .env file.
 *
 * Usage: bun run setup/install.ts
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const REQUIRED_PROJECT_DIRS = ["logs"];
const REQUIRED_RELAY_DIRS = ["logs", "temp", "uploads", "state", join("state", "chats"), join("state", "updates")];

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// --- Checks ---

async function checkBun(): Promise<boolean> {
  const result = await run(["bun", "--version"]);
  if (result.ok) {
    console.log(`  ${PASS} Bun: v${result.stdout}`);
    return true;
  }
  console.log(`  ${FAIL} Bun: not installed`);
  console.log(`      ${dim("Install: curl -fsSL https://bun.sh/install | bash")}`);
  return false;
}

async function checkClaude(): Promise<boolean> {
  const claudePath = process.env.CLAUDE_PATH;
  if (claudePath) {
    const result = await run([claudePath, "--version"]);
    if (result.ok) {
      console.log(`  ${PASS} Claude Code: ${result.stdout}`);
      return true;
    }
  }

  const findCmd = process.platform === "win32" ? ["where", "claude"] : ["which", "claude"];
  const which = await run(findCmd);
  if (which.ok) {
    const version = await run(["claude", "--version"]);
    console.log(`  ${PASS} Claude Code: ${version.ok ? version.stdout : "found"}`);
    return true;
  }

  console.log(`  ${FAIL} Claude Code: not installed`);
  console.log(`      ${dim("Install: npm install -g @anthropic-ai/claude-code")}`);
  return false;
}

// --- Install ---

async function installDeps(): Promise<boolean> {
  console.log(`\n  Installing dependencies...`);
  const result = await run(["bun", "install"]);
  if (result.ok) {
    console.log(`  ${PASS} Dependencies installed`);
    return true;
  }
  console.log(`  ${FAIL} bun install failed`);
  return false;
}

function createDirs(): void {
  for (const dir of REQUIRED_PROJECT_DIRS) {
    const fullPath = join(PROJECT_ROOT, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  ${PASS} Created ${dir}/`);
    } else {
      console.log(`  ${PASS} ${dir}/ ${dim("(exists)")}`);
    }
  }

  for (const dir of REQUIRED_RELAY_DIRS) {
    const fullPath = join(RELAY_DIR, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true, mode: 0o700 });
      console.log(`  ${PASS} Created ${fullPath}`);
    } else {
      console.log(`  ${PASS} ${fullPath} ${dim("(exists)")}`);
    }
    try {
      chmodSync(fullPath, 0o700);
    } catch {
      console.log(`  ${WARN} Could not chmod ${fullPath} to 0700`);
    }
  }
}

function setupEnv(): boolean {
  const envPath = join(PROJECT_ROOT, ".env");
  const examplePath = join(PROJECT_ROOT, ".env.example");

  if (existsSync(envPath)) {
    console.log(`  ${PASS} .env ${dim("(exists)")}`);
    return true;
  }

  if (!existsSync(examplePath)) {
    console.log(`  ${FAIL} .env.example not found`);
    return false;
  }

  copyFileSync(examplePath, envPath);
  console.log(`  ${WARN} .env created from .env.example`);
  console.log(`      ${yellow(">>> Edit .env and add your API keys <<<")}`);
  return false;
}

// --- Main ---

async function main() {
  const platform = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform;

  console.log("");
  console.log(bold("  Claude Telegram Relay — Setup"));
  console.log(dim(`  ${platform} • ${process.arch}`));

  // 1. Prerequisites
  console.log(`\n${cyan("  [1/4] Prerequisites")}`);
  const bunOk = await checkBun();
  if (!bunOk) {
    console.log(`\n  ${red("Bun is required. Install it first.")}`);
    process.exit(1);
  }
  await checkClaude();

  // 2. Dependencies
  console.log(`\n${cyan("  [2/4] Dependencies")}`);
  const depsOk = await installDeps();
  if (!depsOk) process.exit(1);

  // 3. Directories
  console.log(`\n${cyan("  [3/4] Directories")}`);
  createDirs();

  // 4. Environment
  console.log(`\n${cyan("  [4/4] Environment")}`);
  const envReady = setupEnv();

  // Summary
  console.log(`\n${bold("  Next steps:")}`);
  console.log(dim("  ----------"));

  const steps: string[] = [];
  if (!envReady) {
    steps.push(`Edit .env with your API keys: ${cyan("$EDITOR .env")}`);
  }
  steps.push(`Test Telegram connection: ${cyan("bun run setup/test-telegram.ts")}`);
  steps.push(`Test Supabase connection: ${cyan("bun run setup/test-supabase.ts")}`);
  steps.push(`Start the bot: ${cyan("bun run start")}`);

  steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
