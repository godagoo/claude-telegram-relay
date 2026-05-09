# Lessons

## 2026-05-08 - Phase 1.1 relay hardening

- Live decision logs are the source of truth for trigger quality. Explicit user
  requests such as "search your index" and "anesthesia textbook" must be covered
  by regression tests, not only by generic referential-memory examples.
- FTS query builders should remove retrieval-control words (`continue`,
  `search`, `index`, `corpus`) before searching. Those words describe the
  command, not the corpus content.
- When the current message is only a retrieval command, use a small bounded
  window of recent user turns to recover the actual subject anchor.
- Filename/path matches are a separate retrieval path from chunk text. Textbook
  title searches need a scoped path fallback because FTS chunk text may not
  contain the book title.
- Generic textbook title queries such as `anesthesia textbook` need the same
  path fallback as named title queries (`Miller`, `Barash`). Otherwise profile
  notes outrank the actual textbook file-path evidence.
- Path fallback must stay rooted at the known textbook directory. Running GLOB
  title scans across Obsidian or `.claude` for common terms such as `anesthesia`
  can hit the worker timeout.
- A file being present in `files` does not mean searchable content exists.
  Textbook PDFs can show `extraction_status=skipped` and `chunk_count=0`; surface
  that state to Claude instead of pretending the content was searched.
- If retrieval returns only skipped textbook path hits, answer deterministically
  instead of launching Claude. Otherwise the model spends minutes reasoning over
  unavailable content and may provide a generic answer.
- Queue-level catch blocks must log and rethrow. Swallowing handler errors makes
  failed deliveries look completed and hides operational defects.
- Startup retrieval checks should degrade the relay to no indexed retrieval
  instead of keeping Telegram offline. The bot should still answer ordinary
  messages when FTS or the watcher is unhealthy.
- FTS preflight probes must use a narrow, already-regressed AND query. Broad
  tokens such as `todo` can still hit this DB's fragile FTS virtual-table path.
- Retiring the official Telegram plugin means disabling its token file, not just
  killing the bridge process. Cursor can respawn the bridge while the token file
  remains in `~/.claude/channels/telegram/.env`.

## 2026-05-08 - Path-fallback prefix scoping

- Path-fallback GLOB patterns with a leading wildcard (`Textbooks/*Barash*`)
  cannot use any path index. On a populated indexer DB this triggers the 8s
  FTS worker timeout (`fts_timeout_8000ms`). When path fallback errors out,
  the deterministic skipped-textbook guard sees zero hits and falls through
  to Claude, which then runs for the full 5-minute timeout. Fix: AND each
  GLOB with an indexable prefix (`f.path LIKE 'root/%'`) so SQLite scopes
  the scan to the textbook directory before evaluating the GLOB.
  EXPLAIN QUERY PLAN confirms the new shape uses
  `SEARCH f USING COVERING INDEX idx_files_path` instead of `SCAN f`.
- Long-form Miller/Barash phrasings ("What does miller say about the
  indications for intubation?") must be covered by explicit unit tests, not
  just `"What does Barash say?"`-style probes. The exact phrasings from
  `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl` are the source of truth
  — backport the live failure into the test suite the moment the bug is
  reproduced.
- A path-fallback failure can silently mask the deterministic skipped-textbook
  guard. When diagnosing skipped-textbook timeouts, always check
  `[retrieval] path fallback failed:` lines in `relay.err.log` before
  assuming the guard itself is broken.
