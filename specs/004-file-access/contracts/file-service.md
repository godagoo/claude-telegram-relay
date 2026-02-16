# Contract: FileService

**Feature**: 004-file-access
**Date**: 2026-02-15
**Module**: `src/services/files.ts`

---

## Interface

```typescript
interface FileServiceContract {
  /**
   * List entries at the given path.
   * - No path: returns virtual root listing both 'share' and 'brain' as top-level dirs
   * - 'share' or 'brain': lists that root's top-level
   * - 'share/<subpath>' or 'brain/<subpath>': lists that directory
   *
   * Rejects paths escaping the root. Returns empty array if root not configured.
   */
  list(rawPath?: string): Promise<FileEntry[]>;

  /**
   * Read a file and return its content.
   * rawPath MUST include a root prefix ('share/' or 'brain/').
   * Returns FileContent with truncated=true if file exceeds maxReadBytes.
   * Throws FileAccessError for: missing root prefix, path traversal,
   * root not configured, file not found, binary file, read error.
   */
  read(rawPath: string): Promise<FileContent>;

  /**
   * Search file and folder names (case-insensitive substring match).
   * No root prefix: searches both roots; results include root prefix.
   * 'share/<query>' or 'brain/<query>': searches only that root.
   * Never searches file contents.
   */
  search(rawQuery: string): Promise<SearchResult[]>;

  /**
   * Register a path as a pending relay-initiated write.
   * Share watcher will suppress change notification for this path.
   * Must call releasePendingWrite() after write completes.
   */
  markPendingWrite(absolutePath: string): void;

  /**
   * Clear a pending write registration (call after write finishes or fails).
   */
  releasePendingWrite(absolutePath: string): void;
}
```

---

## Error Contract

```typescript
type FileAccessErrorCode =
  | 'ROOT_NOT_CONFIGURED'    // Root exists in path prefix but not in config
  | 'ROOT_PREFIX_REQUIRED'   // /read called without root prefix
  | 'PATH_OUTSIDE_ROOT'      // Traversal attempt detected
  | 'NOT_FOUND'              // File or directory does not exist
  | 'IS_BINARY'              // File detected as binary content
  | 'READ_ERROR'             // Generic I/O error
  | 'ROOT_OFFLINE';          // Root path inaccessible (share unmounted etc.)

class FileAccessError extends Error {
  constructor(
    public readonly code: FileAccessErrorCode,
    public readonly root: 'share' | 'brain' | undefined,
    public readonly path: string | undefined,
    message: string
  ) { super(message); }
}
```

All methods throw `FileAccessError` on failure. Callers (command handlers) catch and
format to user-facing Telegram messages per constitution IV.

---

## Path Parsing Contract

Raw paths follow this format: `[root/]<subpath>`

| Input | Parsed root | Parsed subpath |
|-------|-------------|----------------|
| *(empty)* | both | `/` (virtual root) |
| `share` | `share` | `/` |
| `brain` | `brain` | `/` |
| `share/People` | `share` | `People` |
| `brain/Projects/foo.md` | `brain` | `Projects/foo.md` |
| `People/Alice.md` | *(no root)* | error for `/read`; both for `/search` |

For `/search`, the root token is matched by checking if the first path segment is
exactly `share` or `brain`. If not, the query runs against both roots.

---

## Telegram Command Mapping

| Command | Calls | Format |
|---------|-------|--------|
| `/files` | `list()` | Bulleted list of entries; type indicated by trailing `/` |
| `/files <path>` | `list(path)` | Same |
| `/read <path>` | `read(path)` | File content sent as text; truncation notice if applicable |
| `/search <query>` | `search(query)` | Numbered list of matching paths with root prefix |
