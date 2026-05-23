# Telegram Relay session writeup for codex review

**Window covered:** 2026-05-10 to 2026-05-11 (one continuous Claude Code session)
**Repo:** `/Users/williamregan/Projects/claude-telegram-relay`
**Branch:** `master`, 8 commits ahead of `fork/master`, working tree clean
**Test state at end:** 47 pass, 0 fail, 103 expect (was 31 pass at start)
**Services:** `com.claude.telegram-relay` running, `com.claude.file-indexer` running, `watcher.py` alive

This document covers every change that landed on the branch and the live decision-log evidence behind each one, plus a set of open items that codex should review and recommend fixes for.

---

## TL;DR

Eight commits, all bug-driven, all backed by regression tests where the test surface allowed it. Five came from the AUTO-FIX queue in the handoff. Three more came from live failures the user surfaced during the session.

Three operational changes that are not in git:
- The poisoned turns buffer at `~/.claude-relay/state/chats/8782062645.json` was trimmed back to the last good assistant turn (2026-05-10T20:50:39Z) after Claude emitted bare `<response>` tags twice.
- One-shot extraction of mom's iMessage thread to `~/Projects/claude-telegram-relay/data/mom-imessages.json` via this session's Full Disk Access, so the relay can read it normally without an FDA grant. `data/` is gitignored.
- Two persistent monitors stayed armed over the live test pass (decision log analyzer, stderr tail). They were used for triage, not automated remediation.

---

## Repo state at session start

```
branch:        master ahead of fork/master by 1 commit
last commit:   6f914e2 Improve textbook retrieval over converted markdown
working tree:  clean
bun test:      31 pass / 0 fail / 65 expect
smoke-poison-query:         PASS
smoke-textbook-retrieval:   PASS
services:                   relay + watcher running, preflight clean
```

---

## Commits, in order

### 1. `e72f283` Trigger fires for cote/chestnut/fleisher/stoelting

**Symptom (live decision log):**
```
message: "What does cote say about the indications for intubation?"
trigger_fired: false
hit_count: 0
```

**Root cause:** `src/trigger.ts:11` regex listed only `barash|miller` as bare book-name tokens. Meanwhile `src/retrieval.ts:199-206` already routed chunks for cote, chestnut, fleisher, and stoelting via `BOOK_PATH_FILTERS`. The trigger never fired on the four newer books, so the relay never even called retrieval.

**Fix:**
```diff
-/\b(textbooks?|anesthesia textbook|barash|miller)\b/i
+/\b(textbooks?|anesthesia textbook|barash|miller|cote|chestnut|fleisher|stoelting)\b/i
```

**Tests:** four new entries in `src/trigger.test.ts` should_fire list backporting the exact failing phrasings.

**Verification:** `bun test` 32 pass after the change, then 34 with the next commit's additions.

---

### 2. `f24b3fc` Recover prior anchor on topic-pivot source-redirection follow-ups

**Symptom (decisions-2026-05-09.jsonl entry 3):**
```
prior user turn:  "What does miller say are the indications for an arterial line?"
follow-up:        "No, I want you to instead search through their relevant markdown files that I converted today"
fts_query:        "instead" "relevant" "markdown" "converted" "today"
hit_count:        0
```

**Root cause:** `chooseTokens()` in `src/query-builder.ts:78` only recovered prior-turn anchors when the current message had fewer than two content tokens. The pivot message had five content tokens, all of them source-control vocabulary, so the recovery branch never ran and FTS searched for the wrong terms.

**Fix:** added a topic-pivot detector and a small `SOURCE_CONTROL_STOPWORDS` overlay that drops `instead/rather/actually/relevant/markdown/converted/today` only when a pivot signal is present. When the cleaned message has fewer than two content tokens, recovery now absorbs the whole prior clinical anchor up to `MAX_MATCH_TOKENS=5` instead of stopping at two. Non-pivot recovery behavior is unchanged.

Pivot signals (`TOPIC_PIVOT_PATTERNS`):
- `/\b(instead|rather|actually)\b/i`
- `/\bnot (that|the|those|this)\b/i`
- `/\b(use|read|check|search)\s+(the|those|these|my|your)?\s*(markdown|md|notes?|files?|pdf|docs?)\b/i`
- `/\b(relevant|converted|indexed)\s+(markdown|files?|notes?|docs?|pdf|md)\b/i`
- `/^no[,!.]?\s+(i|let|you|search|look|find|use|check|do|don'?t)\b/i`

