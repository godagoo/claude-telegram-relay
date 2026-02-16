# Feature Specification: File Access for Telegram Interface

**Feature Branch**: `004-file-access`
**Created**: 2026-02-15
**Status**: Draft

## Overview

Two named file roots are accessible through the relay:

- **`share`** — the mounted Windows fileshare (`/mnt/PersonalAssistantHub`). Changes arrive
  both from outside the relay (user editing on Windows directly) and through Telegram. The relay
  watches for external changes and notifies the user when they land.
- **`brain`** — the scanner's SecondBrain data directory (People/Projects/Ideas/Admin). Changes
  arrive through Telegram only. The relay watches for changes to keep the scanner index current.

Both roots are browsable, searchable, and readable via Telegram commands. Write-back to either
root is handled in spec 005.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Browse Files Across Both Roots (Priority: P1)

A user sends `/files` to see both roots, or `/files share/People` to drill into a specific
location. This works identically for both `share` and `brain` roots.

**Why this priority**: Foundational — users must be able to navigate before they can read or
search. Also serves as a health check that both roots are accessible.

**Independent Test**: Send `/files` with both roots configured. Confirm the response lists
`share/` and `brain/` as top-level entries. Send `/files share/People` and confirm only that
subdirectory's contents appear. Send `/files brain` and confirm the brain root is listed.
Delivers standalone value as a file browser.

**Acceptance Scenarios**:

1. **Given** both roots are configured and accessible, **When** the user sends `/files`, **Then**
   the relay returns a virtual top-level listing showing `share/` and `brain/` as named entries
2. **Given** a valid path within a root, **When** the user sends `/files <root>/<subpath>`,
   **Then** the relay returns only the contents of that directory
3. **Given** the user sends `/files <root>` with no subpath, **Then** the relay returns the
   top-level contents of that root
4. **Given** a path containing `..` or referencing outside any configured root, **When** the
   relay processes the request, **Then** it refuses with a clear error and returns no content
5. **Given** one root is offline or inaccessible, **When** the user sends `/files`, **Then** the
   relay returns the available root normally and notes the unavailable one with an error

---

### User Story 2 — Read a File and Inject into Conversation (Priority: P2)

A user sends `/read <root>/<path>` and the file content is injected into the current Claude
conversation as context. Works for files in either root.

**Why this priority**: Primary value of file access — making file content available to Claude
for questions, analysis, or write-back (spec 005). Browsing alone has limited value without it.

**Independent Test**: Send `/read share/People/Alice.md` where the file exists on the share.
Confirm the content appears in Claude's context and Claude can answer questions about it.
Repeat with `/read brain/Projects/foo.md` for the brain root.

**Acceptance Scenarios**:

1. **Given** a readable text file at the given path, **When** the user sends `/read <root>/<path>`,
   **Then** the file content is prepended to the Claude prompt for the current conversation turn
2. **Given** the file exceeds the maximum injectable size, **When** the user sends `/read`,
   **Then** the relay injects the first allowed portion and notifies the user it was truncated
3. **Given** a binary or non-text file at the path, **When** the user sends `/read`,
   **Then** the relay declines gracefully and informs the user the file type is not supported
4. **Given** a path with no root prefix, **When** the user sends `/read <path>`,
   **Then** the relay returns an error asking the user to specify a root (`share` or `brain`)
5. **Given** a path that does not exist, **When** the user sends `/read`, **Then** the relay
   returns a "file not found" message

---

### User Story 3 — Search Files by Name Across Both Roots (Priority: P3)

A user sends `/search <query>` to find matching file and folder names across both roots, or
`/search <root>/<query>` to limit to one root. Results are prefixed with the root name so
the user knows where each file lives.

**Why this priority**: Discoverability — the share may contain many files; users should not
need to know exact paths. Search spans both roots by default to surface everything relevant.

**Independent Test**: With known files in both roots, send `/search alice` and confirm results
from both `share/` and `brain/` appear, each prefixed with their root. Send
`/search share/alice` and confirm only share results are returned.

