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

## 2026-05-11 - Context-before-drafting + ephemeral context cleanup

- User added two linked rules: (1) before drafting any iMessage or email
  reply, the bot must first read the last 5 to 10 messages in that thread
  for context; (2) the fetched context must never be saved to a local file,
  to keep disk usage from accumulating across drafts.
- Encoded as two new lines in `relay.ts:buildPrompt`. Rule 1 names
  `scripts/imessage-thread.sh` as the read helper for iMessage and tells
  the bot to ask the user to paste the thread for email (no generic email
  read helper exists yet). Rule 2 bans writing context to `data/` or
  anywhere else on disk and tells the bot to delete any stale cached
  context files it encounters.
- Operational cleanup: deleted the one-off `data/mom-imessages.json`
  cache from 2026-05-10's manual extraction. The `data/` directory was
  also removed. Re-extracting on demand via the read helper is fast
  (~100 ms) and avoids stale personal-message dumps.
- New memory `feedback_context_before_drafting.md` plus an index pointer
  in `MEMORY.md` so the rule survives session compaction.

## 2026-05-11 - iMessage and email draft helpers; FDA scoped to Claude CLI

- User asked for the relay to be able to read iMessage context and drop
  drafts into the native compose surface for iMessage and email. Hard rule
  (logged earlier today): never auto-send. Compose-only.
- Three helper scripts shipped in `scripts/`:
  - `draft-imessage.sh RECIPIENT` (body on stdin). Pbcopies the body and
    opens `imessage://RECIPIENT`. No FDA, no Automation, no Accessibility
    permission. User pastes and sends manually.
  - `draft-email.sh TO SUBJECT` (body on stdin). Opens a `mailto:` URL
    with subject+body pre-filled. Body also lands on the clipboard as a
    safety net against URL truncation. Works for any default mail client.
  - `imessage-thread.sh RECIPIENT [LIMIT]`. Read-only sqlite3 against
    `~/Library/Messages/chat.db`. Returns JSON. Requires Full Disk Access
    on the Claude CLI binary the relay spawns
    (`~/.local/share/claude/versions/<vN>`). Exits 77 with a pointer to
    `docs/IMESSAGE-SETUP.md` if FDA is not granted.
- System prompt updated so the bot knows the helpers exist and which to
  use for which task. Bot is told to fall back to "draft from description"
  when FDA is missing rather than invent context.
- New doc: `docs/IMESSAGE-SETUP.md` explains the FDA grant procedure and
  enumerates what does NOT work (granting Terminal, granting bun, granting
  the symlink). Source of truth for the user-facing setup steps.
- The Claude-CLI-binary granular FDA scope was chosen because the Bash tool
  that runs `sqlite3` is a child of Claude, and macOS TCC permissions
  follow the process tree from the granted executable.

## 2026-05-11 - Deterministic iMessage context prefetch

- Full Disk Access was not the remaining Peggy failure. FDA was granted to
  `/Users/williamregan/.local/share/claude/versions/2.1.138`, and
  `scripts/imessage-thread.sh Peggy 2` exited 0. The actual helper returned
  an empty result because Messages stores one-on-one chats as phone/email
  identifiers, not contact display names.
- Do not rely on Claude deciding to call `scripts/imessage-thread.sh` from a
  prompt. The relay now detects iMessage-context draft requests itself,
  fetches context before Claude runs, and injects the result into
  `RELEVANT CONTEXT`.
- If the user says a name such as "Peggy", resolve through Contacts first.
  If that fails, fall back to a bounded Messages text search for that name
  and use the matching one-on-one thread identifier. If no match exists, tell
  Claude that FDA worked but the contact/thread did not match, and ask for
  the phone/email instead of claiming a permissions failure.
- Suppress stale assistant turns that say "I cannot read your iMessage
  history" when a fresh iMessage context lookup runs. Otherwise the local
  `RECENT CONVERSATION` buffer can poison the next reply after the underlying
  permission or contact-resolution issue is fixed.
- Keep the runtime FDA prompt aligned with `docs/IMESSAGE-SETUP.md`: for
  Claude Bash helper reads, the relevant FDA entry is the resolved Claude CLI
  binary under `~/.local/share/claude/versions/<latest>`, not the Terminal app
  and not a stale "bun binary is missing FDA" message.

## 2026-05-11 - Broaden draft detection; decouple context fetch from placement

- Live regression 2026-05-11 ~17:53Z right after the autopaste worked for
  Peggy: "Draft a message to William (me) saying hey wuddup" produced text
  in Telegram with no compose-box placement. User: "It should AUTOMATICALLY
  draft it in the imessage draft box like you did for peggy."
- Root cause: `isIMessageDraftRequest` required all three of (a) the literal
  token `imessage|text messages?|texts?|sms`, (b) a draft verb, and (c) a
  context keyword like `last/recent/context`. The user wrote `message` (not
  `imessage`) and gave the body verbatim (no context request). One AND two
  failed, so `extractIMessageContextRequest` returned null, `wantsIMessage
  Placement` was false, and no marker/post-action ran.
- The function name was also misleading: it conflated three independent
  intents. Replaced with `extractIMessageDraftRequest` returning explicit
  `wantsContext` and `wantsPlacement` flags. Trigger keywords broadened to
  include `message|messages|chat message` in the type set and
  `text|message|shoot|send` in the verb set. Contact extraction is now the
  required gate, not the context keyword.
- Placement now defaults to TRUE for any detected draft request. Explicit
  suppression signals (`just give me the text`, `in Telegram only`,
  `don't open Messages`) opt out. The user no longer has to repeat
  "directly in the iMessage box" each time.
- The prefetch helper still runs whenever the intent is extracted, so the
  relay always has a `resolvedRecipient` ready for placement. But the
  `IMESSAGE CONTEXT FOR ...` block is only rendered when `wantsContext` is
  true, which keeps short verbatim drafts ("hey wuddup") from inflating the
  prompt with 10 messages of unused thread history.
- Known follow-up: self-recipient ("to me", "to William (me)") relies on
  the AddressBook having an entry for the user. If it doesn't, the helper
  falls back to a Messages text search which won't find a self-thread.
  Cleanest fix later: add a `USER_IMESSAGE_HANDLE` env and special-case
  `\((me|myself)\)` in the contact extractor.

## 2026-05-11 - Compose-box autopaste vs clipboard fallback

- Follow-up live failure 2026-05-11T20:29Z: the helper reported
  `imessage_draft_mode: "pasted"`, but the user did not see the draft where
  expected. Root cause: `osascript` success only proves macOS accepted a
  Cmd+V keystroke; it does not prove the compose field received the paste.
  Blind UI keystrokes are not a reliable correctness signal.
- Better fix: use Messages' native URL body prefill:
  `sms:<recipient>&body=<url-encoded-body>`. A manual local test opened the
  self thread with `codex-test-do-not-send` visibly in the Mac compose box
  without sending. This avoids Accessibility, System Events, and focus races.
- Helper now emits a JSON envelope on stdout instead of free text:
  `{"ok":true,"mode":"pasted","recipient":"..."}` when paste succeeded, or
  `{"ok":true,"mode":"clipboard_only","recipient":"...","reason":"..."}`
  when native URL body prefill failed and the helper fell back to clipboard
  plus opening the thread. Body is never printed. The relay parses the
  envelope and tells the user the actual placement state — never claims "in
  the compose box" when only the clipboard succeeded.
- Telemetry: `imessage_draft_mode: "pasted" | "clipboard_only"` added to
  `DecisionRecord` so the JSONL distinguishes the two success modes without
  scraping the reply text. `imessage_draft_status` remains the coarse
  success/failure field.
- The Messages helper's message-text contact fallback is unsafe for short
  relationship aliases. Live evidence: `mom` resolved to William's own
  one-on-one thread because the word appeared in recent message text, so the
  relay claimed it placed a draft for mom while addressing the wrong thread.
  Guard that fallback for short and relationship-style inputs (`mom`, `dad`,
  `me`, `wife`, etc.). If AddressBook cannot resolve those aliases, fail
  closed and ask for a phone/email instead of guessing.

## 2026-05-11 - Deterministic iMessage draft placement (mirror of prefetch)

- Live failure 2026-05-11T15:20:59Z: prefetch worked (10 Peggy messages
  injected, draft body looked good in Telegram), but the user reported
  "Draft is good but it is not in the iMessage chatbox". Bot reply said
  "The script call was blocked for approval. Approve the Bash command and
  I'll get it onto your clipboard". There is no approval surface on a
  Telegram-only path; Claude in headless `claude -p` mode has no Bash
  permission UI to invoke.
- Root cause was architectural asymmetry: the relay prefetched read context
  but expected Claude to call `scripts/draft-imessage.sh` for the write side.
  In `-p` mode that's a dead end; Claude either has no Bash tool or it's
  gated behind interactive approval that doesn't exist for Telegram.
- Fix mirrors the prefetch. The relay now detects iMessage placement intent
  (`directly in the iMessage box`, `iMessage chatbox`, `put it in Messages`,
  etc.), asks Claude to emit the draft body between
  `<<<IMESSAGE_DRAFT>>>` / `<<<END_IMESSAGE_DRAFT>>>` markers, then runs
  `scripts/draft-imessage.sh` itself after Claude returns and replaces the
  marker block with a confirmation line.
- The helper's stdout shape is now `{"resolved":"<phone-or-email>",
  "messages":[...]}` so the relay can reuse the resolved chat identifier
  for placement without re-running contact resolution.
- Hard rule preserved: the helper never sends. It pbcopies the body and
  `open imessage://<recipient>`; the user still pastes and sends manually.
- Telemetry: new `imessage_draft_status` field in `DecisionRecord` —
  `placed | markers_missing | empty_body | no_recipient | helper_failed`.
- Stop telling Claude that `scripts/imessage-thread.sh` and
  `scripts/draft-imessage.sh` exist. In headless mode any helper line in
  the prompt is dead weight that produces hallucinated "blocked for
  approval" output. Keep the email helper line for now; the user has not
  asked for symmetric email placement yet.
- Live failure 2026-05-11T16:00:57Z after the post-action shipped:
  `imessage_draft_status: "helper_failed"` with
  `imessage_draft_timeout_6000ms`. The relay had correctly found Peggy,
  read 10 messages, detected placement intent, and got a draft body, but
  killed the placement helper too aggressively during Messages.app startup.
  Treat UI-opening helpers as cold-launch operations; use a human-scale
  timeout and clear the timer after process exit so it cannot fire late.

## 2026-05-11 - Strip Claude Code internal scaffolding tags from relay output

- Live failure 2026-05-11T12:54:45Z: in response to "Okay, please draft an
  email to myself ..." the relay forwarded roughly 5.4 KB of Claude Code
  internal scaffolding to Telegram. Three `<system-reminder>` blocks leaked:
  a `/compact` continuation marker, a bash-escaping rule about `$(...)`
  substitutions, and a full conversation summary including file paths,
  technical context, and every prior user message in the thread.
- Decision-log evidence: `response_chars: 5381`, all four sanitizer counts
  zero (wrapper/memory/prose-dash detectors did not match these tags).
- Root cause: `stripWrapperTags` only handled
  `<response|answer|reply|message|output|result>`. The scaffolding tags
  Claude sometimes emits when confused about session continuity
  (`<system-reminder>`, `<command-name>`, `<local-command-stdout>` and
  similar) were not in the strip list.
