# Phase 1 Relay Bugfixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Pair with `superpowers:systematic-debugging` and `superpowers:test-driven-development`.

**Goal:** Eliminate the two latent Phase 1 bugs surfaced by `~/.claude-relay/logs/relay.err.log` and `decisions-2026-05-08.jsonl` — five 5-minute callClaude timeouts and one path-fallback FTS timeout — and add regression coverage so they cannot recur. Do not broaden scope.

**Architecture:** Two narrow fixes, both inside `src/retrieval.ts` plus regression tests in `src/textbook-response.test.ts` and a new `src/retrieval.test.ts`. No schema changes, no new deps, no embedding/vector work, no PDF extraction work.

**Tech Stack:** Bun 1.3, `bun:sqlite` (SQLite 3.43.2, FTS5), TypeScript, `bun:test`.

---

## Hard Boundaries (carried from the Ralph Loop prompt)

- No embeddings, vector search, `chunks_vec`, Supabase vector work, OpenAI embeddings, FastAPI sidecars, PDF extraction.
- No secret rotation or printing.
- No re-enabling the official Claude Telegram plugin.
- No file changes outside `/Users/williamregan/Projects/claude-telegram-relay`.
- No commits, no pushes.
- No second long-polling Telegram consumer.
- If anything cannot be verified, report `BLOCKED` with evidence.

---

## Evidence (read before starting)

**Bug A — Long-form Miller/Barash phrasings caused 5-minute callClaude timeouts.**
- `~/.claude-relay/logs/decisions-2026-05-08.jsonl` lines 18, 20, 22: query "What does barash say about the indications for intubation?" → `claude_ms` 237s–310s, `injected_count: 3`, hits include `Cote Ped Anesthesia 6 copy (optimized).pdf` with skipped status.
- `~/.claude-relay/logs/relay.err.log` shows `[callClaude] timeout after 300000ms, sending SIGTERM` x2, then `SIGKILL`.
- Lines 23 (16:22 EDT) and 25 (18:18 EDT) succeeded with `claude_ms: 1` after commits a8f00fb / 738d7ae landed. Coverage at HEAD is real but **lacks an explicit regression test using the live failed phrasings**.

**Bug B — Path-fallback FTS hits the 8s worker timeout.**
- `relay.err.log`: `[retrieval] path fallback failed: fts_timeout_8000ms`.
- Decision log line 18 has `retrieval_ms: 12553` (>8s worker bound) → path fallback rejected → `hit_count: 0` → deterministic guard returned `null` (no skipped hits to surface) → Claude ran for full 270s.
- Root cause: `src/retrieval.ts:336-365` (`searchPathAnchors`) builds GLOB patterns with a **leading wildcard** (`Textbooks/*[bB]arash*`). SQLite cannot use a path index for a leading-wildcard GLOB, so it full-scans the `files` table. On a large indexer DB this exceeds the 8s worker timeout.
- **Bug B causes Bug A's symptom in entries 18/20/22**: when path fallback errors out, `searchPathAnchors` returns `[]`, the deterministic guard sees no skipped hits, and Claude is invoked unbounded.

**Already passing baseline (confirmed before drafting this plan):**
- `bun test`: 15 pass / 0 fail.
- `bun build src/relay.ts --target bun --outdir /tmp/relay-ralph-build`: bundles 100 modules in ~57ms.
- `bun run scripts/smoke-poison-query.ts`: PASS.
- `bun run scripts/smoke-textbook-retrieval.ts`: PASS.
- `launchctl list | grep com.claude` shows `com.claude.telegram-relay` and `com.claude.file-indexer` running with exit code 0.

---

## Out of Scope

- Watcher.py auto-restart (`[preflight] watcher.py not running` was a transient observation; relay degraded gracefully).
- Decision-log path discrepancy in the Ralph Loop prompt (`~/.claude-relay/decisions.jsonl` vs. real `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl`) — doc issue, not relay code.
- Stale-lock takeover (relay correctly took over; not a bug).
- Indexer DB schema or watcher behavior.

---

## Task 1: Pre-flight verification baseline

**Files:** none (read-only).

**Step 1: Confirm clean working tree.**
Run: `git status`
Expected: `nothing to commit, working tree clean`. HEAD at `34109e2`.

**Step 2: Capture baseline test output as oracle.**
Run: `bun test 2>&1 | tail -5`
Expected: `15 pass`, `0 fail`.

