# Research: 004-file-access

**Date**: 2026-02-15
**Branch**: `004-file-access`

---

## Decision 1: Filesystem Watching — Share Root (CIFS/SMB)

**Decision**: Use manual polling — `setInterval` + `readdir` + `stat` comparison  
**Rationale**: CIFS/SMB mounts on Linux do not support inotify. `fs.watch` uses inotify
internally and will NOT emit events for remote filesystem changes on a CIFS mount.
`fs.watchFile` (libuv stat polling) is an option but gives coarser control over state
tracking. Manual polling with `readdir` + `stat` mtime comparison allows the service to
diff the directory tree precisely — tracking which files were added, modified, or removed
since the last poll. This is necessary to populate the change notification message.

**Alternatives considered**:
- `fs.watch` on share — does not work; inotify unsupported on CIFS
- `fs.watchFile` per-file — requires knowing file paths upfront; does not detect new files
- Third-party library (chokidar) — rejected per constitution VII (no new npm deps)

**Poll interval default**: 10 seconds (configurable). Balances freshness against SMB I/O load.

**State tracking**: Maintain an in-memory snapshot of `{ [relativePath]: mtimeMs }` for
all files under the share root. On each poll, compare against a fresh `readdir`+`stat` walk.
Diff = added files + modified files (mtime changed) + deleted files.

---

## Decision 2: Filesystem Watching — Brain Root (Local)

**Decision**: Use `fs.watch` with `{ recursive: true }`  
**Rationale**: The brain directory is on a local ext4 filesystem. `fs.watch` uses inotify
on Linux and is efficient — no polling overhead. `recursive: true` covers subdirectory
changes (People/, Projects/, Ideas/, Admin/) in a single watcher instance.

**Alternatives considered**:
- Manual polling (same as share) — unnecessary overhead on local fs; inotify is free
- Per-directory `fs.watch` — more instances, more complexity; recursive single watcher suffices

**Note**: `fs.watch` on Linux emits `'rename'` for both creates and deletes, and `'change'`
for modifications. Both event types should trigger a debounced scanner re-index.

---

## Decision 3: Debounce Strategy

**Decision**: Simple timer-reset debounce per watcher (one debounce timer per root)  
**Rationale**: Coalesces rapid bursts of changes (e.g., saving a file triggers multiple
inotify events) into a single action. Implemented with `clearTimeout` / `setTimeout`.
Default 2 seconds for brain (fast local writes), 0 seconds for share (polling already
coalesces by design — one notification per poll cycle).

---

## Decision 4: Binary File Detection

**Decision**: Read first 8 KB as a `Buffer`; check for null bytes (`buffer.indexOf(0) !== -1`)  
**Rationale**: Null bytes (0x00) are extremely rare in valid UTF-8 text. Binary formats
(images, PDFs, executables, compiled files) consistently contain null bytes. Fast to check,
requires no dependency, handles ~95% of cases correctly.

**Fallback**: If the file extension is in a known binary list (`.png`, `.jpg`, `.pdf`,
`.docx`, `.xlsx`, `.zip`, `.exe`, `.bin`, etc.) reject immediately without reading.
Extension check costs nothing and catches the most common cases before any I/O.

**Alternatives considered**:
- Extension allowlist only — unreliable for files with no extension or wrong extension
- `file-type` npm package — rejected per constitution VII

---

## Decision 5: Path Traversal Prevention

**Decision**: `path.resolve(root, userSuppliedPath)` then assert result starts with
`root + path.sep` (or equals `root`)  
**Rationale**: `path.resolve` normalises `..` segments and produces an absolute path.
The containment check (`startsWith`) ensures the resolved path cannot escape the root.
Run on Linux only — no Windows path separator edge cases.

**Pattern**:
```typescript
import { resolve } from "path";

function containsPath(root: string, userPath: string): string {
  const resolved = resolve(root, userPath);
  const rootWithSep = root.endsWith("/") ? root : root + "/";
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path outside allowed root");
  }
  return resolved;
}
```

**Symlink note**: `path.resolve` does NOT follow symlinks. If symlinks to outside the root
are a concern, `fs.realpath` must be called after resolve. For this feature, symlink
traversal is treated as out-of-scope; the root directories are operator-controlled.

---

## Decision 6: Relay-Initiated Write Suppression (Share Watcher)

**Decision**: Maintain a short-lived `Set<string>` of absolute paths the relay is currently
writing. Share watcher checks changed paths against this set and skips notification for any
match. The set entry is removed after the write completes (or after a 5-second timeout as
a safety net).  
**Rationale**: Simple, in-memory, no persistence required. The window between write start
and watcher poll (10s interval) is wide enough that the set entry will almost always be
cleared before the next poll checks it.

---

## Decision 7: Config Extension Strategy

**Decision**: Add a new optional `files` block to `configSchema` (Zod) alongside the
existing `secondbrain` block. Environment variables follow the existing `FILES_` prefix
pattern.

```
FILES_SHARE_ROOT=/mnt/PersonalAssistantHub
FILES_BRAIN_ROOT=~/.claude-relay/secondbrain   (defaults to secondbrain.dataDir if set)
FILES_MAX_READ_BYTES=51200                      (default 50KB)
FILES_SHARE_POLL_INTERVAL_MS=10000             (default 10s)
FILES_BRAIN_DEBOUNCE_MS=2000                   (default 2s)
```

Both roots are optional; if a root is not configured, commands referencing it return
"root not configured".