- Fix: new `stripScaffoldingTags` in `response-sanitize.ts` matches both
  paired `<tag>...</tag>` blocks and orphan tags for the family
  `system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|tool-use|tool-result|function_calls|function_results`.
  Wired into `sanitizeClaudeResponse` with its own counter and decision-log
  field `scaffolding_tags_stripped`. The post-Claude pipeline logs
  `[scaffolding-leak] removed N internal scaffolding tag(s)` as a stderr
  warning and resets the Claude session if resume is enabled.
- Operational cleanup: truncated the chat turns buffer to drop the 5381-char
  poisoned assistant message so it could not feed back into
  `RECENT CONVERSATION:` on the next turn.

## 2026-05-11 - Runtime context + actionable timeout fallback

- Telegram screenshot 2026-05-11 showed the bot repeatedly telling the user
  to grant macOS Full Disk Access to "the terminal app you launched Claude
  Code from". The relay does not run from a terminal at all. It is spawned
  by launchd as `com.claude.telegram-relay`, and the binaries that would
  need TCC permissions are `/usr/local/bin/bun` and the Claude CLI at
  `~/.local/bin/claude`. The user followed the wrong advice, restarted,
  and was still blocked.
- Fix: added a Runtime context line to the system prompt in
  `relay.ts:buildPrompt` stating exactly that. The bot now refuses to
  recommend granting FDA to a terminal app.
- Same screenshot showed the existing 90s timeout fallback "Try a narrower
  request" failed the user (memory `feedback_timeout_message_unhelpful.md`).
  Replaced the static string with `buildTimeoutFallback(userMessage)` which
  inspects the message for broad/multi-part/textbook patterns and returns
  one to three concrete reframes:
  - textbook signals: "Name the book and a single topic, e.g. ..."
  - multi-part signals: "Split the question into two shorter messages"
  - broad signals: "Pick one specific subtopic instead of the whole area"
  - fallback when none match: a single line covering all three tactics
- Both changes are scoped to the text handler. Voice, image, and document
  paths surface the same Claude timeout via their generic catch and could
  use the same helper if it matters.

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

## 2026-05-11 — iMessage draft placement, contact resolution, and policy footers

- The relay is the sole source of truth for placement status. `replaceDraftBlock`
  only swaps text BETWEEN the marker pair, so any trailing line Claude emits
  after the close marker leaks through to Telegram and contradicts the relay's
  real status (e.g. Claude says "Draft is in the Messages compose box for X"
  while the relay says "no thread found for X"). Use `rebuildAroundDraftBlock`
  in every placement code path — it keeps Claude's lead, scrubs placement-claim
  phrasing from it, and discards everything after the close marker.
- macOS keeps the user's "Me" record in
  `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` but their
  real contacts live in iCloud/Exchange source DBs under `Sources/<UUID>/`. On
  William's Mac the top-level DB has 4 records; the three source DBs have
  ~17,000 combined. Any contact resolver that queries only the top-level DB
  will find nothing real. Always glob `Sources/*/AddressBook-v22.abcddb`.
- Exact-substring contact matching breaks on the most common case: a typo.
  "gailene" doesn't contain "gaileen". Use `difflib.SequenceMatcher` with a
  0.75 ratio cutoff against name tokens (first, last, nick). It catches
  gailene→Gaileen (0.857) and galene→Gaileen (0.83) without false-positiving
  against unrelated short names. Keep the relationship-alias block list
  (mom/dad/etc.) in lockstep across the Python resolver and the bash fallback.
- Draft-intent regexes must include "respond" and "reply", not just
  "draft/write/compose/send/shoot/text/message". "Respond to Conor saying hope
  all is well" is the most natural way to ask for a reply; missing it forces
  Claude through the generic chat path where it appends policy boilerplate
  instead of placing a draft. Guard against hijacking email intent by skipping
  when EMAIL_TYPE_RE matches.
- Never tell Claude to end drafts with "Draft above, review and send manually"
  or any policy footer. The user reads it as nagging. Hard rule in the system
  prompt PLUS a line-anchored strip regex (`stripPlacementClaims`) applied to
  every Claude response BEFORE placement logic. Apply order matters: the strip
  must run before the relay appends its own status line. As of Gate 2B, relay
  status lines avoid "review/send" wording too.
- For UI features that depend on background macOS apps (Messages.app), the
  fast verification loop is: run the helper from the shell with redacted args
  (`./scripts/imessage-thread.sh "gailene" 3 | python3 -c "print counts"`),
  then ship and let the user verify the actual compose box. Don't open
  Messages.app from automated tests — it disrupts the user's UI.
- Boilerplate-stripping regexes need a safety guard: if applying every pattern
  would empty the response entirely, return the original. 2026-05-11 a
  too-broad "you... to send" pattern matched ordinary helpful text and the
  user got "I'm sorry, I generated an empty response" instead of a useful
  reply. Worst case after the guard is one boilerplate line — better than no
  reply. Also: every alternation in a line-anchored regex should require a
  SPECIFIC tell (manually/yourself/from messages/the draft) so an alternative
  branch can never match a generic body line.

## 2026-05-12 — Vault-first memory layer (Obsidian integration)

- Symlink direction matters for Syncthing. Memory files must live in the vault
  as real Markdown; the native Claude Code memory directory must be the
  symlink. The opposite direction (vault as symlink to native) means Syncthing
  may replicate the symlink itself instead of the targets, breaking
  cross-machine memory access.
- One idempotent Python reconciler + multiple triggers (SessionStart hook,
  5-minute launchd, manual) beats six independent automations. One log, one
  lock, one schema migration. Plugins (Templater, QuickAdd, Linter, Dataview)
  are for human UX speed only; Python/launchd own correctness so memory
  integrity works when Obsidian is closed.
- "Never overwrite existing frontmatter" must include the YAML-parse-failure
  case. If frontmatter is unparseable, SKIP the file entirely — don't fall
  through to "fill all defaults" which would clobber the broken-but-recoverable
  original. Logged WARN with file path is enough; user can fix manually.
- Obsidian-side linters may nest top-level frontmatter keys under `metadata:`.
  The reconciler must detect this and MIGRATE the misplaced keys back to
  top-level (per canonical schema) before applying the "fill missing"
  defaults — otherwise you get duplicated keys with empty defaults at top
  level while the real values stay nested.
- launchd has a restricted PATH and HOME may be empty. Python scripts run
  from launchd must use the absolute shebang path (`#!/usr/local/bin/python3`
  rather than `#!/usr/bin/env python3`) when they depend on third-party
  packages installed in a specific Python interpreter — `/usr/bin/python3`
  is Apple's stub and won't have PyYAML or anything else.
- The full reconciler implementation, including the canonical schema, tag
  taxonomy, and operations breakdown, is captured cross-project at
  `~/ObsidianVault/02-Cross-Project/vault-first-memory-architecture.md`.
- `sendResponse` and the persistence calls (`saveMessage`, `appendTurn`) must
  use the SAME final text. 2026-05-11 the Conor turn persisted an empty string
  to the short-term turn buffer while `sendResponse` substituted the "empty
  response" apology — Telegram and the state file disagreed about what the
  user actually saw. Compute the sendable text once with `ensureSendableResponse`
  before all three calls.
- Relationship-alias resolvers must allow EXACT name matches even for blocked
  fuzzy aliases. 2026-05-11 the new Python resolver blocked "mom" entirely
  → the user couldn't address his actual mother (who is in iCloud as a contact
  named "Mom"). Fix: only block fuzzy/substring matches for relationship
  words; allow exact equality with a contact's first name/nickname/full name.
  Additionally, hard-skip the user's own "Me" record across exact/substring/
  fuzzy paths so a stray "mom" → self never happens again. Self-record
  detection is heuristic — also dedupe by chosen identifier so an alternate
  match path can't bypass the "Me" filter.
- Deterministic project-anchor retrieval covers the "semantic search" gap
  cheaply. 2026-05-11 a long speech-rewrite turn referenced Mark Saint Amman,
  Rob Roy, MIET, lawyers — names that all exist in the Obsidian Medicolegal-
  Case binder, but the generic FTS query builder didn't anchor on them
  because they were buried in a long pasted block. A per-project JSON config
  (anchors + path prefixes) plus a scoped FTS query injects the right notes
  whenever the user message hits any anchor. Word-boundary, case-insensitive
  regex matching keeps false positives down. Skip embeddings until anchors
  are demonstrably insufficient.

## 2026-05-12 — Obsidian automation audit fixes

- A frontmatter reconciler must distinguish "no frontmatter" from "bad
  frontmatter." No frontmatter is safe to initialize; malformed frontmatter
  must be skipped with a warning so the existing note is not clobbered.
- SessionStart hooks must derive project identity from the git toplevel, not
  the raw current directory. Claude Code can start inside `src/` or another
  subfolder; using raw `cwd` makes the sanitized path miss `project-map.yaml`
  and silently skips the memory symlink check.
- Scalar YAML fields must be wrapped as one-item lists, never passed through
  `list(value)`. `tags: cross-project-candidate` should become
  `[cross-project-candidate]`, not a list of characters.
- launchd should call the exact working Python interpreter in
  `ProgramArguments` when a script imports third-party packages. The terminal
  hook and launchd do not share the same PATH, so `env python3` can pass
  manually and fail every five minutes under launchd.

## 2026-05-12 — Background memory capture from Telegram turns (v1)

- Wired a deterministic, dependency-free memory-capture module
  (`src/memory-capture.ts`) into the text handler. Synchronous classification
  runs after `sendResponse` + `appendTurn`; the file write is fire-and-forget
  so a slow disk or vault hiccup cannot affect Telegram reply latency. Capture
  failures log and are swallowed so they never propagate into the per-chat
  queue.
- Two destination lanes per the handoff: `01-Projects/<project>/memory/` for
  high-confidence project-anchored captures, `00-Inbox/_pending-memories/` for
  ambiguous ones. The reconciler skips pending entirely (intentional) and
  decays it at 14 days; project-memory writes show up in the next MOC rebuild
  with no normalization needed (frontmatter ships canonical).
- Classifier is regex-only, no LLM, no embeddings. Three trigger families:
  feedback-trigger (`from now on`, `going forward`, `don't ... again`,
  `that was wrong`, `lesson learned`), fact-trigger (`remember that/this`,
  `please remember`, `remember <person> is`, `make a note`, `save this`),
  retrieval-feedback (`keep searching`, `that's not it`, `i meant`,
  `wrong <thing>`, `try X instead`). Hard suppressors: `don't remember/save`,
  `remember to ...` (TODO not memory), and any draft-shaped user message.
- Project inference is layered: `anchoredProjects[0]` if the project-anchor
  retrieval fired; else `claude-telegram-relay` when the user references the
  bot/relay/Telegram-replies/draft-above; else relay as the default for
  behavioral feedback; else `null` → pending lane. Retrieval feedback with no
  anchor is skipped — "keep searching" with no project context is too noisy.
- Atomic writes must use a no-overwrite final step, not plain POSIX
  `rename`. `rename` can replace the target if two captures race on the same
  slug. Write/fsync a temp file in the destination directory, hard-link it to
  the target so `EEXIST` preserves the existing note, then remove the temp
  file. Dedupe by `(kind, slug)` regardless of filename timestamp prefix on
  the pending side; if an existing file has identical body content the call
  returns `duplicate_skipped`, otherwise `exists_no_overwrite` (never
  clobber). The body hash strips frontmatter so date drift doesn't defeat
  dedupe.