**Step 3: Capture baseline build.**
Run: `bun build src/relay.ts --target bun --outdir /tmp/relay-ralph-build 2>&1 | tail -3`
Expected: `relay.js  0.69 MB  (entry point)`.

**Step 4: Capture baseline smokes.**
Run: `bun run scripts/smoke-poison-query.ts && bun run scripts/smoke-textbook-retrieval.ts`
Expected: both end with `PASS`.

**Step 5: Capture relay launchd PID for later restart comparison.**
Run: `launchctl list | grep com.claude.telegram-relay`
Expected: PID > 0, exit code 0. **Record the PID** — Task 8 will compare against the post-restart PID.

**Step 6: No commit.** This task is read-only.

**STOP condition:** if any of steps 2–5 fails, report `BLOCKED` with evidence — the spec assumes baseline passes.

---

## Task 2: Reproduce Bug A — regression tests for live decision-log phrasings

**Files:**
- Modify: `src/textbook-response.test.ts` (append three tests at end of file).

**Step 1: Write the failing tests using the exact phrasings from the live decision log.**

Append to `src/textbook-response.test.ts`:

```ts
test("fires for live phrasing 'What does barash say about the indications for intubation?'", () => {
  const response = buildSkippedTextbookResponse(
    "What does barash say about the indications for intubation?",
    [skippedBarashHit],
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Barash 9.pdf");
});

test("fires for live phrasing 'What does miller say about the indications for intubation?'", () => {
  const response = buildSkippedTextbookResponse(
    "What does miller say about the indications for intubation?",
    [
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller.pdf`,
        "Indexed file path match. extraction_status=skipped; chunk_count=0",
      ),
    ],
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Miller.pdf");
});

