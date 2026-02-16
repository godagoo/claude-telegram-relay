# Quickstart: 004-file-access

**Date**: 2026-02-15
**Branch**: `004-file-access`
**Prerequisites**: spec 003-secondbrain-infra complete; share mounted at `/mnt/PersonalAssistantHub`

---

## 1. Configure the roots

Add to your `.env` file:

```bash
FILES_SHARE_ROOT=/mnt/PersonalAssistantHub
FILES_BRAIN_ROOT=/var/lib/secondbrain/data
FILES_MAX_READ_BYTES=51200
FILES_SHARE_POLL_INTERVAL_MS=10000
FILES_BRAIN_DEBOUNCE_MS=2000
```

If `FILES_BRAIN_ROOT` is not set but `SECONDBRAIN_DATA_DIR` is, the brain root defaults
to that value automatically.

---

## 2. Run tests

```bash
npm test
```

---

## 3. Start the relay

Start the relay normally. At startup the relay logs:
```
[info] FileService: share root = /mnt/PersonalAssistantHub
[info] FileService: brain root = /var/lib/secondbrain/data
[info] WatcherService: share watcher started (poll 10000ms)
[info] WatcherService: brain watcher started (debounce 2000ms)
```

---

## 4. Browse files

Send: `/files`
Expected:
```
share/
brain/
```

Send: `/files share/People`
Expected:
```
Alice.md
Bob.md
Archive/
```

---

## 5. Read a file

Send: `/read share/People/Alice.md`
Expected: file content sent as Telegram message and injected into Claude context.

If the file exceeds 50 KB:
```
File truncated to 50 KB (actual: 120 KB). Showing first 50 KB.
[file content...]
```

---

## 6. Search files

Send: `/search alice`
Expected:
```
Results for "alice" (2):
1. share/People/Alice.md
2. brain/People/alice-notes.md
```

Send: `/search share/project` — only share results returned.

---

## 7. Verify the share watcher

1. Add a file to `PersonalAssistantHub` from Windows
2. Wait up to 10 seconds
3. Expected Telegram notification:
```
Files changed on share:
  + NewDocument.docx
```

---

## 8. Verify the brain watcher

1. Add a `.md` file to the brain data directory
2. Wait up to 5 seconds (debounce)
3. Verify scanner re-indexed (use a SecondBrain command that queries the index)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/files` returns "root not configured" | `FILES_SHARE_ROOT` not set | Add env var, restart relay |
| Share watcher sends no notifications | CIFS does not support inotify (expected) — polling is used | Wait up to `FILES_SHARE_POLL_INTERVAL_MS` |
| `/read` returns "binary file" | Non-text file requested | Only `.md`, `.txt`, `.json`, etc. supported |
| Brain re-index not triggering | `FILES_BRAIN_ROOT` wrong path | Verify path matches scanner data dir |
