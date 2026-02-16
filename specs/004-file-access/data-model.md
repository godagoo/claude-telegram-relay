# Data Model: 004-file-access

**Date**: 2026-02-15
**Branch**: `004-file-access`

---

## Config Entities

### FilesConfig *(new — added to AppConfig)*

Extends `AppConfig` via optional `files` block in `configSchema`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `shareRoot` | `string \| undefined` | `undefined` | Absolute path to mounted Windows share |
| `brainRoot` | `string \| undefined` | `undefined` | Absolute path to SecondBrain data dir |
| `maxReadBytes` | `number` | `51200` | Max bytes injectable by `/read` (50 KB) |
| `sharePollIntervalMs` | `number` | `10000` | Share watcher poll interval |
| `brainDebounceMs` | `number` | `2000` | Brain watcher debounce delay |

If both roots are `undefined`, all file commands return "file access not configured".
`brainRoot` defaults to `secondbrain.dataDir` when that config block is present.

---

## Service Entities

### FileRoot

Runtime representation of a named root. Not persisted — built at startup from config.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `'share' \| 'brain'` | Root identifier used in command prefixes |
| `absolutePath` | `string` | Resolved, canonical path on the local filesystem |

---

### FileEntry

Returned by `/files`. Represents one item in a directory listing.

| Field | Type | Description |
|-------|------|-------------|
| `root` | `'share' \| 'brain'` | Which root this entry belongs to |
| `relativePath` | `string` | Path relative to root (e.g. `People/Alice.md`) |
| `name` | `string` | Basename only |
| `type` | `'file' \| 'directory'` | Entry kind |

No persistence. Created on-demand per `/files` call.

---

### FileContent

Returned by `/read`. Injected into Claude prompt context.

| Field | Type | Description |
|-------|------|-------------|
| `root` | `'share' \| 'brain'` | Which root this content came from |
| `relativePath` | `string` | Path relative to root |
| `text` | `string` | UTF-8 text content (possibly truncated) |
| `truncated` | `boolean` | `true` if content exceeded `maxReadBytes` |
| `sizeBytes` | `number` | Actual file size in bytes |

No persistence. Created on-demand per `/read` call.

---

### SearchResult

Returned by `/search`. One per matching file or directory name.

| Field | Type | Description |
|-------|------|-------------|
| `root` | `'share' \| 'brain'` | Which root this match came from |
| `relativePath` | `string` | Root-relative path of the match |
| `name` | `string` | Matched file/folder name |
| `type` | `'file' \| 'directory'` | Entry kind |

No persistence. Created on-demand per `/search` call.

---

## Watcher State Entities

### ShareSnapshot *(in-memory only)*

The share watcher maintains this to diff between polls.

| Field | Type | Description |
|-------|------|-------------|
| `entries` | `Map<string, number>` | `relativePath → mtimeMs` for every file under share root |
| `capturedAt` | `number` | `Date.now()` when snapshot was taken |

Rebuilt from `readdir`+`stat` walk on each poll cycle. Not persisted — rebuilt on restart
(first poll after restart sends no notification; establishes baseline).

---

### ShareDiff *(in-memory, ephemeral)*

Result of comparing two consecutive `ShareSnapshot` values.

| Field | Type | Description |
|-------|------|-------------|
| `added` | `string[]` | Relative paths of new files |
| `modified` | `string[]` | Relative paths of files whose `mtimeMs` changed |
| `deleted` | `string[]` | Relative paths that existed before but are gone |

Empty diff = no notification sent. Non-empty diff = Telegram notification + update snapshot.

---

### PendingWrite *(in-memory only)*

Set of absolute paths the relay is currently writing (used to suppress share notifications).

| Structure | `Set<string>` |
|-----------|---------------|
| Entry added | Before relay writes a file to the share |
| Entry removed | After write completes, or after 5-second safety timeout |

---

## State Transitions

### Share Watcher Lifecycle

```
IDLE → POLLING (setInterval fires)
POLLING → DIFF (readdir+stat walk complete)
DIFF → NOTIFY (diff non-empty AND path not in PendingWrite)
DIFF → IDLE (diff empty or all paths suppressed)
NOTIFY → IDLE (Telegram message sent)
```

### Brain Watcher Lifecycle

```
IDLE → PENDING (fs.watch event received)
PENDING → PENDING (additional events within debounce window reset timer)
PENDING → REINDEX (debounce timer fires)
REINDEX → IDLE (ScannerService.scanAllDocuments() resolves)
```

---

## Environment Variables (new)

| Variable | Maps to | Default |
|----------|---------|---------|
| `FILES_SHARE_ROOT` | `files.shareRoot` | `undefined` |
| `FILES_BRAIN_ROOT` | `files.brainRoot` | `undefined` (falls back to `secondbrain.dataDir`) |
| `FILES_MAX_READ_BYTES` | `files.maxReadBytes` | `51200` |
| `FILES_SHARE_POLL_INTERVAL_MS` | `files.sharePollIntervalMs` | `10000` |
| `FILES_BRAIN_DEBOUNCE_MS` | `files.brainDebounceMs` | `2000` |