test("fires when at least one of several hits is a skipped textbook path", () => {
  const response = buildSkippedTextbookResponse(
    "What does Barash say about indications for intubation?",
    [
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Barash 9.pdf`,
        "Some extracted chapter content about intubation",
      ),
      skippedBarashHit,
    ],
  );

  expect(response).toContain("I found the textbook files");
});
```

**Step 2: Run only these tests.**
Run: `bun test src/textbook-response.test.ts -v 2>&1 | tail -30`
Expected: all three new tests **pass** (the fix already shipped in commits a8f00fb / 34109e2; this task locks in regression coverage).

**Step 3: If any test FAILS, STOP.** That means the live failure mode is still reachable in HEAD. Apply `superpowers:systematic-debugging`: reproduce in a smoke, identify root cause in `buildSkippedTextbookResponse` or its call site at `src/relay.ts:473`, fix the smallest possible thing, re-run.

**Step 4: Do NOT commit yet.** Bundle with Task 4's commit.

---

## Task 3: Reproduce Bug B — failing test for path-anchor SQL shape

**Files:**
- Create: `src/retrieval.test.ts`.

**Step 1: Write the failing test.**

The test asserts the SQL builder for path anchors emits a non-leading-wildcard prefix predicate (which SQLite can index-scope) in addition to the existing GLOBs. We will export the builder in Task 4.

Create `src/retrieval.test.ts` with:

```ts
import { expect, test } from "bun:test";
import { __test__buildPathAnchorSql } from "./retrieval";

test("path anchor SQL scopes by indexable prefix LIKE per root", () => {
  const { sql } = __test__buildPathAnchorSql(["barash"]);

  // Without an indexable prefix, SQLite full-scans `files` because every GLOB
  // pattern starts with a wildcard. This was Bug B's root cause.
  expect(sql).toMatch(/f\.path LIKE \?/);
  expect(sql).toMatch(/f\.path GLOB \?/);
});

test("path anchor SQL preserves GLOB token clause for token matching", () => {
  const { sql } = __test__buildPathAnchorSql(["miller", "barash"]);

  // Both tokens must still appear as GLOB OR clauses inside the same root.
  const globMatches = sql.match(/f\.path GLOB \?/g) ?? [];
  expect(globMatches.length).toBeGreaterThanOrEqual(2);
});

test("path anchor SQL returns ordered params: prefix-then-globs per root, then deny, then k", () => {
  const { orderedParams, expectedRoots } = __test__buildPathAnchorSql(["barash"]);

  // First param is the LIKE prefix for the first (and currently only) root.
  expect(orderedParams[0]).toMatch(/Desktop\/Exam_Prep\/Textbooks\/%$/);
  expect(expectedRoots).toBe(1);
});
```

**Step 2: Run the test.**
Run: `bun test src/retrieval.test.ts -v 2>&1 | tail -20`
Expected: **FAIL** — `__test__buildPathAnchorSql` is not exported from `retrieval.ts`.

**Step 3: Do NOT proceed to a fix without seeing the failure.** This is the TDD red step.

---

## Task 4: Fix Bug B — add prefix scope predicate to `searchPathAnchors`

**Files:**
- Modify: `src/retrieval.ts:336-365` (replace `searchPathAnchors` and add a new helper + test export).

**Step 1: Refactor the SQL builder.**

Replace the current `searchPathAnchors` implementation with:

```ts
function buildPathAnchorSql(tokens: string[]): {
  sql: string;
  orderedParams: unknown[];
  expectedRoots: number;
} {
  // Per root: (f.path LIKE ? AND (f.path GLOB ? OR f.path GLOB ? ...))
  // The LIKE has no leading wildcard, so SQLite can use a path index to
  // scope the scan to the textbook directory before evaluating the GLOBs.
  const rootClauses: string[] = [];
  const orderedParams: unknown[] = [];

  for (const root of PATH_FALLBACK_ROOTS) {
    const rootGlobs = tokens.map(
      (token) => `${root}/*${caseTolerantGlobToken(token)}*`,
    );
    const globClause = rootGlobs.map(() => "f.path GLOB ?").join(" OR ");
    rootClauses.push(`(f.path LIKE ? AND (${globClause}))`);

    orderedParams.push(`${root}/%`);
    orderedParams.push(...rootGlobs);
  }

  const sql = `
SELECT -f.id AS id,
       'Indexed file path match. extraction_status=' || COALESCE(f.extraction_status, 'unknown') ||
       '; chunk_count=' || COALESCE(f.chunk_count, 0) AS text,
       f.path AS path,
       0 AS chunk_index,
       -1.0 AS rank_score
  FROM files f
 WHERE (${rootClauses.join(" OR ")})
   AND ${DENY_CLAUSE}
 ORDER BY f.path
 LIMIT ?
`;

  return {
    sql,
    orderedParams,
    expectedRoots: PATH_FALLBACK_ROOTS.length,
  };
}

// Test-only export — not consumed by relay runtime.
export const __test__buildPathAnchorSql = buildPathAnchorSql;

async function searchPathAnchors(query: string, k: number): Promise<Hit[]> {
  const tokens = pathTokensFromQuery(query);
  if (tokens.length === 0) return [];

  const { sql, orderedParams } = buildPathAnchorSql(tokens);
  const params = [...orderedParams, ...DENY_PATTERNS, k];
  const { rows } = await runFtsInWorker(sql, params);
  return (rows as RetrievedRow[]).map(toHit);
}
```

**Step 2: Run the previously-failing test.**
Run: `bun test src/retrieval.test.ts -v 2>&1 | tail -20`
Expected: all three tests **pass**.

**Step 3: Run the full test suite for regression check.**
Run: `bun test 2>&1 | tail -10`
Expected: **21 pass / 0 fail** (15 baseline + 3 from Task 2 + 3 from Task 3).

**Step 4: Re-run smokes to confirm no behavioral regression.**
Run: `bun run scripts/smoke-poison-query.ts && bun run scripts/smoke-textbook-retrieval.ts`
Expected: both end with `PASS`. The textbook smoke must still report `first_textbook_status: "Indexed file path match. extraction_status=skipped; chunk_count=0"` for the three test messages.

**Step 5: Re-run the build.**
Run: `bun build src/relay.ts --target bun --outdir /tmp/relay-ralph-build 2>&1 | tail -3`
Expected: bundles cleanly, no TypeScript errors.

**Step 6: Optional sanity probe — confirm SQLite uses an index for the new prefix predicate.**

Run (read-only):
```
sqlite3 ~/.local-search/metadata.db "EXPLAIN QUERY PLAN SELECT 1 FROM files f WHERE f.path LIKE '/Users/williamregan/Desktop/Exam_Prep/Textbooks/%' AND f.path GLOB '/Users/williamregan/Desktop/Exam_Prep/Textbooks/*[bB]arash*' LIMIT 1;"
```
Expected: plan mentions `SEARCH f USING INDEX` or `USING COVERING INDEX`, NOT `SCAN f`. If SCAN appears, the index does not cover `path` and a follow-up task is needed (do **not** create indexes — out of scope; report observation only).

**Step 7: Do NOT commit yet.** Bundle with Task 6's lessons update.

---

## Task 5: (Optional) Synthetic-DB smoke for path-fallback bound

**Decision:** Skip if Task 4 step 6 confirms SQLite uses an index. Run only if step 6 shows `SCAN f` and we need belt-and-braces.

**Files:**
- Create: `scripts/smoke-path-fallback-bound.ts` (only if pursued).

The risk of this script is high (worker isolation, env var override, synthetic schema must match real schema enough for the SQL to plan correctly). Prefer the EXPLAIN QUERY PLAN probe in Task 4 step 6 over building this smoke. Document the decision either way in Task 9's handoff.

---

## Task 6: Update `tasks/lessons.md`

**Files:**
- Modify: `tasks/lessons.md` (append a new dated section at the end).

**Step 1: Append.**

```markdown

## 2026-05-08 - Path-fallback prefix scoping

- Path-fallback GLOB patterns with a leading wildcard (`Textbooks/*Barash*`)
  cannot use any path index. On a populated indexer DB this triggers the 8s
  FTS worker timeout (`fts_timeout_8000ms`). When path fallback errors out,
  the deterministic skipped-textbook guard sees zero hits and falls through
  to Claude, which then runs for the full 5-minute timeout. Fix: AND each
  GLOB with an indexable prefix (`f.path LIKE 'root/%'`) so SQLite scopes
  the scan to the textbook directory before evaluating the GLOB.
- Long-form Miller/Barash phrasings ("What does miller say about the
  indications for intubation?") must be covered by explicit unit tests, not
  just `"What does Barash say?"`-style probes. The exact phrasings from
  `~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl` are the source of truth
  — backport the live failure into the test suite the moment the bug is
  reproduced.
- A path-fallback failure can silently mask the deterministic guard. When
  diagnosing skipped-textbook timeouts, always check `[retrieval] path
  fallback failed:` lines in `relay.err.log` before assuming the guard
  itself is broken.
```

**Step 2: Run all tests one more time as a final smoke before commit.**
Run: `bun test 2>&1 | tail -5`
Expected: 21 pass / 0 fail.

**Step 3: Do NOT commit.** Per Ralph Loop hard boundary. Stage only if the user explicitly approves.

---

## Task 7: Final verification suite

Re-run the four required completion-criteria commands in order:

**Step 1:** `bun test 2>&1 | tail -10` → 21 pass / 0 fail.
**Step 2:** `bun build src/relay.ts --target bun --outdir /tmp/relay-ralph-build 2>&1 | tail -3` → clean bundle.
**Step 3:** `bun run scripts/smoke-poison-query.ts` → ends with `PASS`.
**Step 4:** `bun run scripts/smoke-textbook-retrieval.ts` → ends with `PASS`, all three test queries return `extraction_status=skipped` first textbook hit.

**Step 5: Diff review.**
Run: `git status && git diff --stat`
Expected diff scope (exact set):
- `src/retrieval.ts` (modified — `searchPathAnchors` refactor + test export)
- `src/retrieval.test.ts` (new)
- `src/textbook-response.test.ts` (modified — three appended tests)
- `tasks/lessons.md` (modified — appended section)
- `docs/plans/2026-05-08-phase1-relay-bugfixes.md` (new — this plan)

**Step 6: Confirm no commits or pushes happened.**
Run: `git log --oneline -3`
Expected: HEAD still `34109e2 Extend skipped-textbook guard to "keep searching" follow-ups`.

---

## Task 8: Controlled relay restart

Code that runs in the relay process changed (`src/retrieval.ts`), so a restart is required.

**Step 1: Confirm code change requires restart.**
Run: `git diff --name-only`
Expected: includes `src/retrieval.ts`. (Tests and docs alone would not require a restart.)

**Step 2: Capture pre-restart PID.**
Run: `launchctl list | grep com.claude.telegram-relay`
Expected: PID matches the value from Task 1 step 5.

**Step 3: Kickstart the launchd service (do NOT bootout/bootstrap).**
Run: `launchctl kickstart -k gui/$(id -u)/com.claude.telegram-relay`
Expected: command exits 0, no error.

**Why kickstart -k:** restarts the existing job in place. Avoids the bootstrap/bootout dance that risks leaving a second consumer alive (the Ralph Loop explicitly forbids a second long-polling Telegram consumer).

**Step 4: Wait briefly, verify new PID and healthy startup.**
Run: `sleep 3 && launchctl list | grep com.claude.telegram-relay && tail -25 ~/.claude-relay/logs/relay.out.log`
Expected:
- PID differs from step 2.
- Out log shows in order: `[retrieval] readonly invariant verified`, `[preflight] FTS sanity: architecture probe returns hits`, `[preflight] watcher.py: alive` (or `not running` — degrade is acceptable), `[preflight] Telegram getMe: @wr_claude_20260427_bot`, `[relay] retrieval preflight complete`, `Bot is running!`.

**Step 5: Verify err log is unchanged or shorter.**
Run: `tail -10 ~/.claude-relay/logs/relay.err.log`
Expected: no new fatal errors. The historical timeouts are fine — they predate the restart.

**Step 6: Confirm only one relay consumer exists.**
Run: `pgrep -f "claude-telegram-relay" | wc -l`
Expected: small number (1–2 — `pgrep -f` may match the parent and child). If >3, investigate before declaring done.

---

## Task 9: Handoff report

Print to chat (do NOT commit, do NOT push):

```
PHASE 1 RELAY BUGFIX HANDOFF
============================

Bugs fixed:
1. Bug B (root cause) — Path-fallback FTS hit 8s worker timeout because
   GLOB patterns had a leading wildcard, forcing a full scan of `files`.
   Fixed by ANDing each GLOB with an indexable LIKE prefix per root.
2. Bug A (regression coverage) — Long-form Miller/Barash phrasings ("What
   does miller say about the indications for intubation?") had been
   reaching the deterministic guard since commits a8f00fb / 34109e2 but
   were not regression-tested with the live phrasings. Now covered.

Causal link: when Bug B caused path fallback to error, the deterministic
guard saw zero hits and let Claude run for the full 5-minute timeout
(decision-log entries 18, 20, 22). Bug B's fix removes the symptom path.

Files changed:
- src/retrieval.ts                    (path-anchor SQL refactor)
- src/retrieval.test.ts               (new — 3 SQL-shape tests)
- src/textbook-response.test.ts       (3 live-phrasing regression tests)
- tasks/lessons.md                    (path-fallback prefix scoping lesson)
- docs/plans/2026-05-08-phase1-relay-bugfixes.md (new — this plan)

Verification (paste exact output):
- bun test                                              [21 pass / 0 fail]
- bun build src/relay.ts --target bun ...               [clean bundle]
- bun run scripts/smoke-poison-query.ts                 [PASS]
- bun run scripts/smoke-textbook-retrieval.ts           [PASS]

Live relay:
- Restarted via launchctl kickstart -k at <ts>
- New PID: <pid>; old PID: <pid>
- Startup logs healthy; one Telegram consumer; no new err entries.

Remaining risks / not done:
- EXPLAIN QUERY PLAN result for the new prefix predicate: <SEARCH or SCAN>.
  If SCAN, files table lacks a path index — out of scope to add here.
- Watcher.py auto-restart not addressed (out of scope).
- No commits made; user must review and commit/push manually.

PHASE1_RELAY_RALPH_COMPLETE
```

Only print `PHASE1_RELAY_RALPH_COMPLETE` if all of the following are true:
- All 21 tests pass.
- Build is clean.
- Both smokes pass.
- `tasks/lessons.md` updated.
- `git diff` reviewed and matches Task 7 step 5's expected scope exactly.
- Relay restarted once and logs are healthy.
- No commits or pushes happened.

If any criterion fails, print the BLOCKED report instead:
- exact blocker
- evidence gathered
- fixes attempted
- safest next manual decision

---

## Stop conditions during execution

Halt immediately if any of the following occur:
- Test count drops below 15 (something existing broke).
- A new error class appears in `relay.err.log` that did not exist at baseline.
- `git diff` shows a change outside the relay repo.
- Path fallback returns hits for non-textbook directories (scope leak in the new SQL).
- Smoke scripts time out or return zero hits where they previously returned hits.
- `launchctl kickstart` produces a duplicate PID or the bot fails to come back online within 10 seconds.

In any of these cases: revert the breaking edit (`git checkout -- <file>`), re-run the failing command, and report what was reverted.
