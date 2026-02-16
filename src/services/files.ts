/**
 * FileService — path-safe file access for /files, /read, and /search commands.
 */

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import {
  FileAccessError,
  type FileContent,
  type FileEntry,
  type FilesConfig,
  type SearchResult,
} from "../types/files";

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const MAX_SEARCH_DEPTH = 10;

export class FileService {
  private config: FilesConfig;
  private log: Logger;
  readonly pendingWrites: Set<string> = new Set();

  constructor(config: FilesConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /**
   * Resolve subpath within root, checking for traversal and symlink escapes.
   */
  async resolveSafe(root: string, subpath: string): Promise<string> {
    const resolved = resolve(root, subpath);

    // Lexical check: resolved must equal root or start with root/
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new FileAccessError(
        "PATH_OUTSIDE_ROOT",
        undefined,
        subpath,
        `Path '${subpath}' is outside root '${root}'`
      );
    }

    // Realpath check: follow symlinks and verify real location is within root
    let realResolved: string;
    try {
      realResolved = await realpath(resolved);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new FileAccessError("NOT_FOUND", undefined, subpath, `Path not found: '${subpath}'`);
      }
      if (nodeErr.code === "EACCES") {
        throw new FileAccessError(
          "ROOT_OFFLINE",
          undefined,
          subpath,
          `Access denied: '${subpath}'`
        );
      }
      throw new FileAccessError(
        "PATH_OUTSIDE_ROOT",
        undefined,
        subpath,
        `Cannot resolve path '${subpath}': ${String(err)}`
      );
    }

    if (realResolved !== root && !realResolved.startsWith(`${root}/`)) {
      throw new FileAccessError(
        "PATH_OUTSIDE_ROOT",
        undefined,
        subpath,
        `Symlink at '${subpath}' escapes root '${root}'`
      );
    }