- Never let memory capture create a new `01-Projects/<project>/` folder from
  classifier/config output. Validate the project path segment and require the
  project memory directory to exist; route missing projects to pending review
  instead. This keeps typoed anchors and future config mistakes from becoming
  durable vault structure.
- Ambiguous personal facts should not fall into `claude-telegram-relay` just
  because the relay captured them. Prefer an existing personal catch-all
  project (`williamregan-home`, then `williamregan-Projects`) and reserve the
  relay project for bot behavior, retrieval, iMessage, and implementation
  feedback. Otherwise "Peggy is the cleaner" pollutes the relay's own memory
  instead of William's personal memory.
- Do not leave synthetic verification memories in the real vault. If a test
  writes through the production module to prove the reconciler path, remove
  the artifact and rebuild the MOC before handing off; otherwise "Captured
  from Telegram" becomes false provenance.
- YAML emission is hand-written (no `js-yaml` dep). Aliases/tags are flow
  lists with quoted scalars (`tags: ["a", "b"]`) so single-string inputs
  cannot collapse to `tags: a` and accidentally serialize as a character
  list. The reconciler's `_represent_list` would do the same, but a v1 round
  trip must not depend on the reconciler.
- Decision-log JSONL gained six optional fields:
  `memory_capture_attempted`, `memory_capture_reason`,
  `memory_capture_confidence`, `memory_capture_kind`,
  `memory_capture_destination`, `memory_capture_project`. The classifier
  result is captured synchronously so these fields are accurate even when the
  background write is still in flight. The write result lands on stderr/stdout
  (`[memory-capture] <reason> kind=... dest=... path=...`).
- Tests isolate via `MEMORY_CAPTURE_VAULT=<tmpdir>` set before the module is
  imported. The module reads the env lazily so tests can override it without
  racing import order. End-to-end round trip writes into the tmp vault and is
  cleaned up in `afterAll`. 18 new tests covering all 8 cases from the
  handoff plus orchestrator round-trip; full `bun test` is green at 112/112.
- v1 scope: text handler only. Voice/image/document turns are typically
  drafting or analysis — they could be wired the same way later if a real use
  case appears, but speculative coverage is out of scope. Suppression and
  draft-detection are conservative enough that wiring those handlers would be
  mechanical: same classify call, fire-and-forget write.

## 2026-05-12 — Drop the pending-inbox lane from the classifier (best-guess routing)

- User feedback after v1 shipped: they will not review an inbox folder, so the
  classifier must always pick a project. Pending-lane routing inside
  `classifyMemoryCandidate` was eliminated; the writer keeps the
  `project_missing_routed_pending` guard as a safety net for typoed/missing
  project directories (defense in depth, not the normal path).
- New project-inference order: `anchoredProjects[0]` → relay self-reference →
  feedback-trigger default to relay → token scan over existing
  `01-Projects/*` folder names (≥ 6-char tokens, longest match wins) →
  env-configurable fallback (`MEMORY_CAPTURE_FALLBACK_PROJECT`, default
  `claude-telegram-relay`). `MemoryCaptureInput` gained an optional
  `availableProjects` field so tests can control routing without touching the
  vault; production reads `01-Projects/*` lazily and caches by vault root.
- "Token scan" is conservative: project name split on `[-_\s.]+`, only tokens
  ≥ 6 chars are eligible, longest-token match wins. "Medicolegal" matches
  `Medicolegal-Case`; "telegram" matches `claude-telegram-relay`; short
  acronyms like "MIET" or "WDMD" fall through to the anchor config or
  fallback. Generic 4-5 char words (case, app, stack) never trigger routing.
- Retrieval-feedback with no project anchor remains a hard skip. The user
  said no inbox, not "capture more aggressively" — a bare "keep searching"
  with no context cannot be honestly routed and would just clutter the
  fallback project. Drop it on the floor.
- Confidence semantics shifted: fallback-routed notes are `medium`,
  everything with a real signal (anchor/self-ref/feedback-default/token-scan)
  is `high`, retrieval-feedback stays `medium`. Token-scanned routing earns
  `high` because a distinctive ≥ 6-char project name appearing as a whole
  word in the user text is a strong signal, even though the writer never
  consulted the anchor config.
- Tag taxonomy: fallback-routed notes get `status/needs-routing` so they're
  easy to grep/filter inside the catch-all project. The reconciler doesn't
  rewrite this tag, so it stays as a manual review affordance without
  reviving the inbox lane.
- Test additions: token scan via explicit `availableProjects`, env override
  of fallback project, and the orchestrator test that previously asserted
  pending-lane behavior now asserts the file lands in the relay project
  memory dir. Suite at 116/116.

## 2026-05-12 — Contact-regex /i flag let lowercase filler match as a proper noun

- Live failure 2026-05-12T17:52:35Z: "Nono it needs to be in my iMessages
  compose box on my phone!" was routed through the iMessage draft pipeline
  with `imessage_context_contact="be in my"`. The relay prefetched context
  for a non-existent contact and then asked Claude for a marker block;
  Claude (correctly) refused, leading to `imessage_draft_status:
  "markers_missing"` and an 851-char paragraph reply that violated the
  "concise, scannable" rule.
- Root cause: the contact regex in `extractIMessageDraftRequest` used a
  trailing `/i` flag. The proper-noun branch `[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}`
  was meant to require real capitalization, but `/i` makes character classes
  case-insensitive, so `[A-Z]` also matched lowercase. The phrase "to be in
  my" satisfied the three-word proper-noun shape with all-lowercase letters.
- Fix: drop the global `/i`. Prefix keyword stays case-insensitive via
  `[Ww]ith` / `[Tt]o`. Email branch keeps case-insensitivity via explicit
  `[A-Za-z]` ranges. Proper-noun branch is now genuinely case-sensitive,
  matching the way human-written contact names actually look.
- Regression coverage: the exact live phrasing plus four similar
  lowercase-filler probes (`to my phone`, `to me`, `to her phone`, etc.)
  all assert `extractIMessageDraftRequest` returns `null`. Suite at 119/119.
- Related but not in this fix: the user's underlying complaint ("I want
  drafts in my iMessages compose box on my phone") is the open Option B
  work in `project_imessage_phone_access_path.md` — file-based drafts at
  `~/Library/Messages/Drafts/<chat_identifier>/composition.plist`. Option A
  (Messages-in-iCloud + lock-screen) was chosen on 2026-05-11 but evidently
  hasn't delivered the phone-side experience yet. That's a separate
  workstream from this regex bugfix.

## 2026-05-13 — Past-draft references must not trigger new-draft detection

- Live failure 2026-05-13T00:14:47Z (decisions-2026-05-13.jsonl): user
  asked "In your draft to Peggy did not not ready through her previous
  text messages for context?" — a meta-question about a prior draft.
  Relay parsed it as a new draft request because all three components
  fired: `draft` (DRAFT_VERB_RE), `messages` (MESSAGE_TYPE_RE), `to Peggy`
  (contact regex with capitalized name). Relay prefetched 10 Peggy
  messages (resource waste, prompt bloat) and appended the
  `markers_missing` footer to Claude's correct meta-answer.
- Root cause: `hasDraftVerbAndType` had no notion of past-tense /
  meta-reference to a prior draft. The phrase "your draft to X" is
  syntactically indistinguishable from "draft a message to X" if you
  only check for the presence of (verb, type, contact).
- Fix: new `PAST_DRAFT_REFERENCE_RE` gate runs BEFORE the implicit-verb
  and verb+type checks in `hasDraftVerbAndType`. Pattern requires a
  possessive determiner (your/the/that/this/my/our/his/her/their/
  last/previous/previously/earlier/prior) + a draft-noun (draft/message/
  reply/response/text/imessage/sms/email/note) + a recipient indicator
  (to/for/with/about). The recipient-indicator tail is non-negotiable —
  without it, "directly in the iMessage box" matches and breaks
  legitimate imperative draft requests (live regression caught in
  iteration: the existing "Go through my last 5-10 text messages with
  Peggy ... directly in the iMessage box" test failed because my first
  draft of the regex matched "in the iMessage" without a tail).
- Two-step regex (PAST + POSSESSIVE) collapses to one because the
  POSSESSIVE shape strictly contains the PAST shape minus an optional
  preposition prefix; the prefix is irrelevant once the (det)(noun)(tail)
  triple is present.
- Tests: live failure phrasing + four nearby variants ("Your reply to
  Conor seemed off", "Did you read context before your draft to Sarah?",
  "Regarding the text to Mom earlier", "On your previous draft to
  William") all return null; three imperative shapes ("Draft an iMessage
  to Peggy saying thanks", "Respond to Conor saying hope all is well",
  "Please send a message to William saying hey") still trigger. Full
  suite 122/122.
- Operational note: when a regex layered fix conflicts with an existing
  legitimate test, that test is the cheaper truth signal. Iteration
  in this loop went: first regex → test #1 fails → tighten with tail →
  all 17 pass. Don't change the existing test; tighten the new regex.

## 2026-05-12 — Gate-1 iMessage draft writer safety

- While preparing the temporary `composition.plist` writer for the
  phone-visibility Gate 1 test, the inlined handoff script had a safety gap:
  if an existing draft file was present but unparseable, `existing_body_chars`
  returned `None`, which the writer treated the same as "no file exists".
  That could overwrite a real user draft without a backup.
- Fix in `/tmp/icloud-draft-write-test.py`: an existing-but-unparseable
  draft now returns `existing_draft_unparseable` unless `--force` is used.
  With `--force`, the current file is moved to
  `composition.plist.bak-<unix-ts>` before writing. This matches the hard
  rule: never clobber user draft state silently.
- Verification: the temporary writer syntax-checks with
  `/usr/local/bin/python3 -m py_compile`; a missing target returns
  `target_dir_missing`; both `+17809346164` and today's active
  `+15196816391` draft refuse without `--force` and report only body
  character counts, not plaintext.

## 2026-05-13 — Gate 2B iPhone draft handoff

- Gate 1 result was negative: direct `~/Library/Messages/Drafts/<chat_id>/composition.plist`
  writes can be picked up by Mac Messages.app, but file-based draft state did
  not propagate to the iPhone compose box. Do not keep iterating on
  `composition.plist` as the phone-delivery path.
- 2026-05-14 correction: the Shortcuts iCloud container was a Mac-local
  verification trap on this machine. The file existed locally but did not
  reach the iPhone. The active iCloud Drive container is
  `~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json`;
  the relay default and the iOS Shortcut's Get File action must both target
  that iCloud Drive path.
- Gate 2B now uses an iCloud JSON file as the handoff surface:
  `~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json`.
  The file contains the current plaintext draft because the iPhone Shortcut
  needs to read it, but decision logs store only the path, Shortcut URL, and
  SHA-256 hash.
- The relay now prefers the Shortcuts iCloud handoff when an iMessage recipient is
  resolved, and falls back to the existing Mac compose helper only if the
  handoff write fails or no recipient is resolved. The Mac helper remains
  important as a local fallback; do not remove it.
- The handoff writer must convert every filesystem failure after root
  detection (mkdir/open/write/fsync/chmod/rename) into `{ ok: false }`, not
  throw. The relay depends on that contract to fall back to the Mac compose
  helper instead of failing the whole Telegram reply.
