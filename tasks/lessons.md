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
- Gate 2B v1 uses the Shortcuts iCloud container as the handoff surface:
  `~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json`.
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
- The storage selector in Shortcuts is load-bearing. The working shortcut
  reads "Get File from Shortcuts at path claude-relay-drafts/latest.json",
  which maps to `iCloud~is~workflow~my~workflows/Documents` on macOS. Writing
  the general `com~apple~CloudDocs/claude-relay-drafts/latest.json` path is a
  different file and will not feed the Shortcut unless the Shortcut is also
  pointed at general iCloud Drive.
- 2026-05-13 audit: the terminal's successful Mac Shortcut run only worked
  after copying `latest.json` into the Shortcuts container. That proved the
  relay default was wrong, not that the Shortcut should be repointed. Fix the
  writer to match the working Shortcut storage selector.
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
  - Because the bookmark is device-specific, the simpler design is to write
    the relay's payload into the Shortcuts container and let the shortcut
    use its default storage. That's what the relay was changed to do on
    2026-05-13 (relay code change made in parallel during this build):
    write to
    `~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json`,
    so the Shortcut's default `WFGetFilePath="claude-relay-drafts/latest.json"`
    resolves correctly without any custom bookmark.
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
- Do not rely only on Telegram inline buttons for `shortcuts://` handoff URLs.
  Custom-scheme behavior can vary by Telegram/iOS client. Keep the inline
  "Open draft on iPhone" button, but also leave a visible `shortcuts://...`
  fallback in the message so the user can copy it if the button does nothing.
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
