# Contract: WatcherService

**Feature**: 004-file-access
**Date**: 2026-02-15
**Module**: `src/services/watcher.ts`

---

## Interface

```typescript
interface WatcherServiceContract {
  /**
   * Start both watchers. Safe to call if already running (no-op).
   * - Share watcher: begins polling at sharePollIntervalMs
   * - Brain watcher: begins fs.watch on brainRoot (if configured)
   * Skips a watcher if its root is not configured.
   */
  start(): void;

  /**
   * Stop both watchers and clear all timers. Safe to call if not running.
   */
  stop(): void;
}
```

---

## Callback Contracts (injected at construction)

```typescript
interface WatcherCallbacks {
  /**
   * Called when the share watcher detects external changes.
   * @param diff - Files added, modified, or deleted since last poll
   * Responsibility of caller: send Telegram notification to user.
   */
  onShareChange(diff: ShareDiff): void;

  /**
   * Called when the brain watcher detects any change (after debounce).
   * Responsibility of caller: trigger ScannerService.scanAllDocuments().
   */
  onBrainChange(): void;
}

interface ShareDiff {
  added: string[];     // root-relative paths of new files
  modified: string[];  // root-relative paths of changed files
  deleted: string[];   // root-relative paths of removed files
}
```

---

## Behaviour Guarantees

| Guarantee | Share | Brain |
|-----------|-------|-------|
| Does not use inotify | ✓ (poll-based) | ✗ (uses inotify — local fs) |
| Coalesces rapid changes | ✓ (one diff per poll interval) | ✓ (debounce timer) |
| Suppresses relay writes | ✓ (checks PendingWrite set) | n/a |
| No notification on first poll | ✓ (establishes baseline) | n/a |
| Survives share going offline | ✓ (catches readdir errors; resumes next poll) | n/a |
| Survives brain dir inaccessible | n/a | ✓ (catches fs.watch errors; logs warn) |

---

## Construction

```typescript
new WatcherService(
  config: FilesConfig,
  callbacks: WatcherCallbacks,
  pendingWrites: Set<string>,   // shared reference from FileService
  logger: Logger
)
```

`WatcherService` depends on `FileService` only through the shared `pendingWrites` reference.
It does not import `FileService` directly — avoiding circular dependencies.