- The storage selector in Shortcuts is load-bearing. If the Shortcut editor
  reads "Get File from Shortcuts at path claude-relay-drafts/latest.json", it
  maps to `iCloud~is~workflow~my~workflows/Documents` on macOS. That path
  worked for a Mac-side `shortcuts run` smoke test but did not sync to the
  iPhone on 2026-05-14. For the phone handoff, pick the real iCloud Drive
  file under `com~apple~CloudDocs` in the Shortcut editor and keep
  `RELAY_ICLOUD_DRAFT_DIR` aligned with it.
- User-facing placement copy must avoid the banned "review and send" /
  "send manually" footer family. The phone handoff status is:
  `Phone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft`.

## 2026-05-13 - ClaudeDraft Shortcut: manual recipe beats automation

- The macOS `shortcuts` CLI has no `create` subcommand — only `run`, `list`,
  `view`, `sign`. There is no first-class programmatic path to build a new
  Shortcut from a script. `shortcuts sign --mode anyone --input <plist>`
  exists, so a hand-rolled `.shortcut` plist with WFActions array can be
  imported, but the plist schema for each action (e.g. WFSendMessageShowComposeSheet
  on `is.workflow.actions.sendmessage`) is not officially documented and the
  failure mode if you get one field wrong on Send Message is "ships a real
  send." Do not use this route for any action set that includes Send Message
  unless you have a known-good fixture to diff against.
- Shortcuts.app's editor is hostile to System Events. Top-level windows are
  visible (`name of every window` returns "All Shortcuts" / "New Shortcut" /
  individual editors), but the action-picker is search-driven and individual
  action toggles like "Show When Run" sit inside disclosure groups that are
  not reliably AX-addressable. The prior session's osascript route stalled
  here even before bypass mode was on — bypass mode does not make the
  accessibility tree richer.
- For any Shortcut whose correctness depends on a single toggle that
  silently flips destructive ("Show When Run" OFF = auto-send), the right
  call is the 4-step manual recipe handed to the user, not automation. The
  user builds it in ~2 min; the build-time tap-test on Mac catches the
  toggle without burning a real iMessage.
- Verification fixture detail: the `latest.json` present at handoff time
  was the relay's self-test fixture (`recipient_label: "ClaudeDraft self-test"`,
  `recipient: wregan599@gmail.com`, `body_sha256: "test"` — the literal
  string, not a real hash). This is fine for Shortcut build verification —
  Action 1 just reads whatever is at the path — and the recipient being
  the user's own email means an accidental Send would arrive at his own
  inbox. Real relay-written files have a proper SHA-256 in `body_sha256`.
- Leftover state to clean up at end of build: the prior session created an
  empty Shortcut literally named "New Shortcut" in the user's Shortcuts
  library. It is harmless but should be deleted after `ClaudeDraft` is
  saved, to keep the library tidy.

## 2026-05-13 - ClaudeDraft Shortcut: plist+sign route is viable, supersedes earlier "manual only" claim

- Today's session built and shipped ClaudeDraft end-to-end via the
  `shortcuts sign --mode anyone` route. Earlier-today entry above was
  pessimistic about Send Message — concrete schema below makes it tractable.
- `shortcuts sign --mode anyone --input <file>.shortcut --output <file>.shortcut`
  works when the input has the `.shortcut` extension (a plain `.plist`
  extension is rejected with "not in the correct format"). The Obj-C
  runtime warnings about `T@"NSString",?,R,C` are harmless noise — the
  signed output still gets written. Use binary plist for the input.
- Shortcut name on import is the **filename minus extension** — there is
  no `WFWorkflowName` key in the plist. To name a shortcut `ClaudeDraft`,
  the file must be `ClaudeDraft.shortcut`.
- Existing user shortcuts on disk (in `Shortcuts.sqlite`'s `ZSHORTCUTACTIONS`
  table) are the most reliable schema reference. `Pipewrench` in this
  user's library happened to be a near-identical pattern (downloadurl →
  detect.dictionary → getvalueforkey × 3 → sendmessage) and gave the exact
  Send Message parameter shape:
  - `is.workflow.actions.sendmessage` parameters:
    - `IntentAppIdentifier: "com.apple.MobileSMS"`
    - `IntentAppDefinition: {BundleIdentifier, Name, TeamIdentifier}`
    - `WFSendMessageActionRecipients` (NOT `WFSendMessageRecipients`)
    - `WFSendMessageContent`
    - `ShowWhenRun: True` ← the make-or-break toggle (NOT
      `WFSendMessageShowComposeSheet` as community references sometimes
      claim). When `True`, the OS shows the compose sheet instead of
      auto-sending.
- Magic-variable chaining for `is.workflow.actions.getvalueforkey`
  feeding `sendmessage`: assign every action a UUID, reference upstream
  outputs as
  `{Value: {OutputUUID, Type: "ActionOutput", OutputName: "<output-name>", Aggrandizements: [{Type: "WFCoercionVariableAggrandizement", CoercionItemClass: "WFStringContentItem"}]}, WFSerializationType: "WFTextTokenAttachment"}`.
  `OutputName` strings are stable: `"File"` for documentpicker, `"Dictionary"`
  for detect.dictionary, `"Dictionary Value"` for getvalueforkey, `"Text"` for
  gettext. Aggrandizement coercion ensures the downstream consumer gets
  the right type (e.g. recipient as `WFStringContentItem`).
- Get File action storage selector — important and non-obvious:
  - With `WFShowFilePicker=False` and no `WFFile` bookmark, just
    `WFGetFilePath="claude-relay-drafts/latest.json"` resolves to the
    **Shortcuts iCloud container**
    (`~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/`),
    not the iCloud Drive root. The action displays in the editor as
    `Get file from Shortcuts at path X`. The word "Shortcuts" there is the
    Files-app provider, not the app name.
  - To target iCloud Drive root explicitly you must supply a `WFFile`
    bookmark dict that survives import:
    ```
    WFFile: {
      fileLocation: {
        crossDeviceItemID: "docs.icloud.com:com.apple.CloudDocs/<UUID>/<itemID>",
        fileProviderDomainID: "com.apple.CloudDocs.iCloudDriveFileProvider/<UUID>",
        relativeSubpath: "com~apple~CloudDocs/claude-relay-drafts/latest.json",
        WFFileLocationType: "iCloud",
      },
      filename: "latest.json", displayName: "latest.json",
    }
    ```
    These UUIDs are device/account-specific; capture them once from a UI
    edit and embed them. **And** `WFGetFilePath` must be empty/absent when
    `WFFile` already names a specific file, or runtime errors with "the
    provided file path must be contained within the directory."
  - 2026-05-14 correction: the Shortcuts-container simplification was wrong
    for the real iPhone handoff on this Mac. It proved only that
    `shortcuts run ClaudeDraft` on the Mac could read the file. The file did
    not reach the iPhone. The relay now writes to the active iCloud Drive
    container:
    `~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json`.
    The Shortcut must therefore be edited to read that iCloud Drive file, not
    the default "Shortcuts" provider path.
- Send Message action triggers a one-time **OS privacy prompt** the first
  time it runs: "Allow 'ClaudeDraft' to send 1 dictionary in a message?"
  with Don't Allow / Allow Once / Always Allow. The word "dictionary"
  refers to the OS tracking the upstream data type, not the actual message
  payload — the recipient and body are extracted correctly downstream of
  the Get Value actions. Pick **Allow Once** for one-shot tests so you
  don't grant permanent dictionary-send permission to the shortcut.
- UI-automation tactics that worked on macOS 15 today, for future Shortcut
  edits when bookmark capture is needed:
  - Mouse click via Quartz `CGEventCreateMouseEvent` is reliable. The
    Shortcuts editor's action elements (e.g. the storage-location pill
    on a Get File action) are clickable at the visible text rectangle.
  - To set a folder/file bookmark in the editor's `NSOpenPanel`: open the
    panel via clicking the pill, then **Cmd+Shift+G** ("Go to Folder")
    with the absolute filesystem path, Enter to navigate, Enter to confirm.
    This commits a bookmark that survives save and re-read from
    `ZSHORTCUTACTIONS.ZDATA`.
- Toolchain bootstrap pattern: import a minimal one-action shortcut
  (`Show Result`) via plist+sign+open and click `Add Shortcut` first to
  confirm the import flow works on the user's machine before authoring
  the real shortcut. This caught one early-iteration bug (extension
  mismatch) without risking the destructive Send Message path.
- `shortcuts list` / `shortcuts run` / `shortcuts view` are the public CLI.
  There is no `shortcuts delete` — tombstoning rows via
  `UPDATE ZSHORTCUT SET ZTOMBSTONED=1 WHERE ZNAME=...` in
  `~/Library/Shortcuts/Shortcuts.sqlite` removes them from the list.
  Shortcuts.app's iCloud sync eventually propagates the tombstone.
- End-of-build verification on Mac: with the relay-written fixture present
  in the Shortcuts container, `shortcuts run ClaudeDraft` brings up the
  Messages compose sheet pre-filled with the recipient
  (`wregan599@gmail.com` in the self-test fixture); Escape or Cancel
  closes the sheet without sending. Confirmed no row appears in
  `~/Library/Messages/chat.db` after cancellation.
- After a Mac-side Shortcut smoke test, check for stale
  `shortcuts run ClaudeDraft` processes before handoff. The CLI can remain
  alive while a compose sheet is open or after a UI test stalls; that makes the
  terminal look stuck even though the relay code is fine. Stop the stale test
  runner, then verify the relay process and iCloud `latest.json` separately.
