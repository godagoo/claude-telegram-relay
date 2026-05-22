// Repo-hygiene regression: every git-tracked text source/doc file must be
// free of literal control bytes (U+0000–U+001F except \t,\n,\r, and U+007F).
//
// PLAN3: "Add a repo hygiene test that fails on literal NUL bytes in
// tracked source/docs."
//
// Tests that need NUL or other control characters in test fixtures should
// use escapes (e.g. "\x00", String.fromCharCode(0x80)) so the bytes only
// exist in the running test process, never on disk.

import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

const FILE_EXTENSIONS_TO_SCAN = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".sql",
  ".sh",
  ".py",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".css",
]);

function listTrackedFiles(): string[] {
  const out = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function shouldScan(filename: string): boolean {
  for (const ext of FILE_EXTENSIONS_TO_SCAN) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

function findControlByteOffsets(bytes: Buffer): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0A || b === 0x0D) continue;
    if (b < 0x20 || b === 0x7F) offsets.push(i);
  }
  return offsets;
}

describe("repo hygiene: no literal control bytes in tracked source/docs", () => {
  test("every tracked .ts/.md/.json/.sql/.sh/.py file is clean", () => {
    const files = listTrackedFiles().filter(shouldScan);
    const violations: { file: string; line: number; byte: string }[] = [];
    for (const rel of files) {
      const full = join(REPO_ROOT, rel);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const data = readFileSync(full);
      const offsets = findControlByteOffsets(data);
      if (offsets.length === 0) continue;
      for (const offset of offsets.slice(0, 3)) {
        const line = data.subarray(0, offset).toString("utf8").split("\n").length;
        const byte = `0x${data[offset].toString(16).padStart(2, "0")}`;
        violations.push({ file: rel, line, byte });
      }
    }
    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  ${v.file}:${v.line} contains ${v.byte}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} literal control bytes in tracked files. ` +
          `Replace with escape sequences (\\xNN, \\uNNNN, or String.fromCharCode):\n${summary}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
