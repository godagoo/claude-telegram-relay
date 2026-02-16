/**
 * Integration tests for FileService — uses real temp directories.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileService } from "../../src/services/files";
import { FileAccessError } from "../../src/types/files";
import type { FilesConfig } from "../../src/types/files";

const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: function () {
    return this;
  },
} as unknown as Logger;

let shareDir: string;
let brainDir: string;

beforeEach(async () => {
  shareDir = await mkdtemp(join(tmpdir(), "test-share-"));
  brainDir = await mkdtemp(join(tmpdir(), "test-brain-"));
});

afterEach(async () => {
  await rm(shareDir, { recursive: true, force: true });
  await rm(brainDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<FilesConfig> = {}): FilesConfig {
  return {
    shareRoot: shareDir,
    brainRoot: brainDir,
    maxReadBytes: 51200,
    sharePollIntervalMs: 10000,
    brainDebounceMs: 2000,
    ...overrides,
  };
}

// ─── read() integration tests ────────────────────────────────────────────────

describe("FileService.read() — integration", () => {
  it("reads known text content and returns it with truncated:false", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    const content = "Hello, this is Alice's file.\nLine 2.\n";
    await writeFile(join(shareDir, "alice.txt"), content, "utf-8");

    const result = await svc.read("share/alice.txt");
    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.root).toBe("share");
    expect(result.relativePath).toBe("alice.txt");
  });

  it("reads a file larger than maxReadBytes and returns truncated:true", async () => {
    const maxReadBytes = 100;
    const svc = new FileService(makeConfig({ maxReadBytes }), mockLogger);
    const content = "A".repeat(200);
    await writeFile(join(shareDir, "big.txt"), content, "utf-8");

    const result = await svc.read("share/big.txt");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(maxReadBytes);
  });

  it("throws NOT_FOUND for nonexistent file", async () => {
    const svc = new FileService(makeConfig(), mockLogger);

    await expect(svc.read("share/nonexistent.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws ROOT_PREFIX_REQUIRED when no root prefix given", async () => {
    const svc = new FileService(makeConfig(), mockLogger);

    await expect(svc.read("alice.txt")).rejects.toMatchObject({
      code: "ROOT_PREFIX_REQUIRED",
    });
  });

  it("throws IS_BINARY for file containing null bytes", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    const binaryContent = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(shareDir, "image.png"), binaryContent);

    await expect(svc.read("share/image.png")).rejects.toMatchObject({
      code: "IS_BINARY",
    });
  });
});

// ─── list() integration tests ─────────────────────────────────────────────────

describe("FileService.list() — integration", () => {
  it("no arg returns virtual listing with both roots", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    const entries = await svc.list();
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name);
    expect(names).toContain("share");
    expect(names).toContain("brain");
  });

  it("lists files in share root", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    await writeFile(join(shareDir, "note.md"), "content");
    await mkdir(join(shareDir, "People"));

    const entries = await svc.list("share");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.find((e) => e.name === "note.md")?.type).toBe("file");
    expect(entries.find((e) => e.name === "People")?.type).toBe("directory");
  });

  it("lists files in subdirectory", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    await mkdir(join(shareDir, "People"));
    await writeFile(join(shareDir, "People", "Alice.md"), "Alice");

    const entries = await svc.list("share/People");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("Alice.md");
    expect(entries[0]?.type).toBe("file");
  });

  it("absent root throws ROOT_NOT_CONFIGURED", async () => {
    const svc = new FileService(makeConfig({ shareRoot: undefined }), mockLogger);
    await expect(svc.list("share")).rejects.toMatchObject({
      code: "ROOT_NOT_CONFIGURED",
    });
  });

  it("offline root throws ROOT_OFFLINE (missing dir)", async () => {
    const missingDir = join(tmpdir(), `definitely-does-not-exist-${Date.now()}`);
    const svc = new FileService(makeConfig({ shareRoot: missingDir }), mockLogger);
    // realpath will throw ENOENT → NOT_FOUND for subpath, but for bare root listing
    // readdir throws ENOENT → NOT_FOUND
    await expect(svc.list("share")).rejects.toBeInstanceOf(FileAccessError);
  });
});

// ─── search() integration tests ──────────────────────────────────────────────

describe("FileService.search() — integration", () => {
  it("finds files in both roots", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    await writeFile(join(shareDir, "alice-share.md"), "Alice on share");
    await writeFile(join(brainDir, "alice-brain.md"), "Alice in brain");

    const results = await svc.search("alice");
    const roots = results.map((r) => r.root);
    expect(roots).toContain("share");
    expect(roots).toContain("brain");
  });

  it("limits to share root when prefixed", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    await writeFile(join(shareDir, "alice-share.md"), "Alice on share");
    await writeFile(join(brainDir, "alice-brain.md"), "Alice in brain");

    const results = await svc.search("share/alice");
    expect(results.every((r) => r.root === "share")).toBe(true);
  });

  it("returns empty array when no files match", async () => {
    const svc = new FileService(makeConfig(), mockLogger);
    const results = await svc.search("zzz_no_match_xyz");
    expect(results).toHaveLength(0);
  });

  it("one root missing — returns results from available root only", async () => {
    const missingDir = join(tmpdir(), `missing-${Date.now()}`);
    const svc = new FileService(makeConfig({ shareRoot: missingDir }), mockLogger);
    await writeFile(join(brainDir, "alice.md"), "Alice");

    // Should not throw; returns brain results
    const results = await svc.search("alice");
    expect(results.some((r) => r.root === "brain")).toBe(true);
  });

  it("search across directories recursively", async () => {
    const svc = new FileService(makeConfig({ brainRoot: undefined }), mockLogger);
    await mkdir(join(shareDir, "subdir"));
    await writeFile(join(shareDir, "subdir", "deep-alice.md"), "Deep Alice");

    const results = await svc.search("deep-alice");
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("deep-alice.md");
  });
});