**Tests:** three new in `src/query-builder.test.ts`:
- live failure regression asserts `"miller" "indications" "arterial" "line"`
- topic-pivot with new clinical content does not merge prior anchor
- source-redirection without prior context returns empty query

---

### 3. `cbf4ac3` Skip Claude on bare textbook-inventory prompts via catalog short-circuit

**Symptom:** "anesthesia textbook" and similar bare-inventory prompts were spawning Claude with the synthetic `_catalog` hit as context, costing 30 to 150 seconds for a reply whose content is a static book list.

**Root cause:** `retrieval.ts:isBroadTextbookInventoryQuery` already returns a single synthetic hit at `TEXTBOOK_CATALOG_PATH`, but `relay.ts` did not check for it before calling Claude.

**Fix:**
- New `buildCatalogResponse(hits)` in `src/textbook-response.ts`. When `hits.length === 1` and the single hit is the catalog hit, return a formatted bullet list directly.
- Wired into `src/relay.ts:473` between the skipped-textbook check and the Claude call.
- `CATALOG_BOOK_LIST` and `CATALOG_HIT_PATH` are exported from `retrieval.ts` so both modules read from one source of truth.

**Tests:** four new in `src/textbook-response.test.ts`:
- formatted bullet list returned for the catalog hit
- non-catalog hit returns null
- catalog mixed with other hits returns null
- empty hits returns null

**Verification:** bare inventory prompts now answer in under 50 ms with no Claude round trip. Existing smoke test still passes.

---

### 4. `86c22c1` Default Telegram replies to concise, scannable, bulleted

**Symptom:** User explicitly logged a feedback memory asking for concise, scannable, bulleted replies (`feedback_response_style.md`). The system prompt in `buildPrompt` already said "concise and conversational" but did not mention bullets or scannable form, so long paragraphs still leaked through.

**Fix:** single-line directive update in `src/relay.ts:771-773`.

**No test:** `buildPrompt` is not exported and has no existing coverage. Per the handoff convention, skipped a test rather than extract the function just for this. Subsequent commits did extract a different sanitization function (`response-sanitize.ts`) and that pattern could be replicated for `buildPrompt` if codex sees value.

---

### 5. `b9f16ca` Pin book-name anchors over longer clinical adjectives

**Symptom (live decision log 2026-05-10T21:08:13Z):**
```
message:    "Compare the differences in how opioids affect an epidural in kids versus adults between cote and barash"
fts_query:  "differences" "epidural" "compare" "opioids" "adults"
hit_count:  1   (one incidental cote_ped6 page; zero barash content)
user feedback after: "That response is unacceptable"
```

**Root cause:** `buildSearchQuery` selects `MAX_MATCH_TOKENS=5` tokens by descending length. "cote" (4) and "barash" (6) were pushed out by "differences" (11), "epidural" (8), "compare" (7), "opioids" (7), "adults" (6). Book tokens are the highest-precision retrieval signal we have because `retrieval.prepareFtsQuery` converts them into BOOK_PATH_FILTERS scope predicates. Losing them collapsed the FTS scope back to all four `SCOPE_PATTERNS` and returned a single accidental match.

**Fix:** added `BOOK_NAME_ANCHORS` set in `src/query-builder.ts:14-25`. Token selection now pins all book-anchor tokens first, then fills the remaining capacity by the existing length-desc + alpha sort.

**Tests:** two new in `src/query-builder.test.ts`:
- pins book-name anchors over longer clinical adjectives (asserts both `cote` and `barash` survive)
- exact ordered output `"cote" "barash" "differences" "epidural" "compare"`

**Live verification post-fix (decisions 2026-05-10T22:48:56Z):**
```
fts_query:    "cote" "barash" "differences" "epidural" "compare"
hit_count:    8   (4 barash9/ pages + 1 cote_ped6/ + others)
claude_ms:    33965
response:     structured, bulleted comparison with attribution per book
```

---

### 6. `b8f8d3e` Strip bare `<response>`/`<answer>` wrapper tags from Claude output

**Symptom (live decisions 2026-05-10T21:08:25Z and 21:58:25Z):**
```
assistant content: "<response>"
```
The relay forwarded the bare tag straight to Telegram. The screenshot the user shared shows the bot replying with a literal `<response>` message. The first occurrence had no `<response>` anywhere in prior history, so it was not echo. The resumed Claude session then preserved the pattern and repeated it on the next retry.

