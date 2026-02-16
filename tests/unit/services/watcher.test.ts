import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesConfig, ShareDiff, WatcherCallbacks } from "../../../src/types/files";

vi.mock("node:fs/promises");
vi.mock("node:fs");

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
  sharePollIntervalMs: 100,
  brainDebounceMs: 200,
  ...overrides,
});

// makeCallbacks returns mock fns cast as WatcherCallbacks for construction,
// but the raw mock object is returned so callers can assert on .mock.calls etc.
function makeCallbacks(): {
  cb: WatcherCallbacks;
  onShareChange: ReturnType<typeof vi.fn>;
  onBrainChange: ReturnType<typeof vi.fn>;
} {
  const onShareChange = vi.fn();
  const onBrainChange = vi.fn();
  return {
    onShareChange,
    onBrainChange,
    cb: {
      onShareChange: onShareChange as unknown as (diff: ShareDiff) => void,
      onBrainChange: onBrainChange as unknown as () => void,
    },
  };
}

async function getWatcherService() {
  const { WatcherService } = await import("../../../src/services/watcher");
  return WatcherService;
}

interface MockDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function makeDirent(name: string, isDir: boolean): MockDirent {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe("WatcherService — share watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("first poll establishes baseline; onShareChange NOT called", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    vi.mocked(fsp.readdir).mockResolvedValue([makeDirent("file1.txt", false)] as unknown as Awaited<
      ReturnType<typeof fsp.readdir>
    >);

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 1000,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    // Advance past first poll interval
    await vi.advanceTimersByTimeAsync(150);

    expect(onShareChange).not.toHaveBeenCalled();
    svc.stop();
  });

  it("second poll with new file calls onShareChange with diff.added", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    let callCount = 0;
    vi.mocked(fsp.readdir).mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
      }
      return [makeDirent("new-file.txt", false)] as unknown as Awaited<
        ReturnType<typeof fsp.readdir>
      >;
    });

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 2000,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    await vi.advanceTimersByTimeAsync(150); // first poll
    await vi.advanceTimersByTimeAsync(150); // second poll

    expect(onShareChange).toHaveBeenCalledOnce();
    const diff: ShareDiff = (onShareChange.mock.calls[0] as [ShareDiff])[0];
    expect(diff.added).toContain("/mnt/share/new-file.txt");
    svc.stop();
  });

  it("second poll with modified mtime calls onShareChange with diff.modified", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    let statCallCount = 0;
    vi.mocked(fsp.readdir).mockResolvedValue([
      makeDirent("existing.txt", false),
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

    vi.mocked(fsp.stat).mockImplementation(async () => {
      statCallCount++;
      return {
        mtimeMs: statCallCount <= 1 ? 1000 : 2000,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.stat>>;
    });

    svc.start();
    await vi.advanceTimersByTimeAsync(150); // first poll baseline
    await vi.advanceTimersByTimeAsync(150); // second poll: mtime changed

    expect(onShareChange).toHaveBeenCalledOnce();
    const diff: ShareDiff = (onShareChange.mock.calls[0] as [ShareDiff])[0];
    expect(diff.modified).toContain("/mnt/share/existing.txt");
    svc.stop();
  });

  it("second poll with removed file calls onShareChange with diff.deleted", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    let callCount = 0;
    vi.mocked(fsp.readdir).mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return [makeDirent("old-file.txt", false)] as unknown as Awaited<
          ReturnType<typeof fsp.readdir>
        >;
      }
      return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
    });

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 1000,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    await vi.advanceTimersByTimeAsync(150); // first poll
    await vi.advanceTimersByTimeAsync(150); // second poll: file removed

    expect(onShareChange).toHaveBeenCalledOnce();
    const diff: ShareDiff = (onShareChange.mock.calls[0] as [ShareDiff])[0];
    expect(diff.deleted).toContain("/mnt/share/old-file.txt");
    svc.stop();
  });

  it("changed path in pendingWrites suppresses onShareChange for that path", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>(["/mnt/share/relay-write.txt"]);
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    let callCount = 0;
    vi.mocked(fsp.readdir).mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
      }
      return [makeDirent("relay-write.txt", false)] as unknown as Awaited<
        ReturnType<typeof fsp.readdir>
      >;
    });

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 1000,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);

    expect(onShareChange).not.toHaveBeenCalled();
    svc.stop();
  });

  it("readdir throws — no crash; next poll retries", async () => {
    const WatcherService = await getWatcherService();
    const { cb } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    vi.mocked(fsp.readdir).mockRejectedValue(new Error("EACCES: permission denied"));

    svc.start();
    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();

    svc.stop();
  });

  it("directory nested beyond depth 10 is skipped; no crash", async () => {
    const WatcherService = await getWatcherService();
    const { cb } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    vi.mocked(fsp.readdir).mockImplementation(async (dirPath) => {
      const p = String(dirPath);
      const rel = p.replace("/mnt/share", "");
      const depth = rel ? rel.split("/").filter(Boolean).length : 0;
      if (depth >= 10) {
        return [makeDirent("deep-file.txt", false)] as unknown as Awaited<
          ReturnType<typeof fsp.readdir>
        >;
      }
      return [makeDirent("sub", true)] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
    });

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 1000,
      isFile: () => true,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();
    svc.stop();
  });

  it("stop() clears interval; onShareChange not called after stop", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onShareChange } = makeCallbacks();
    const pendingWrites = new Set<string>();
    const svc = new WatcherService(makeConfig(), cb, pendingWrites, mockLogger);

    let callCount = 0;
    vi.mocked(fsp.readdir).mockImplementation(async () => {
      callCount++;
      if (callCount > 1) {
        return [makeDirent("file.txt", false)] as unknown as Awaited<
          ReturnType<typeof fsp.readdir>
        >;
      }
      return [] as unknown as Awaited<ReturnType<typeof fsp.readdir>>;
    });

    vi.mocked(fsp.stat).mockResolvedValue({
      mtimeMs: 1000,
    } as unknown as Awaited<ReturnType<typeof fsp.stat>>);

    svc.start();
    await vi.advanceTimersByTimeAsync(150); // first poll
    svc.stop(); // stop before second poll
    await vi.advanceTimersByTimeAsync(300); // advance past more intervals

    expect(onShareChange).not.toHaveBeenCalled();
  });
});

