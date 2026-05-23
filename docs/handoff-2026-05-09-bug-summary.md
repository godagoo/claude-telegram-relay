# Claude Telegram Relay — Phase 1 Bug Summary & Handoff

**Date:** 2026-05-09
**Repo:** [github.com/godagoo/claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay) (working in fork `wregan599-jpg/claude-telegram-relay`)
**Local HEAD when this doc was written:** `66bb15b` plus three uncommitted Loop 2 changes
**Live PR:** [#18 — Phase 1 hardening](https://github.com/godagoo/claude-telegram-relay/pull/18)

---

## What this document is

A self-contained summary of the Phase 1 retrieval bugs found, fixed, and still open, written so a model that has not seen this codebase can:

1. Understand the scope and the hard constraints.
2. Read concrete evidence (live decision-log entries, error log lines, EXPLAIN QUERY PLAN results).
3. Propose fixes for the open items with the right level of caution.

If you ask another model to act on this doc, paste it as context and constrain the model to the **Hard Boundaries** section below.

---

## Hard boundaries (carried from the original Ralph Loop prompt)

These are non-negotiable for any further fix work in this repo:

- No embeddings, vector search, `chunks_vec`, Supabase vector work, OpenAI embeddings, FastAPI sidecars, or PDF extraction.
- No secret rotation or printing.
- No re-enabling the official Claude Telegram plugin.
- No file changes outside `/Users/williamregan/Projects/claude-telegram-relay`.
- No commits or pushes without explicit user approval.
- No second long-polling Telegram consumer.
- The relay touches a live Telegram bot, local credentials, `launchd`, and a SQLite index. Restart only via `launchctl kickstart -k gui/$(id -u)/com.claude.telegram-relay` after code changes are validated locally.

## Verification commands (the four "completion criteria")

Any proposed fix must keep all four green:

```bash
bun test
bun build src/relay.ts --target bun --outdir /tmp/relay-ralph-build
bun run scripts/smoke-poison-query.ts
bun run scripts/smoke-textbook-retrieval.ts
```

---

## Architecture in one paragraph

A Bun/TypeScript Telegram long-poll relay that delegates reasoning to the `claude` CLI and augments prompts with FTS5 lexical retrieval over a SQLite indexer DB at `~/.local-search/metadata.db`. Retrieval is two-track: (1) `chunks_fts` MATCH against indexed chunk text, (2) a **path fallback** that returns synthetic hits for files that exist in the index but were never extracted into chunks (typical for large PDFs marked `extraction_status=skipped`). A **deterministic skipped-textbook guard** in `src/textbook-response.ts` short-circuits Claude when the result is "all-skipped path hits", since otherwise Claude would reason over unavailable content for the full 5-minute timeout. Live decision logs are written to `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl` and are the source of truth for trigger/retrieval quality.

---

## Bugs FIXED in this Phase 1 hardening pass

### Bug A — Skipped-textbook guard regression coverage (live phrasings)

**Status:** ✅ Fixed (regression coverage added; underlying logic was already hardened in commits `a8f00fb`, `738d7ae`, `34109e2`).

**Live evidence:** `~/.claude-relay/logs/decisions-2026-05-08.jsonl` entries 18, 20, 22 — query "What does barash say about the indications for intubation?" hit `claude_ms` 237s–310s (full SIGTERM/SIGKILL). After fixes landed, entries 23 and 25 succeeded with `claude_ms: 1`.

**Root cause:** The deterministic guard's `TEXTBOOK_REQUEST` regex matched short forms ("What does Barash say?") but the live failed phrasings (long, with "indications for intubation") had no explicit unit-test coverage, so the fix could silently regress.

**Fix:** Three regression tests appended to `src/textbook-response.test.ts` using the exact decision-log phrasings. Tests pass on current HEAD, locking in coverage.

**Files:** `src/textbook-response.test.ts`.

---

### Bug B — Path-fallback FTS hit the 8s worker timeout

**Status:** ✅ Fixed in commit `66bb15b` (Phase 1.2).

**Live evidence:**
- `~/.claude-relay/logs/relay.err.log`: `[retrieval] path fallback failed: fts_timeout_8000ms`.
- `~/.claude-relay/logs/decisions-2026-05-08.jsonl` entry 18: `retrieval_ms: 12553` (>8s worker bound) → `hit_count: 0` → guard couldn't fire → Claude ran for 270s.

**Root cause:** `searchPathAnchors` in `src/retrieval.ts` built GLOB patterns of the form `${root}/*${caseTolerantGlobToken(token)}*`. The leading wildcard prevents SQLite from using any path index, forcing a full scan of the `files` table on the populated indexer DB.

**Fix:** Refactored `searchPathAnchors` to AND each GLOB with an indexable `f.path LIKE 'root/%'` predicate per root. SQLite now scopes the scan to the textbook directory before evaluating the GLOB. Verified via `EXPLAIN QUERY PLAN`:

```
Before: SCAN f
After:  SEARCH f USING COVERING INDEX idx_files_path (path>? AND path<?)
```

**Causal coupling with Bug A:** When path fallback errored, the deterministic guard saw zero hits, fell through, and let Claude run for the full 5-minute timeout. Bug B's fix removes that symptom path entirely.

**Files:** `src/retrieval.ts` (refactor + test-only `__test__buildPathAnchorSql` export), `src/retrieval.test.ts` (new — 3 SQL-shape regression tests).

---

### Bug C — Deterministic guard "any" vs. "every" semantics divergence

**Status:** ✅ Fixed in working tree (uncommitted at time of writing).

**Live evidence:** `~/.claude-relay/logs/decisions-2026-05-09.jsonl`:
- Entry 1 (04:10:22Z): user asked "What does miller say are the indications for an arterial line?" — guard fired (`claude_ms: 1`).
- Entry 2 (04:10:58Z): user replied "Okay; this response is unacceptable. Please mark it down as a bug we must fix".
- Entry 3 (04:14:49Z): user clarified intent: "No, I want you to instead search through their relevant markdown files that I converted today".

**Root cause:** The two phrasing paths in `src/textbook-response.ts` had divergent semantics:

| Path | Pre-fix behavior | Original intent (lessons.md) |
|------|------------------|------------------------------|
| Original phrasing (`TEXTBOOK_REQUEST` matches) | Fires if **ANY** hit is a skipped textbook path | "ONLY skipped textbook path hits" |
| Continuation (`keep going/searching/looking`) | Fires if **EVERY** hit is a skipped textbook path | Same |

The "only" semantics had been lost in the original-phrasing implementation. When the user had extractable alternatives indexed (markdown notes, vault chunks, real PDF chunks), the guard would still bail with the canned message instead of letting Claude reason over the real content.

**Compounding factor:** A Loop 1 regression test, "fires when at least one of several hits is a skipped textbook path", encoded the buggy semantics as a positive assertion — which made the divergence harder to notice at PR time.

**Fix:** Replaced the original-phrasing path's `if (skippedHits.length === 0) return null;` with `if (hits.length === 0 || !hits.every(isSkippedTextbookPath)) return null;`, matching the continuation-path semantics. Inverted the wrong test and added two new regression tests:

- "does not fire for original phrasing when an extractable hit exists alongside skipped textbook"
- "does not fire for original phrasing when a non-textbook markdown hit exists"

Plus a positive test that the guard *does* still fire when every hit is a skipped textbook path (the all-skipped scenario the guard was originally designed for).

**Files:** `src/textbook-response.ts`, `src/textbook-response.test.ts`, `tasks/lessons.md`.

---

## Open / outstanding issues

### Bug D — Anchor recovery does not handle topic-pivot follow-ups

**Status:** ⏳ Documented, not fixed. Needs design judgment.

**Live evidence:** `~/.claude-relay/logs/decisions-2026-05-09.jsonl` entry 3 (04:14:49Z):
- User: "No, I want you to instead search through their relevant markdown files that I converted today"
- FTS query produced: `"instead" "relevant" "markdown" "converted" "today"`
- Hits: 0. Topic anchor (miller / arterial / indications) was never recovered, so the search retrieved nothing relevant.

**Root cause:** `chooseTokens` in `src/query-builder.ts:77-97` only pulls anchor tokens from prior turns when the current message has fewer than 2 content tokens:

```ts
function chooseTokens(currentMessage: string, recentTurns: Turn[]): string[] {
  const chosen = uniqueTokens(filterContent(currentMessage));
  if (chosen.length >= 2) return chosen;   // <-- gate that misses topic pivots

  const seen = new Set(chosen);
  const priorUserTurns = recentTurns
    .filter((turn) => turn.role === "user")
    .slice(-4)
    .reverse();

  for (const turn of priorUserTurns) {
    for (const token of filterContent(turn.content)) {
      if (seen.has(token)) continue;
      seen.add(token);
      chosen.push(token);
      if (chosen.length >= 2) return chosen;
    }
  }

  return chosen;
}
```

Topic-pivot phrasings ("instead", "but actually", "rather", "no,", "different source") have 5+ content tokens but still implicitly reference the prior subject ("their relevant markdown files" → "their" = the prior topic). The current heuristic treats content-rich messages as self-contained.

**Constraints any fix must honor:**

- The lessons in `tasks/lessons.md` warn against broad single-token searches and against query expansion that hits the FTS5 corrupt-vtab path. The implicit AND of multiple tokens is what keeps queries safe, so anchor merge must stay bounded (`MAX_MATCH_TOKENS = 5`).
- The retrieval-control words (`continue`, `search`, `index`, `corpus`, `keep`, `looking`, …) are already in `STOPWORDS` (`src/query-builder.ts:20-40`). New pivot signals should join that list **for filtering only**, while a separate detector decides whether to merge prior-turn anchors.
- Any change must not regress `src/textbook-response.test.ts` "Keep searching" tests — those rely on the existing recovery path.

**Suggested approach (for ChatGPT or a follow-up loop):**

1. Define `TOPIC_PIVOT_SIGNALS = /\b(instead|rather|actually|different|but|no,)\b/i`.
2. In `chooseTokens`, if `TOPIC_PIVOT_SIGNALS.test(currentMessage)`, ALWAYS attempt to merge top tokens from the prior **user** turn (last one), even when the current message has ≥2 content tokens.
3. Cap the merged result to `MAX_MATCH_TOKENS` and de-duplicate.
4. Ensure pivot signal words themselves are in `STOPWORDS` so they don't end up in the FTS query.
5. Test cases:
   - "No, search markdown instead" after "What does miller say…" → query includes "miller".
   - "But actually, what about Cote?" after "Tell me about Barash" → query includes "cote" but probably not "barash" (the user explicitly pivoted away).
   - "Different question — what is propofol?" after "Tell me about Barash" → genuine new topic; recovery should NOT inject "barash".

This is genuinely ambiguous (when does the user keep the topic vs. drop it?), so any heuristic should be heavily test-covered with at least 6–8 cases drawn from real or plausible decision-log phrasings.

---

### Bug E — Deterministic skipped-textbook response is too curt

**Status:** ⏳ UX issue, not yet addressed.

**Current message** (`src/textbook-response.ts`):

```
I found the textbook files in your index, but they were indexed only as
file paths, not extracted into searchable text yet.

- <file 1>
- <file 2>

So I can confirm the files exist, but I cannot quote or answer from
Barash/Miller content until we fix PDF extraction for those files.
```

**Why this matters:** Live evidence shows users perceive this as a dead-end — see Bug C's entry 2 ("this response is unacceptable") even after the user had converted the PDFs to markdown for a reason.

**Suggested rewrite:**

```
I found the textbook files in your index, but they were indexed only as
file paths, not extracted into searchable text yet:

- <file 1>
- <file 2>

I can't quote from these PDFs directly. If you've saved notes or
markdown extracts of this material, ask me to "search my notes for X"
and I'll look there instead. If you want me to try anyway, reply
"keep searching" and I'll widen the search.
```

This both lowers user frustration and gives an explicit affordance ("keep searching") that already has tested code-path support (the continuation form of the guard).

**Files to touch:** `src/textbook-response.ts` only. No test changes needed beyond updating the `expect(response).toContain(...)` substrings.

---

### Bug F — Watcher.py auto-restart not handled by the relay

**Status:** ⏳ Observation only; out of scope for the relay repo per the original Ralph Loop boundaries.

**Evidence:** `~/.claude-relay/logs/relay.err.log` contains `[preflight] watcher.py not running; indexed content may be stale`. The relay correctly degrades — it stays online and answers ordinary messages — but the indexer is not auto-restarted.

**Why it's out of scope here:** `watcher.py` lives in `~/Projects/claude-indexer`, a separate repo. The relay's responsibility is to detect and degrade, which it already does.

**Suggested follow-up (in the indexer repo, not here):** A `LaunchAgents` plist for the watcher with `KeepAlive = true`, or a healthcheck script that calls `launchctl kickstart` on the indexer service when the relay's preflight reports it down for >N minutes.

---

### Bug G — Hard-coded 5-minute Claude timeout is too generous

**Status:** ⏳ Observation; tradeoff worth discussing.

**Source:** `src/relay.ts:52` — `const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;`.

**Concern:** When Bug B was active, users waited 5 full minutes before getting an error message. Even with Bug B fixed, a confused query against the live system can pin Claude for 5 minutes before timeout.

**Proposed change:** lower to ~90 seconds with a "still thinking — about to give up" intermediate Telegram message at ~75s. Make the timeout configurable via `CLAUDE_TIMEOUT_MS` env var so power users can override.

**Risk:** legitimate reasoning over large prompts (decision-log entries 19/20 took ~120s of `claude_ms` and returned good content). A blanket 90s would cut some real successes. Mitigation: have the intermediate message say "still thinking, reply 'wait' to extend" to give the user agency.

**Files to touch:** `src/relay.ts` only.

---

### Bug H — Decision log path mismatch in operator docs

**Status:** ⏳ Doc-only.

**Evidence:** The original Phase 1 Ralph Loop prompt referenced `~/.claude-relay/decisions.jsonl`, but the actual path is `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl` (date-stamped, in `logs/` subdir).

**Fix:** update any prompt files, READMEs, or operator docs that reference the old path. Inside this repo, no source code references the old path, so this is a low-priority doc cleanup.

---

## Inefficiencies and code smells (lower priority)

### I-1: Path-fallback hits always rank ahead of FTS chunk hits

**Source:** `src/retrieval.ts` `search()` function — `for (const hit of [...pathHits, ...ftsHits])`.

**Behavior:** If `searchPathAnchors` returns 5 hits for a query like "miller arterial line indications", those 5 path-fallback hits fill the top of the result set before any chunk text from extracted content gets a chance. With `k = 8`, that leaves only 3 slots for actual chunk content.

**Why this matters:** Bug C's fix mitigates the worst symptom (the deterministic guard now falls through to Claude when extractable content exists), but Claude's prompt is still anchored on path-fallback hits if those dominate the top-K. Real chunk content may not even reach Claude.

**Suggested fix:** Interleave or rank by score. Path-fallback hits all have `rank_score = -1.0` (synthetic), and FTS chunks have real BM25-ish ranks. Either:

a) Change ordering to `[...ftsHits, ...pathHits]` so chunk content wins ties.
b) Cap `pathHits.length` to `Math.floor(k / 2)` and let FTS fill the rest.

