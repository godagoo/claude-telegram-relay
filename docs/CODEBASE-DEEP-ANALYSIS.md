# Claude Telegram Relay — Complete Codebase Analysis

> Generated: 2026-05-16. Full English-language technical reference for LLM analysis.

---

## 1. Project Purpose

`claude-telegram-relay` is a personal AI assistant running locally on a Mac. It listens for Telegram messages from a single authorized user, builds a rich prompt with memory and retrieval context, invokes the `claude` CLI (Claude Code) as a subprocess, sanitizes the response, and sends it back via Telegram.

**The user** is William, an anesthesiology resident physician in Ontario, Canada. His primary use cases:

- **Study:** Query a local SQLite FTS index of six anesthesia textbooks (Barash, Chestnut, Cote, Fleisher, Miller, Stoelting) via natural language from Telegram.
- **Communication:** Draft iMessages to contacts. The relay fetches iMessage thread history before calling Claude, then places the finished draft directly into the Messages compose box via a shell script, iCloud Drive Shortcut handoff, or iPhone Mirror accessibility automation.
- **Memory capture:** Automatically detect and write important facts, corrections, and goals to the Obsidian vault in structured Markdown. Optionally also to Supabase with vector embeddings.
- **General assistant:** Any other query, with short-term conversation context from a per-chat ring buffer.

---

## 2. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun v1.x | Fast TypeScript, Worker threads, native SQLite |
| Language | TypeScript (ESM modules) | Type safety |
| Telegram | grammY v1.21 | Bot framework for Node/Bun |
| AI backend | `claude` CLI subprocess | Reuses active Claude Code session; avoids re-implementing auth |
| Primary DB | SQLite at `~/.local-search/metadata.db` | Local, zero network, fast FTS5 |
| Optional DB | Supabase (PostgreSQL + pgvector) | Durable memory + semantic search (feature-gated) |
| Memory store | Obsidian vault Markdown files | Human-readable, synced via Syncthing |
| Voice | Groq whisper-large-v3-turbo OR local whisper-cpp | Configurable |
| Daemon | macOS LaunchAgent | Auto-restart, environment injection |

---

## 3. Directory Structure

```
claude-telegram-relay/
├── src/                        # All TypeScript source modules
│   ├── relay.ts                # MAIN ENTRY POINT (~1950 lines)
│   ├── telegram-polling.ts     # 409 conflict classification + retry
│   ├── telegram-response.ts    # Message splitting, chunked send
│   ├── trigger.ts              # Referential intent classifier (10 regex patterns)
│   ├── memory.ts               # Supabase memory read/write
│   ├── memory-capture.ts       # Obsidian memory file writer (fire-and-forget)
│   ├── retrieval.ts            # FTS search against local indexer SQLite
│   ├── query-builder.ts        # Assembles FTS5 query from conversation tokens
│   ├── imessage-context.ts     # iMessage thread prefetch + draft intent parsing
│   ├── imessage-draft.ts       # Draft marker parsing, placement, boilerplate strip
│   ├── icloud-drive-draft.ts   # Write draft JSON to iCloud Drive for Shortcuts
│   ├── iphone-mirror-draft.ts  # Type draft via iPhone Mirror accessibility
│   ├── response-sanitize.ts    # 5-stage Claude output cleanup pipeline
│   ├── short-term.ts           # Per-chat ring buffer (10 turns, JSON file)
│   ├── project-anchors.ts      # Project-specific FTS injection by keyword
│   ├── transcribe.ts           # Voice transcription (Groq or local)
│   ├── books.ts                # Anesthesia textbook name constants + regex
│   ├── decision-log.ts         # Append-only JSONL observability journal
│   ├── fts-worker.ts           # Bun Worker thread for isolated SQLite FTS
│   ├── arch-check.ts           # macOS binary architecture checker (Rosetta)
│   └── supabase-config.ts      # Feature flags for Supabase subsystems
├── config/
│   ├── profile.md              # User identity and style preferences (injected into every prompt)
│   ├── profile.example.md      # Template for new users
│   └── project-anchors.json    # Keyword-to-project-path mapping for context injection
├── db/
│   └── schema.sql              # Supabase schema (messages, memory, logs + pgvector RPCs)
├── daemon/
│   ├── launchagent.plist       # macOS LaunchAgent template
│   └── claude-relay.service    # systemd unit (Linux reference)
├── docs/                       # Setup guides and implementation plans
├── scripts/                    # Shell scripts called as subprocesses
│   ├── imessage-thread.sh      # Read iMessage thread from chat.db (needs Full Disk Access)
│   ├── draft-imessage.sh       # Write to Messages compose box
│   └── draft-email.sh          # Write to Mail Drafts
├── setup/                      # Interactive setup scripts
├── .env                        # Runtime secrets (git-ignored)
└── package.json
```

---

## 4. End-to-End Message Flow (Text Message)

