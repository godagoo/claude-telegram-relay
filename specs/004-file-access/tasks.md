---
description: "Task list for 004-file-access"
---

# Tasks: File Access for Telegram Interface

**Input**: Design documents from `/specs/004-file-access/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = Browse, US2 = Read, US3 = Search, US4 = Share Watcher, US5 = Brain Watcher

---

## Phase 1: Setup (Shared Types & Config)

**Purpose**: Create the new types file and extend config — shared by all user stories.

- [X] T001 [P] Create `src/types/files.ts` with `FileEntry`, `FileContent`, `SearchResult`,
  `ShareDiff`, `FileAccessError`, `FileAccessErrorCode`, `FilesConfig` type definitions
  matching `specs/004-file-access/data-model.md` and `contracts/file-service.md`
- [X] T002 [P] Add `FilesConfig` to `AppConfig` in `src/types/config.ts` as optional `files?`
  field; export `FilesConfig` from `src/types/index.ts`
- [X] T003 Add `files` block to `configSchema` in `src/config/schema.ts` with Zod validation
  for `shareRoot`, `brainRoot`, `maxReadBytes` (default 51200), `sharePollIntervalMs`
  (default 10000), `brainDebounceMs` (default 2000); add `parseFilesEnvVars()` using
  `FILES_SHARE_ROOT`, `FILES_BRAIN_ROOT`, `FILES_MAX_READ_BYTES`, `FILES_SHARE_POLL_INTERVAL_MS`,
  `FILES_BRAIN_DEBOUNCE_MS`; `brainRoot` falls back to `secondbrain.dataDir` when set

---

## Phase 2: Foundational (FileService Core)

**Purpose**: Implement the shared path-safety and binary-detection primitives that every
user story depends on. No user story can be tested until these pass.

**⚠️ CRITICAL**: All US1–US5 implementation depends on these helpers being correct.

- [X] T004 [P] Write failing unit tests for `FileService` core helpers in
  `tests/unit/services/files.test.ts`: `resolveSafe(root, path)` rejects `..` traversal,
  rejects absolute paths outside root, accepts valid subpaths,
  rejects symlinks whose `fs.promises.realpath()` resolves outside the root (throws
  `FileAccessError` with code `PATH_OUTSIDE_ROOT`), treats absent symlink targets (ENOENT
  from realpath) as `NOT_FOUND`; `isBinary(buf)` returns true
  for buffers with null bytes, false for clean UTF-8; `parseRoot(rawPath)` splits `share/foo`
  → `{ root: 'share', subpath: 'foo' }`, bare `share` → `{ root: 'share', subpath: '' }`,
  no-prefix path → `{ root: undefined, subpath: rawPath }`
- [X] T005 Implement `FileService` class skeleton in `src/services/files.ts` with constructor
  taking `FilesConfig` and `Logger`; implement `resolveSafe()`, `isBinary()`, `parseRoot()`,
  `markPendingWrite()`, `releasePendingWrite()` (5-second safety timeout on each entry);
  `resolveSafe()` MUST call `fs.promises.realpath()` after the lexical `path.resolve` check —
  if realpath resolves outside the root throw `PATH_OUTSIDE_ROOT`; if realpath throws ENOENT
  throw `NOT_FOUND`;
  verify all T004 tests pass

**Checkpoint**: Core helpers correct — user story phases can begin.

---

## Phase 3: User Story 1 — Browse Files (Priority: P1) 🎯 MVP

**Goal**: `/files` and `/files <root>/<subpath>` return directory listings from either root.

**Independent Test**: Configure one or both roots pointing at local directories. Send `/files`
— confirm virtual top-level listing. Send `/files share/People` — confirm subdirectory contents.
Deliver invalid path — confirm rejection. Disconnect root — confirm error, relay still responds.

- [X] T006 [P] [US1] Write failing unit tests for `FileService.list()` in
  `tests/unit/services/files.test.ts`:
  — no arg → returns two `FileEntry` items with `type:'directory'` named `share` and `brain`
    (only for configured roots)
  — `'share'` → returns top-level entries of share root
  — `'share/People'` → returns entries of that subdirectory
  — path with `..` → throws `FileAccessError` with code `PATH_OUTSIDE_ROOT`
  — unconfigured root → throws `FileAccessError` with code `ROOT_NOT_CONFIGURED`
  — root dir unreadable → throws `FileAccessError` with code `ROOT_OFFLINE`
- [X] T007 [US1] Implement `FileService.list(rawPath?)` in `src/services/files.ts`; uses
  `parseRoot`, `resolveSafe`, `fs/promises.readdir` with `{ withFileTypes: true }`; returns
  `FileEntry[]`; verify all T006 tests pass
- [X] T008 [US1] Register `/files` command handler in `src/index.ts` (gated on
  `config.files?.shareRoot || config.files?.brainRoot`): parses command args, calls
  `fileService.list()`, formats response as bulleted list with `[DIR]`/`[FILE]` prefixes;
  catches `FileAccessError` and sends human-readable error per constitution IV

**Checkpoint**: US1 complete. Send `/files` and `/files share/People` from Telegram — both work.

---

## Phase 4: User Story 2 — Read File (Priority: P2)

**Goal**: `/read <root>/<path>` injects text file content into the Claude prompt for the
current conversation turn.

**Independent Test**: Send `/read share/People/Alice.md` — confirm content appears in Claude
context and Claude can answer questions about it. Send `/read share/image.png` — confirm
binary refusal. Send `/read People/Alice.md` (no root) — confirm prefix-required error.

- [X] T009 [P] [US2] Write failing unit tests for `FileService.read()` in
  `tests/unit/services/files.test.ts`:
  — valid text file → returns `FileContent` with `truncated:false`
  — file over `maxReadBytes` → returns `FileContent` with `truncated:true` and `text` length
    exactly `maxReadBytes`
  — file with null bytes → throws `FileAccessError` with code `IS_BINARY`
  — path without root prefix → throws `FileAccessError` with code `ROOT_PREFIX_REQUIRED`
  — nonexistent file → throws `FileAccessError` with code `NOT_FOUND`
  — root offline → throws `FileAccessError` with code `ROOT_OFFLINE`
- [X] T010 [US2] Implement `FileService.read(rawPath)` in `src/services/files.ts`; enforces
  root prefix; uses `resolveSafe`; reads first 8 KB to `isBinary` check; reads full content
  up to `maxReadBytes` bytes; verify all T009 tests pass
- [X] T011 [US2] Register `/read` command handler in `src/index.ts`: parses path from args,
  calls `fileService.read()`, prepends `FileContent.text` to the Claude prompt for the current
  session turn (follows existing prompt-building pattern in `ClaudeService`); sends truncation
  notice when `truncated:true`; catches `FileAccessError` with user-readable message
- [X] T012 [US2] Add integration test for `/read` round-trip in `tests/integration/files.test.ts`:
  write a temp text file, call `fileService.read()` directly, assert returned text matches file

**Checkpoint**: US2 complete. `/read share/People/Alice.md` injects content and Claude
can answer questions about it in the same message.

---

## Phase 5: User Story 3 — Search Files (Priority: P3)

**Goal**: `/search <query>` returns matching file/folder names from both roots; optional
root prefix limits to one root.

**Independent Test**: Create known files in both roots. Send `/search alice` — confirm results
from both roots with root prefix. Send `/search share/alice` — confirm only share results.
Send `/search nonexistent` — confirm "no results" message.

- [X] T013 [P] [US3] Write failing unit tests for `FileService.search()` in
  `tests/unit/services/files.test.ts`:
  — no-prefix query → results from both configured roots, each prefixed with root name
  — `'share/alice'` → only share results
  — query with zero matches → returns empty array
  — case-insensitive match (`'ALICE'` matches `alice.md`)
  — special characters treated as literal substring (no regex)
  — one root offline → returns results from available root (no throw)
- [X] T014 [US3] Implement `FileService.search(rawQuery)` in `src/services/files.ts`:
  recursive `readdir` walk of configured roots; case-insensitive `includes` match on entry
  name; skips unreadable subdirs (logs warn); returns `SearchResult[]`; verify T013 tests pass
- [X] T015 [US3] Register `/search` command handler in `src/index.ts`: parses query from
  args, calls `fileService.search()`, formats numbered list with root-prefixed paths; empty
  result → "no results found for `<query>`"

**Checkpoint**: US3 complete. `/search alice` returns matches from both roots.

---

## Phase 6: User Story 4 — Watch Share for External Changes (Priority: P4)

**Goal**: Share watcher polls `/mnt/PersonalAssistantHub` and sends Telegram notification
when files change externally; suppresses relay-initiated writes.

**Independent Test**: Start relay with share configured. Add a file on the share from
Windows. Within `sharePollIntervalMs` seconds confirm a Telegram notification listing the
new file arrives. Edit a file through the relay (spec 005 simulation: call
`markPendingWrite` manually); confirm no duplicate notification.

- [X] T016 [P] [US4] Write failing unit tests for `WatcherService` share watcher in
  `tests/unit/services/watcher.test.ts` (use fake timers and mocked `fs/promises`):
  — first poll establishes baseline; `onShareChange` NOT called
  — second poll with new file → `onShareChange` called with `diff.added`
  — second poll with modified mtime → `onShareChange` called with `diff.modified`
  — second poll with removed file → `onShareChange` called with `diff.deleted`
  — changed path in `pendingWrites` → `onShareChange` not called for that path
  — readdir throws → no crash; next poll retries
  — directory nested beyond depth 10 → skipped; `onShareChange` not called for its contents
  — `stop()` clears interval; `onShareChange` not called after stop
- [X] T017 [US4] Create `src/services/watcher.ts` with `WatcherService` class skeleton:
  constructor takes `FilesConfig`, `WatcherCallbacks`, `pendingWrites: Set<string>`, `Logger`;
  `start()` and `stop()` stubs
- [X] T018 [US4] Implement share watcher in `WatcherService.start()`: `setInterval` at
  `sharePollIntervalMs`; recursive `readdir`+`stat` walk (breadth-first, hard depth limit 10 —
  subdirectories beyond depth 10 are skipped with a single `log.warn`) building
  `Map<string, number>`; diff against `shareSnapshot`; filter `pendingWrites`; call
  `onShareChange(diff)` if diff non-empty; update snapshot; verify all T016 tests pass
- [X] T019 [US4] Wire share watcher `onShareChange` callback in `src/index.ts`: formats
  diff as Telegram message ("Files changed on share: + added.md, ~ modified.md, - deleted.md");
  sends to authorised user chat

**Checkpoint**: US4 complete. External share changes produce Telegram notification within
`sharePollIntervalMs` seconds.

---

## Phase 7: User Story 5 — Watch Brain for Scanner Re-index (Priority: P5)

**Goal**: Brain watcher uses `fs.watch` (inotify) to detect changes in the scanner data
directory and triggers a debounced `ScannerService.scanAllDocuments()`.

**Independent Test**: Start relay with brain root configured. Add a `.md` file to the brain
data directory. Within `brainDebounceMs` + scanner time, verify scanner index includes the
new file (use a SecondBrain command that queries the index).

- [X] T020 [P] [US5] Write failing unit tests for `WatcherService` brain watcher in
  `tests/unit/services/watcher.test.ts` (fake timers, mocked `fs.watch`):
  — `fs.watch` event fires → `onBrainChange` called after debounce timer expires
  — multiple events within debounce window → `onBrainChange` called exactly once
  — `fs.watch` error event → logs warn; does not crash
  — `stop()` closes watcher; `onBrainChange` not called after stop
- [X] T021 [US5] Implement brain watcher in `WatcherService.start()`: `fs.watch(brainRoot,
  { recursive: true })`; any event resets `clearTimeout`/`setTimeout` debounce;
  on timer fire call `onBrainChange()`; error handler logs warn; verify T020 tests pass
- [X] T022 [US5] Wire brain watcher `onBrainChange` callback in `src/index.ts`: calls
  `scannerService.scanAllDocuments()` (already instantiated for SecondBrain commands);
  logs `info` on re-index complete; no Telegram notification

**Checkpoint**: US5 complete. Brain directory changes silently trigger scanner re-index.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Help discoverability, run full verification suite, validate quickstart.

- [X] T023 [P] Add `/files`, `/read <root/path>`, and `/search <query>` to bot help text
  in `src/index.ts`; include brief usage hint for each
- [X] T024 [P] Add integration tests covering both-roots and offline-root scenarios in
  `tests/integration/files.test.ts`: `list()` with real temp dirs; `search()` across two dirs;
  `read()` truncation; one root absent
- [X] T025 Run full test suite (`npm test`) and `npm run typecheck` and `npm run lint`;
  fix any failures before proceeding
- [X] T026 Step through `specs/004-file-access/quickstart.md` steps 1–8 on the running relay;
  update quickstart.md if any step description is incorrect

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately (T001–T003 run in parallel)
- **Foundational (Phase 2)**: Depends on Phase 1 (T003 must be complete before T005)
- **US1 (Phase 3)**: Depends on Phase 2
- **US2 (Phase 4)**: Depends on Phase 2; US1 not required but `/read` reuses `FileService`
- **US3 (Phase 5)**: Depends on Phase 2; independent of US1 and US2
- **US4 (Phase 6)**: Depends on Phase 2; `WatcherService` created here (T017)
- **US5 (Phase 7)**: Depends on T017 (WatcherService skeleton)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: No dependency on other stories
- **US2 (P2)**: No dependency; reuses `FileService` from Foundational phase
- **US3 (P3)**: No dependency; reuses `FileService`
- **US4 (P4)**: No dependency; `WatcherService` is a new class
- **US5 (P5)**: Depends on T017 (WatcherService skeleton created in US4 phase)

### Within Each User Story

- Tests (T004, T006, T009, T013, T016, T020) MUST be written and FAIL before implementation
- T005 (helpers) before T007 (list), T010 (read), T014 (search)
- T017 (skeleton) before T018 (share impl) and T021 (brain impl)
- Implementation before command handler registration
- Command registration (index.ts) last in each story

### Parallel Opportunities

```bash
# Phase 1 — all in parallel:
Task: T001 — src/types/files.ts
Task: T002 — src/types/config.ts
Task: T003 — src/config/schema.ts  (can start T001/T002 in parallel with T003)