Either would need a test like "when the same query returns both chunk and path-fallback hits, Claude receives at least one chunk".

### I-2: STOPWORDS list is large and ad-hoc

**Source:** `src/query-builder.ts:20-40`.

The list mixes English stopwords with bot-specific control words (`searching`, `looking`, `keep`, `index`, `corpus`, `vault`, `setup`). It works, but every new behavior adds words. There's no test that asserts a specific control word is filtered.

**Suggested cleanup:** split into `BASE_STOPWORDS` and `RELAY_CONTROL_WORDS`, and add a parameterized test that runs `filterContent` over each control word and asserts it's stripped. This is purely refactoring — no behavioral change. Skip if not motivated by a specific bug.

### I-3: `relay.out.log.run1` artifact in logs dir

**Source:** `~/.claude-relay/logs/relay.out.log.run1` (883 bytes, dated 2026-05-08 08:19).

Probably leftover from manual testing. No code references it. Can be deleted manually if log dir cleanliness matters. Not a bug.

### I-4: No log rotation for `decisions-*.jsonl`

**Source:** `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl` (one per day).

Decision logs grow unbounded. After ~6 months at heavy use this becomes hundreds of MB. No rotation script exists. Suggest a weekly job that gzips files older than 30 days, or a `RETAIN_DAYS` env var that the relay enforces at startup.