```
Telegram Bot API (long-polling, grammY)
        |
        v
bot.on("message:text")
        |
        v
Per-chat FIFO queue -- prevents races on rapid messages
        |
        v
STEP 1: DEDUPLICATION
  loadSeenUpdateIds() reads today's + yesterday's JSONL decision log
  plus any orphaned .started marker files for crash recovery.
  If the update ID is already seen: skip silently.
        |
        v
STEP 2: TRIGGER CLASSIFICATION
  isReferential(message) -- 10 regex patterns:
    - "search", "find", "look up", "retrieve", "from the index"
    - Book name mentions (Barash, Miller, Chestnut, etc.)
    - Memory verbs: "remember when", "what did I say about"
    - "the X" / "that X" entity references
    - Possessive person references: "my dad", "my mom"
    - Continuation cues: "what about", "and also"
    - Past-state questions: "was", "were", "did"
  Returns: boolean -- should FTS retrieval run?
        |
        v
STEP 3: FTS RETRIEVAL (only if referential=true)
  buildSearchQuery(message, recentTurns) -- query-builder.ts
    - Strips stopwords, extracts up to 5 content tokens
    - Pins book-name tokens first (textbook queries are common)
    - Detects topic pivots, recovers clinical anchors from prior turns
    - Returns: FTS5 quoted-token expression, e.g. '"propofol" "induction"'
  search(query, k=5) -- retrieval.ts
    - Checks: is this a broad catalog query? Return catalog list directly.
    - Runs FTS in a Bun Worker thread (isolated, 8s timeout)
    - Falls back to path-anchor SQL (LIKE + GLOB) for textbook names
    - Returns: top 3 hits, max 900 chars each, with path + score
        |
        v
STEP 4: IMESSAGE INTENT EXTRACTION
  extractIMessageDraftRequest(message) -- imessage-context.ts
  Detects draft verbs (draft, write, reply, respond, send, text, message)
  combined with message type nouns (message, text, reply, note).
  Extracts:
    - contactName: from self-reference ("mom", "dad"), relationship, or explicit name
    - wantsContext: does the user want the existing thread injected?
    - wantsPlacement: should the draft be auto-placed? (default true, opt-out detected)
    - directBody: inline body from "saying X" / "with X" / colon syntax
  Guards: past-draft-reference suppression, email-type suppression.
  Returns: null if not a draft request.
        |
        v
STEP 5: IMESSAGE THREAD PREFETCH (if draft intent detected + wantsContext)
  fetchIMessageContext(projectRoot, request) -- imessage-context.ts
  Spawns: scripts/imessage-thread.sh <contact> <limit>
  Timeout: 8 seconds
  Requires Full Disk Access for the bun binary (not Claude, not Terminal).
  Returns: { status, resolvedRecipient, messages[] }
  Status values: found | empty | fda_denied | error | timeout
        |
        v
STEP 6: PROJECT ANCHOR CONTEXT
  findAnchoredProjects(message) -- project-anchors.ts
  Tests anchor keywords from config/project-anchors.json:
    Currently configured: "Medicolegal-Case" project with anchors:
    lawyer, attorney, counsel, appeal, appellant, probation, supervisor,
    Saint Amman, Rob Roy, MIET, CaRMS, procedural fairness, Natalie, Madison,
    residency match, exhibit
  retrieveAnchoredContext(matches):
    Opens indexer DB directly (read-only PRAGMA), runs OR-quoted FTS scoped
    to the project's file paths. Returns top 4 chunks per project.
        |
        v
STEP 7: DETERMINISTIC SHORTCUT CHECK
  If message matches a known textbook retrieval pattern AND FTS returned hits:
  Skip Claude entirely. Send the formatted retrieval block directly to Telegram.
  This avoids the 90-second Claude timeout for simple lookup queries.
        |
        v
STEP 8: PROMPT ASSEMBLY -- buildPrompt()
  Sections injected into the prompt:
    1. System header: role, current date, timezone, user name
    2. Profile block: full contents of config/profile.md
    3. Memory context: Supabase facts + active goals (if MEMORY_AUTHORITY=supabase)
    4. Project anchor context: labeled FTS blocks per matched project
    5. Retrieval context: FTS hits from local indexer
    6. iMessage thread context: formatted conversation history from chat.db
    7. Recent conversation turns: last 6, rendered as USER:/ASSISTANT: blocks
    8. iMessage draft instructions: drafting rules, no-em-dash constraint, style guide
    9. User message
  Max prompt size: 120,000 characters. Truncated if exceeded.
        |
        v
STEP 9: CLAUDE CLI INVOCATION -- callClaude(prompt)
  Spawns: claude -p "<prompt>" in RELAY_CWD
  RELAY_CWD defaults to ~/Projects/claude-telegram-relay
  Environment: inherits relay process env, with CLAUDE_RESUME=0
  Timeout: CLAUDE_TIMEOUT_MS (default 90000ms = 90 seconds)
  On timeout: SIGTERM sent to process tree
  After KILL_GRACE_MS (10s): SIGKILL sent to process tree
  Process tree kill: not just top-level PID -- the entire group is terminated
  On success: stdout captured as raw Claude response
        |
        v
STEP 10: RESPONSE SANITIZATION -- sanitizeClaudeResponse()
  Five sequential stages, each tracks stripped-item counts:
  Stage 1: stripMemoryTags
    - Parses [REMEMBER: ...], [GOAL: ...], [DONE: ...] tags
    - Side effect: writes parsed facts/goals to Supabase (if enabled)
    - Removes the tags from the response text
  Stage 2: stripWrapperTags
    - Removes Claude Code XML wrapper artifacts:
      system-reminder, command-name, command-message, command-args,
      local-command-stdout, local-command-stderr, user-prompt-submit-hook,
      tool-use, tool-result, function_calls, function_results
  Stage 3: stripScaffoldingTags
    - Removes session scaffolding artifacts
  Stage 4: stripTurnMarkers
    - Removes conversation turn demarcation lines
  Stage 5: stripProseDashes
    - Em dash (U+2014) in " — " context: replaced with ", "
    - En dash (U+2013) in numeric ranges "1-2": replaced with " to "
    - Skips code spans and code blocks
    - Hard rule: no em dashes in output (especially critical for email/text drafts)
        |
        v
STEP 11: IMESSAGE DRAFT PLACEMENT (if draft intent detected)
  Extracts draft body from between markers:
    <<<IMESSAGE_DRAFT>>> ... <<<END_IMESSAGE_DRAFT>>>
  Strips 13 patterns of Claude placement-claim boilerplate:
    "Draft is in the Messages compose box"
    "review and send manually"
    "I can't send for you"
    "You'll need to send this through your Messages app"
    ... and 9 more variants
  Placement priority order:
    1. iPhone Mirror (if RELAY_IPHONE_MIRROR_PLACEMENT=1 env var set)
       Spawns scripts/iphone-mirror-draft.ts via bun, 45s timeout
       Uses macOS accessibility to type into Messages on a mirrored iPhone
    2. Mac Messages paste (scripts/draft-imessage.sh, 25s timeout)
       Reads body from stdin, uses AppleScript to paste into compose box
       Returns JSON: { mode: "pasted" | "new_compose" | "clipboard_only" }
    3. iCloud Drive Shortcut handoff (fallback)
       Writes JSON to ~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
       Atomic write (temp file + rename)
       Body contains: { recipient, recipient_label, body, ts, body_sha256 }
       Claude generates: shortcuts://run-shortcut?name=ClaudeDraft URL
       formatPhoneHandoffForTelegram() converts that URL to plain text
       (Telegram Bot API rejects custom URL schemes in inline keyboard buttons)
        |
        v
STEP 12: TELEGRAM REPLY -- sendTelegramResponse()
  prepareTelegramResponseText(): applies formatPhoneHandoffForTelegram
  splitTelegramResponseText(): splits at paragraph/line/word boundaries below 4000 chars
  Sends each chunk with link preview disabled
  Returns: partial-failure info if mid-sequence chunks fail
        |
        v
STEP 13: SHORT-TERM PERSISTENCE -- appendTurn()
  Writes USER + ASSISTANT turn to per-chat ring buffer
  Location: ~/.claude-relay/state/chats/<chatId>.json
  Max size: 10 turns (oldest evicted)
  Permissions: 0o700 directory, 0o600 file
        |
        v
STEP 14: MEMORY CAPTURE (fire-and-forget, async)
  classifyForMemory(message, response) -- memory-capture.ts
  Checks trigger patterns:
    FEEDBACK_TRIGGERS: "from now on", "going forward", "don't X again",
                       "lesson learned", "that was wrong"
    FACT_TRIGGERS: "remember that/this", "please remember",
                   "make a note", "save this"
    RETRIEVAL_FEEDBACK_TRIGGERS: "keep searching", "that's not it",
                                 "wrong file", "try X instead"
  Hard suppressions:
    SUPPRESS_RE: "don't remember this", "don't save this"
    REMEMBER_TODO_RE: "remember to" (task reminder, not a fact)
    DRAFT_REQUEST_RE: iMessage drafting context
  Project inference (in priority order):
    1. Anchored project keywords from config/project-anchors.json
    2. Relay self-reference ("relay", "telegram", "bot")
    3. Feedback default (relay project)
    4. Token scan of available project directories
    5. Fallback project
  writeMemoryCandidate():
    Atomic write using hard-link trick (link before rename -- fails on existing target)
    Deduplicates by kind+slug
    Falls back to ~/ObsidianVault/00-Inbox/_pending-memories if project dir missing
    Never overwrites existing memories
  renderMemoryFile():
    YAML frontmatter: name, description, type, severity, first_seen, last_updated
    Markdown body: rule/fact + Why: line + How to apply: line + evidence quote
        |
        v
STEP 15: DECISION LOG -- logDecision()
  Appends JSONL record to ~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl
  Fields: updateId, chatId, timestamp, message preview, trigger flags,
          sanitization counts, placement mode, bodyHash, error if any
  Also writes: ~/.claude-relay/state/updates/<updateId>.started (status marker)
  Update marker is crash recovery signal -- if relay restarts mid-response,
  the .started file prevents duplicate processing on the next poll.
```