**Acceptance Scenarios**:

1. **Given** matching files exist in both roots, **When** the user sends `/search <query>`,
   **Then** the relay returns matching paths from both roots, each prefixed with `share/` or
   `brain/`
2. **Given** the user sends `/search <root>/<query>`, **When** processed, **Then** only files
   within that root are searched and returned
3. **Given** no files match in any root, **When** the user sends `/search <query>`, **Then**
   the relay responds with "no results found"
4. **Given** a query with special characters, **When** the relay processes it, **Then** it is
   treated as a literal case-insensitive substring match against file and folder names only —
   not file contents, not a regex or glob
5. **Given** one root is offline, **When** the user sends `/search`, **Then** the relay returns
   results from the available root and notes the unavailable one

---

### User Story 4 — Watch Share for External Changes (Priority: P4)

The relay monitors the `share` root for filesystem changes. When files are added, modified, or
removed on the Windows share outside the relay (e.g. the user editing directly on Windows), the
relay sends a Telegram notification summarising what changed.

**Why this priority**: The share is edited externally without the relay's knowledge. Without
monitoring, the user would not know when new or updated files are available to read or act on.

**Independent Test**: With the relay running, add a file to the share from Windows. Within
30 seconds, confirm a Telegram message arrives listing the new file path. Modify an existing
file on Windows; confirm a change notification arrives.

**Acceptance Scenarios**:

1. **Given** the relay is watching the share root, **When** a file is created or modified
   externally, **Then** the relay sends a Telegram notification listing the changed paths within
   the configured poll interval (default 10 seconds)
2. **Given** multiple files change within the poll interval, **When** the poll fires,
   **Then** a single notification is sent listing all changed paths rather than one per file
3. **Given** the share goes offline, **When** it comes back online, **Then** the watcher
   resumes and detects the next external change normally
4. **Given** a change to the share was made through the relay itself (spec 005 write-back),
   **When** the watcher detects it, **Then** no notification is sent (relay-initiated changes
   are not reported as external)

---

### User Story 5 — Watch Brain Directory for Scanner Index Currency (Priority: P5)

The relay monitors the `brain` root for filesystem changes. When files change, the scanner
service re-indexes automatically. This keeps the in-memory document index current without
requiring a manual reload command.

**Why this priority**: Brain changes arrive through Telegram (the relay writes them). The
watcher ensures the scanner's index reflects the latest state after each write without the
user needing to trigger a reload.

**Independent Test**: With the relay running, add a new markdown file to the brain data
directory. Without any manual command, confirm the scanner's document index includes the new
file within 30 seconds.

**Acceptance Scenarios**:

1. **Given** the relay is watching the brain directory, **When** a file is created or modified
   there, **Then** the scanner service re-indexes within the configured debounce window
   (default 2 seconds), silently with no Telegram notification
2. **Given** rapid successive changes within the debounce window, **When** they occur, **Then**
   only one re-index is triggered rather than one per change
3. **Given** the brain directory becomes temporarily inaccessible, **When** it becomes accessible
   again, **Then** the watcher resumes and triggers a re-index on the next change

---

### Edge Cases

- What happens when a path contains `..` or a symlink pointing outside a configured root?
- How does `/files` behave when given a path pointing at a single file rather than a directory?
- How are permission-denied errors on individual files handled during listing or search —
  skip silently, skip with a warning, or abort the whole operation?
- What happens if one watcher fails while the other continues — does the relay degrade gracefully?
- How does the share watcher distinguish relay-initiated writes (spec 005) from external changes?
- What if both roots are on the same physical path (misconfiguration)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support two named file roots, `share` and `brain`, each with an
  independently configured filesystem path
- **FR-002**: System MUST expose a `/files [<root>][/<subpath>]` command: no arguments returns
  a virtual top-level listing of both roots; a root name returns that root's top-level; a full
  path returns that directory's contents