**Root cause:** Claude emitted only the opening tag of a structured-output frame before stalling. The relay had no defense against this. `stripMemoryTags` handled `[REMEMBER:]/[GOAL:]/[DONE:]` brackets but not XML-style wrappers. `ensureSendableResponse` saw a non-empty string and passed it through.

**Fix (defense in depth, three layers):**
1. New module `src/response-sanitize.ts` with `stripMemoryTags` (moved from relay.ts) and a new `stripWrapperTags` that unwraps matched `<response>...</response>` pairs and strips orphan opening or closing tags. Same logic applied to `answer`, `reply`, `message`, `output`, `result`.
2. Wired into `src/relay.ts:480-491` between `processMemoryIntents` and `ensureSendableResponse`. When the strip leaves nothing, the friendlier empty-response fallback fires: "Hmm, I didn't generate a useful reply this time. Could you rephrase or ask a more specific question?" (previously the robotic "I'm sorry, I generated an empty response.").
3. System-prompt directive added: "Reply in plain text. Never wrap your response in XML or HTML tags such as `<response>`, `</response>`, `<answer>`, or `<reply>`. If you have nothing useful to say, ask a clarifying question instead of returning an empty or tag-only reply."

**Tests:** seven new in `src/relay-strip.test.ts` covering bare opening, bare closing, matched-pair unwrap, alternate tag names, ordinary prose passthrough, newline collapse, and the memory-tag stripper.

**Operational cleanup:** trimmed the chat turns buffer at `~/.claude-relay/state/chats/8782062645.json` back to the last good assistant turn so the poisoned `<response>` turns stopped feeding back into `RECENT CONVERSATION:` and reinforcing the pattern.

---

### 7. `8e4b085` Bake William's writing-style rules into the relay system prompt

**Symptom:** Mother's Day note drafted via the relay violated the cross-project writing-style rules four times in one short message. The rules were saved at `~/ObsidianVault/02-Cross-Project/writing_style_for_william.md` and the full version at `~/.claude/projects/-Users-williamregan-ObsidianVault/memory/feedback_writing_style.md` but the relay's `buildPrompt` did not load them.

**Fix:** inlined the rules (em-dash prohibition, no AI vocab, varied rhythm, conversational warmth, no parallel-bullet overload) in `src/relay.ts:buildPrompt` with explicit scoping: "When drafting outgoing text on the user's behalf (emails, iMessages, letters, notes, anything that will go out under his name)". The existing concise/scannable directive still applies for clinical and technical replies. Tests still 47 pass.

---

### 8. `fe02e90` Replace inline writing-style rules with verbatim version

**Trigger:** User supplied a different phrasing of the same rule set:

> Remember to always follow the following:
> You must act as an expert human-writing editor and rewrite your output so it reads as entirely organic, authentic, and written by a confident, experienced human.
> Please apply the following guidelines:
> - Tone & Voice: Make it sound conversational, warm, and engaging, like a knowledgeable expert explaining something casually but professionally. Add subtle human emotion and natural emphasis to make the writing feel alive.
> - Rhythm & Flow: Master the pacing. Actively vary sentence lengths, improve transitions, and ensure a smooth, natural rhythm that carries the reader effortlessly.
> - What to Eliminate: Strip out any robotic phrasing, stiff structures, monotone patterns, and overly formal jargon. Remove repetitive, predictable AI-like word choices and avoid adding unnecessary fluff.
> - The Golden Rule: Preserve the original meaning and core message completely intact while making the text completely undetectable as AI. Ensure absolutely no "-" "em dashes" in your final output.

**Fix:** replaced the inline rules in `src/relay.ts:buildPrompt` with the verbatim text. Updated the same three source-of-truth files (vault, user memory, project pointer memory) so they stay aligned.

---

## File-level diff summary (6f914e2..HEAD)

```
 src/query-builder.test.ts     |  75 ++++++++++++++++++++++++
 src/query-builder.ts          |  79 +++++++++++++++++++++++--
 src/relay-strip.test.ts       |  50 ++++++++++++++++
 src/relay.ts                  |  51 +++++++++++------
 src/response-sanitize.ts      |  41 +++++++++++++
 src/retrieval.ts              |  17 +++++-
 src/textbook-response.test.ts |  47 ++++++++++++++-
 src/textbook-response.ts      |  20 ++++++-
 src/trigger.test.ts           |   4 ++
 src/trigger.ts                |   2 +-
 tasks/lessons.md              | 130 ++++++++++++++++++++++++++++++++++++++++++
 11 files changed, 487 insertions(+), 29 deletions(-)
```