---

## 5. Source File Breakdown

### 5.1 relay.ts — Main Orchestrator

**Size:** ~1950 lines  
**Role:** Everything. Entry point, configuration, startup preflight, all message handlers, the Claude subprocess caller, prompt builder, and session management.

**Key constants:**
```
BOT_TOKEN              -- from TELEGRAM_BOT_TOKEN env var
ALLOWED_USER_ID        -- from TELEGRAM_USER_ID env var (single authorized user)
CLAUDE_PATH            -- path to claude CLI binary
RELAY_CWD              -- working dir for claude subprocess (defaults to relay project root)
CLAUDE_TIMEOUT_MS      -- 90000 (90 seconds)
KILL_GRACE_MS          -- 10000 (10 seconds between SIGTERM and SIGKILL)
MAX_PROMPT_CHARS       -- 120000
MAX_RECENT_TURNS_RENDERED -- 6
```

**Session management:**
- Session ID stored in `~/.claude-relay/session.json`
- Session is reset when Claude emits a wrapper tag (signals a new conversation context)
- CLAUDE_RESUME=0 env var prevents the claude CLI from resuming an existing session

**Lock file:**
- `~/.claude-relay/bot.lock` with the relay's PID
- Prevents duplicate instances
- Checked on startup; stale locks are cleaned up

**Supabase gating:**
- Feature-gated on presence of SUPABASE_URL + SUPABASE_ANON_KEY env vars
- Further controlled per-feature by supabase-config.ts
- If Supabase is unconfigured, all memory operations go to Obsidian vault only

**callClaude(prompt):**
```
spawn: claude -p <prompt>
cwd: RELAY_CWD
env: inherited + CLAUDE_RESUME=0
timeout: CLAUDE_TIMEOUT_MS
on timeout: kill entire process tree with SIGTERM, then SIGKILL after grace
on success: return trimmed stdout
on error: throw with stderr context (sanitized before logging)
```

**buildPrompt(message, context):**
Assembles the full system prompt. Order of sections:
1. Role definition (you are a personal AI assistant for William...)
2. Current date and timezone
3. Profile markdown (config/profile.md)
4. Durable memory (Supabase facts/goals if enabled)
5. Project anchor context (if project keywords found)
6. Retrieval context (FTS hits)
7. iMessage thread context (if fetched)
8. Recent conversation turns (up to MAX_RECENT_TURNS_RENDERED)
9. iMessage draft instructions (hard no-em-dash rule, tone guide, placement explanation)
10. User message

**Message handlers:**
- `bot.on("message:text")` -- main handler
- `bot.on("message:voice")` -- transcribes via Groq/whisper, then routes as text
- `bot.on("message:photo")` -- not yet implemented (placeholder)
- `bot.on("message:document")` -- not yet implemented (placeholder)

All handlers: only respond to ALLOWED_USER_ID. All route through the per-chat FIFO queue.

**Startup preflight sequence:**
1. Read profile.md
2. Create state directories (~/.claude-relay, subdirs)
3. Load seen update IDs (crash recovery)
4. Check lock file; write new lock
5. Verify SQLite retrieval DB (read-only invariant probe)
6. Log arch check (bun + claude binary architectures)
7. Verify Telegram bot credentials (getMe API call)
8. Start polling with 409 conflict retry loop

---

### 5.2 telegram-polling.ts — 409 Conflict Handler

**Purpose:** When Telegram returns HTTP 409 on getUpdates (another bot instance is running), classify the conflict type and provide actionable diagnostics.

**Conflict types:**
- `competing_poller`: Another process is polling the same bot token
- `webhook_active`: A webhook is registered; getUpdates conflicts with it
- `unknown_getupdates_409`: Unclassified 409

**Retry behavior:**
- Base delay: 1000ms between retries
- Escalation at attempt 10: log detailed diagnostic with human-readable hint
- Re-escalation every 60 attempts after that
- Hints include: how to find the competing process, how to delete the webhook

---

### 5.3 telegram-response.ts — Reply Formatter

**prepareTelegramResponseText(text):**
- Applies formatPhoneHandoffForTelegram: converts `shortcuts://run-shortcut?name=ClaudeDraft` to the plain-text equivalent "Run ClaudeDraft in Shortcuts on your iPhone."
- Reason: Telegram Bot API rejects non-HTTP(S) URL schemes in keyboard button URLs and will return 400 Bad Request.

