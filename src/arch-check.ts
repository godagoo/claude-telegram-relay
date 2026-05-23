export type BinaryArch = "arm64" | "x86_64" | "universal" | "unknown";

export interface BinaryArchInfo {
  path: string;
  arch: BinaryArch;
  rosettaWarning: boolean; // true when arch === "x86_64"
}

export interface ArchReport {
  bun: BinaryArchInfo;
  claude: BinaryArchInfo;
  currentProcessRosetta: boolean;
  hasWarnings: boolean;
}

/**
 * Runs /usr/bin/file <binaryPath> and parses the Mach-O arch from output.
 * Returns "unknown" on error or non-Mach-O output. SYNCHRONOUS.
 */
export function getBinaryArch(binaryPath: string): BinaryArch {
  const result = Bun.spawnSync({
    cmd: ["/usr/bin/file", binaryPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return "unknown";

  const output = new TextDecoder().decode(result.stdout);
  const hasArm64 = output.includes("arm64");
  const hasX86 = output.includes("x86_64");

  if (hasArm64 && hasX86) return "universal";
  if (hasArm64) return "arm64";
  if (hasX86) return "x86_64";
  return "unknown";
}

/**
 * Runs `/usr/sbin/sysctl -n sysctl.proc_translated`. Returns true when the
 * current process is running under Rosetta. SYNCHRONOUS.
 *
 * launchd agents commonly run with a narrow PATH that excludes /usr/sbin.
 * Keep this absolute like the /usr/bin/file probe above so preflight behavior
 * does not depend on Terminal's interactive shell environment.
 */
export function isRosettaProcess(): boolean {
  const result = Bun.spawnSync({
    cmd: ["/usr/sbin/sysctl", "-n", "sysctl.proc_translated"],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return false;

  const output = new TextDecoder().decode(result.stdout).trim();
  return output === "1";
}

/**
 * Checks bun (process.execPath) and claude (claudePath).
 * hasWarnings is true when any binary is x86_64 OR currentProcessRosetta.
 * SYNCHRONOUS.
 */
export function checkRelayBinaries(claudePath: string): ArchReport {
  const currentProcessRosetta = isRosettaProcess();

  const bunArch = getBinaryArch(process.execPath);
  const bunInfo: BinaryArchInfo = {
    path: process.execPath,
    arch: bunArch,
    rosettaWarning: bunArch === "x86_64",
  };

  const claudeArch = getBinaryArch(claudePath);
  const claudeInfo: BinaryArchInfo = {
    path: claudePath,
    arch: claudeArch,
    rosettaWarning: claudeArch === "x86_64",
  };

  const hasWarnings =
    bunInfo.rosettaWarning || claudeInfo.rosettaWarning || currentProcessRosetta;

  return {
    bun: bunInfo,
    claude: claudeInfo,
    currentProcessRosetta,
    hasWarnings,
  };
}

/**
 * Human-readable label for a BinaryArch value.
 */
export function archLabel(arch: BinaryArch): string {
  switch (arch) {
    case "arm64":
      return "Apple silicon ✓";
    case "universal":
      return "Universal (Intel + Apple silicon) ✓";
    case "x86_64":
      return "Intel only — will break in macOS 28 ✗";
    case "unknown":
      return "unknown";
  }
}