    return realResolved;
  }

  /**
   * Detect binary content by checking for null bytes in the buffer.
   */
  isBinary(buf: Buffer): boolean {
    return buf.includes(0x00);
  }

  /**
   * Parse optional 'share/' or 'brain/' prefix from a raw path.
   */
  parseRoot(rawPath: string): {
    root: "share" | "brain" | undefined;
    subpath: string;
  } {
    const sep = rawPath.indexOf("/");
    const firstSegment = sep === -1 ? rawPath : rawPath.slice(0, sep);
    const remainder = sep === -1 ? "" : rawPath.slice(sep + 1);

    if (firstSegment === "share" || firstSegment === "brain") {
      return { root: firstSegment, subpath: remainder };
    }

    return { root: undefined, subpath: rawPath };
  }

  /**
   * Mark a path as pending write — suppresses watcher notifications for 5s.
   */
  markPendingWrite(absolutePath: string): void {
    this.pendingWrites.add(absolutePath);
    setTimeout(() => {
      this.pendingWrites.delete(absolutePath);
    }, 5000);
  }

  /**
   * Remove a path from pending writes immediately.
   */
  releasePendingWrite(absolutePath: string): void {
    this.pendingWrites.delete(absolutePath);
  }

  /**
   * List files/directories. No arg → virtual listing of configured roots.
   * With arg → listing of that directory.
   */
  async list(rawPath?: string): Promise<FileEntry[]> {
    if (!rawPath) {
      // Virtual listing of configured roots
      const entries: FileEntry[] = [];
      if (this.config.shareRoot) {
        entries.push({
          root: "share",
          relativePath: "",
          name: "share",
          type: "directory",
        });
      }
      if (this.config.brainRoot) {
        entries.push({
          root: "brain",
          relativePath: "",
          name: "brain",
          type: "directory",
        });
      }
      return entries;
    }

    const { root, subpath } = this.parseRoot(rawPath);

    if (!root) {
      throw new FileAccessError(
        "ROOT_NOT_CONFIGURED",
        undefined,
        rawPath,
        `Path '${rawPath}' has no root prefix (use 'share/...' or 'brain/...')`
      );
    }

    const rootPath = root === "share" ? this.config.shareRoot : this.config.brainRoot;
    if (!rootPath) {
      throw new FileAccessError(
        "ROOT_NOT_CONFIGURED",
        root,
        rawPath,
        `Root '${root}' is not configured`
      );
    }

    let dirPath: string;
    if (subpath) {
      dirPath = await this.resolveSafe(rootPath, subpath);
    } else {
      dirPath = rootPath;
    }

    let dirents: DirentLike[];
    try {
      dirents = (await readdir(dirPath, {
        withFileTypes: true,
      })) as unknown as DirentLike[];
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new FileAccessError("NOT_FOUND", root, rawPath, `Directory not found: '${rawPath}'`);
      }
      if (nodeErr.code === "ENOTDIR") {
        throw new FileAccessError(
          "NOT_A_DIRECTORY",
          root,
          rawPath,
          `'${rawPath}' is not a directory`
        );
      }
      throw new FileAccessError(
        "ROOT_OFFLINE",
        root,
        rawPath,
        `Cannot read directory '${rawPath}': ${String(err)}`
      );
    }

    return dirents.map((d) => ({
      root,
      relativePath: subpath ? `${subpath}/${d.name}` : d.name,
      name: d.name,
      type: d.isDirectory() ? ("directory" as const) : ("file" as const),
    }));
  }

  /**
   * Read a file's text content. Requires root prefix.
   */
  async read(rawPath: string): Promise<FileContent> {
    const { root, subpath } = this.parseRoot(rawPath);

    if (!root) {
      throw new FileAccessError(
        "ROOT_PREFIX_REQUIRED",
        undefined,
        rawPath,
        `Path '${rawPath}' must start with 'share/' or 'brain/'`
      );
    }

    const rootPath = root === "share" ? this.config.shareRoot : this.config.brainRoot;
    if (!rootPath) {
      throw new FileAccessError(
        "ROOT_NOT_CONFIGURED",
        root,
        rawPath,
        `Root '${root}' is not configured`
      );
    }

    const absolutePath = await this.resolveSafe(rootPath, subpath);

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(absolutePath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new FileAccessError("NOT_FOUND", root, rawPath, `File not found: '${rawPath}'`);
      }
      throw new FileAccessError(
        "ROOT_OFFLINE",
        root,
        rawPath,
        `Cannot stat '${rawPath}': ${String(err)}`
      );
    }

    const sizeBytes = fileStat.size;

    let buf: Buffer;
    try {
      buf = (await readFile(absolutePath)) as unknown as Buffer;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new FileAccessError("NOT_FOUND", root, rawPath, `File not found: '${rawPath}'`);
      }
      throw new FileAccessError(
        "ROOT_OFFLINE",
        root,
        rawPath,
        `Cannot read '${rawPath}': ${String(err)}`
      );
    }

    // Binary check on first 8KB (or entire file if smaller)
    const sampleBuf = buf.slice(0, 8192);
    if (this.isBinary(sampleBuf)) {
      throw new FileAccessError(
        "IS_BINARY",
        root,
        rawPath,
        `'${rawPath}' appears to be a binary file`
      );
    }

    const { maxReadBytes } = this.config;
    const truncated = buf.length > maxReadBytes;
    const text = buf.slice(0, maxReadBytes).toString("utf-8");

    return {
      root,
      relativePath: subpath,
      text,
      truncated,
      sizeBytes,
    };
  }

  /**
   * Search for files/directories matching a query string (case-insensitive).
   * Optional root prefix limits search to one root.
   */
  async search(rawQuery: string): Promise<SearchResult[]> {
    const { root: queryRoot, subpath: query } = this.parseRoot(rawQuery);

    const rootsToSearch: Array<{ root: "share" | "brain"; path: string }> = [];

    if (queryRoot) {
      const rootPath = queryRoot === "share" ? this.config.shareRoot : this.config.brainRoot;
      if (rootPath) {
        rootsToSearch.push({ root: queryRoot, path: rootPath });
      }
    } else {
      if (this.config.shareRoot) {
        rootsToSearch.push({ root: "share", path: this.config.shareRoot });
      }
      if (this.config.brainRoot) {
        rootsToSearch.push({ root: "brain", path: this.config.brainRoot });
      }
    }

    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const { root, path } of rootsToSearch) {
      try {
        const rootResults = await this.walkSearch(root, path, "", lowerQuery, 0);
        results.push(...rootResults);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ root, error: msg }, "Search: root unavailable, skipping");
      }
    }

    return results;
  }

  private async walkSearch(
    root: "share" | "brain",
    rootPath: string,
    relDir: string,
    lowerQuery: string,
    depth: number
  ): Promise<SearchResult[]> {
    if (depth > MAX_SEARCH_DEPTH) {
      this.log.warn({ depth, relDir }, "Search: max depth reached, skipping");
      return [];
    }

    const dirPath = relDir ? join(rootPath, relDir) : rootPath;
    let dirents: DirentLike[];

    try {
      dirents = (await readdir(dirPath, {
        withFileTypes: true,
      })) as unknown as DirentLike[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ dirPath, error: msg }, "Search: cannot read directory, skipping");
      return [];
    }

    const results: SearchResult[] = [];

    for (const d of dirents) {
      const relPath = relDir ? `${relDir}/${d.name}` : d.name;

      if (d.name.toLowerCase().includes(lowerQuery)) {
        results.push({
          root,
          relativePath: relPath,
          name: d.name,
          type: d.isDirectory() ? "directory" : "file",
        });
      }

      if (d.isDirectory()) {
        const sub = await this.walkSearch(root, rootPath, relPath, lowerQuery, depth + 1);
        results.push(...sub);
      }
    }

    return results;
  }
}