**splitTelegramResponseText(text):**
- Splits long responses at paragraph boundaries, then line boundaries, then word boundaries
- Target: each chunk under 4000 characters (Telegram's sendMessage limit)

**sendTelegramResponse(bot, chatId, text):**
- Sends chunks sequentially
- link_preview_options: disabled (prevents noisy URL previews)
- Returns partial-failure info if a mid-sequence chunk fails (so the decision log can record it)

---

### 5.4 trigger.ts — Referential Classifier

**Purpose:** Determine whether the user's message is asking to retrieve information from the local index, justifying an FTS search.

**Ten regex patterns tested:**
1. Explicit retrieval commands: "search", "find", "look up", "retrieve", "from the index", "in the database"
2. Book names: Barash, Miller, Chestnut, Stoelting, Cote, Fleisher, Morgan, textbook
3. Memory verbs: "remember when", "what did I say about", "remind me"
4. Entity reference: "the X" or "that X" (referring to a named thing)
5. Possessive person: "my dad", "my mom", "my professor"
6. Continuation: "what about", "and also", "also tell me"
7. Past-state: "was", "were", "did" (asking about historical state)
8. Clinical lookups: "dose of", "mechanism of", "side effects of"
9. Explicit memory: "did I mention", "have I told you"
10. Comparative: "compared to", "difference between", "versus"

Returns true if any pattern matches. False triggers mean the FTS step is skipped entirely (saves DB round-trip for conversational messages).

---

### 5.5 memory.ts — Supabase Memory Layer

**Purpose:** Read and write structured memory to Supabase when MEMORY_AUTHORITY=supabase.

**processMemoryIntents(supabase, response):**
- Parses three tag types from Claude's response:
  - `[REMEMBER: <fact>]` -- stores to `memory` table as type `fact`
  - `[GOAL: <goal>]` -- stores to `memory` table as type `goal`
  - `[DONE: <goal slug>]` -- marks matching goal as type `completed_goal`
- Embedding generation: calls Supabase Edge Function `embed` to get vector (1536 dims, OpenAI ada-002)
- Returns: cleaned response (tags removed) + count of operations performed

**getMemoryContext(supabase):**
- Calls Supabase RPC `get_facts()`: most recent 10 facts ordered by created_at desc
- Calls Supabase RPC `get_active_goals()`: all non-completed goals
- Formats as a prompt block:
  ```
  ## Facts I Know About You
  - <fact 1>
  ...
  ## Your Current Goals
  - <goal 1> [deadline: <date>]
  ```

**getRelevantContext(supabase, query):**
- Calls Supabase Edge Function `search` with the query string
- Edge Function generates an embedding and runs pgvector cosine similarity search
- Returns top 5 semantically similar past messages
- Used to inject conversation history relevant to the current query

---

### 5.6 memory-capture.ts — Obsidian Memory Writer

**Purpose:** After each relay turn, classify whether the exchange contains a memorable fact, user correction, or retrieval feedback. If so, write a structured Markdown file to the Obsidian vault. This runs fire-and-forget (does not block the Telegram reply).

**Classification triggers:**

FEEDBACK_TRIGGERS (user correcting relay behavior):
- "from now on", "going forward"
- "don't X again", "stop doing X"
- "lesson learned", "that was wrong"
- "next time", "in the future do"

FACT_TRIGGERS (user stating a fact to remember):
- "remember that", "remember this"
- "please remember", "make a note"
- "save this", "note that", "keep in mind"

RETRIEVAL_FEEDBACK_TRIGGERS (user correcting search behavior):
- "keep searching", "that's not it"
- "wrong file", "try X instead"
- "search for X not Y"

**Hard suppressions:**
- SUPPRESS_RE: "don't remember this", "don't save this" -- explicit opt-out
- REMEMBER_TODO_RE: "remember to do X" -- task reminder, not a memory
- DRAFT_REQUEST_RE: iMessage drafting context -- not a memory moment

**Project inference (priority order):**
1. Match anchor keywords from config/project-anchors.json
2. "relay", "telegram", "bot" -- classify to relay project
3. Default feedback to relay project
4. Scan available project directories for token matches
5. Fallback project (configured in env)

**writeMemoryCandidate():**
- Target path: `~/ObsidianVault/01-Projects/<project>/memory/<kind>_<slug>.md`
- Atomic write: create temp file, link to target (fails if target exists = deduplication), rename temp to target
- If project directory does not exist: writes to `~/ObsidianVault/00-Inbox/_pending-memories/`
- Never overwrites existing memories

**renderMemoryFile():**
```yaml
---
name: <slug>
description: <one-line summary>
metadata:
  type: feedback | user | project | reference
  severity: low | medium | high | critical
  first_seen: YYYY-MM-DD
  last_updated: YYYY-MM-DD
  trigger: <which trigger pattern matched>
---

<rule/fact statement>

**Why:** <reason from evidence>
**How to apply:** <when this guidance is relevant>

Evidence:
> User: "<message excerpt>"
> Assistant: "<response excerpt>"
```

---

### 5.7 retrieval.ts — Local FTS Search

**Purpose:** Search the local SQLite FTS5 index (`~/.local-search/metadata.db`) built by the separate `claude-indexer` project. Returns the most relevant text chunks for a query.

**Database opened with:**
- `PRAGMA journal_mode = WAL` (concurrent readers)
- `PRAGMA query_only = ON` (read-only enforcement at SQLite level)
- `PRAGMA busy_timeout = 2000`
- Invariant probe on startup: begin SAVEPOINT, verify query_only, rollback

**Scope patterns (which directories are searched):**
- `~/ObsidianVault/` -- all personal vault notes
- `~/.claude/projects/` -- Claude project memory files
- `~/.claude/` -- Claude global memory
- `~/Desktop/Exam_Prep/Textbooks/` -- anesthesia textbook PDFs (chunked)

**search(query, k):**
1. Sanitize query (strip SQL injection characters, normalize whitespace)
2. Check: is this a broad catalog inventory query? ("list all books", "what textbooks do you have") -- return pre-built catalog string directly
3. Run FTS in Worker thread with 8s timeout (isolation: if FTS hangs, main thread is unaffected)
4. If FTS returns 0 hits: attempt path-anchor SQL fallback (for textbook name queries)
5. Combine and rank results

**runFtsInWorker(sql, params):**
- Creates a new Bun Worker (`src/fts-worker.ts`) per query
- Posts: `{ sql, params }`
- Worker responds: `{ rows, ms }` or `{ error }`
- Worker terminated after response (no reuse -- prevents state leakage)
- Timeout: if Worker does not respond in 8s, terminate it and throw

**buildPathAnchorSql(tokens):**
- For textbook name queries (e.g. "Miller"), builds:
  `(f.path LIKE '/Users/williamregan/Desktop/Exam_Prep/Textbooks/Miller%' AND (f.path GLOB '*/Miller*' OR ...))`
- The LIKE prefix is non-leading-wildcard so SQLite can use the path B-tree index
- The GLOB provides filename specificity

**renderContext(hits):**
- Top 3 hits, max 900 chars each
- Format:
  ```
  [1] path/to/file.md (chunk 4, rank 3, score 0.87)
  <chunk text truncated to 900 chars>
  ```

---

### 5.8 query-builder.ts — FTS Query Assembler

**Purpose:** Convert a natural-language Telegram message into a precise FTS5 query expression.

**buildSearchQuery(currentMessage, recentTurns):**
1. Normalize: lowercase, strip punctuation
2. Remove stopwords (extensive list including clinical filler: "what", "does", "the", "and", "about", "tell", "me", "please", "can", "you", "explain")
3. Remove source-control stopwords ("git", "branch", "commit", "diff" -- not relevant to textbook search)
4. Pin book-name tokens first (they are the strongest anchor for textbook retrieval)
5. Detect topic pivot: if current message shares fewer than 2 tokens with the previous turn's query, it's a new topic -- don't carry forward prior context
6. If not a topic pivot, supplement with tokens from the most recent prior turn
7. Recover clinical anchor: if a book name was mentioned in recent turns but not the current message, prepend it
8. Take up to 5 total tokens
9. Return FTS5 implicit-AND expression: `'"propofol" "induction" "TIVA"'`
10. Return empty string if fewer than 2 tokens (avoids overly broad searches)

---

### 5.9 imessage-context.ts — Thread Prefetch and Draft Intent Parsing

**Purpose:** Two responsibilities -- (1) detect whether the user wants to draft an iMessage, and (2) fetch the existing conversation thread from chat.db as context.

**extractIMessageDraftRequest(message):**

Detection: message must contain a draft verb AND a message type noun.

Draft verbs: draft, write, reply, respond, send, text, message, compose, prepare, create

Message type nouns: message, text, reply, note, response

Contact extraction (in priority order):
1. Self-reference map: "mom" -> "Mom", "dad" -> "Dad", "my wife" -> spouse name from profile
2. Relationship nouns: brother, sister, friend, colleague, boss, patient
3. Command-position heuristic: first capitalized word after "to" or "for"
4. Explicit name: any capitalized proper noun in the message

wantsContext detection (does user want thread history?):
- Positive: "reply to", "respond to", "following up", "continue our conversation"
- Negative: "new message", "fresh message", "not a reply"

wantsPlacement detection (should relay auto-place the draft?):
- Opt-out phrases: "just give me the text", "just the draft", "don't place", "don't send"
- Default: true (placement attempted unless opted out)

directBody extraction:
- "saying <body>", "with <body>", "message: <body>"
- If directBody found, skip Claude for the draft body (use directly)

Guards:
- Past-draft-reference suppression: "the draft I sent earlier" -- not a new request
- Email-type suppression: "email", "gmail" -- handled by separate pipeline
- Multi-relationship suppression: if message mentions 3+ different people, skip (ambiguous)

**fetchIMessageContext(projectRoot, request):**
- Spawns: `<projectRoot>/scripts/imessage-thread.sh <contactName> <limit>`
- Limit: 10 messages by default, 20 if wantsContext is explicit
- Timeout: 8 seconds
- Requires Full Disk Access for the bun binary (not Claude, not Terminal)
  Reason: chat.db is at ~/Library/Messages/chat.db, protected by TCC
  Process tree: launchd -> bun -> bash -> imessage-thread.sh -> sqlite3
  Only bun needs FDA; granting it to Terminal or Claude does not help
- Parses JSON output: `{ resolved: boolean, messages: [{sender, body, date}] }`
- Returns: `{ status, resolvedRecipient, messages }`

Status values:
- `found`: messages retrieved, resolvedRecipient is the phone/email
- `empty`: contact found but no messages
- `fda_denied`: TCC error (operation not permitted on chat.db)
- `error`: script failed
- `timeout`: 8s elapsed

**renderIMessageContext(result):**
Formats the result into a clear natural-language block:
```
## iMessage Thread with <contact> (<resolvedRecipient>)
Most recent 10 messages:

[<date>] <sender>: <body>
[<date>] You: <body>
...

Draft a reply that responds to the most recent message above.
```
If status is fda_denied, explains why and tells Claude to proceed without context.

---

### 5.10 imessage-draft.ts — Draft Placement Core

**Purpose:** Extract the draft from Claude's response, strip boilerplate claims, and manage the placement pipeline.

**Marker constants:**
```
DRAFT_MARKER_OPEN  = "<<<IMESSAGE_DRAFT>>>"
DRAFT_MARKER_CLOSE = "<<<END_IMESSAGE_DRAFT>>>"
```

Claude is instructed to wrap the draft body in these markers. Everything outside them is Claude's commentary.

**stripPlacementClaims(text):**
Applies 13 regex patterns to remove lines where Claude explains its limitations:
1. "Draft is in the Messages compose box"
2. "review and send manually"
3. "I can't send for you"
4. "You'll need to send this through your Messages app"
5. "I've placed the draft"
6. "draft has been placed"
7. "compose box is ready"
8. "I cannot actually send"
9. "The draft is ready"
10. "copy and paste this"
11. "open Messages and"
12. "I don't have access to Messages"
13. "This is the draft text"

Safety: if stripping would empty the response, returns original and logs error.

**rebuildAroundDraftBlock(response, replacement):**
- Keeps Claude's optional lead sentence (with placement claims scrubbed)
- Discards everything after the closing marker
- Appends the relay's real status line (e.g. "Draft placed in Messages compose box.")

**placeIMessageDraft(projectRoot, recipient, body):**
- Spawns: `<projectRoot>/scripts/draft-imessage.sh <recipient>`
- Body piped to stdin
- Timeout: 25 seconds
- Parses JSON envelope from stdout: `{ mode: "pasted" | "new_compose" | "clipboard_only" }`
- Modes:
  - `pasted`: Draft pasted into existing compose box (recipient already open)
  - `new_compose`: New Messages conversation opened and compose box pre-filled
  - `clipboard_only`: Messages not accessible; draft copied to clipboard as fallback

---

### 5.11 icloud-drive-draft.ts — iCloud Shortcut Handoff

**Purpose:** When Mac Messages placement fails or iPhone placement is preferred, write the draft as a JSON file to iCloud Drive. A Shortcuts automation on the iPhone picks it up via the ClaudeDraft shortcut.

**writeICloudDriveDraft(recipient, recipientLabel, body):**
- Target: `~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json`
- Validates target is inside iCloud Drive root (security check, prevents path traversal)
- Atomic write: write to `.latest.json.tmp`, then rename to `latest.json`
- JSON payload:
  ```json
  {
    "recipient": "+15196394490",
    "recipient_label": "Mark",
    "body": "draft text here",
    "ts": "2026-05-16T19:00:00.000Z",
    "body_sha256": "abc123..."
  }
  ```
- Returns: `{ path, shortcutUrl, bodySha256 }`

**shortcutUrl:**
`shortcuts://run-shortcut?name=ClaudeDraft`
Note: this URL scheme is NOT sent as a Telegram keyboard button (Bot API rejects it).
formatPhoneHandoffForTelegram() converts it to plain text: "Run ClaudeDraft in Shortcuts on your iPhone."

---

### 5.12 iphone-mirror-draft.ts — iPhone Mirror Placement

**Purpose:** If the user has iPhone Mirror running (macOS Sequoia+ feature that shows iPhone screen on Mac), use macOS Accessibility to type the draft body directly into the Messages compose box on the mirrored iPhone.

**shouldUseIPhoneMirrorPlacement():**
- Returns true if `RELAY_IPHONE_MIRROR_PLACEMENT=1` env var is set
- Not enabled by default (requires the user to be at their Mac with iPhone Mirror open)

**placeIPhoneMirrorDraft(recipient, body):**
- Spawns: `bun run scripts/iphone-mirror-draft.ts`
- Body piped to stdin
- Timeout: 45 seconds (longer than Mac Messages -- accessibility automation is slower)
- Startup logs can be noisy; parses JSON from the last line of stdout only
- Returns: `{ ok, mode: "typed", verified?, error? }`

---

### 5.13 response-sanitize.ts — Five-Stage Response Pipeline

**Purpose:** Clean Claude's raw output before sending to Telegram. Removes artifacts from Claude Code's XML wrapper system, memory tags, conversation scaffolding, and em dashes.

**Stage 1: stripMemoryTags**
- Removes: `[REMEMBER: ...]`, `[GOAL: ...]`, `[DONE: ...]`
- Note: Supabase write side effects happen in memory.ts (before sanitization). Sanitization just removes the tags from displayed text.

**Stage 2: stripWrapperTags**
Claude Code wraps its output in XML tags when running as a subprocess. These must be stripped:
- `<system-reminder>...</system-reminder>`
- `<command-name>...</command-name>`
- `<command-message>...</command-message>`
- `<command-args>...</command-args>`
- `<local-command-stdout>...</local-command-stdout>`
- `<local-command-stderr>...</local-command-stderr>`
- `<user-prompt-submit-hook>...</user-prompt-submit-hook>`
- `<tool-use>...</tool-use>`
- `<tool-result>...</tool-result>`
- `<function_calls>...</function_calls>`
- `<function_results>...</function_results>`

**Stage 3: stripScaffoldingTags**
Removes session scaffolding artifacts that Claude Code emits when running in interactive mode.

**Stage 4: stripTurnMarkers**
Removes conversation turn demarcation markers (e.g., "---TURN 1---" style lines).

**Stage 5: stripProseDashes**
- Em dash (U+2014) in prose context ` — `: replaced with `, `
- En dash (U+2013) in numeric range context `1–2`: replaced with `1 to 2`
- Skips: code spans (backtick-enclosed), code blocks (triple-backtick-enclosed)
- This is a hard requirement because em dashes look unnatural in iMessage drafts and email

Each stage returns `{ clean, stripped }` count. Final `sanitizeClaudeResponse` returns aggregated counts for the decision log so you can see how noisy each Claude invocation was.

---

### 5.14 short-term.ts — Ring Buffer Persistence

**Purpose:** Maintain a rolling window of recent conversation turns per chat, persisted to disk so they survive relay restarts.

**Storage:**
- Directory: `~/.claude-relay/state/chats/`
- File per chat: `<chatId>.json`
- Permissions: directory 0o700, file 0o600

**Format:**
```json
[
  { "role": "user", "content": "What is the MAC of desflurane?", "ts": 1715000000 },
  { "role": "assistant", "content": "The MAC of desflurane is 6% at sea level...", "ts": 1715000001 }
]
```

**loadTurns(chatId):** Reads file, parses JSON, returns array (empty if file missing).
**appendTurn(chatId, userMsg, assistantMsg):** Loads, appends both turns, trims to last 10, writes back.
**renderRecentTurns(turns):** Emits XML format (legacy path; relay.ts uses its own plain-text renderer for the 6-turn window).

---

### 5.15 project-anchors.ts — Project Context Injection

**Purpose:** When a user message contains keywords tied to a specific long-running project, automatically inject relevant context from that project's files.

**config/project-anchors.json format:**
```json
{
  "Medicolegal-Case": {
    "paths": [
      "~/ObsidianVault/01-Projects/Medicolegal-Case/",
      "~/Desktop/Appeal_Case/"
    ],
    "anchors": [
      "lawyer", "attorney", "counsel",
      "appeal", "appellant",
      "probation", "supervisor",
      "Saint Amman", "Rob Roy",
      "MIET", "CaRMS",
      "procedural fairness",
      "Natalie", "Madison",
      "residency match", "exhibit"
    ]
  }
}
```

**findAnchoredProjects(text):**
- Tests each project's anchor keywords as word-boundary case-insensitive regexes
- Returns: array of `{ projectName, paths }` for matched projects

**retrieveAnchoredContext(matches):**
- Opens indexer DB directly (read-only via PRAGMA, no Worker thread for this path)
- For each matched project, runs OR-quoted FTS scoped to project paths via `f.path LIKE ?`
- Returns top 4 chunks per project

**renderAnchoredContext(results):**
```
## Context: Medicolegal-Case
[1] ObsidianVault/01-Projects/Medicolegal-Case/timeline.md (chunk 2)
<chunk text>

[2] ...
```

---

### 5.16 transcribe.ts — Voice Transcription

**Purpose:** Convert Telegram voice messages (OGG Opus format) to text before processing.

**Routes on VOICE_PROVIDER env var:**

`groq` (default when GROQ_API_KEY set):
- Uses groq-sdk with model `whisper-large-v3-turbo`
- Wraps the OGG buffer as a `File` object (Groq API expects File interface)
- Returns: transcribed text string

`local` (whisper-cpp):
- Writes OGG to temp file
- Converts to 16kHz mono WAV using ffmpeg: `ffmpeg -i input.ogg -ar 16000 -ac 1 output.wav`
- Runs whisper-cpp binary with the WAV file
- Reads `.txt` output file whisper-cpp creates alongside the WAV
- Cleans up all temp files on success and failure
- Returns: transcribed text string

After transcription: message is processed identically to a text message.

---

### 5.17 books.ts — Anesthesia Textbook Catalog

**Purpose:** Central registry of the six anesthesia textbooks in the local FTS index.

**Textbooks registered:**
1. Barash Clinical Anesthesia, 9th edition
2. Chestnut's Obstetric Anesthesia, 6th edition
3. Cote's Pediatric Anesthesia, 6th edition
4. Fleisher's Uncommon Diseases, 6th edition
5. Miller's Anesthesia, 10th edition
6. Stoelting's Pharmacology and Physiology, 8th edition

**Exports:**
- `BOOKS`: array of `{ key, displayName, pathFragment }` objects
- `BOOK_KEYS`: string array of shorthand keys (e.g., "barash", "miller")
- `BOOK_KEY_SET`: Set for O(1) membership testing
- `CATALOG_BOOK_LIST`: pre-formatted string listing all books with full names
- `BOOK_TRIGGER_PATTERN`: regex alternation string for use in trigger.ts

---

### 5.18 decision-log.ts — Observability Journal

**Purpose:** Every processed Telegram update gets a JSONL record written to disk. This is the primary observability mechanism for debugging relay behavior.

**Log location:** `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl`
**File rotation:** New file per calendar day.
**Permissions:** 0o600

**JSONL record fields:**
```json
{
  "updateId": 12345,
  "chatId": 8782062645,
  "ts": "2026-05-16T19:00:00.000Z",
  "messagePreview": "What does Miller say about prop...",
  "referential": true,
  "draftIntent": false,
  "retrievalHits": 3,
  "sanitization": { "memoryTags": 0, "wrapperTags": 2, "proseDashes": 1 },
  "placementMode": null,
  "bodyHash": null,
  "error": null
}
```

**Update markers:**
- Path: `~/.claude-relay/state/updates/<updateId>.started`
- Written at start of processing, deleted on completion
- On relay startup, `loadSeenUpdateIds()` scans today's + yesterday's JSONL
  plus any orphaned `.started` files (crash recovery)
- This prevents duplicate processing if the relay crashes mid-turn and restarts

---

### 5.19 fts-worker.ts — SQLite FTS Worker Thread

**Purpose:** Run FTS queries in an isolated Bun Worker thread so a hung or slow query cannot block the main relay event loop.

**Pattern:** One Worker created per query, destroyed after response. No reuse.

**Worker receives:**
```json
{ "sql": "SELECT ...", "params": ["token1", "token2"] }
```

**Worker responds:**
```json
{ "rows": [...], "ms": 42 }
```
or on error:
```json
{ "error": "SQLITE_ERROR: ..." }
```

**Worker opens DB with:**
- `readwrite` mode (required by Bun's SQLite API even for read-only intent)
- `PRAGMA query_only = ON` (enforced read-only at SQLite level after open)
- `PRAGMA busy_timeout = 2000`

The Worker executes the query synchronously (blocking within its own thread) and posts the result. The main thread uses an 8-second wall-clock timeout; if no response arrives, the Worker is terminated.

---

### 5.20 arch-check.ts — Binary Architecture Checker

**Purpose:** On macOS with Apple Silicon, verify that both the bun runtime and the claude CLI are running as native arm64 binaries (not under Rosetta x86_64 emulation). Rosetta causes compatibility issues with some SQLite FTS operations and increases latency.

**getBinaryArch(binaryPath):**
- Runs `/usr/bin/file <binaryPath>` (absolute path -- launchd has a narrow PATH)
- Parses output for: `arm64`, `x86_64`, `universal binary`
- Returns: `"arm64" | "x86_64" | "universal" | "unknown"`

**isRosettaProcess():**
- Runs `/usr/sbin/sysctl -n sysctl.proc_translated` (absolute path required)
- Returns: `true` if current bun process is running under Rosetta
- Returns: `false` if native arm64 or on Intel Mac

**checkRelayBinaries(claudePath):**
- Checks bun: `process.execPath` (current bun binary)
- Checks claude: `claudePath` from env
- Returns: `ArchReport { bun, claude, rosetta }`

**archLabel(arch, rosetta):**
- Returns human-readable string: "arm64 (native)" or "x86_64 (Rosetta)" with checkmarks/warnings

Arch check is logged during startup preflight. The relay never hard-fails on arch mismatch -- it warns and continues. This is purely diagnostic.

---

### 5.21 supabase-config.ts — Feature Flag Gate

**Purpose:** Supabase has three independent subsystems. This module lets you enable/disable each without removing credentials.

**getSupabaseFeatureConfig(env):**

Reads:
- `MEMORY_AUTHORITY`: `"obsidian"` (default) or `"supabase"`
  Controls whether durable memory (facts/goals) uses Supabase or Obsidian vault only
- `SUPABASE_MESSAGE_HISTORY`: `"0"` or `"1"`
  Controls whether conversation turns are persisted to Supabase `messages` table
- `SUPABASE_RELEVANT_CONTEXT`: `"0"` or `"1"`
  Controls whether semantic search (pgvector) is run for each query

Returns:
```typescript
{
  durableMemory: boolean,       // only true when MEMORY_AUTHORITY=supabase
  messageHistory: boolean,      // SUPABASE_MESSAGE_HISTORY=1
  relevantContext: boolean      // SUPABASE_RELEVANT_CONTEXT=1
}
```

Current default configuration: all Supabase features disabled. Memory goes to Obsidian vault only. This is the recommended starting state for this user.

---

## 6. Database Schemas

### 6.1 Local SQLite (indexer)

Location: `~/.local-search/metadata.db`
Owned by: the `claude-indexer` project (separate repo)

Tables used by relay (read-only):
```sql
-- File metadata
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mtime INTEGER,
  size INTEGER,
  extraction_status TEXT,  -- pending | done | failed | blocked
  indexed_at INTEGER
);

-- Text chunks with FTS
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  chunk_index INTEGER,
  content TEXT
);

-- FTS5 virtual table (external content, linked to chunks)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);
```

Relay queries join `chunks_fts` with `chunks` and `files` to get paths alongside matched text.

### 6.2 Supabase PostgreSQL

Location: Supabase cloud project (URL from SUPABASE_URL env var)
Extension required: `pgvector`

```sql
-- Conversation history
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL,           -- "user" or "assistant"
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  metadata JSONB,
  embedding VECTOR(1536)        -- OpenAI ada-002 embeddings
);

-- Structured memory
CREATE TABLE memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL,           -- fact | goal | completed_goal | preference
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  priority INTEGER DEFAULT 5,
  embedding VECTOR(1536)
);

-- Observability logs
CREATE TABLE logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  payload JSONB
);

-- Row-level security enabled on all tables
-- All tables scoped to authenticated user

-- Helper RPCs
CREATE FUNCTION get_recent_messages(limit_count INTEGER)
  RETURNS SETOF messages;

CREATE FUNCTION get_active_goals()
  RETURNS SETOF memory;  -- WHERE type = 'goal'

CREATE FUNCTION get_facts()
  RETURNS SETOF memory;  -- WHERE type = 'fact' ORDER BY created_at DESC LIMIT 10

-- Semantic search RPCs (pgvector cosine similarity)
CREATE FUNCTION match_messages(query_embedding VECTOR(1536), match_count INTEGER)
  RETURNS TABLE(id UUID, content TEXT, similarity FLOAT);

CREATE FUNCTION match_memory(query_embedding VECTOR(1536), match_count INTEGER)
  RETURNS TABLE(id UUID, type TEXT, content TEXT, similarity FLOAT);
```

---

## 7. Configuration Files

### config/profile.md

Injected into every Claude prompt. Contains:
- Name: William
- Timezone: America/Toronto (Eastern Time)
- Occupation: Anesthesiology resident; also builds AI automation tools
- Location: Kitchener/London, Ontario, Canada
- Goals: streamline communications, study for boards, maintain AI assistant
- Constraints: frequently busy with clinical work; family messages should be warm
- Communication style: direct, warm, conversational, never stiff
- Hard formatting rules: no em dashes in drafts, no salutations/sign-offs in texts

### config/project-anchors.json

Maps project names to keyword anchors and file paths. Currently configured:

Project: `Medicolegal-Case`
Paths:
- `~/ObsidianVault/01-Projects/Medicolegal-Case/`
- `~/Desktop/Appeal_Case/`

Anchors (word-boundary case-insensitive regex match):
- lawyer, attorney, counsel
- appeal, appellant
- probation, supervisor
- Saint Amman, Rob Roy
- MIET, CaRMS
- procedural fairness
- Natalie, Madison
- residency match, exhibit

---

## 8. Shell Scripts Referenced

These are called as subprocesses by the relay. They live in the `scripts/` directory.

### scripts/imessage-thread.sh

**Purpose:** Read the iMessage thread with a named contact from `~/Library/Messages/chat.db`.
**Args:** `<contact_name> <message_limit>`
**Requires:** Full Disk Access granted to the bun binary (not Terminal, not Claude)
**Output:** JSON: `{ resolved: boolean, messages: [{sender, body, date}] }`
**Timeout enforced by caller:** 8 seconds

Why FDA is granted to bun specifically: The process tree is `launchd -> bun -> bash -> imessage-thread.sh -> sqlite3`. TCC (Transparency, Consent, and Control) checks the launching application, which is bun. FDA must be granted to the real bun binary at its Cellar path, found via `readlink -f "$(which bun)"`, NOT to the symlink at `/usr/local/bin/bun`.

### scripts/draft-imessage.sh

**Purpose:** Write a draft to the Messages app compose box using AppleScript.
**Args:** `<recipient_phone_or_email>`
**Stdin:** Draft body text
**Output:** JSON: `{ mode: "pasted" | "new_compose" | "clipboard_only" }`
**Timeout enforced by caller:** 25 seconds

### scripts/iphone-mirror-draft.ts

**Purpose:** Use macOS Accessibility API to type the draft into Messages on a mirrored iPhone.
**Runtime:** bun
**Stdin:** Draft body text
**Output:** JSON on last line of stdout: `{ ok, mode: "typed", verified?, error? }`
**Timeout enforced by caller:** 45 seconds

### scripts/draft-email.sh

**Purpose:** Write a draft to Mail.app Drafts folder.
**Used by:** Phase A.5 email drafting (separate flow, not the iMessage pipeline)

---

## 9. Runtime State Files

All runtime state lives under `~/.claude-relay/`:

```
~/.claude-relay/
├── bot.lock                           # PID of running relay (singleton)
├── session.json                       # Current Claude session ID
├── state/
│   ├── chats/
│   │   └── <chatId>.json              # Per-chat ring buffer (10 turns)
│   └── updates/
│       └── <updateId>.started         # Crash-recovery marker (deleted on completion)
└── logs/
    └── decisions-YYYY-MM-DD.jsonl     # Append-only decision log (rotates daily)
```

---

## 10. Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| TELEGRAM_BOT_TOKEN | Yes | -- | Bot API token from @BotFather |
| TELEGRAM_USER_ID | Yes | -- | Authorized user's Telegram user ID |
| CLAUDE_PATH | No | auto-detected | Path to claude CLI binary |
| RELAY_CWD | No | project root | Working directory for claude subprocess |
| CLAUDE_TIMEOUT_MS | No | 90000 | ms before SIGTERM sent to claude |
| CLAUDE_RESUME | No | 0 | Set to 1 to resume Claude sessions |
| SUPABASE_URL | No | -- | Supabase project URL (enables Supabase features) |
| SUPABASE_ANON_KEY | No | -- | Supabase service_role key (env var name preserved for back-compat; the configured RLS policies grant access to service_role only) |
| MEMORY_AUTHORITY | No | obsidian | "supabase" to enable durable memory |
| SUPABASE_MESSAGE_HISTORY | No | 0 | "1" to persist turns to Supabase |
| SUPABASE_RELEVANT_CONTEXT | No | 0 | "1" to enable pgvector semantic search |
| GROQ_API_KEY | No | -- | Enables Groq voice transcription |
| VOICE_PROVIDER | No | groq | "local" for whisper-cpp |
| RELAY_IPHONE_MIRROR_PLACEMENT | No | 0 | "1" to use iPhone Mirror for draft placement |

---

## 11. LaunchAgent (macOS Daemon)

The relay runs as a macOS LaunchAgent for the logged-in user (not root).

**Label:** `com.claude.telegram-relay`
**Plist location (after setup):** `~/Library/LaunchAgents/com.claude.telegram-relay.plist`

Key properties:
- `KeepAlive: true` -- launchd restarts the relay if it exits for any reason
- `ThrottleInterval: 10` -- 10-second minimum between restart attempts
- `EnvironmentVariables`: PATH, HOME, CLAUDE_PATH, CLAUDE_TIMEOUT_MS, CLAUDE_RESUME=0
- `StandardOutPath` / `StandardErrorPath`: relay writes logs to `logs/com.claude.telegram-relay.log`

Management commands:
```bash
# Start
launchctl load ~/Library/LaunchAgents/com.claude.telegram-relay.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.claude.telegram-relay.plist

# Check status
launchctl list | grep claude-telegram

# View logs
tail -f ~/Projects/claude-telegram-relay/logs/com.claude.telegram-relay.log
tail -f ~/Projects/claude-telegram-relay/logs/com.claude.telegram-relay.error.log
```

---

## 12. Known Issues and Current Status

### Current: Terminal Showing Non-English Script

As of 2026-05-16, the Claude Code terminal for this project is displaying text in what appears to be Armenian script. The relay itself is running correctly (logs show normal startup and successful message processing). The non-English rendering is likely a Claude Code display issue, not a relay code issue. Possible causes:

1. Claude responded in a non-English language (Claude mistakenly switched language)
2. The claude CLI is outputting escape sequences that corrupted terminal encoding
3. A Telegram message from the user triggered a language switch in Claude's system prompt

The relay code itself has no locale-dependent behavior. All strings are hardcoded ASCII/UTF-8 English.

### Historical Bug: Textbook Query Timeouts (Fixed)

Long-form textbook phrasings like "What does Miller say about propofol pharmacokinetics?" caused 5-minute Claude timeouts. Fixed by adding a deterministic textbook retrieval shortcut that bypasses Claude entirely when a clear textbook query is detected and FTS returns hits.

### Historical Bug: FTS Path-Anchor Performance (Fixed)

`searchPathAnchors` was using leading-wildcard GLOB patterns (`GLOB '*/Miller/*'`) which prevented SQLite from using the path B-tree index, causing 8-second timeouts on every textbook name query. Fixed by adding a non-leading-wildcard LIKE prefix per textbook root that allows index use.

### Historical Bug: Telegram 400 on shortcuts:// URL (Fixed)

The iCloud Drive handoff was placing the `shortcuts://run-shortcut?name=ClaudeDraft` URL in a Telegram inline keyboard button. Telegram Bot API returns 400 Bad Request for non-HTTP(S) URL schemes. Fixed by `formatPhoneHandoffForTelegram()` which converts the URL to plain text before sending.

### Known Limitation: FDA for iMessage Context

Reading iMessage thread history requires Full Disk Access for the bun binary. This must be granted manually in System Settings > Privacy & Security > Full Disk Access. The exact binary path must be found via `readlink -f "$(which bun)"` -- granting it to symlinks does not work.

### Known Limitation: Rosetta Compatibility

On macOS 15+ (Sequoia), running bun or claude under Rosetta (x86_64 on Apple Silicon) can cause SQLite FTS compatibility issues. The arch-check.ts preflight now detects and warns about this.

---

## 13. User Profile and Context

William is an anesthesiology resident in Ontario. His use of this relay is professional and practical:

- He messages the bot while on call, between cases, or studying for boards
- He needs replies to be brief unless explicitly asking for depth
- He drafts iMessages to family (parents, partner) and colleagues
- Family messages (especially to his parents) should be warm and natural
- He studies anesthesia using six specific textbooks indexed locally
- He is involved in a medicolegal appeal case (keywords trigger project-anchors)
- He also builds AI automation tools (hence the sophistication of this relay)

Hard formatting rules that apply to ALL drafts this relay produces:
- No em dashes (U+2014 or U+2013) anywhere in email or text drafts
- No salutations ("Hi Mark,") in text message drafts
- No sign-offs ("Best, William") in text message drafts
- Replies must respond to the last message in the thread (not generic)
- Tone: conversational, warm, direct -- never corporate or stiff

---

## 14. Architecture Decisions and Trade-offs

### Why spawn the claude CLI instead of calling the Anthropic API directly?

The relay inherits the user's active Claude Code session including MCP servers, memory, tools, and the user's own CLAUDE.md instructions. This gives every relay response access to the same enriched context as an interactive Claude Code session. The cost is a subprocess spawn overhead (~1-2 seconds) and dependence on the claude binary being present and authenticated.

### Why a local SQLite FTS index instead of a cloud vector database?

The six anesthesia textbooks are large PDFs (hundreds of MB). FTS5 with porter stemming is fast, local, and requires zero network. For medical study queries, keyword retrieval is nearly as good as semantic retrieval -- medical terms like "propofol", "desflurane", "MAC", "TIVA" are not paraphrased. The indexer project maintains a live SQLite FTS index. Adding a vector database would add an embedding pipeline, a running Qdrant instance, and network latency.

### Why Obsidian vault for memory instead of Supabase by default?

The user already uses Obsidian as his note-taking system. Writing memories to the vault means they appear in his existing knowledge base, are human-readable, and sync via Syncthing. Supabase is available as an optional upgrade for semantic memory search.

### Why per-chat FIFO queues?

If the user sends two messages rapidly, the relay could process them concurrently and both would call Claude simultaneously. Claude CLI does not support concurrent invocations sharing the same session. The FIFO queue ensures turns are processed one at a time per chat, preventing session corruption.

### Why fire-and-forget for memory capture?

Memory capture involves writing files to disk and potentially making Supabase calls. These should not delay the Telegram reply. The user sees the response immediately; memory capture happens in the background. If it fails, the decision log records the error.

### Why 13 patterns to strip Claude's placement claims?

Claude was trained to be honest about what it can and cannot do. It will often append disclaimers like "I can't actually send this for you" even when the relay has already placed the draft. These claims are factually incorrect (the relay DID place it) and confusing to the user. The 13 patterns were built incrementally from real observed Claude outputs.

### Why atomic writes everywhere?

The relay processes one update at a time per chat, but multiple background tasks (memory capture, decision log, state files) write to disk concurrently with the main flow. Atomic writes (temp file + rename) prevent partial reads by other processes. This is especially important for the iCloud Drive draft file, which the iPhone Shortcut reads within seconds.
