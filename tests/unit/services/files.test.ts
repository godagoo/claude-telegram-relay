import * as fsp from "node:fs/promises";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilesConfig } from "../../../src/types/files";

vi.mock("node:fs/promises");

interface MockDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

const makeConfig = (overrides: Partial<FilesConfig> = {}): FilesConfig => ({
  shareRoot: "/mnt/share",
  brainRoot: "/mnt/brain",
  maxReadBytes: 51200,
  sharePollIntervalMs: 10000,
  brainDebounceMs: 2000,
  ...overrides,
});

// Lazy import to allow mocks to be set up first
async function getFileService() {
  const { FileService } = await import("../../../src/services/files");
  return FileService;
}

function makeDirent(name: string, isDir: boolean): MockDirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

describe("FileService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ─── resolveSafe ─────────────────────────────────────────────────────────────

  describe("resolveSafe", () => {
    it("accepts valid subpath and returns resolved path", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/People/Alice.md");

      const result = await svc.resolveSafe("/mnt/share", "People/Alice.md");
      expect(result).toBe("/mnt/share/People/Alice.md");
    });

    it("rejects .. traversal with PATH_OUTSIDE_ROOT", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      await expect(svc.resolveSafe("/mnt/share", "../etc/passwd")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
    });

    it("rejects absolute path outside root with PATH_OUTSIDE_ROOT", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      await expect(svc.resolveSafe("/mnt/share", "/etc/passwd")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
    });

    it("rejects symlink resolving outside root with PATH_OUTSIDE_ROOT", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      // realpath returns a path outside the root (symlink escape)
      vi.mocked(fsp.realpath).mockResolvedValue("/etc/passwd");

      await expect(svc.resolveSafe("/mnt/share", "link")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
    });

    it("throws NOT_FOUND when realpath returns ENOENT", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const enoentErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fsp.realpath).mockRejectedValue(enoentErr);

      await expect(svc.resolveSafe("/mnt/share", "nonexistent.txt")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  // ─── isBinary ────────────────────────────────────────────────────────────────

  describe("isBinary", () => {
    it("returns true for buffer containing null byte", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]); // "He\0lo"
      expect(svc.isBinary(buf)).toBe(true);
    });

    it("returns false for clean UTF-8 text buffer", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const buf = Buffer.from("Hello, world!", "utf-8");
      expect(svc.isBinary(buf)).toBe(false);
    });
  });

  // ─── parseRoot ───────────────────────────────────────────────────────────────

  describe("parseRoot", () => {
    it("splits 'share/foo' into root:share, subpath:foo", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      expect(svc.parseRoot("share/foo")).toEqual({ root: "share", subpath: "foo" });
    });

    it("handles bare 'share' as root:share, subpath:''", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      expect(svc.parseRoot("share")).toEqual({ root: "share", subpath: "" });
    });

    it("returns root:undefined for path without share/brain prefix", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      expect(svc.parseRoot("People/Alice.md")).toEqual({
        root: undefined,
        subpath: "People/Alice.md",
      });
    });

    it("splits 'brain/Notes/foo.md' into root:brain, subpath:Notes/foo.md", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      expect(svc.parseRoot("brain/Notes/foo.md")).toEqual({
        root: "brain",
        subpath: "Notes/foo.md",
      });
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("no arg returns virtual listing of configured roots", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const entries = await svc.list();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name)).toContain("share");
      expect(entries.map((e) => e.name)).toContain("brain");
      expect(entries.every((e) => e.type === "directory")).toBe(true);
    });

    it("no arg with only shareRoot returns only share", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig({ brainRoot: undefined }), mockLogger);

      const entries = await svc.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe("share");
    });

    it("'share' returns top-level entries of share root", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share");
      vi.mocked(fsp.readdir).mockResolvedValue([
        makeDirent("People", true),
        makeDirent("Notes.md", false),
      ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

      const entries = await svc.list("share");
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.name === "People")?.type).toBe("directory");
      expect(entries.find((e) => e.name === "Notes.md")?.type).toBe("file");
    });

    it("'share/People' returns entries of that subdirectory", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/People");
      vi.mocked(fsp.readdir).mockResolvedValue([
        makeDirent("Alice.md", false),
      ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

      const entries = await svc.list("share/People");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe("Alice.md");
    });

    it("path with '..' throws PATH_OUTSIDE_ROOT", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      await expect(svc.list("share/../../../etc")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
    });

    it("unconfigured root throws ROOT_NOT_CONFIGURED", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig({ shareRoot: undefined }), mockLogger);

      await expect(svc.list("share")).rejects.toMatchObject({
        code: "ROOT_NOT_CONFIGURED",
      });
    });

    it("root dir unreadable throws ROOT_OFFLINE", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share");
      const eaccesErr = Object.assign(new Error("EACCES"), { code: "EACCES" });
      vi.mocked(fsp.readdir).mockRejectedValue(eaccesErr);

      await expect(svc.list("share")).rejects.toMatchObject({
        code: "ROOT_OFFLINE",
      });
    });

    it("path pointing at a file throws NOT_A_DIRECTORY", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/Notes.md");
      const enotdirErr = Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      vi.mocked(fsp.readdir).mockRejectedValue(enotdirErr);

      await expect(svc.list("share/Notes.md")).rejects.toMatchObject({
        code: "NOT_A_DIRECTORY",
      });
    });
  });

  // ─── read ────────────────────────────────────────────────────────────────────

  describe("read", () => {
    it("valid text file returns FileContent with truncated:false", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const content = "Hello, Alice!";
      const buf = Buffer.from(content, "utf-8");

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/People/Alice.md");
      vi.mocked(fsp.readFile).mockResolvedValue(buf as unknown as string);
      vi.mocked(fsp.stat).mockResolvedValue({
        size: buf.length,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

      const result = await svc.read("share/People/Alice.md");
      expect(result.text).toBe(content);
      expect(result.truncated).toBe(false);
      expect(result.root).toBe("share");
    });

    it("file over maxReadBytes returns truncated:true with text.length === maxReadBytes", async () => {
      const FileService = await getFileService();
      const maxReadBytes = 10;
      const svc = new FileService(makeConfig({ maxReadBytes }), mockLogger);

      const content = "A".repeat(20); // 20 bytes, larger than 10
      const buf = Buffer.from(content, "utf-8");

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/big.txt");
      vi.mocked(fsp.readFile).mockResolvedValue(buf as unknown as string);
      vi.mocked(fsp.stat).mockResolvedValue({
        size: buf.length,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

      const result = await svc.read("share/big.txt");
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(maxReadBytes);
    });

    it("file with null bytes throws IS_BINARY", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const binaryBuf = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);

      vi.mocked(fsp.realpath).mockResolvedValue("/mnt/share/image.png");
      vi.mocked(fsp.readFile).mockResolvedValue(binaryBuf as unknown as string);
      vi.mocked(fsp.stat).mockResolvedValue({
        size: binaryBuf.length,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

      await expect(svc.read("share/image.png")).rejects.toMatchObject({
        code: "IS_BINARY",
      });
    });

    it("path without root prefix throws ROOT_PREFIX_REQUIRED", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      await expect(svc.read("People/Alice.md")).rejects.toMatchObject({
        code: "ROOT_PREFIX_REQUIRED",
      });
    });

    it("nonexistent file throws NOT_FOUND", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const enoentErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fsp.realpath).mockRejectedValue(enoentErr);

      await expect(svc.read("share/missing.md")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("root offline throws ROOT_OFFLINE", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      const eaccesErr = Object.assign(new Error("EACCES"), { code: "EACCES" });
      vi.mocked(fsp.realpath).mockRejectedValue(eaccesErr);

      await expect(svc.read("share/file.txt")).rejects.toMatchObject({
        code: "ROOT_OFFLINE",
      });
    });
  });

  // ─── search ──────────────────────────────────────────────────────────────────

  describe("search", () => {
    it("no-prefix query returns results from both configured roots", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.readdir).mockImplementation(async (dirPath, _opts) => {
        const p = String(dirPath);
        if (p === "/mnt/share") {
          return [makeDirent("alice.md", false)] as unknown as Awaited<
            ReturnType<typeof fsp.readdir>
          >;
        }
        if (p === "/mnt/brain") {
          return [makeDirent("alice-notes.md", false)] as unknown as Awaited<
            ReturnType<typeof fsp.readdir>
          >;
        }
        return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
      });

      const results = await svc.search("alice");
      expect(results.some((r) => r.root === "share")).toBe(true);
      expect(results.some((r) => r.root === "brain")).toBe(true);
    });

    it("'share/alice' limits results to share root only", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.readdir).mockImplementation(async (dirPath, _opts) => {
        const p = String(dirPath);
        if (p === "/mnt/share") {
          return [makeDirent("alice.md", false)] as unknown as Awaited<
            ReturnType<typeof fsp.readdir>
          >;
        }
        return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
      });

      const results = await svc.search("share/alice");
      expect(results.every((r) => r.root === "share")).toBe(true);
    });

    it("query with zero matches returns empty array", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.readdir).mockResolvedValue([makeDirent("bob.md", false)] as unknown as Awaited<
        ReturnType<typeof fsp.readdir>
      >);

      const results = await svc.search("zzz_no_match");
      expect(results).toHaveLength(0);
    });

    it("search is case-insensitive", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig({ brainRoot: undefined }), mockLogger);

      vi.mocked(fsp.readdir).mockResolvedValue([
        makeDirent("Alice.md", false),
      ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

      const results = await svc.search("ALICE");
      expect(results).toHaveLength(1);
    });

    it("special characters are treated as literal substring", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig({ brainRoot: undefined }), mockLogger);

      vi.mocked(fsp.readdir).mockResolvedValue([
        makeDirent("file(1).md", false),
        makeDirent("other.md", false),
      ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

      const results = await svc.search("file(1)");
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("file(1).md");
    });

    it("one root offline still returns results from available root", async () => {
      const FileService = await getFileService();
      const svc = new FileService(makeConfig(), mockLogger);

      vi.mocked(fsp.readdir).mockImplementation(async (dirPath, _opts) => {
        const p = String(dirPath);
        if (p === "/mnt/share") {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        if (p === "/mnt/brain") {
          return [makeDirent("alice.md", false)] as unknown as Awaited<
            ReturnType<typeof fsp.readdir>
          >;
        }
        return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
      });

      const results = await svc.search("alice");
      expect(results.some((r) => r.root === "brain")).toBe(true);
      // Should not throw
    });
  });
});