---

## Live decision-log evidence summary

```
ts                       hits  claude_ms  err                          message
2026-05-10T05:29:31.953Z   8   167176                                  What does barash say about drugs' effects on swallowing
2026-05-10T05:32:22.546Z   0   162506                                  You need to be faster
2026-05-10T05:55:38.313Z   8    17011                                  What does barash say about drugs' effects on swallowing
2026-05-10T17:39:21.055Z   8    11488                                  What does barash say about drugs' effects on swallowing
2026-05-10T17:40:17.646Z   0    37282                                  Please log this as a bug.
2026-05-10T17:40:55.653Z   0    45357                                  Totally unacceptable response.
2026-05-10T20:50:00.986Z   8    36788                                  What does barash say about drugs' effects on swallowing
2026-05-10T21:08:13.940Z   1    11366                                  Compare ... cote and barash    [PRE-FIX: anchor-drop]
2026-05-10T21:08:48.960Z   0    12302                                  That response is unacceptable
2026-05-10T21:10:02.273Z   0   300964   claude_timeout_300000ms         You do this a lot ... deep search
2026-05-10T21:58:13.829Z   0    11219                                  You need to stop generating this: [<response>]
2026-05-10T22:48:56.376Z   8    33965                                  Compare ... cote and barash    [POST-FIX: 4 barash + 1 cote, structured reply]
2026-05-10T22:51:47.274Z   0    20697                                  Can you get Claude to go through my mom's iMessages
2026-05-10T22:53:19.715Z   0    37504                                  Sincere. Speaking to the difficult year ...
2026-05-10T23:04:35.390Z   0    13107                                  Did you not go through my iMessages with my mom for context?
2026-05-10T23:07:54.368Z   0    26007                                  Okay, her phone number is: 6043154583
```

---

# Open items for codex review

Concrete asks. Each has a file:line anchor and a starting hypothesis. Codex should validate or push back.

## OQ-1. 300-second timeout on meta-instructions

**Evidence:** decision-log entry 2026-05-10T21:10:02Z, message "You do this a lot. Please document it and instruct Claude to do a deep search for where this bug is." Result: `claude_ms=300964`, `error=claude_timeout_300000ms`, `hit_count=0`.

**Hypothesis:** Claude interpreted "do a deep search" as an open-ended tool-use loop and ran until the relay's 5-minute wall clock killed the process. The user-facing message is "Sorry, that took too long..." which is fine, but the relay wastes the full 300 seconds of CLI time and the user gets no value.

**Question for codex:** What is the cleanest way to bound this without breaking legitimate long-running queries?
Candidate approaches:
- Pass `--max-turns N` (or equivalent) to the `claude` CLI invocation in `src/relay.ts:247`.
- Drop the default `CLAUDE_TIMEOUT_MS` from 300000 to 90000 for chat replies, raise it only when the message contains an explicit "take your time" or "deep search" signal.
- Detect meta-instruction patterns ("do a deep search", "go through every", "thoroughly review") in `relay.ts:message:text` handler and emit a deterministic clarifying response before spawning Claude.
- Stream Claude output and emit a "still working..." progress message at 30s, 60s, 120s instead of going silent.

## OQ-2. Sanitization gap on voice, image, and document handlers

**Evidence:** `src/relay.ts:617` (voice), `src/relay.ts:680` (image), `src/relay.ts:711+` (document). All three call `callClaude` then `processMemoryIntents` then `sendResponse` directly. None of them call `stripMemoryTags` or the new `stripWrapperTags`.

**Hypothesis:** If Claude emits a bare `<response>` tag or a memory bracket on a voice transcription or image caption, it goes straight to Telegram. The text handler is hardened; the others are not. This is a defense-in-depth gap.

**Question for codex:** suggest the minimal refactor that routes all four handlers through a shared post-Claude pipeline (memory strip + wrapper strip + ensureSendableResponse + memory-tag-leak log).

## OQ-3. `CLAUDE_PATH` resolution under launchd

