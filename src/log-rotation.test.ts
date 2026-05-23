import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rotateLogIfTooLarge } from "./log-rotation.ts";

function tempLog(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-log-rotation-"));
  return { dir, path: join(dir, "com.claude.telegram-relay.error.log") };
}

describe("rotateLogIfTooLarge", () => {
  test("missing file returns no-op", async () => {
    const { dir, path } = tempLog();
    try {
      const result = await rotateLogIfTooLarge({ path, maxBytes: 100 });
      expect(result.rotated).toBe(false);
      if (result.rotated === false) {
        expect(result.reason).toBe("missing");
      }
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file below threshold returns no-op and preserves content", async () => {
    const { dir, path } = tempLog();
    try {
      const content = "small log\n";
      writeFileSync(path, content);
      const result = await rotateLogIfTooLarge({ path, maxBytes: 1024 });
      expect(result.rotated).toBe(false);
      if (result.rotated === false && result.reason !== "missing") {
        expect(result.reason).toBe("below_threshold");
        expect(result.sizeBytes).toBe(content.length);
      }
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file at exact threshold is below_threshold (strict greater-than rotates)", async () => {
    const { dir, path } = tempLog();
    try {
      const content = "x".repeat(100);
      writeFileSync(path, content);
      const result = await rotateLogIfTooLarge({ path, maxBytes: 100 });
      expect(result.rotated).toBe(false);
      if (result.rotated === false && result.reason !== "missing") {
        expect(result.reason).toBe("below_threshold");
      }
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file above threshold creates archive with original content and truncates original", async () => {
    const { dir, path } = tempLog();
    try {
      const content = "x".repeat(200);
      writeFileSync(path, content);
      const result = await rotateLogIfTooLarge({ path, maxBytes: 100 });
      expect(result.rotated).toBe(true);
      if (result.rotated) {
        expect(result.sizeBytes).toBe(200);
        expect(existsSync(result.archivePath)).toBe(true);
        expect(readFileSync(result.archivePath, "utf8")).toBe(content);
      }
      expect(statSync(path).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive name is deterministic when now and pid are injected", async () => {
    const { dir, path } = tempLog();
    try {
      writeFileSync(path, "x".repeat(200));
      const result = await rotateLogIfTooLarge({
        path,
        maxBytes: 100,
        now: new Date("2026-05-19T09:16:31.000Z"),
        pid: 1234,
      });
      expect(result.rotated).toBe(true);
      if (result.rotated) {
        expect(result.archivePath).toBe(`${path}.20260519T091631Z.1234.old`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive lives in the same directory as the original", async () => {
    const { dir, path } = tempLog();
    try {
      writeFileSync(path, "x".repeat(200));
      const result = await rotateLogIfTooLarge({ path, maxBytes: 100, pid: 99 });
      expect(result.rotated).toBe(true);
      if (result.rotated) {
        expect(result.archivePath.startsWith(dir)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to process.pid when pid is not injected", async () => {
    const { dir, path } = tempLog();
    try {
      writeFileSync(path, "x".repeat(200));
      const result = await rotateLogIfTooLarge({
        path,
        maxBytes: 100,
        now: new Date("2026-05-19T09:16:31.000Z"),
      });
      expect(result.rotated).toBe(true);
      if (result.rotated) {
        expect(result.archivePath.endsWith(`.${process.pid}.old`)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