- Self-addressed iMessage drafts need a first-class parser path. "Reply to
  myself..." and "Reply to me..." do not contain a capitalized contact name,
  so the normal `to <ProperName>` extractor misses them and the relay falls
  back to slow generic Claude chat. Route `myself` / `me` to a deterministic
  self contact and short-circuit context lookup to `RELAY_SELF_RECIPIENT`
  (fallback: William's Apple-ID email) so the relay writes the phone handoff
  file without shelling out to Messages history.
- Keep self-recipient intent stricter than self-recipient extraction. Phrases
  like "Please send to me instead of the Mac" are UI complaints, not draft
  requests. Accept strong self-draft shapes (`reply to me`, `text me`, `ping
  me`, `send me a message`, `draft a message to me`) but do not treat every
  stray `to me` as a draft.
- Do not use Telegram inline buttons for `shortcuts://` handoff URLs.
  Telegram rejects custom schemes in inline keyboard URLs. Keep the
  `shortcuts://...` URL as plain message text only.
- Exact-body iMessage requests should bypass Claude. If the user says
  "Reply to myself saying X" or "Text Peggy with X", the body is already known;
  wrapping it in the draft markers locally avoids a slow Claude call and avoids
  marker-compliance failures. Reserve Claude for polishing descriptive asks or
  using fetched thread context. Guard the `with ...` form carefully:
  "Draft an iMessage with Peggy" means Peggy is the recipient, not the body.
- Vague placement requests with no exact body and no resolved Messages thread
  should fail fast with a clarification, not go through Claude and then report
  `markers_missing`. Example: "draft an iMessage response to Mark directly in
  the chatbox" has neither a body nor usable thread context when Mark cannot be
  resolved, so ask for Mark's phone/email plus the message body. Treat `empty`,
  `timeout`, and `error` lookup statuses the same for this branch; none give
  the relay a usable body or recipient.
- Do not run placement-claim stripping across the inside of
  `<<<IMESSAGE_DRAFT>>>` markers before extracting the body. The stripper is
  intentionally aggressive against lines like "I can't send it..." and "I have
  placed the draft...", but those can be legitimate user-supplied body text.
  The stripper itself now preserves complete marker blocks before removing
  boilerplate, so future callers cannot corrupt exact draft bodies.
- Treat retrieval startup preflight as diagnostic, not a permanent feature
  gate. The SQLite index can transiently lock during launch; if preflight
  times out and the relay sets `retrievalAvailable=false`, FTS stays disabled
  until a manual restart even though later searches may work. Keep retrieval
  enabled after preflight failure and let per-request search handling decide.

## 2026-05-13 - FDA target is bun, not claude; 409 Conflict means two instances

- FDA target is **bun**, not Claude CLI, for the imessage-context prefetch
  path. `src/imessage-context.ts:fetchIMessageContext` spawns
  `scripts/imessage-thread.sh` directly via bun's native `spawn` API; the
  actual process tree is `launchd → bun (relay.ts) → bash →
  imessage-thread.sh → sqlite3`. Claude is not in this chain at all
  anymore. macOS TCC checks Full Disk Access against the responsible
  process that opens `chat.db`; that process is bun. Live evidence
  2026-05-13: relay log on Mac A showed
  `[imessage-context] contact=Mark status=fda_denied messages=0` after
  Mac A migration even though the user had granted FDA per the previous
  `docs/IMESSAGE-SETUP.md`, which still pointed at the Claude CLI binary
  — dead code for this path. **Why:** the relay was rewritten on
  2026-05-11 to do deterministic context prefetch before Claude runs,
  removing the Claude → Bash → sqlite3 chain the old setup doc assumed.
  **How to apply:** any future code change that moves iMessage fetching
  to a different process MUST update `docs/IMESSAGE-SETUP.md` in the
  same commit. Grant FDA to `readlink -f "$(which bun)"` — the resolved
  Cellar path (`/opt/homebrew/Cellar/bun/<version>/bin/bun` on Apple
  Silicon), not the `/opt/homebrew/bin/bun` or `/usr/local/bin/bun`
  symlink. Symlinks re-point on every `brew upgrade bun` and TCC
  silently denies again.
- 409 Conflict in `relay.err.log` = two bot instances polling the same
  Telegram token. GrammyError shape:
  `Call to 'getUpdates' failed! (409: Conflict: terminated by other
  getUpdates request; make sure that only one bot instance is running)`.
  Telegram delivers each incoming update to exactly one of N pollers
  non-deterministically — user-facing symptom is "mixed, confusing,
  unrepeatable" replies because some messages get processed by the old
  instance and some by the new. Live evidence 2026-05-13: during the
  Mac B → Mac A migration, Mac B's launchd `com.claude.telegram-relay`
  stayed loaded after Mac A's relay came up; a screenshot of an
  unexpected 90s timeout response was actually Mac B's old code
  answering, not Mac A's. **Why:** `launchctl kickstart` on Mac A does
  not stop Mac B's process — they're independent machines polling the
  same bot token. **How to apply:** always
  `grep 409 ~/Projects/claude-telegram-relay/logs/com.claude.telegram-relay.error.log`
  before investigating relay logic bugs. `launchctl unload` the old
  instance (and `pkill -f 'bun run src/relay.ts'` any stragglers)
  before starting the new one. Never rely on the new instance "winning"
  the poll race — Telegram's delivery is non-deterministic.

## 2026-05-14 - Senior hardening pass: fail closed, prove smoke paths, bound side effects

- `TELEGRAM_USER_ID` is not optional for this relay. A missing allowlist turns a
  local Claude Code bridge into a public bot. Startup must fail closed when the
  user ID is missing, a placeholder, or non-numeric; setup verification should
  mirror that check.
- Claude subprocesses must not inherit the relay's whole environment. Pass a
  narrow auth/runtime allowlist, disable tools for ordinary text turns, and only
  enable `Read` from the upload directory for image/document turns. A one-line
  `claude -p ... --no-session-persistence --tools ''` probe is the cheapest
  way to catch flag/env breakage before restarting launchd.
- Update markers need phase semantics. `started` means retry after a crash;
  `sent` means Telegram accepted a user-visible reply and redelivery would
  duplicate it. Never load raw in-flight `started` markers as permanently seen.
- iMessage helper envelopes must be generated with JSON escaping, not raw
  `printf` interpolation. The `?`/`-`/empty recipient sentinel is a real
  blank-recipient compose path and needs a test that verifies the generated
  `sms:&body=...` URL without launching Messages.
- `imessage-thread.sh` is a directly runnable boundary script. Validate `LIMIT`
  in the script, cap it, and classify sqlite authorization/open failures as
  exit 77 even if the initial `-r chat.db` check passed.
- The active converted textbook corpus on this machine is indexed under
  `~/Downloads/anes-textbooks-markdown` while the older catalog/path constants
  pointed at `~/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown`. Retrieval
  should search both roots and prefer converted Markdown before skipped PDF path
  hits. Book-scoped strict AND queries can miss real content; if the strict
  query returns zero, try adjacent clinical token pairs before path fallback.
- `bun test` is not enough for retrieval work. Package-level verification must
  include `scripts/smoke-poison-query.ts` and
  `scripts/smoke-textbook-retrieval.ts` so a green unit suite cannot hide a
  broken live-index query.
- Uploaded Telegram filenames are untrusted. Never join `doc.file_name`
  directly into `UPLOADS_DIR`; use a generated filename with a sanitized
  extension, keep the original only as prompt metadata, and unlink upload files
  from a `finally` block so Claude timeouts do not leave sensitive artifacts on
  disk.
- Setup scripts are part of the operational surface. `setup:verify` must check
  the actual voice providers (`VOICE_PROVIDER=groq|local`), and any printed
  launchd stop command must be implemented (`--unload --service all`) rather
  than being aspirational CLI copy.
- Telegram inline keyboard URLs cannot use custom schemes such as
  `shortcuts://`. iPhone Shortcut handoff links must remain plain message text;
  otherwise Telegram rejects `sendMessage` with 400
  `Unsupported URL protocol` after the relay has already generated and written
  the draft. After fixing source, restart launchd or the live bot will keep
  running the stale reply path.
- The final Telegram-visible response must be computed before sending,
  persistence, short-term history, memory capture, and decision metrics. Do not
  hide display-only rewrites inside `sendResponse`; that recreates the old
  Conor empty-response bug in a new form. 2026-05-14 example: `sendResponse`
  showed `Open on iPhone: shortcuts://...`, but `appendTurn` saved the
  internal `Phone handoff ready:` line, contaminating the next Claude prompt.
- Multi-chunk Telegram replies need explicit partial-send semantics. If at
  least one chunk is accepted and a later chunk fails, treat the update as
  user-visible and log `telegram_partial_send_after_*`; retrying the same
  update would duplicate the accepted prefix. Only rethrow when zero chunks
  were accepted.
- Runtime state is sensitive. `~/.claude-relay`, decision logs, update
  markers, and short-term chat state must be `0700`/`0600`; setup verification
  should check the actual runtime directories, not just repo-local folders.
- Upload turns must use per-update private directories and pass only that
  directory via Claude `--add-dir`. A shared upload root lets concurrent
  prompt-injected uploads read each other's files.
- Telegram downloads require explicit status and size gates before buffering or
  writing. Check Telegram metadata, `response.ok`, `Content-Length`, and stream
  byte counts with per-type caps.
- Lock files must be acquired atomically with exclusive create. A read-check-
  write lock can start two long-polling relays during launchd/manual races.
- launchd setup must fail if unload fails, XML-escape generated plist strings,
  and lint the plist before loading. Otherwise stale pollers or invalid plists
  look like successful installs.
- Do not send Claude CLI stderr back to Telegram. Log a bounded sanitized
  summary locally and send a generic failure to the user; stderr can contain
  local paths, stack traces, or configuration details.
- Keep startup preflight probes aligned with smoke-test semantics. Do not use a
  poison query as a startup health probe; if the smoke test says a query should
  return zero rows, preflight must not warn when it does.

## 2026-05-14 - ClaudeDraft Shortcut verifier must catch UI path drift

- The iPhone error `latest.jsoneon couldn't be opened` was not a relay writer
  typo: source still wrote `latest.json` under
  `com~apple~CloudDocs/claude-relay-drafts`. The installed Shortcut path had
  been corrupted by a stray UI edit. Source-level fix: `setup:verify` now
  decodes the installed `ClaudeDraft` actions from `~/Library/Shortcuts/Shortcuts.sqlite`
  and fails on `latest.jsoneon`, the old Shortcuts app container, or
  `ShowWhenRun !== true`.
- A valid CloudDocs Shortcut shape on this machine can be either a folder
  bookmark to `com~apple~CloudDocs/claude-relay-drafts` with `WFGetFilePath`
  set exactly to `latest.json`, or a file bookmark directly to `.../latest.json`
  with an empty path field. `claude-relay-drafts/latest.json` looks plausible
  in the editor but produced `Error: The file "latest.json" couldn't be
  opened because there is no such file` during `shortcuts run ClaudeDraft`;
  reject it in `setup:verify`.
- Keep the old Shortcuts-container file visible in verification. If
  `~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json`
  exists, warn every time; that stale copy can make a wrong-provider Shortcut
  appear healthy until the CloudDocs and Shortcuts-container files diverge.
- During the same iPhone edit session, the Shortcut lost its entire Get File
  action. `setup:verify` caught this as `ClaudeDraft is missing the Get File
  action`; restore only from a known-good five-action plist after backing up
  `~/Library/Shortcuts/Shortcuts.sqlite*`. Keep a fixture test for missing Get
  File so verifier regressions fail in `bun test`.
- Presence is not enough for Shortcut validation. The live editor moved Get
  File to the end once, leaving the dictionary parser wired to an output that
  no longer existed at runtime. The verifier must require Get File as action 0
  and require `Get Dictionary from Input` to read that exact action UUID.
- Recipient appearing in Messages is not proof the body was wired correctly.
  On iPhone, `ClaudeDraft` opened a compose sheet for Mark but left the body
  blank because `WFSendMessageContent` was stored as a raw
  `WFTextTokenAttachment`. Working Shortcuts wrap variable message bodies as a
  `WFTextTokenString` with the object-replacement placeholder and an
  `attachmentsByRange` entry pointing at the body dictionary value. The
  verifier must reject raw body attachments and require the wrapped token
  string form.
- Mac-side Shortcut validation is not iPhone validation. A directly patched
  `~/Library/Shortcuts/Shortcuts.sqlite` can pass locally while the iPhone
  still has the stale shortcut. If `ClaudeDraft-install.shortcut` is present
  in iCloud Drive, `setup:verify` must treat the iPhone install as pending
  after validating the signed artifact, not report the handoff as fully ready.
- iPhone import uses the `.shortcut` filename as the installed shortcut name.
  `ClaudeDraft-install.shortcut` imports as `ClaudeDraft-install`, so it does
  not replace the relay target. To fix the actual iPhone handoff, install a
  signed file named exactly `ClaudeDraft.shortcut`, then delete both temporary
  iCloud artifacts after the phone accepts it.
- The Shortcut validator must enforce the whole five-action chain, not just
  the presence of safe-looking actions. Extra actions or a second Send Message
  action can bypass the safety contract even when the first Send Message has
  `ShowWhenRun=true`.
- `open sms:...` success is not proof that Messages accepted the body into the
  compose field. Until there is UI-level confirmation, the Mac fallback should
  be reported as opened Messages plus clipboard, not as a pasted draft.
- If `Always Allow` is accidentally granted on the iPhone Shortcut's Send
  Message privacy prompt, reset it from `ClaudeDraft` editor -> bottom info
  button -> Privacy -> Reset Privacy. After reset, the `Allow Send Message to
  use ... Always Allow` row disappears. The source verifier still needs to
  enforce `ShowWhenRun=true`; the phone-side privacy reset only clears the OS
  prompt grant.

## 2026-05-14 - Relay runtime hardening: queues, state roots, and partial sends

- Per-chat ordering must cover every Telegram update type, not just text.
  Voice/photo/document handlers also append to short-term state, so a global
  per-chat queue middleware is required. If a text handler still calls
  `enqueue()` internally, make the queue re-entrant with `AsyncLocalStorage`
  or it will deadlock on itself.
- Partial Telegram send handling must be uniform. If `sendTelegramResponse`
  accepts chunk 1 and fails on chunk 2 for voice/photo/document replies, record
  `telegram_partial_send_after_*` in `errorMsg`, mark the update sent, and save
  the exact sendable text to Supabase and short-term state.
- Runtime state defaults must share one base. `RELAY_DIR` should drive logs,
  update markers, uploads, and short-term chat state unless a specific
  `RELAY_LOG_DIR` or `RELAY_STATE_DIR` override is set. Do not let
  `setup:verify` pass a custom `RELAY_DIR` while markers or chat state still
  write to `~/.claude-relay`.
- If an update throws before any Telegram-visible reply is accepted, remove it
  from the in-memory seen set so same-process redelivery can retry. If a sent
  marker was written, keep it as seen to avoid duplicate replies after a late
  persistence failure.
- Claude subprocess cwd should come from `PROJECT_DIR`, `RELAY_CWD`, or the
  actual repo root, not a hardcoded `~/Projects/claude-telegram-relay` path.
  Verify the cwd is readable at startup so launchd failures are immediate.
- launchd reload should remove by label before unloading by plist path, then
  verify `launchctl list <label>` is absent before loading. Otherwise a stale
  job loaded from an older path can survive and compete for Telegram polling.

## 2026-05-14 - Relationship aliases and formatted phones must resolve before context drafting

- A request like "open up my recent iMessages with my mom and draft a response"
  failed before the relay reached `imessage-thread.sh`: the parser only
  extracted proper-noun contacts, phone numbers, or emails after `to/with`.
  Lowercase relationship aliases like `my mom` returned `null`, so Claude saw
  a generic chat prompt and drifted into stale Telegram context. Add explicit
  relationship-alias parsing for `mom/mum/mother`, `dad/father`, and similar
  family terms while keeping past-draft references suppressed.
- Follow-up phrasing can hide the same bug one layer earlier. "Please draft a
  response back to my mom" still bypassed the iMessage path after the first
  relationship-alias fix because `response` was not treated as a message-draft
  type. Keep `reply` and `response` in the message-type detector, with the
  existing email guard and past-draft guard preventing hijacks like "John's
  email" or "the response to Mom earlier."
- Parser fixes must harden the new boundary, not just the live phrase. After
  adding `response` and `reply`, explicitly suppress meta-questions like
  "Did you draft a response to Peggy yesterday?" or "Has Claude sent a
  response to Peggy?" and keep the implicit
  `respond/reply ... to` bridge limited to `back to` / `right back to` so
  email idioms such as "reply all to John", "reply-all to John", or "reply
  all back to John" do not open iMessage placement.
- AddressBook phone numbers are often formatted, e.g. `1 (604) 315-4583`, but
  Messages `chat_identifier` values are normalized digits such as
  `+16043154583`. If the resolver returns the formatted AddressBook value,
  context lookup can resolve a contact and still return zero messages. Normalize
  contact phones before returning them, and make `imessage-thread.sh` query all
  equivalent chat identifier shapes.
- Live verification for this class of bug should avoid printing private message
  text. Check only the resolved suffix and message count, for example:
  `scripts/imessage-thread.sh mom 10 | python3 -c '...'`. Acceptance for the
  2026-05-14 bug was `resolved=True`, suffix `4583`, and `messages=10`.

## 2026-05-15 - Supabase complements Obsidian; it must not compete with it

- Obsidian is the durable memory source of truth for the relay. Keep
  `MEMORY_AUTHORITY=obsidian` unless intentionally migrating durable facts and
  goals to Supabase.
- Supabase is useful as an operational layer: Telegram message history,
  semantic search over prior conversations, and later analytics. In that mode,
  `SUPABASE_MESSAGE_HISTORY=1` and `SUPABASE_RELEVANT_CONTEXT=1` are safe.
- Do not ask Claude to emit `[REMEMBER]`, `[GOAL]`, or `[DONE]` tags merely
  because Supabase credentials exist. Those tags write to the Supabase
  `memory` table, so they are enabled only when
  `MEMORY_AUTHORITY=supabase`.
- `setup:verify` and `setup/test-supabase.ts` should require the Supabase
  `messages` table for history/search, but the `memory` table is optional in
  the default Obsidian-first architecture.

## 2026-05-15 - Relationship aliases must win over proper nouns inside draft bodies

- Live failure: `Text mom saying heading to London` staged an iMessage draft
  for `London` instead of Mom. The parser matched the explicit `to London`
  phrase inside the direct body before checking the relationship alias at the
  start of the request.
- Contact extraction must prefer relationship aliases (`mom`, `my mom`,
  `mother`, `dad`, etc.) before scanning for proper-noun `to/with` contacts
  in the rest of the sentence. Proper nouns inside the message body are often
  places, people, or topics, not the recipient.
- Regression acceptance: `extractIMessageDraftRequest("Text mom saying heading
  to London")` returns `contact: "mom"` and `directBody: "heading to London"`.
  Live verification wrote `latest.json` with recipient suffix `4583`, ran the
  `ClaudeDraft` Shortcut with `Allow Once`, and confirmed the iPhone compose
  sheet showed `To: Mom` with body `heading to London`.
- Safety acceptance must include a no-send proof. Querying Messages for the
  exact body in outgoing messages from the last 30 minutes returned `0` before
  and after the Shortcut run.
- Telegram custom-scheme text is not a reliable one-tap trigger. Do not phrase
  the status as if Telegram will open `shortcuts://` directly. Tell the user
  the truthful next action: run `ClaudeDraft` in Shortcuts on the iPhone.
- 2026-05-15 follow-up: Mac Messages showing the draft is not proof that the
  iPhone compose field is populated. The screenshot showed the Mac compose
  field contained `heading to London` while iPhone Mirroring still showed an
  empty `iMessage` input. Do not run Mac Messages placement as a "silent bonus"
  for phone handoff; it creates a false success signal.
- Direct `sms:+number&body=...` opened the iPhone thread but did not populate
  the compose field on this setup. The verified phone path was:
  open the iPhone Messages thread through mirroir, tap the bottom compose
  field, type the body through mirroir keyboard input, OCR-check that the body
  is visible, and never tap the send arrow.
- Enable the mirroir typed-placement path only when iPhone Mirroring is
  actively available (`RELAY_IPHONE_MIRROR_PLACEMENT=1`). Keep the CloudDocs
  `latest.json`/ClaudeDraft Shortcut handoff as a fallback, and use Mac
  Messages only when phone handoff is unavailable.
- 2026-05-15 architecture correction: iPhone Mirroring is diagnostic-only, not
  a production path. The relay's real requirement is remote Mac + local iPhone,
  so the Mac cannot drive the iPhone compose box directly. Leave
  `RELAY_IPHONE_MIRROR_PLACEMENT=0` for production. The durable production
  contract is: relay writes CloudDocs `latest.json`; the iPhone runs
  `ClaudeDraft` locally; the Shortcut opens the compose sheet with
  `ShowWhenRun=true`.
- If the product needs fewer taps, solve it with an iPhone-side trigger, not
  Mac-side mirroring. Candidate production upgrades: an HTTPS redirect link
  from Telegram that opens `shortcuts://run-shortcut?name=ClaudeDraft`, or a
  push-notification workflow such as Pushcut/Pushover that the user taps on
  the iPhone. Fully automatic background iMessage compose on a personal iPhone
  is blocked by iOS security unless a local iPhone automation/app participates.

## 2026-05-15 - Re-export iPhone Shortcut installs from the validated Mac shortcut

- Live failure repeated at 10:11: Telegram requests for Mom and Dad wrote a
  correct CloudDocs `latest.json` (`recipient_label: dad`, suffix `1365`,
  body `heading to London`), but the iPhone Messages compose field stayed
  empty. The no-send database check for that exact body returned `0`.
- Root cause is at the Mac/iPhone Shortcut boundary, not the relay parser or
  the handoff JSON. If Messages opens to the right recipient with no body, the
  iPhone still has a stale or miswired `ClaudeDraft` Shortcut.
- Do not try to sign raw `ZSHORTCUTACTIONS.ZDATA` directly. Apple's
  `shortcuts sign` can crash on a top-level action array. Wrap the validated
  action array in a workflow dictionary containing `WFWorkflowActions`, icon,
  import question, input/output class, type, and client-version keys, convert
  that workflow to a binary plist, then sign it.
- The repo command for that path is `bun run setup:export-shortcut`. It reads
  the Mac-installed `ClaudeDraft`, validates it, signs a file named exactly
  `ClaudeDraft.shortcut`, writes it to iCloud Drive, and validates the signed
  artifact. The phone still needs the one-time Files install/replace step.
- `setup:verify` should fail while `~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut`
  remains present. That is an intentional pending-install signal, not a code
  regression. After the phone is confirmed to populate the compose body,
  delete the install file from iCloud Drive.
- Decision logs must not record an iCloud Drive handoff as `placed`. A
  successful `latest.json` write means the phone input is ready, not that the
  iPhone compose field is populated. Use `phone_handoff_ready`, and while the
  signed install artifact still exists, use `phone_shortcut_install_pending`
  and tell the user to install/replace `ClaudeDraft.shortcut` first.

## 2026-05-15 - Pending Shortcut artifacts are setup failures, not live draft copy

- Live failure: after the fixed `ClaudeDraft.shortcut` install artifact was
  created in iCloud Drive, every draft request returned a long install/replace
  instruction block instead of the normal handoff response. That was the wrong
  product boundary. The live draft path should write `latest.json` and report
  `phone_handoff_ready`; setup health checks should catch leftover install
  artifacts separately.
- A stale `~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut`
  file must not change the user-facing response for every Telegram draft.
  `setup:verify` already fails on that artifact, which is the correct place to
  surface the pending-install problem.
- 2026-05-17 correction: if the phone has just lost/deleted all shortcuts and
  the fixed `ClaudeDraft.shortcut` install artifact is present, a plain "Run
  ClaudeDraft" status is misleading because the iPhone target may not exist.
  Surface `phone_shortcut_install_pending` with the exact Files -> iCloud Drive
  -> `ClaudeDraft.shortcut` install/replace instruction until the artifact is
  removed after a real iPhone compose-body verification.
- Do not expose `shortcuts://run-shortcut?...` in Telegram copy. Telegram
  rejects custom schemes in inline keyboards and does not make custom-scheme
  message text a reliable trigger. Keep the runtime wording simple:
  `Run ClaudeDraft in Shortcuts on your iPhone.`
- Keep decision logs precise: CloudDocs handoff is `phone_handoff_ready`, not
  `placed`. Only a verified iPhone Mirroring typed path or another UI-level
  proof may use `placed`.
- Diagnostic iPhone Mirroring verification must prove the body is visible on a
  Messages compose surface, not merely anywhere on the mirrored phone. A live
  false positive put `heading to London` in iPhone search suggestions and
  passed because OCR contained the body. Reject known non-Messages surfaces
  such as Google Suggestions and Telegram before typing or claiming success.
- 2026-05-15 Telegram product correction: when phone handoff is not verified,
  the Telegram chatbot should still show the draft itself, not an operational
  instruction line. Strip internal `Phone handoff ready: shortcuts://...` from
  the user-visible reply instead of converting it to `Run ClaudeDraft...`.
  Keep the handoff path and shortcut URL in decision logs for debugging.

---

## 2026-05-16 — iPhone mirror + iCloud Drive failure fallthrough bug

**File:** `src/relay.ts` lines 1141-1185

**Root cause:** Two independent if-chains evaluate the draft placement outcome. Chain 2 sets `imessageDraftStatus = "phone_handoff_ready"` when `iPhoneMirror?.ok` is true, but never assigns `placement`. Chain 3 ran unconditionally and its final `else if (!handoff?.ok)` fired whenever `handoff.ok` was false — including the case where iPhone mirror had already succeeded. Result: `imessageDraftStatus` and `assistantText` were silently overwritten with `"helper_failed"` and an error message even though the draft was placed successfully.

**Fix:** Wrapped all of chain 3 in `if (placement !== undefined)`. `placement` is only assigned in chain 2's `else` branch, which runs only when both iPhone mirror and iCloud Drive failed. The guard makes the invariant structural rather than relying on `!handoff?.ok` being redundantly true.

**Pattern to watch:** Any time a status variable is set in one if-branch and an independent if-chain runs afterward with a broader condition (`!x` where `x` is false in a successful sibling branch), the successful branch's state can be silently overwritten. Always gate follow-up chains on the concrete evidence of what happened (the assigned variable), not on the absence of a prior failure flag.

## 2026-05-16 — Live relay audit: launchd, Telegram polling, and phone handoff boundaries

- Live relay logs showed repeated `GrammyError ... getUpdates ... 409:
  Conflict: terminated by other getUpdates request` followed by launchd
  restarts. The local `bot.lock` only protects one `RELAY_DIR`; it cannot
  prove token-level exclusivity across another process, machine, or tool using
  the same Telegram bot token. The relay must treat Telegram 409 long-polling
  conflicts as a runtime contention state: stay alive, log the competing
  poller signal, and retry with bounded backoff instead of crashing into a
  KeepAlive loop.
- First local 409 check: `ps ... | rg telegram/0.0.6` and
  `~/.claude/channels/telegram/.env`. The official Claude Telegram plugin can
  respawn from Cursor/Claude even when no launchd service exists. Disable its
  token file by moving `.env` aside without printing the token, then stop the
  plugin process. If 409s persist after one Telegram long-poll timeout window,
  suspect another machine or remote process using the same bot token.
- Launchd's generated PATH omitted `/usr/sbin`, so the architecture preflight
  could not find `sysctl` even though the check was diagnostic-only. Runtime
  probes that call system tools should use absolute paths (`/usr/bin/file`,
  `/usr/sbin/sysctl`) or the generated launchd PATH must include the needed
  system directories. Do not rely on Terminal's interactive PATH to validate a
  launchd service.
- Phone handoff details are internal relay state, not Telegram UX. A successful
  CloudDocs write means `latest.json` is ready for the iPhone Shortcut; it does
  not mean Telegram should show `shortcuts://...` or an "Open on iPhone" line.
  Telegram replies should show the draft body. Keep `shortcutUrl`, handoff path,
  and body hash in decision logs for debugging.
- `writeICloudDriveDraft` must reject draft directories outside
  `~/Library/Mobile Documents/com~apple~CloudDocs` at runtime. `setup:verify`
  catching a bad `RELAY_ICLOUD_DRAFT_DIR` is not enough because old launchd
  env, manual runs, or future code paths can still call the writer directly.
  Never mark `phone_handoff_ready` for a local temp dir or the non-syncing
  Shortcuts container.
- Shortcut validation must verify the file provider identity, not just action
  order and relative paths. The Get File bookmark should have
  `WFFileLocationType=iCloud` and a CloudDocs
  `fileProviderDomainID`; otherwise a path string that looks right can still
  point at a provider the iPhone Shortcut cannot read.
- Multi-recipient relationship phrasing such as `mom and dad` must not silently
  choose the first relationship contact. Until the relay has real group-thread
  support, opt out of one-contact automation rather than drafting to only one
  person.

## 2026-05-16 — Telegram polling diagnostics: do not over-claim ownership

- `bot.start({ onStart })` does not prove this process owns long polling.
  grammY can invoke `onStart` before a later `getUpdates` call fails with 409,
  so logs must say "polling attempt" until the process has survived without a
  conflict. Avoid "owner" wording unless ownership is actually proven.
- A zero-timeout `getUpdates` probe can succeed during a quiet window while a
  different 30-second long poller wins the next race. It is useful as a token
  reachability check, not as proof that no other machine or service owns the
  bot token.
- Telegram 409 handling must stay scoped to `getUpdates`. A generic
  `error_code=409` from `sendMessage` or another Telegram method should not be
  converted into an infinite polling retry loop. Classify method and message
  together before suppressing the exception.
- Persistent polling conflicts need token-safe operator diagnostics: attempt
  count, elapsed seconds, retry delay, PID, lock path, plugin config presence,
  local process count, and webhook status. Never print the token, token hash,
  or full Telegram API URL.

## 2026-05-16 — Shortcut smoke tests must be bounded

- Do not tell operators to run `shortcuts run ClaudeDraft` directly from a
  Claude Code shell. The command can remain alive while macOS waits on a
  Shortcuts privacy prompt or a Messages compose sheet, leaving the terminal in
  a false "shell still running" state even when the relay is healthy. Use the
  bounded `bun run setup:run-shortcut` wrapper so the test process is killed on
  timeout and the operator gets a concrete cleanup instruction.
- Verifiers must be self-bounded. `setup:verify` should not rely on an external
  Claude Code watchdog to break stuck subprocesses or network checks. Wrap
  `launchctl`, `sqlite3`, `plutil`, `aea`, Python probes, and HTTP checks with
  explicit timeouts so one blocked local service cannot pin the whole terminal.
- Command-position iMessage requests need higher precedence than generic
  `to/with` scans. `Text Mark saying heading to London` means recipient Mark
  and body "heading to London"; a later regex must not reinterpret `to London`
  inside the body as the recipient.
- Strip every historical Shortcut handoff label from Telegram-visible text.
  Both `Phone handoff ready: shortcuts://...` and `Open on iPhone:
  shortcuts://...` are internal relay control lines, not user-facing copy.
- Claude CLI nonzero exits are errors, not assistant replies. Throw them back
  to the Telegram handler so decision logs carry `error=claude_exit_*` instead
  of persisting "Claude CLI failed..." as if it were a normal model response.

## 2026-05-17 - Worktree drift; process reset over codebase reset

- When a feature worktree was created from a stale commit on main and main's
  working tree has advanced with verified runtime fixes, do NOT try to reconcile
  by pulling stale-vs-worktree files INTO the worktree. That accumulates
  "wip-snapshot" commits and produces a mongrel branch that is neither a clean
  rebase nor a clean PR. The recovery is: commit main's WIP as a safety
  snapshot, then treat the worktree branch as a patch SOURCE — cherry-pick
  only NEW modules forward to main, one small PR each. Files that main has
  independently advanced (`src/relay.ts`, `src/retrieval.ts`,
  `src/decision-log.ts`, `scripts/draft-imessage.sh`, `scripts/resolve-contact.py`,
  `scripts/smoke-textbook-retrieval.ts`) are NOT eligible for backport from
  the stale worktree.
- New modules ported forward must match main's existing inline semantics
  precisely. `src/session.ts` ported from the audit branch had to be adjusted
  to (a) keep the optional `createdAt` field that main's inline `SessionState`
  carries, (b) call `ensurePrivateDir` before writing the session file (main's
  inline `saveSession` does), (c) match main's `HOME || "~"` default relay dir,
  and (d) have `rotateSession` return a fresh `SessionState` after deleting the
  file so future relay wiring cannot accidentally keep using a stale in-memory
  `--resume` id. Porting verbatim would have dropped `createdAt`, skipped the
  directory creation, and made stale session reuse too easy during integration.
- Add-ons (Gmail, WhatsApp, Supabase dual-memory, voice reply) stay out of the
  relay's hot path until each has its own draft-only acceptance test. The
  draft-router em-dash gate and iMessage recipient allowlist are the
  draft-only safety architecture; nothing that produces an outbound action
  bypasses them.

## 2026-05-17 - Pure intent parser as dormant infrastructure

- `src/memory.ts` embeds a REMEMBER/GOAL/DONE parser inside
  `processMemoryIntents`, which is gated on having a live Supabase client.
  Adding `src/intents.ts` as a pure parse-only module that strips and captures
  the same tag set (plus DECISION / EMAIL_DRAFT / IMSG_DRAFT / WHATSAPP_DRAFT)
  is a draft-only-safe addition: it never writes or sends, and main's runtime
  path continues to use the embedded `processMemoryIntents`. Future PRs can
  swap the embedded parser for the standalone module without changing on-the-
  wire behavior. Land the parser as infrastructure first; integrate later.

## 2026-05-17 — Compass relay audit integration

- Implement high-risk relay fixes before broad add-ons. Supabase dual-memory,
  Gmail REST drafts, WhatsApp links, voice replies, and scheduled jobs need
  credentialed acceptance tests and draft-only safety checks; do not bolt them
  onto the hot Telegram path in the same sweep as runtime bug fixes.
- A topic-pivot phrase is metadata, not content. Drop pivot/source words such
  as `wait`, `different`, and `source`, keep the user's new clinical terms,
  and recover prior user anchors up to the FTS token cap.
- Claude subprocess timeouts should use Bun's native `timeout` and
  `killSignal` support. Manual `AbortController` plus process-tree
  SIGTERM/SIGKILL escalation is more code and less deterministic.
- FTS worker preflight is a soft startup health probe. Route it through the
  same worker as real retrieval, cache the result, and keep startup moving on
  a 250 ms cold-start timeout while preserving real per-query worker failures.
- Feedback-capture commands like "log this as an unacceptable response" should
  never spend a full Claude turn. A deterministic acknowledgement plus the
  existing memory-capture writer is the correct fast path.
- Do not advertise tools Claude cannot actually use. If normal Telegram turns
  pass no Bash tool, the prompt must not tell Claude to call email or message
  helper scripts.

## 2026-05-17 - Draft-router as the single outbound chokepoint

- `src/draft-router.ts` is the architectural place for outbound safety. Two
  draft-only acceptance properties hold by test:
    1. em-dash gate refuses to emit text containing U+2014 (em-dash) or
       U+2013 (en-dash)
    2. iMessage recipient allowlist gate fails-closed on missing or malformed
       allowlist file, refusing every recipient until the file exists with a
       JSON array of approved E.164 phones / emails
  The allowlist gate is the second layer of defense against the iOS Shortcut
  Show-When-Run single-point-of-failure documented in
  `docs/IMESSAGE-SHORTCUT-HANDOFF.md`. Even if that toggle ever flips OFF, the
  relay refuses to write `latest.json` for any recipient not pre-approved.
- The 4096-char Telegram split (paragraph then sentence then hard) and the
  60-second "still thinking" feedback hook also live in draft-router so
  future integrations have one place to call. The current
  `sendTelegramResponse` in `src/telegram-response.ts` already does
  paragraph-aware splitting; the draft-router's split is available for
  callers that need sentence-level fallback when a Claude reply exceeds
  4096 chars in one paragraph.
- Draft-router must share the relay's `RELAY_DIR || HOME || "~"` fallback
  semantics. A dormant safety module with a slightly different state path will
  pass unit tests and then fail when wired into launchd. Also avoid logging raw
  iMessage recipients when an allowlist is missing; the failure reason is enough.

## 2026-05-17 — Contact alias override for AddressBook / chat.db mismatches

- The contact resolver can confidently return the wrong number when the
  user's AddressBook and Messages.app diverge. Live failure 2026-05-17:
  every `Text dad saying heading to London` resolved to `+16048741365`
  (AddressBook contact "Dad", primary phone) which has zero messages in
  `chat.db`. A first attempt incorrectly inferred that Dad should map to
  Mom's active thread (`+16043154583`) based on chat.db volume alone. The user
  corrected the authoritative mapping: Dad is `+16048092405`; Mom is
  `+16043154583`. Do not infer family aliases from message counts when the
  user supplies the actual phone numbers. The relay should make the resolved
  handle visible before handoff so this class of mistake is obvious.
- Fix: `~/.claude-relay/contact-aliases.json` is consulted BEFORE the
  AddressBook lookup in `scripts/resolve-contact.py`. Format is a flat
  JSON object mapping lowercased alias to phone-or-email. Direct
  identifiers (a phone or email typed at Telegram) skip the file
  entirely. Phone values are normalized to E.164 on load. Malformed or
  missing files are silently ignored so the AddressBook fallback path
  keeps working for unknown aliases.
- The default path is overridable via `RELAY_CONTACT_ALIASES_PATH`.
  Tests in `src/imessage-contact-alias.test.ts` use a temp file so they
  are independent of the user's real production alias map.
- Open follow-up: the relay's Telegram reply for a draft should surface
  the resolved phone, so the user catches a wrong number BEFORE running
  ClaudeDraft. Today the reply is just "Run ClaudeDraft in Shortcuts on
  your iPhone." with no indication of which handle the draft will go to.

## 2026-05-17 — Anesthesia prompt integration must match relay-owned retrieval

- Do not paste XML prompt blocks that tell Claude to run `rg`, Bash, or search
  tools into the Telegram relay. Ordinary text turns call Claude with no tools;
  the relay performs deterministic FTS retrieval before Claude runs and injects
  `RELEVANT INDEXED CONTENT` into the prompt. Advertising unavailable tools
  causes false claims and instruction leakage.
- Generic anesthesia-domain questions need their own retrieval gate. Book-name
  triggers catch prompts like "What does Miller say...", but "rocuronium dosing
  and onset for RSI" should also search the converted textbook corpus. Keep the
  route high precision and scope those queries to the known Markdown textbook
  roots instead of the whole Obsidian/native-memory search space.
- If a strict AND FTS query has no hits, corpus-scoped generic medical queries
  need a bounded relaxation pass. The first query-builder token is the strongest
  clinical anchor after ranking; pair it with later tokens before falling back
  to adjacent pairs.
- Book-name typo normalization must happen before both query building and
  retrieval path-filtering. Live failure 2026-05-17: "brash" was semantically
  meant as Barash, but the FTS query treated it as ordinary content and mixed in
  Miller chunks. Common typo aliases belong in `books.ts` and should canonicalize
  to the book key before token ranking and `BOOK_PATH_FILTERS` routing.

## 2026-05-17 — System/user prompt separation via Claude CLI

- Concatenating the system instructions and the user message into a single
  `-p <prompt>` argument can make Claude paraphrase its own role back as the
  reply when retrieval scores poorly. Live failure 2026-05-17T07:17:04Z on
  "Search for what cote says are the indications for arterial line placement"
  returned ~190 chars of role recitation ("You are responding to William
  directly. Use the search results above as factual grounding ...") instead
  of the actual clinical content. `response-sanitize.ts` cannot help because
  the leak is original prose, not a tagged block.
- The fix is structural: pass durable rules + per-turn context to
  `--append-system-prompt` and pass only the user message to `-p`. Split the
  built prompt at the LAST `\nUser: ` marker so inner `User:` / `Assistant:`
  labels inside a RECENT CONVERSATION block stay in the system half.
- Verified by re-issuing the failing prompt through the CLI in the new shape:
  Claude returned a real pediatric-anesthesia answer with bullet-listed
  indications, not a role paraphrase. Helper lives in `src/prompt-split.ts`
  so it can be unit-tested without triggering relay's top-level lock
  acquisition.

## 2026-05-17 — Anesthesia corpus portability and gate-boundary regression test

- `ANESTHESIA_CORPUS_ROOT` was a literal `/Users/williamregan/Desktop/...`
  string baked into `src/anesthesia-corpus.ts`. It compiled, ran, and passed
  tests on the only Mac that mattered today, but the runtime instruction
  block told Claude only one root existed while `retrieval.ts` actually
  searched two roots (`~/Desktop/...` and `~/Downloads/...`). Citations
  from the Downloads root were valid retrievals but Claude had been told
  that root did not exist.
- Fix: derive `ANESTHESIA_CORPUS_ROOTS` from `homedir()`, expose it as a
  readonly array, and rebuild `ANESTHESIA_CORPUS_INSTRUCTIONS` to mention
  both roots. Keep `ANESTHESIA_CORPUS_ROOT` as a back-compat alias for the
  primary root so existing imports keep building.
- Added a `prepareFtsQuery` test that pins the corpus gate boundary: a set
  of benign non-medical queries ("set a reminder for 10pm", "what is on my
  calendar tomorrow") must return `corpusScoped: false` and must NOT
  include the textbook roots in `scopePatterns`. This is the regression
  guard for `isAnesthesiaCorpusQuery` accidentally widening to match
  everything, which would silently scope every retrieval to the textbook
  corpus and starve general-conversation answers.
- Documented the classifier's known false positives ("airway" in allergy
  context, "RSI" as repetitive strain injury, "epidural" steroid
  injection for back pain) as accepted tradeoffs in tests, so future
  contributors do not narrow the patterns without weighing the user-side
  tradeoff (terse anesthesia queries like "RSI dosing for rocuronium"
  must keep routing to FTS without explicit textbook framing).

## 2026-05-17 — iPhone Shortcut verification needs exact UI state checks

- Mirroir OCR coordinates are labels, not always the tappable control. A loose
  regex for `OK` matched the `Quick Look` shortcut label and tapped the wrong
  tile. For permission prompts, match exact quoted button labels from OCR lines
  or use fixed coordinates from a screenshot after visual confirmation.
- When `ClaudeDraft` opens Messages, the Shortcuts tile can remain in a running
  state with a small stop control. Subsequent taps on the shortcut body may do
  nothing until that stale run is stopped. If a rerun is needed, return to
  Shortcuts, tap the stop control in the top-right of the `ClaudeDraft` tile,
  then tap the tile body again.
- Keep the iCloud install marker (`~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut`)
  until a real iPhone compose-body verification has been observed. After the
  phone opens Messages with the expected recipient and body, move or remove the
  marker and rerun `bun run setup:verify`; otherwise the relay should keep
  surfacing `phone_shortcut_install_pending`.

## 2026-05-17 — Command-position iMessage names can be lowercase

- Live Telegram command `Text jacqueline saying where you at?` was received
  by the relay but fell through to the generic Claude path because
  `COMMAND_POSITION_CONTACT_RE` only accepted capitalized proper names,
  phone numbers, and emails. Direct draft commands typed on a phone are often
  lowercase and should not depend on Claude marker compliance.
- The fix must stay command-position only. Allowing lowercase names in the
  generic `to/with` branch reintroduces old false positives like "text
  messages with Peggy" and "Draft a message saying hey". Anchor the lowercase
  allowance to request-start commands such as `Text`, `Message`, or `Ping`
  with an optional polite prefix.

## 2026-05-17 — Direct text bodies still need thread context and writing rules

- Do not treat `Text <contact> saying <body>` as a verbatim placement request
  for named contacts. Live issue: after the lowercase parser fix, Jacqueline
  resolved and the iPhone compose box was verified, but the relay wrote the
  literal body `where you at?` because `directBody` suppressed context
  injection and bypassed Claude.
- For named contacts, treat the direct body as the core meaning. Still inject
  the last 5 to 10 iMessages when the resolver can read the thread, then let
  Claude apply the user's human-writing rules. Preserve the intent, but match
  the relationship, cadence, and warmth from the actual thread.
- Keep the direct-body bypass only for direct phone/email recipients or runtime
  failures where no safe thread can be read. That preserves a deterministic
  fallback while preventing ordinary named-contact drafts from skipping context.

## 2026-05-17 — Modern Messages rows store text in `attributedBody`

- Live issue: `Respond to Conor's last message` drafted `ha might need a full
  neuro exam at this point` because the context helper filtered on
  `message.text IS NOT NULL`. Current Conor rows in `chat.db` had NULL
  `message.text` with the visible body inside `message.attributedBody`, so the
  relay skipped April 2026 context and fell back to an October 2025 message:
  `May have to check his reflexes`.
- Any iMessage context reader must decode `attributedBody` before deciding the
  thread is stale or empty. Also skip tapback rows (`associated_message_type`
  nonzero) so "Loved ..." reactions do not masquerade as real message bodies.
- For vague commands like `reply/respond to <person>'s last message`, decline
  automatic placement when the latest decoded thread message is already from
  the user. That is safer than inventing a new follow-up to an already answered
  thread.

## 2026-05-17 — Clear stale iPhone handoffs before every new draft attempt

- Live issue: after Jacqueline's draft was written to `latest.json`, a later
  Nater command fell through the non-draft path and then failed the first
  fixed draft run because a decoded Messages row contained a null byte. During
  both failures, `latest.json` still pointed at Jacqueline, so ClaudeDraft
  reopened the wrong compose even though Telegram showed a new Nater draft.
- Fix pattern: as soon as the relay recognizes a new iMessage placement
  request, delete the old CloudDocs `latest.json` before Claude runs. If the
  new request fails, ClaudeDraft should find no stale handoff rather than a
  previous recipient/body.
- Also sanitize decoded iMessage text for null/control bytes before injecting
  it into the Claude CLI prompt. Bun refuses spawn args containing null bytes,
  so raw `attributedBody` extraction must never feed `\0` into `callClaude`.