**Evidence:** `src/relay.ts:43`: `const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";`. The plist at `~/Library/LaunchAgents/com.claude.telegram-relay.plist` does not set `PATH` or `CLAUDE_PATH`. launchd inherits a minimal PATH. The actual binary is at `/Users/williamregan/.local/bin/claude` which would not be on launchd's default PATH.

**Hypothesis:** today the relay works because something somewhere (a launchctl setenv, a shell init read on bun startup, or the bun cwd resolution) is finding `claude` on PATH. That setup is fragile. If a future macOS update or system reboot drops the augmented PATH, every Claude call will fail with ENOENT.

**Question for codex:** confirm the fragility, recommend either an absolute-path default (with `command -v claude` resolution at preflight) or a `EnvironmentVariables` block in the plist. Also evaluate whether the plist should pin the bun binary to its versioned path (`/usr/local/Cellar/bun/1.3.13/bin/bun` versus the symlink at `/usr/local/bin/bun`).

## OQ-4. No automated em-dash lint on outgoing drafts

**Context:** the writing-style rules now live in the system prompt (commit fe02e90). The Golden Rule explicitly forbids em dashes. But Claude can still slip one, and there is no post-generation lint that catches U+2014 (em dash) or U+2013 (en dash) in outgoing text.

**Question for codex:** is it worth adding a `stripDashes` step to `src/response-sanitize.ts` that replaces U+2014 with `, ` or a space, and U+2013 similarly? Edge cases:
- Dashes inside fenced code blocks or backtick code spans should be preserved (technical content).
- The sanitizer fires on every Claude reply, not only on drafts going out under William's name, so it could over-correct on technical chat replies. Maybe gate on a heuristic ("the reply contains 'Dear', 'Hi mom', 'Best,', 'Love,', etc.") or just always strip and accept the over-correction.

## OQ-5. Resumed-session poisoning recovery

**Evidence:** the two `<response>` failures (21:08:25 and 21:58:25) happened in the same Claude session because `callClaude` uses `--resume` with `session.sessionId`. Once Claude emits a bad reply, the resumed session keeps it in its context window and the pattern recurs.

**Question for codex:** propose a recovery mechanism. Candidates:
- When `stripWrapperTags.stripped > 0`, blank out `session.json` so the next call starts a fresh session.
- Track a hash of the last N replies; if the same bare-tag string appears in 2+ consecutive replies, reset session.
- Add a Telegram-side `/reset` command that nukes both `~/.claude-relay/session.json` and the chat turns buffer.

## OQ-6. iMessage and Mail access architecture

**Context:** the user asked the bot to read iMessages for context on a Mother's Day note. The relay does not have Full Disk Access. The bot's Claude session attempted to read `~/Library/Messages/chat.db` and hit the TCC wall. The bot's user-facing message suggested granting Terminal FDA, which is wrong because the relay runs under launchd, not Terminal.

This session worked around it by reading the DB with this Claude Code session's FDA and dumping the relevant thread to `~/Projects/claude-telegram-relay/data/mom-imessages.json` (gitignored). The relay can read that file normally.

**Question for codex:** if this capability is needed long-term, what is the safest architecture?
- A: grant FDA to `/Users/williamregan/.local/share/claude/versions/<v>` (broad, covers everything Claude reads).
- B: build `scripts/imessages-thread.ts` as a narrow helper invoked via Claude's Bash tool, grant FDA to `bun`. Narrower than A because only bun gets FDA; Claude itself does not.
- C: per-request flow. User Telegram message triggers a separate FDA-enabled helper (signed binary or AppleScript wrapper) that extracts a thread on demand and writes to a sandboxed cache. The relay reads the cache.
- D: pre-extraction. The user runs a periodic export of selected threads from an FDA-enabled context (this Claude Code session, or a launchd job that signs into FDA at install). Relay only reads the export.

Option D has the cleanest blast radius. Codex should evaluate.

## OQ-7. Three-way book-name drift

**Evidence:** book-name tokens are now listed in three places.
- `src/trigger.ts:11` regex `cote|chestnut|fleisher|stoelting|barash|miller`
- `src/retrieval.ts:199-206` `BOOK_PATH_FILTERS` keys
- `src/query-builder.ts:14-25` `BOOK_NAME_ANCHORS`

Adding a new textbook requires updating all three. The lessons.md entry from commit b9f16ca calls this out as a known constraint, but the constraint is enforced by manual discipline.