describe("WatcherService — brain watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("fs.watch event fires → onBrainChange called after debounce expires", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onBrainChange } = makeCallbacks();
    const pendingWrites = new Set<string>();

    let watchHandler: ((event: string, filename: string | null) => void) | undefined;
    const mockWatcher = {
      on: vi.fn((event: string, handler: unknown) => {
        if (event === "change") watchHandler = handler as typeof watchHandler;
        return mockWatcher;
      }),
      close: vi.fn(),
    };
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);

    const svc = new WatcherService(
      makeConfig({ shareRoot: undefined }),
      cb,
      pendingWrites,
      mockLogger
    );

    svc.start();

    watchHandler?.("change", "notes.md");

    expect(onBrainChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(onBrainChange).toHaveBeenCalledOnce();
    svc.stop();
  });

  it("multiple events within debounce → onBrainChange called exactly once", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onBrainChange } = makeCallbacks();
    const pendingWrites = new Set<string>();

    let watchHandler: ((event: string, filename: string | null) => void) | undefined;
    const mockWatcher = {
      on: vi.fn((event: string, handler: unknown) => {
        if (event === "change") watchHandler = handler as typeof watchHandler;
        return mockWatcher;
      }),
      close: vi.fn(),
    };
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);

    const svc = new WatcherService(
      makeConfig({ shareRoot: undefined }),
      cb,
      pendingWrites,
      mockLogger
    );

    svc.start();

    watchHandler?.("change", "a.md");
    await vi.advanceTimersByTimeAsync(50);
    watchHandler?.("change", "b.md");
    await vi.advanceTimersByTimeAsync(50);
    watchHandler?.("change", "c.md");

    await vi.advanceTimersByTimeAsync(250);

    expect(onBrainChange).toHaveBeenCalledOnce();
    svc.stop();
  });

  it("fs.watch error event logs warn and does not crash", async () => {
    const WatcherService = await getWatcherService();
    const { cb } = makeCallbacks();
    const pendingWrites = new Set<string>();

    let errorHandler: ((err: Error) => void) | undefined;
    const mockWatcher = {
      on: vi.fn((event: string, handler: unknown) => {
        if (event === "error") errorHandler = handler as typeof errorHandler;
        return mockWatcher;
      }),
      close: vi.fn(),
    };
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);

    const svc = new WatcherService(
      makeConfig({ shareRoot: undefined }),
      cb,
      pendingWrites,
      mockLogger
    );

    svc.start();

    expect(() => errorHandler?.(new Error("watch error"))).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
    svc.stop();
  });

  it("stop() closes watcher; onBrainChange not called after stop", async () => {
    const WatcherService = await getWatcherService();
    const { cb, onBrainChange } = makeCallbacks();
    const pendingWrites = new Set<string>();

    let watchHandler: ((event: string, filename: string | null) => void) | undefined;
    const mockWatcher = {
      on: vi.fn((event: string, handler: unknown) => {
        if (event === "change") watchHandler = handler as typeof watchHandler;
        return mockWatcher;
      }),
      close: vi.fn(),
    };
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as fs.FSWatcher);

    const svc = new WatcherService(
      makeConfig({ shareRoot: undefined }),
      cb,
      pendingWrites,
      mockLogger
    );

    svc.start();
    svc.stop();

    watchHandler?.("change", "after-stop.md");
    await vi.advanceTimersByTimeAsync(300);

    expect(onBrainChange).not.toHaveBeenCalled();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("start() with no brainRoot does not call fs.watch", async () => {
    const WatcherService = await getWatcherService();
    const { cb } = makeCallbacks();
    const pendingWrites = new Set<string>();

    const svc = new WatcherService(
      makeConfig({ brainRoot: undefined, shareRoot: undefined }),
      cb,
      pendingWrites,
      mockLogger
    );

    svc.start();

    expect(fs.watch).not.toHaveBeenCalled();
    svc.stop();
  });
});