- **FR-003**: System MUST expose a `/read <root>/<path>` command that injects the text content
  of the specified file into the current Claude prompt; a path without a root prefix MUST be
  rejected with a prompt to specify the root
- **FR-004**: System MUST expose a `/search <query>` command that matches file and folder names
  (case-insensitive substring, not contents) across both roots by default; `/search <root>/<query>`
  limits the search to that root; results are prefixed with their root name
- **FR-005**: System MUST restrict all file access to paths within configured roots; any path
  referencing outside a root (including `..` traversal) MUST be rejected before any file
  operation. Symbolic links MUST be resolved via `fs.promises.realpath()` before the containment
  check; a symlink whose resolved target falls outside the configured root MUST be rejected with
  `PATH_OUTSIDE_ROOT`
- **FR-006**: System MUST limit injectable content from `/read` to a configurable maximum size;
  content exceeding the limit MUST be truncated with a visible notice
- **FR-007**: System MUST return descriptive user-facing error messages (not stack traces) when
  a root is offline, a path is not found, or a file cannot be read as text
- **FR-008**: System MUST watch the `share` root for external filesystem changes and send a
  Telegram notification summarising changed paths, applying a configurable poll interval
- **FR-009**: System MUST suppress share-watcher notifications for changes the relay made itself
  (to avoid notifying the user about their own relay-driven writes)
- **FR-010**: System MUST watch the `brain` root for filesystem changes and trigger a scanner
  re-index on change, applying a configurable debounce delay; no Telegram notification is sent
- **FR-011**: System MUST continue handling all other Telegram commands normally when one or
  both roots are offline or a watcher is unavailable
- **FR-012**: System MUST detect binary files and return an informative refusal rather than
  raw bytes
- **FR-013**: System MUST allow both root paths, the share poll interval, the brain debounce
  interval, and the maximum injectable size to be set via configuration without code changes
- **FR-014**: If a root is not configured, commands referencing that root MUST return a clear
  "root not configured" message rather than an error

### Key Entities

- **FileRoot**: A named, configured base directory (`share` or `brain`); all user paths are
  resolved relative to a root
- **FileEntry**: A listing item with a name, type (file or directory), root name, and relative
  path; returned by `/files`
- **FileContent**: The text content of a file with its root, relative path, and truncation flag;
  injected into the Claude prompt by `/read`
- **SearchResult**: A root-prefixed relative path whose name matches the search query
- **WatchEvent**: An internal signal from either watcher carrying the root name, changed paths,
  and whether the change was relay-initiated; routes to notification or re-index accordingly

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can list both roots in under 2 seconds when both are accessible
- **SC-002**: Users can read and inject a text file under the size limit into a Claude
  conversation in under 3 seconds end-to-end
- **SC-003**: Path traversal attempts are rejected 100% of the time with no content returned
- **SC-004**: External share changes produce a Telegram notification within 10 seconds under
  normal load
- **SC-005**: Brain directory changes trigger a scanner re-index within 10 seconds under
  normal load
- **SC-006**: The relay remains operational and handles non-file commands when one or both
  roots are offline
- **SC-007**: All file commands (`/files`, `/read`, `/search`) are discoverable via `/help`
- **SC-008**: Relay-initiated share writes never produce a share-change notification

## Assumptions

- `share` maps to `/mnt/PersonalAssistantHub` (established in spec 003-secondbrain-infra)
- `brain` maps to the ScannerService's configured data directory (separate path from the share)
- Text files include `.md`, `.txt`, `.json`, `.yaml`, `.csv`, and similar plain-text formats;
  binary detection uses file header inspection or extension
- Maximum injectable file size defaults to 50 KB; configurable
- Both watchers are opt-in; if a root path is not configured the corresponding watcher does
  not start
- Distinguishing relay-initiated vs external share writes is achieved by the relay recording
  a short-lived "write in progress" marker before writing and checking it in the watcher callback
- No new npm dependencies; all file and watch operations use Node.js standard library
  (per project constitution VII)
