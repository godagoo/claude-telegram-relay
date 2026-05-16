import { expect, test, spyOn, afterEach } from "bun:test";
import {
  getBinaryArch,
  isRosettaProcess,
  checkRelayBinaries,
  archLabel,
} from "./arch-check";

// Helper to create a mock spawnSync return value
function mockResult(stdout: string, exitCode = 0) {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
  } as any;
}

test("getBinaryArch returns 'arm64' for arm64-only file output", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("/path: Mach-O 64-bit executable arm64")
  );
  const result = getBinaryArch("/some/path");
  spy.mockRestore();
  expect(result).toBe("arm64");
});

test("getBinaryArch returns 'x86_64' for Intel file output", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("/path: Mach-O 64-bit executable x86_64")
  );
  const result = getBinaryArch("/some/path");
  spy.mockRestore();
  expect(result).toBe("x86_64");
});

test("getBinaryArch returns 'universal' for fat binary output", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult(
      "/path: Mach-O universal binary with 2 architectures: [x86_64:...] [arm64:...]"
    )
  );
  const result = getBinaryArch("/some/path");
  spy.mockRestore();
  expect(result).toBe("universal");
});

test("getBinaryArch returns 'unknown' when file command fails", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("", 1)
  );
  const result = getBinaryArch("/some/path");
  spy.mockRestore();
  expect(result).toBe("unknown");
});

test("getBinaryArch returns 'unknown' for non-Mach-O output", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("/path: ASCII text")
  );
  const result = getBinaryArch("/some/path");
  spy.mockRestore();
  expect(result).toBe("unknown");
});

test("isRosettaProcess returns true when sysctl reports 1", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("1\n")
  );
  const result = isRosettaProcess();
  spy.mockRestore();
  expect(result).toBe(true);
});

test("isRosettaProcess returns false when sysctl reports 0", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("0\n")
  );
  const result = isRosettaProcess();
  spy.mockRestore();
  expect(result).toBe(false);
});

test("isRosettaProcess returns false when sysctl fails", () => {
  const spy = spyOn(Bun, "spawnSync").mockReturnValueOnce(
    mockResult("", 1)
  );
  const result = isRosettaProcess();
  spy.mockRestore();
  expect(result).toBe(false);
});

test("checkRelayBinaries hasWarnings false when all arm64", async () => {
  const spy = spyOn(Bun, "spawnSync")
    .mockReturnValueOnce(mockResult("0\n"))                              // isRosettaProcess sysctl
    .mockReturnValueOnce(mockResult("/path: Mach-O 64-bit executable arm64")) // bun arch
    .mockReturnValueOnce(mockResult("/path: Mach-O 64-bit executable arm64")); // claude arch
  const report = await checkRelayBinaries("/usr/local/bin/claude");
  spy.mockRestore();
  expect(report.hasWarnings).toBe(false);
  expect(report.bun.arch).toBe("arm64");
  expect(report.claude.arch).toBe("arm64");
});

test("checkRelayBinaries hasWarnings true when bun is x86_64", async () => {
  const spy = spyOn(Bun, "spawnSync")
    .mockReturnValueOnce(mockResult("0\n"))                              // isRosettaProcess sysctl
    .mockReturnValueOnce(mockResult("/path: Mach-O 64-bit executable x86_64")) // bun arch
    .mockReturnValueOnce(mockResult("/path: Mach-O 64-bit executable arm64")); // claude arch
  const report = await checkRelayBinaries("/usr/local/bin/claude");
  spy.mockRestore();
  expect(report.hasWarnings).toBe(true);
  expect(report.bun.rosettaWarning).toBe(true);
});

test("archLabel returns correct strings for all four values", () => {
  expect(archLabel("arm64")).toBe("Apple silicon ✓");
  expect(archLabel("universal")).toBe("Universal (Intel + Apple silicon) ✓");
  expect(archLabel("x86_64")).toBe("Intel only — will break in macOS 28 ✗");
  expect(archLabel("unknown")).toBe("unknown");
});