---

## Test inventory

| File | Tests | Notes |
|------|-------|-------|
| `src/trigger.test.ts` | 5 | Existing — referential trigger |
| `src/query-builder.test.ts` | 5 | Existing — FTS query construction |
| `src/textbook-response.test.ts` | 13 | 8 original + 3 from Loop 1 + 3 from Loop 2 (1 inverted) |
| `src/retrieval.test.ts` | 3 | Loop 1 — SQL-shape regression for Bug B |
| **Total** | **23** |

Run with: `bun test` → expect `23 pass / 0 fail / 51 expect() calls`.

Smoke scripts (out-of-test runtime checks):

| Script | What it does |
|--------|--------------|
| `scripts/smoke-poison-query.ts` | Verifies a known-broad query is bounded by FTS query construction. |
| `scripts/smoke-textbook-retrieval.ts` | Verifies path fallback returns scoped hits and surfaces `extraction_status=skipped` for the live indexer DB. |

---

## Quick reproduction guide for each bug

If you want to reproduce on a clean checkout (or have ChatGPT generate fresh fixes from scratch):

| Bug | Reproduce |
|-----|-----------|
| A | `git checkout 18f263e^` (before the hardening series) → `bun test` (passes, but no coverage of long-form phrasings) → manually send "What does barash say about the indications for intubation?" to the live relay; observe 240–310s `claude_ms` in the decision log. |
| B | On any commit before `66bb15b`, run `EXPLAIN QUERY PLAN` against `~/.local-search/metadata.db` for a path-fallback-style GLOB; observe `SCAN f`. The 8s worker timeout fires intermittently against the populated DB. |
| C | On commit `66bb15b` (before Loop 2), in `src/textbook-response.test.ts` add a test where one hit is a regular markdown chunk and one is a skipped textbook path with a "What does Barash say" phrasing — assert `expect(response).toBeNull()`. The test fails (guard fires when it shouldn't). |
| D | Send to the live relay: "What does miller say about X?" then immediately "No, search instead through my notes". Inspect the second decision-log entry's `fts_query` field — it lacks "miller". |
| E | Send "What does miller say about X?" with the textbook PDFs in skipped state; observe the canned response and judge it as a user. |

---

## Files modified across the two loops (cumulative diff vs. `34109e2`)

```
Loop 1 (committed as 66bb15b):
  M  src/retrieval.ts                                +37 / -10
  A  src/retrieval.test.ts                           +27
  M  src/textbook-response.test.ts                   +40
  M  tasks/lessons.md                                +22
  A  docs/plans/2026-05-08-phase1-relay-bugfixes.md  (plan, +470)

Loop 2 (uncommitted at time of writing):
  M  src/textbook-response.ts                        +6 / -1
  M  src/textbook-response.test.ts                   +37 / -3
  M  tasks/lessons.md                                +30
```

---

## Recommended sequencing if you let another model continue

1. **Bug E rewrite** (5 min, safe). Lowers user frustration immediately. No new tests needed — just adjust existing `toContain` substrings.
2. **I-1 ranking fix** (30 min). Single-file change in `src/retrieval.ts`, one new test in `src/retrieval.test.ts`. Verifies real chunk content reaches Claude when both kinds of hits exist.
3. **Bug D anchor recovery** (1–2 hr). The big one. Needs design discussion before code. Have the model propose the heuristic first, then implement against 6–8 test cases.
4. **Bug G timeout** (30 min, but coordinated with the user). Behavior change with user-visible impact — should be opt-in via env var first.
5. **I-4 log rotation** (15 min). Self-contained.

Anything in **Bug F** lives in a different repo and should not be touched here.

---

## Contact for the live system

- **launchd service:** `com.claude.telegram-relay` (PID currently 20131 after Loop 2 restart).
- **Restart command:** `launchctl kickstart -k gui/$(id -u)/com.claude.telegram-relay`.
- **Logs:** `~/.claude-relay/logs/{relay.out.log,relay.err.log,decisions-YYYY-MM-DD.jsonl}`.
- **Indexer DB (read-only from the relay):** `~/.local-search/metadata.db`.