**Question for codex:** suggest a single-source-of-truth pattern. Possibilities:
- Export `BOOK_PATH_FILTERS` from retrieval, derive trigger regex and `BOOK_NAME_ANCHORS` from its keys. The trigger regex would need a fixed prefix (`textbooks?|anesthesia textbook`) and a dynamic suffix.
- Move all three into a new `src/books.ts` and import from each consumer.

## OQ-8. `session.json` never written

**Evidence:** `~/.claude-relay/session.json` does not exist on disk. `callClaude` (`src/relay.ts:250`) only appends `--resume` when `session.sessionId` is set. Without `session.json`, every call is a fresh Claude session, so conversation continuity depends entirely on `RECENT CONVERSATION:` injection from the turns buffer.

**Question for codex:** is this intentional? `saveSession` is called inside `callClaude` (line 308) only when a session ID can be parsed from Claude output. If Claude's `-p` mode does not emit a parseable `Session ID:` line, the file is never written and `--resume` never engages. Confirm by reading actual `claude -p` output, then decide:
- Accept fresh-session-every-call as the design.
- Fix the regex if Claude's output format changed.
- Drop `--resume` from `callClaude` entirely and rely on `RECENT CONVERSATION:` only.

## OQ-9. Decision-log telemetry blind spots

**What we have:** `prompt_chars`, `claude_ms`, `retrieval_ms`, `hit_count`, `top_rank_score`, `second_rank_score`, `fts_query`, `error`, `timeout_kind`, `turn_buffer_size_before`.

**What we do not have:**
- p50 and p95 latency rollups (would surface drift)
- Sanitizer activations (`memory_tags_stripped`, `wrapper_tags_stripped`)
- Was a deterministic short-circuit hit (`catalog_response_used`, `skipped_textbook_response_used`)?
- Trigger fire counts per pattern (which regex is doing the work)
- The actual response text length (decoupled from prompt size)

**Question for codex:** rank these by signal value. Adding all of them is cheap; the question is whether anyone will look.

## OQ-10. Voice and image handlers do not persist turns

**Evidence:** the text handler at `src/relay.ts:506` calls `appendTurn(chatId, { role: "assistant", content: assistantText, ts })`. The voice handler at `src/relay.ts:617` and image handler at `src/relay.ts:680` do not. They call `saveMessage` (Supabase) but not `appendTurn` (local turns buffer).

**Hypothesis:** voice and image replies are missing from `RECENT CONVERSATION:` injection. The bot will not remember its own voice replies on the next text message.

**Question for codex:** confirm the gap, and propose the smallest fix (likely adding `appendTurn` after `sendResponse` in both handlers, with a sensible `content` representation for image replies).

---

# Verification at session end

```
$ bun test
 47 pass / 0 fail / 103 expect() calls / 5 files

$ bun build src/relay.ts --target bun --outdir /tmp/relay-self-heal-build
  relay.js  0.70 MB  (entry point)

$ bun run scripts/smoke-poison-query.ts
PASS: poison query handled within bound

$ bun run scripts/smoke-textbook-retrieval.ts
PASS: textbook retrieval smoke checks returned scoped converted/path hits

$ git diff --check
(clean)

$ launchctl list | grep com.claude
55084   0   com.claude.telegram-relay
38018   0   com.claude.file-indexer

$ tail -3 ~/.claude-relay/logs/relay.out.log
[preflight] Telegram getMe: @wr_claude_20260427_bot (id=8596494289)
[relay] retrieval preflight complete
Bot is running!
```

---

# Files codex should read

Primary code under review (in order of size of change):
- `src/query-builder.ts` (topic-pivot detection + BOOK_NAME_ANCHORS pinning)
- `src/relay.ts` (system prompt, sanitization wiring, catalog short-circuit wiring)
- `src/response-sanitize.ts` (new module)
- `src/textbook-response.ts` (`buildCatalogResponse`)
- `src/retrieval.ts` (CATALOG_BOOK_LIST export)
- `src/trigger.ts` (regex extension)

Test files:
- `src/query-builder.test.ts`
- `src/relay-strip.test.ts` (new)
- `src/textbook-response.test.ts`
- `src/trigger.test.ts`

Reference docs:
- `tasks/lessons.md` (every lesson from this session is dated 2026-05-10)
- `~/.claude/projects/-Users-williamregan-Projects-claude-telegram-relay/memory/MEMORY.md`
- `~/ObsidianVault/02-Cross-Project/writing_style_for_william.md`
