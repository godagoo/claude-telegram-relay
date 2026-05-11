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

## 2026-05-09 - Skipped-textbook guard semantics: only-when-every

- The deterministic skipped-textbook guard had divergent semantics between the
  two phrasing paths: the original-phrasing path fired whenever ANY hit was a
  skipped textbook path, while the continuation path required EVERY hit to be
  a skipped textbook path. The "only" semantics described in the original
  lesson ("If retrieval returns ONLY skipped textbook path hits, answer
  deterministically") had been lost in the original-phrasing implementation.
  Live evidence: `decisions-2026-05-09.jsonl` entry 1 (04:10:22Z) — user asked
  "What does miller say are the indications for an arterial line?", guard
  fired, user replied "Okay; this response is unacceptable. Please mark it
  down as a bug we must fix." Fix: unify both paths to require
  `hits.every(isSkippedTextbookPath)`, so any extractable hit (markdown notes,
  vault chunks, real PDF chunks) lets Claude reason over real content instead
  of bailing with the canned message.
- A test that asserts buggy behavior is worse than no test. The Loop 1
  regression test "fires when at least one of several hits is a skipped
  textbook path" encoded the wrong semantics as a positive assertion and
  prevented the divergence from being noticed at PR time. Live decision-log
  phrasings are still the source of truth — but the *expected* behavior in
  the test must match the *intended* behavior, not the *current* behavior.

## 2026-05-09 - Known limitation: anchor recovery on topic-pivot follow-ups (deferred)

- Path fallback title matching must validate the basename, not only the full
  path. Live evidence: `Miller_Barash/Barash...pdf` matched a `miller` title
  query because the parent directory contained `Miller_Barash`; that let Barash
  files outrank Miller files. Keep the SQL root/GLOB prefilter for performance,
  but pull a bounded candidate pool and filter token matches against the file
  basename before returning hits.
- Once converted textbook markdown exists, old path-only PDF hits must be a
  fallback, not the primary result. Treat book names (`miller`, `barash`,
  `chestnut`, etc.) as path filters for the converted corpus and search the
  remaining clinical terms inside that book. Otherwise the skipped-PDF guard
  hides newly indexed markdown content and the bot still claims it cannot read
  the textbook.
- Preserve the "no broad single-token FTS" invariant after transforming a
  query. `miller anesthesia` looks like two tokens before book filtering, but
  after `miller` becomes a path filter only `anesthesia` remains; running that
  broad single-token FTS can still trip this DB's fragile FTS path.
- `query-builder.ts` `chooseTokens` only pulls anchor tokens from prior turns
  when the current message has fewer than 2 content tokens. Topic-pivot
  follow-ups like "No, I want you to instead search through their relevant
  markdown files that I converted today" (entry 3 of `decisions-2026-05-09`)
  have 5+ content tokens but still reference the prior subject implicitly
  ("their"). The FTS query becomes `"instead" "relevant" "markdown"
  "converted" "today"` — none of the actual content anchor (miller / arterial
  / indications) survives.
- Not fixed in this loop because the heuristic needs design work and one data
  point is thin. Candidate approaches for a future loop: detect topic-pivot
  signals ("instead", "but actually", "rather", "no, "), and when present
  always merge the top anchor tokens from the prior user turn alongside the
  current message's tokens.

## 2026-05-10 - Writing-style rules baked into the relay system prompt

- Cross-project rule set (`~/ObsidianVault/02-Cross-Project/writing_style_for_william.md`)
  must apply automatically to anything the bot drafts on the user's behalf
  (emails, iMessages, letters, notes). User has flagged AI-sounding drafts
  repeatedly and rejects them.
- A Mother's Day note drafted via the relay on 2026-05-10 violated the rule
  set four times in one short message (em dashes) and read with monotone
  cadence. Trigger for the integration: user said "ensure this is part of
  the Telegram pathway as well" after the rewrite.
- Inlined a concise version of the rules in `buildPrompt`'s system prompt
  with explicit scoping ("when drafting outgoing text on the user's behalf").
  Kept the existing concise/scannable directive so technical/clinical replies
  still use bullets. Full rules referenced by path so Claude can read them
  if needed.
- Rules to scan for in any draft going out under his name:
  zero em dashes, no AI vocab (delve/leverage/navigate/etc.), no form-letter
  phrases, no stiff transitions, no parallel-bullet overload, vary rhythm,
  contractions on.

## 2026-05-10 - Strip bare XML wrapper tags from Claude responses

- Live failure 2026-05-10T21:08:25 and again at 21:58:25: Claude emitted the
  literal string `<response>` as its entire reply to a textbook comparison
  query. The relay sent the bare tag straight to Telegram. The resumed
  Claude session then preserved the pattern and repeated it.
- Symptom on Telegram: a single message containing only `<response>`. User
  could not tell whether the relay or Claude was at fault.
- Root cause appears to be Claude occasionally starting a structured-output
  format and emitting only the opening wrapper before stalling. There is no
  `<response>` template anywhere in the relay's prompt pipeline — the tag
  comes from Claude itself.
- Fix is defense-in-depth, mirroring `stripMemoryTags`:
  - Extract sanitization into `src/response-sanitize.ts` and add
    `stripWrapperTags`. Unwrap matched `<response>...</response>` pairs,
    strip orphan opening/closing tags (and the same for
    answer/reply/message/output/result). Apply in the text handler between
    memory-intent processing and `ensureSendableResponse`.
  - When the strip leaves nothing, the existing empty-response fallback
    fires — but the fallback message is now friendlier
    ("Hmm, I didn't generate a useful reply this time. Could you rephrase
    or ask a more specific question?").
  - Add a system-prompt directive forbidding XML/HTML wrappers and asking
    Claude to emit a clarifying question instead of empty/tag-only output.
- Operational: when poisoned wrapper-tag turns appear in
  `~/.claude-relay/state/chats/<chat_id>.json`, trim the buffer back to the
  last good assistant turn. `RECENT CONVERSATION:` is injected verbatim, so
  poisoned turns reinforce the pattern across calls.

## 2026-05-10 - Pin book-name anchors over longer clinical adjectives

- Live decision log 2026-05-10T21:08:13Z: "Compare the differences in how
  opioids affect an epidural in kids versus adults between cote and barash"
  produced FTS query `"differences" "epidural" "compare" "opioids" "adults"`.
  Both "cote" and "barash" got pushed out of the top-5 by the length-desc
  selection in `buildSearchQuery`, so `retrieval.prepareFtsQuery` never saw
  them and the BOOK_PATH_FILTERS routing was bypassed. Result: 1 incidental
  cote hit, no barash content, response was rated "Unacceptable".
- Book-name tokens are the highest-precision signal we have for textbook
  questions because they switch FTS from broad scope-pattern search to a
  tight per-book path scope. `query-builder.ts` now pins all tokens in
  `BOOK_NAME_ANCHORS` (must stay in sync with `BOOK_PATH_FILTERS` keys in
  retrieval.ts) before applying the length sort to the rest.
- Multi-book comparison queries work for free now: FTS gets multiple
  book-path scopes ORed together and ANDs the clinical content terms inside
  those scopes, so "compare cote and barash on X" returns relevant pages
  from both books rather than 0 hits or one accidental match.
- When extending the corpus to a new book, add the lowercase key to
  `BOOK_PATH_FILTERS` (retrieval.ts), the trigger regex (trigger.ts), and
  `BOOK_NAME_ANCHORS` (query-builder.ts) in the same change.

## 2026-05-10 - Telegram default reply style: concise, scannable, bulleted

- User feedback (saved in memory `feedback_response_style.md`): bullets over
  prose, lead with the answer, this is a Telegram reader. The buildPrompt
  system instruction in `relay.ts` already said "concise and conversational"
  but didn't explicitly request bullets/scannable form, so long-paragraph
  replies still leaked through.
- Updated the instruction to: "Default to concise, scannable replies: lead
  with the answer, prefer short bullets for multi-part responses, and avoid
  long paragraphs unless the user explicitly asks for depth or nuance."
- Kept it as a default rather than a hard rule so clinical nuance can still
  be requested ("explain in detail", "walk me through"). No meta-commentary,
  no change to retrieval/memory semantics.

## 2026-05-10 - Deterministic catalog response for bare textbook-inventory prompts

- Bare inventory prompts (`anesthesia textbook`, `anesthesia textbooks`,
  `please continue to look for my anesthesia textbooks`) collapse to the
  synthetic `_catalog` FTS hit, but the relay still spawned Claude with that
  hit as context — adding 30s-150s of latency to a question whose answer is
  literally a static book list.
- Add `buildCatalogResponse` alongside `buildSkippedTextbookResponse`. When
  the FTS result is exactly one catalog hit, return a bulleted book list
  directly and skip the Claude round trip entirely. Share `CATALOG_BOOK_LIST`
  with retrieval so the list has one source of truth.
- Don't try to short-circuit Claude for anything more ambitious. Specific
  book/topic questions still need synthesis. The short-circuit is keyed off
  the exact synthetic catalog file_path, not heuristics over the message.

## 2026-05-10 - Topic-pivot source-redirection needs prior anchor recovery

- Long follow-up messages whose tokens are entirely source/format control
  vocabulary (`instead`, `relevant`, `markdown`, `converted`, `today`) must
  recover the prior clinical anchor instead of FTS-searching their own
  words. Live evidence: `decisions-2026-05-09.jsonl` entry 3 produced
  `"instead" "relevant" "markdown" "converted" "today"` and 0 hits after the
  user asked "What does miller say are the indications for an arterial line?".
- `chooseTokens` now detects topic-pivot signals (`instead/rather/actually`,
  `not that/the`, `use the markdown`, `relevant markdown files`,
  `^no, (i|let|search|...)`). When a pivot is detected, source-control words
  are also dropped from the current message. If the cleaned current message
  has <2 tokens, recovery from prior user turns runs the same way as for
  bare continuations — but absorbs the *whole* prior clinical anchor
  (up to MAX_MATCH_TOKENS) so a 4-token anchor stays a 4-token query.
- Trigger pivot recovery only on explicit source-redirection signals. Don't
  fire it on any long message — the FTS implicit-AND model would mix prior
  topic into the new one and break legitimate topic shifts.

## 2026-05-10 - Trigger coverage must mirror BOOK_PATH_FILTERS

- The retrieval trigger regex in `src/trigger.ts` only listed `barash|miller` as
  bare book-name tokens even though `BOOK_PATH_FILTERS` in `src/retrieval.ts`
  already supports `cote`, `chestnut`, `fleisher`, and `stoelting`. Live evidence:
  `What does cote say about the indications for intubation?` produced
  `trigger_fired: false, hit_count: 0`. Fix: every book key in
  `BOOK_PATH_FILTERS` must appear in the trigger regex. If a new book is added
  to retrieval, add the name (and a regression test) to the trigger in the same
  change. Backport the failing decision-log phrasing into `trigger.test.ts`.

## 2026-05-10 - Broad textbook queries need front-matter demotion

- Broad title queries such as `anesthesia textbook` can rank contributor/title
  pages above clinically useful pages because the semantic-analysis prose repeats
  "textbook" and "anesthesia" in front matter. Apply a post-FTS demotion for
  converted textbook hits whose snippets identify front matter, contributors,
  title pages, tables of contents, or copyright material. Do not apply this to
  specific content questions, because contributor/front-matter pages may be the
  correct answer when explicitly requested.
- Bare inventory prompts such as `anesthesia textbook` are not clinical search
  questions. Return a fast catalog hit instead of running broad FTS over the
  whole corpus; keep FTS for book-specific or topic-specific questions.

## 2026-05-11 - Codex review hardening pass

- Book metadata must have one source of truth. Keep textbook keys, display
  names, path segments, and trigger aliases in `src/books.ts`; derive trigger
  regexes, query-builder anchors, retrieval path filters, and catalog responses
  from that file. Manual three-way updates caused drift between Cote/Chestnut/
  Fleisher/Stoelting trigger coverage and retrieval support.
- Every Claude response path needs the same sanitizer. Text, voice, image, and
  document replies all pass through memory-tag stripping, wrapper-tag stripping,
  and prose Unicode dash replacement before Telegram sees them. Sanitizer
  activations are now logged in decision JSONL so regressions are visible.
- Default to fresh Claude CLI calls plus bounded `RECENT CONVERSATION:` context.
  `--resume` is opt-in via `CLAUDE_RESUME=1`; resumed sessions can preserve bad
  output patterns such as bare `<response>` tags after a single poisoned turn.
- Non-text handlers must persist turns into the local short-term buffer. Saving
  only to dormant Supabase leaves voice/image/document replies out of later
  `RECENT CONVERSATION:` prompts.
- launchd cannot be trusted to inherit an interactive shell PATH. Default
  `CLAUDE_PATH` to `~/.local/bin/claude`, verify it during preflight, and fail
  loudly if the CLI is not executable.
- Five-minute Claude calls are too expensive for Telegram chat failures. Make
  `CLAUDE_TIMEOUT_MS` configurable and default it to 90 seconds; longer
  workflows should be explicit, not the default chat path.
