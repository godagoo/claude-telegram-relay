/**
 * WatcherService — monitors share (polling) and brain (inotify) for external changes.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { FilesConfig, ShareDiff, WatcherCallbacks } from "../types/files";

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const MAX_SHARE_DEPTH = 10;

export class WatcherService {
  private config: FilesConfig;
  private callbacks: WatcherCallbacks;
  private pendingWrites: Set<string>;
  private log: Logger;

  private shareInterval: ReturnType<typeof setInterval> | undefined;
  private shareSnapshot: Map<string, number> = new Map();
  private shareBaselineSet = false;

  private brainWatcher: FSWatcher | undefined;
  private brainDebounce: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    config: FilesConfig,
    callbacks: WatcherCallbacks,
    pendingWrites: Set<string>,
    log: Logger
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.pendingWrites = pendingWrites;
    this.log = log;
  }

  start(): void {
    this.stopped = false;

    // Share watcher — polling
    if (this.config.shareRoot) {
      this.shareInterval = setInterval(() => {
        void this.pollShare();
      }, this.config.sharePollIntervalMs);
    }

    // Brain watcher — inotify via fs.watch
    if (this.config.brainRoot) {
      try {
        const brainWatcher = watch(this.config.brainRoot, { recursive: true });

        brainWatcher.on("change", (_event: string, _filename: string | null) => {
          if (this.stopped) return;
          // Debounce: clear any pending timer and set a new one
          clearTimeout(this.brainDebounce);
          this.brainDebounce = setTimeout(() => {
            if (!this.stopped) {
              this.callbacks.onBrainChange();
            }
          }, this.config.brainDebounceMs);
        });

        brainWatcher.on("error", (err: Error) => {
          this.log.warn({ error: err.message }, "Brain watcher error");
        });

        this.brainWatcher = brainWatcher;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ error: msg }, "Failed to start brain watcher");
      }
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.shareInterval !== undefined) {
      clearInterval(this.shareInterval);
      this.shareInterval = undefined;
    }

    if (this.brainDebounce !== undefined) {
      clearTimeout(this.brainDebounce);
      this.brainDebounce = undefined;
    }

    if (this.brainWatcher !== undefined) {
      this.brainWatcher.close();
      this.brainWatcher = undefined;
    }
  }

  private async pollShare(): Promise<void> {
    const shareRoot = this.config.shareRoot;
    if (!shareRoot) return;

    let currentSnapshot: Map<string, number>;
    try {
      currentSnapshot = await this.buildShareSnapshot(shareRoot, "", 0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ error: msg }, "Share poll: failed to build snapshot");
      return;
    }

    if (!this.shareBaselineSet) {
      // First poll — establish baseline; do not call onShareChange
      this.shareSnapshot = currentSnapshot;
      this.shareBaselineSet = true;
      return;
    }

    const diff = this.diffSnapshots(this.shareSnapshot, currentSnapshot);

    // Filter out pending writes (relay-initiated changes)
    diff.added = diff.added.filter((p) => !this.pendingWrites.has(p));
    diff.modified = diff.modified.filter((p) => !this.pendingWrites.has(p));
    diff.deleted = diff.deleted.filter((p) => !this.pendingWrites.has(p));

    if (diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0) {
      this.callbacks.onShareChange(diff);
    }

    this.shareSnapshot = currentSnapshot;
  }

  private async buildShareSnapshot(
    rootPath: string,
    relDir: string,
    depth: number
  ): Promise<Map<string, number>> {
    if (depth > MAX_SHARE_DEPTH) {
      this.log.warn({ depth, relDir }, "Share snapshot: max depth reached, skipping");
      return new Map();
    }

    const dirPath = relDir ? join(rootPath, relDir) : rootPath;
    let dirents: DirentLike[];

    try {
      dirents = (await readdir(dirPath, {
        withFileTypes: true,
      })) as unknown as DirentLike[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ dirPath, error: msg }, "Share snapshot: cannot read directory");
      return new Map();
    }

    const snapshot: Map<string, number> = new Map();

    for (const d of dirents) {
      const relPath = relDir ? `${relDir}/${d.name}` : d.name;
      const absPath = join(rootPath, relPath);

      if (d.isDirectory()) {
        const subSnap = await this.buildShareSnapshot(rootPath, relPath, depth + 1);
        for (const [k, v] of subSnap) {
          snapshot.set(k, v);
        }
      } else {
        try {
          const fileStat = await stat(absPath);
          snapshot.set(absPath, fileStat.mtimeMs);
        } catch {
          // Skip files we can't stat
        }
      }
    }

    return snapshot;
  }

  private diffSnapshots(prev: Map<string, number>, current: Map<string, number>): ShareDiff {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [path, mtime] of current) {
      const prevMtime = prev.get(path);
      if (prevMtime === undefined) {
        added.push(path);
      } else if (prevMtime !== mtime) {
        modified.push(path);
      }
    }

    for (const path of prev.keys()) {
      if (!current.has(path)) {
        deleted.push(path);
      }
    }

    return { added, modified, deleted };
  }
}
