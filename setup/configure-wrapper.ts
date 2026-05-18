/**
 * Generate the ~/Applications/ClaudeRelay.app wrapper bundle so TCC/FDA
 * grants attach to a stable bundle ID rather than the versioned Bun
 * realpath. Usage:
 *
 *   bun run setup:wrapper
 *
 * After running this, grant Full Disk Access to ~/Applications/ClaudeRelay.app
 * in System Settings, then rerun `bun run setup:launchd` so the LaunchAgent
 * points at the wrapper executable.
 */

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  WRAPPER_BUNDLE_ID,
  WRAPPER_BUNDLE_NAME,
  WRAPPER_EXECUTABLE_NAME,
  generateWrapperInfoPlist,
  generateWrapperShellScript,
} from "./wrapper-bundle.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const RELAY_DIR = process.env.RELAY_DIR || join(HOME, ".claude-relay");
const LOGS_DIR = process.env.RELAY_LOG_DIR || join(RELAY_DIR, "logs");
const WRAPPER_APP_ROOT = process.env.RELAY_WRAPPER_APP_ROOT ||
  join(HOME, "Applications", `${WRAPPER_BUNDLE_NAME}.app`);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

function resolveBunPath(): string {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  const proc = Bun.spawnSync(["which", "bun"]);
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (out) {
    try {
      return realpathSync(out);
    } catch {
      return out;
    }
  }
  return "bun";
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(Bun.file(join(PROJECT_ROOT, "package.json")).text() as unknown as string);
    return typeof pkg?.version === "string" ? pkg.version : "1.0.0";
  } catch {
    return "1.0.0";
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log(`  ${FAIL} ClaudeRelay wrapper is macOS-only.`);
    process.exit(1);
  }

  console.log("");
  console.log(bold("  Configure ClaudeRelay wrapper bundle"));
  console.log(dim(`  Bundle: ${WRAPPER_APP_ROOT}`));
  console.log(dim(`  Bundle ID: ${WRAPPER_BUNDLE_ID}`));
  console.log("");

  const bunRealpath = resolveBunPath();
  const version = readPackageVersion();

  const env: Record<string, string> = {
    HOME,
    PATH: `${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    RELAY_DIR,
    RELAY_LOG_DIR: LOGS_DIR,
    CLAUDE_PATH: `${HOME}/.local/bin/claude`,
    CLAUDE_TIMEOUT_MS: process.env.CLAUDE_TIMEOUT_MS || "90000",
    CLAUDE_RESUME: process.env.CLAUDE_RESUME || "0",
    RELAY_FDA_BUNDLE_ID: WRAPPER_BUNDLE_ID,
  };
  if (process.env.RELAY_PYTHON) env.RELAY_PYTHON = process.env.RELAY_PYTHON;

  const contentsDir = join(WRAPPER_APP_ROOT, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  mkdirSync(macosDir, { recursive: true, mode: 0o755 });

  const infoPlistPath = join(contentsDir, "Info.plist");
  writeFileSync(infoPlistPath, generateWrapperInfoPlist({ version }), { mode: 0o644 });
  console.log(`  ${PASS} Wrote ${infoPlistPath}`);

  const execPath = join(macosDir, WRAPPER_EXECUTABLE_NAME);
  writeFileSync(
    execPath,
    generateWrapperShellScript({
      bunRealpath,
      projectRoot: PROJECT_ROOT,
      script: "src/relay.ts",
      env,
      logsDir: LOGS_DIR,
    }),
    { mode: 0o755 },
  );
  chmodSync(execPath, 0o755);
  console.log(`  ${PASS} Wrote ${execPath}`);

  console.log("");
  console.log(bold("  Next steps"));
  console.log(`  1. Open System Settings > Privacy & Security > Full Disk Access.`);
  console.log(`     Add ${WRAPPER_APP_ROOT}.`);
  console.log(`  2. Rerun: ${dim("bun run setup:launchd")}`);
  console.log(`  3. Verify: ${dim("bun run setup:verify")}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