# Phase 2 — test and impl sequential:
Task: T004 — write failing tests
Task: T005 — implement helpers (after T004)

# After Phase 2, US1–US4 test-writing is parallelisable:
Task: T006 — US1 tests
Task: T009 — US2 tests
Task: T013 — US3 tests
Task: T016 — US4 tests

# US5 test writing starts after T017 (WatcherService skeleton):
Task: T020 — US5 tests
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T005)
3. Complete Phase 3: US1 Browse (T006–T008)
4. **STOP and VALIDATE**: `/files` and `/files share/People` work from Telegram
5. Proceed to US2 only after US1 smoke tests pass

### Incremental Delivery

1. US1 → file browser → validate
2. US2 → file injection into Claude → validate
3. US3 → file search → validate
4. US4 → share change notifications → validate with Windows edit test
5. US5 → scanner re-index on brain change → validate with new .md file test
6. Polish → full suite green, quickstart validated

---

## Notes

- All tasks produce changes to `src/` or `tests/` only — no changes to `infra/` or other specs
- Constitution II (Test-First) is non-negotiable: tests MUST be written and FAIL before
  the implementation tasks that make them pass
- `WatcherService` tests use `vi.useFakeTimers()` for `setInterval` / `setTimeout`; mock
  `fs.watch` and `fs/promises.readdir` — never touch real filesystem in unit tests
- `pendingWrites` is a `Set<string>` passed by reference between `FileService` and
  `WatcherService` — no circular imports
- CIFS share watcher will NOT work with `fs.watch` — polling is mandatory (see research.md)
