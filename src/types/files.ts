/**
 * Types for 004-file-access: FileService and WatcherService
 */

// ─── Error types ─────────────────────────────────────────────────────────────

export type FileAccessErrorCode =
  | "ROOT_NOT_CONFIGURED" // Root named in prefix but not in config
  | "ROOT_PREFIX_REQUIRED" // /read called without share/ or brain/ prefix
  | "PATH_OUTSIDE_ROOT" // Traversal or symlink escape detected
  | "NOT_FOUND" // File or directory does not exist
  | "IS_BINARY" // File detected as binary
  | "READ_ERROR" // Generic I/O error
  | "ROOT_OFFLINE" // Root path inaccessible (unmounted, EACCES, etc.)
  | "NOT_A_DIRECTORY"; // Path exists but is a file, not a directory

export class FileAccessError extends Error {
  constructor(
    public readonly code: FileAccessErrorCode,
    public readonly root: "share" | "brain" | undefined,
    public readonly path: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "FileAccessError";
  }
}

// ─── Service data types ───────────────────────────────────────────────────────

export interface FileEntry {
  root: "share" | "brain";
  relativePath: string;
  name: string;
  type: "file" | "directory";
}

export interface FileContent {
  root: "share" | "brain";
  relativePath: string;
  text: string;
  truncated: boolean;
  sizeBytes: number;
}

export interface SearchResult {
  root: "share" | "brain";
  relativePath: string;
  name: string;
  type: "file" | "directory";
}

export interface ShareDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface FilesConfig {
  /** Absolute path to mounted Windows share (e.g. /mnt/PersonalAssistantHub) */
  shareRoot?: string;
  /** Absolute path to SecondBrain data directory */
  brainRoot?: string;
  /** Max bytes injectable by /read. Default: 51200 (50 KB) */
  maxReadBytes: number;
  /** Share watcher poll interval in ms. Default: 10000 */
  sharePollIntervalMs: number;
  /** Brain watcher debounce delay in ms. Default: 2000 */
  brainDebounceMs: number;
}

// ─── Watcher callbacks ────────────────────────────────────────────────────────

export interface WatcherCallbacks {
  onShareChange(diff: ShareDiff): void;
  onBrainChange(): void;
}
