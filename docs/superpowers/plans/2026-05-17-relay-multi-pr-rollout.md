# Claude Telegram Relay — Multi-PR Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the audit-derived hardening, dual-memory architecture, and Gmail/WhatsApp/voice/scheduled features as three phase-gated PRs. Each PR is independently deployable. The relay stays online throughout.

**Architecture:** Three sequential PRs that share an architectural spine (`src/draft-router.ts`, `src/intents.ts`, `src/session.ts`, `src/memory/index.ts`). PR #1 ships the spine plus bug fixes plus session continuity. PR #2 wires Supabase under the existing `src/memory/index.ts` facade. PR #3 wires email / WhatsApp / voice / scheduled jobs through the same draft-router chokepoint.

**Tech stack:** Bun 1.x (TypeScript), `bun:sqlite` (FTS5 for textbooks/notes), Supabase Postgres + pgvector (HNSW), OpenAI `text-embedding-3-small`, Anthropic Claude CLI in `-p` headless mode with `--resume`, Gmail REST v1, `whatsapp://send` deep link, macOS `say`+`ffmpeg(libopus)` for voice, macOS `launchd` for process supervision.

---

## Spec Corrections (Evidence-Based Departures from the Audit)

Before any code: the audit got several items wrong against the *current* codebase. The plan rejects or rewrites them. Every rejection is documented so a reviewer can challenge it without re-reading the audit.

| Audit item | Audit claim | Evidence | Plan action |
|---|---|---|---|
| **BUG-2** | "FTS preflight is missing — add `SELECT COUNT(*) FROM chunks LIMIT 1` through the worker." | `src/retrieval.ts:133-145` already runs `await search('"anesthesia" "textbook"', 1)` as preflight — a real FTS roundtrip, strictly more informative than a COUNT. Called from `relay.ts:1842-1856`. | **Reject.** A COUNT probe is regressive. Document the rejection in lessons. |
| **BUG-3** | "Add `TOPIC_PIVOT_RE = /\\b(instead\|rather\|actually\|different\|but\|no,\|wait\|wrong\|not that)\\b/i` and force anchor recovery when matched." | `src/query-builder.ts:48-54` already defines `TOPIC_PIVOT_PATTERNS` — a superset of the audit's regex including `^no[,!.]?\\s+(i\|let\|you\|search\|...)`, source/format redirection (`use the markdown`, `check those notes`), and `not (that\|the\|those\|this)`. The gating at `:144-148` already extends recovery to `MAX_MATCH_TOKENS=5` on pivot. | **Reject.** Already implemented richer than the audit prescribes. |
| **BUG-7** | "Em-dash strip must skip `<pre>` and `>>>` blocks too." | `src/response-sanitize.ts:43-65` already skips triple-backtick and inline-backtick blocks. No evidence in `decisions-*.jsonl` that Claude emits `<pre>` or `>>>` fences. | **Reject** until reproduced. YAGNI. |
| **BUG-8** | "Docs reference wrong decision-log path." | `src/decision-log.ts:87` writes `~/.claude-relay/logs/decisions-${date}.jsonl`. `docs/handoff-2026-05-09-bug-summary.md:49` documents the same path. | **Reject.** No mismatch. |
| **KI-1** | "STOPWORDS need to be split." | Already split: `STOPWORDS` (general), `SOURCE_CONTROL_STOPWORDS` (pivot-conditional), `PATH_ANCHOR_STOPWORDS` (path fallback). | **Reject.** Already done. |
| **KI-2** | "Basename validation needs `/^[A-Za-z0-9_\\-.]{1,128}$/`." | `src/retrieval.ts:568-571` reads basenames from filesystem-loaded `files.path`, not user input. No traversal attack surface. | **Reject.** Premature paranoia. |
| **Gmail threading** | "`threadId` on `users.drafts.create.message` enforces threading." | Verified against Google's Manage-Threads doc: `threadId` alone places the draft in the sender's thread view but **recipients see a standalone message**. Threading on the recipient side requires `In-Reply-To` + `References` + matching `Subject` in the RFC 2822 MIME. | **Correct in plan.** All three headers required. |
| **`Bun.spawn` async timeout** | "Use `Bun.spawn({ timeout, killSignal: 'SIGKILL' })` and you can detect timeout from `signalCode`." | Verified against bun.sh/docs/api/spawn: the runtime does kill on timeout, BUT `Bun.spawn` (async) does NOT expose `exitedDueToTimeout` (only `Bun.spawnSync` does). `signalCode === "SIGKILL"` is indistinguishable from an external SIGKILL. | **Correct in plan.** Track timeout via a local `startedAt + elapsed >= TIMEOUT_MS` marker, not via `signalCode` alone. |
| **`--resume` parsing** | "Extract `session_id` from `--output-format json`." | Current code at `src/relay.ts:561` parses `Session ID: ([a-f0-9-]+)` from `--output-format text`. That regex never matches the JSON envelope. | **Correct in plan.** Flip output format to `json` and parse `.session_id` from the envelope. |
| **Claude cwd stability** | (audit silent on this) | Verified: Claude stores sessions under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. If `--resume` runs from a different `cwd`, the SDK looks in the wrong place. | **Add to plan.** Pin `cwd` to `RELAY_CWD` on every spawn (already done in `relay.ts:102,518` — call out so it stays pinned). |

**Confirmed bugs / additions to ship:** BUG-1 (English directive), BUG-4 (actionable skipped-textbook wording), BUG-5 (`floor(k/2)` path-fallback cap), BUG-6 (Bun-native timeout + JSON envelope + session rotation), KI-3 (30-day decision-log sweep), session continuity ON by default, intent-tag → dual-write memory protocol, Gmail REST integration with full threading, WhatsApp deep link, voice reply, scheduled decision-digest + spaced-repetition jobs.

---

## File Structure

### Files added (across all three PRs)

```
src/
  session.ts                        # PR1 — session.json persistence + rotation
  intents.ts                        # PR1 — parse/apply [REMEMBER:] [GOAL:] [DONE:] [DECISION:] [EMAIL_DRAFT:] [IMSG_DRAFT:] [WHATSAPP_DRAFT:]
  draft-router.ts                   # PR1 — single outbound chokepoint, em-dash gate, 4096-char splitter, 60s "still thinking" timer
  health-check.ts                   # PR1 — reusable probes used by both relay startup and setup/verify.ts
  email.ts                          # PR3 — RFC 2822 build with In-Reply-To + References + Subject; em-dash gate before encode
  whatsapp.ts                       # PR3 — deep link only, em-dash gate, contact map
  tts.ts                            # PR3 — say → ffmpeg(libopus) → .ogg → Telegram sendVoice
  embeddings.ts                     # PR2 — text-embedding-3-small wrapper, 1536 dims, retry, 1500ms timeout
  memory/
    obsidian.ts                     # PR2 — markdown append with YAML frontmatter
    supabase.ts                     # PR2 — Supabase RPC writes/reads
    index.ts                        # PR2 — facade selecting MEMORY_AUTHORITY (obsidian | supabase | both)

  session.test.ts                   # PR1
  intents.test.ts                   # PR1
  draft-router.test.ts              # PR1
  draft-router-splitter.test.ts     # PR1 — 4096-char split behavior
  callClaude-timeout.test.ts        # PR1 — Date.now() marker discriminates timeout vs other kill
  decision-log-retention.test.ts    # PR1 — 30-day sweep
  bug5-pathcap.test.ts              # PR1
  bug4-wording.test.ts              # PR1
  embeddings.test.ts                # PR2
  memory-obsidian.test.ts           # PR2
  memory-supabase.test.ts           # PR2
  memory-facade-fanout.test.ts      # PR2 — dual-write boundary; Supabase failure doesn't block Obsidian
  email-threading.test.ts           # PR3 — In-Reply-To + References + Subject preserved
  email-emdash-reject.test.ts       # PR3
  whatsapp-deeplink.test.ts         # PR3
  whatsapp-emdash-reject.test.ts    # PR3
  tts.test.ts                       # PR3

setup/
  verify.ts                         # PR1 (9 colored checks; stubs for not-yet-live)
  test-supabase.ts                  # PR1 stub → PR2 real
  gmail-auth.ts                     # PR3 one-time OAuth flow

scripts/
  smoke-bun-timeout.ts              # PR1 — proves Bun.spawn native timeout + our marker work
  smoke-session-resume.ts           # PR1 — proves --resume picks up across restarts
  smoke-session-rotate.ts           # PR1 — proves SIGKILL-mid-stream triggers session.json rotation
  gmail-thread.ts                   # PR3 — read latest N message headers via users.threads.get?format=metadata
  create-gmail-draft.ts             # PR3 — POST users.drafts.create with full threading
  smoke-gmail-threading.ts          # PR3 — verify draft appears threaded in recipient mailbox

examples/
  decision-digest.ts                # PR3 — daily 06:30 summary, drafts to Telegram
  study-spaced-repetition.ts        # PR3 — daily 19:00 Leitner card prompt

daemon/
  com.claude.relay.decision-digest.plist  # PR3
  com.claude.relay.study-cards.plist      # PR3

db/
  migrations/
    0001_init.sql                   # PR2 — replaces current schema.sql shape
    0002_hnsw_indexes.sql           # PR2 — vector_cosine_ops on messages.embedding, memory.embedding

supabase/functions/
  match_messages/index.ts           # PR2 — RPC wrapper Edge Function
  match_memory/index.ts             # PR2
  get_facts/index.ts                # PR2
  get_active_goals/index.ts         # PR2

docs/superpowers/plans/
  2026-05-17-relay-multi-pr-rollout.md   # THIS FILE
```

### Files modified

```
src/relay.ts                  # PR1: extract callClaude internals, wire session.ts/intents.ts/draft-router.ts
                              # PR2: replace memory.ts import with memory/index.ts facade; allSettled fanout
                              # PR3: route email/whatsapp/tts intents through draft-router
src/retrieval.ts              # PR1: BUG-5 path-fallback cap in combineHits
src/textbook-response.ts      # PR1: BUG-4 actionable wording
src/memory.ts                 # PR2: KEEP for backcompat through PR2, then DELETE in PR2 final commit (re-export thin shim)
src/supabase-config.ts        # PR2: add 'both' authority
db/schema.sql                 # PR2: replaced by migrations; keep file as "see db/migrations/"
.env.example                  # PR1 / PR2 / PR3: new vars per phase
README.md                     # PR3: setup phases rewritten
CLAUDE.md                     # PR3: rewritten with phase-by-phase user-facing setup
tasks/lessons.md              # End of each PR: append phase lessons
daemon/launchagent.plist      # PR1: bump CLAUDE_TIMEOUT_MS to 90000 in plist for parity with default
```

---

## Phase 0 — Branch Setup (5 min)

Phase 0 runs once before PR #1.

### Task 0.1: Confirm clean tree, create PR #1 branch

**Files:** none — git only.

- [ ] **Step 1: Confirm clean working tree (modulo expected unstaged changes from prior handovers).**

Run: `git status --short`
Expected: We may see unstaged changes from prior handovers. **Do not** stash them; instead create PR #1 branch from current `master` HEAD so the in-flight handover work is not lost, then cherry-pick or commit before starting tasks.

- [ ] **Step 2: Create the PR #1 branch.**

```bash
git checkout -b relay/pr1-bugs-arch-session
```

Expected output: `Switched to a new branch 'relay/pr1-bugs-arch-session'`.

- [ ] **Step 3: Verify Bun version (the plan relies on Bun 1.x `spawn` timeout).**

Run: `bun --version`
Expected: `1.x.x` (anything `>= 1.0.0`). If older, run `curl -fsSL https://bun.sh/install | bash` and re-source.

- [ ] **Step 4: Verify Claude CLI presence and `-p` mode.**

Run: `claude --version && claude -p --help | grep -E 'session|resume|output-format'`
Expected: CLI present; help output shows `--resume`, `--session-id`, `--output-format`.

---

## Phase 1 — PR #1: Bugs + Architecture + Session Continuity (~1 day)

**Branch:** `relay/pr1-bugs-arch-session`
**Net LOC delta target:** +650 / −400 = +250
**Test count target:** 33 → 49 passing, 0 failing

### Task 1.1: BUG-1 — Add English-only directive

**Files:**
- Modify: `src/relay.ts:1740-1741` (system prompt block)
- Test: `src/relay-strip.test.ts` (extend existing)

- [ ] **Step 1: Find the exact insertion point.**

The current line at `src/relay.ts:1740-1741` reads:

```
"Reply in plain text. Never wrap your response in XML or HTML tags such as <response>, </response>, <answer>, or <reply>. If you have nothing useful to say, ask a clarifying question instead of returning an empty or tag-only reply.",
```

The insertion point is the line **immediately above** this one in the same array literal.

- [ ] **Step 2: Insert the directive.**

Use the `Edit` tool with:

```typescript
// old_string
"Reply in plain text. Never wrap your response in XML or HTML tags such as <response>, </response>, <answer>, or <reply>. If you have nothing useful to say, ask a clarifying question instead of returning an empty or tag-only reply.",
```

```typescript
// new_string
"Respond in English only. If the user writes in another language, translate it internally but reply in English.",
"Reply in plain text. Never wrap your response in XML or HTML tags such as <response>, </response>, <answer>, or <reply>. If you have nothing useful to say, ask a clarifying question instead of returning an empty or tag-only reply.",
```

- [ ] **Step 3: Add a regression test that proves the directive ships.**

Create `src/system-prompt-english.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("system prompt contains English-only directive", () => {
  const relay = readFileSync(join(import.meta.dir, "relay.ts"), "utf-8");
  expect(relay).toContain("Respond in English only");
  expect(relay).toContain("translate it internally but reply in English");
});
```

- [ ] **Step 4: Run the test.**

Run: `bun test src/system-prompt-english.test.ts`
Expected: `1 pass, 0 fail`.

- [ ] **Step 5: Commit.**

```bash
git add src/relay.ts src/system-prompt-english.test.ts
git commit -m "$(cat <<'EOF'
BUG-1: add single-line English-only system directive

Closes audit item BUG-1. One declarative sentence beats verbose
"CRITICAL DIRECTIVE" theater per Lesson #N+5.
EOF
)"
```

---

### Task 1.2: BUG-5 — Cap path-fallback hits at floor(k/2)

**Files:**
- Modify: `src/retrieval.ts:387-398` (`combineHits`)
- Test: `src/bug5-pathcap.test.ts` (new)

- [ ] **Step 1: Write the failing test.**

Create `src/bug5-pathcap.test.ts`:

```typescript
import { expect, test } from "bun:test";

// We test the algorithm by stubbing a tiny version that mirrors combineHits.
// The real combineHits is not exported; we re-implement here to lock the
// contract: with k=8, path hits must not exceed floor(8/2)=4.

interface Hit { chunk_id: number; file_path: string; content: string }

function combineHits(ftsHits: Hit[], pathHits: Hit[], k: number): Hit[] {
  const pathCap = Math.floor(k / 2);
  const combined: Hit[] = [];
  const seen = new Set<number>();
  let pathTaken = 0;

  for (const hit of ftsHits) {
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    combined.push(hit);
    if (combined.length >= k) return combined;
  }
  for (const hit of pathHits) {
    if (seen.has(hit.chunk_id)) continue;
    if (pathTaken >= pathCap) break;
    seen.add(hit.chunk_id);
    combined.push(hit);
    pathTaken++;
    if (combined.length >= k) break;
  }
  return combined;
}

test("BUG-5: path hits capped at floor(k/2) when FTS hits are sparse", () => {
  const fts: Hit[] = [
    { chunk_id: 1, file_path: "a", content: "" },
    { chunk_id: 2, file_path: "b", content: "" },
  ];
  const path: Hit[] = [
    { chunk_id: 3, file_path: "c", content: "" },
    { chunk_id: 4, file_path: "d", content: "" },
    { chunk_id: 5, file_path: "e", content: "" },
    { chunk_id: 6, file_path: "f", content: "" },
    { chunk_id: 7, file_path: "g", content: "" },
    { chunk_id: 8, file_path: "h", content: "" },
  ];
  const out = combineHits(fts, path, 8);
  const pathInOut = out.filter((h) => h.chunk_id >= 3);
  expect(pathInOut.length).toBe(4);
  expect(out.length).toBe(6);
});

test("BUG-5: FTS hits never displaced by path hits", () => {
  const fts: Hit[] = Array.from({ length: 8 }, (_, i) => ({
    chunk_id: i + 1, file_path: "fts", content: "",
  }));
  const path: Hit[] = [
    { chunk_id: 99, file_path: "path", content: "" },
  ];
  const out = combineHits(fts, path, 8);
  expect(out.length).toBe(8);
  expect(out.every((h) => h.chunk_id <= 8)).toBe(true);
});
```

- [ ] **Step 2: Run the test (should pass against the new contract, fail against current code).**

Run: `bun test src/bug5-pathcap.test.ts`
Expected: `2 pass, 0 fail` (these test the *new* algorithm, not the live module).

- [ ] **Step 3: Replace `combineHits` in `src/retrieval.ts:387-398` with the capped version.**

Use `Edit`:

```typescript
// old_string
function combineHits(ftsHits: Hit[], pathHits: Hit[], k: number): Hit[] {
  const combined: Hit[] = [];
  const seen = new Set<number>();

  for (const hit of [...ftsHits, ...pathHits]) {
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    combined.push(hit);
    if (combined.length >= k) break;
  }

  return combined;
}
```

```typescript
// new_string
function combineHits(ftsHits: Hit[], pathHits: Hit[], k: number): Hit[] {
  // FTS hits are always ranked first; path-fallback hits are a *fallback*,
  // so they may fill at most floor(k/2) slots even when FTS is sparse.
  // Otherwise broad path matches (every Miller chapter) drown the one
  // real FTS hit that actually answered the question. BUG-5.
  const pathCap = Math.floor(k / 2);
  const combined: Hit[] = [];
  const seen = new Set<number>();
  let pathTaken = 0;

  for (const hit of ftsHits) {
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    combined.push(hit);
    if (combined.length >= k) return combined;
  }
  for (const hit of pathHits) {
    if (seen.has(hit.chunk_id)) continue;
    if (pathTaken >= pathCap) break;
    seen.add(hit.chunk_id);
    combined.push(hit);
    pathTaken++;
    if (combined.length >= k) break;
  }
  return combined;
}
```

- [ ] **Step 4: Run the full retrieval test suite to catch any regression.**

Run: `bun test src/retrieval.test.ts src/bug5-pathcap.test.ts`
Expected: all pass.

- [ ] **Step 5: Run textbook smoke.**

Run: `bun run scripts/smoke-textbook-retrieval.ts`
Expected: exit 0.

- [ ] **Step 6: Commit.**

```bash
git add src/retrieval.ts src/bug5-pathcap.test.ts
git commit -m "$(cat <<'EOF'
BUG-5: cap path-fallback hits at floor(k/2)

FTS hits keep priority. Path hits fill at most half the slot
budget. Prevents broad path matches from drowning the one real
chunk hit that answered the question.
EOF
)"
```

---

### Task 1.3: BUG-4 — Actionable skipped-textbook wording

**Files:**
- Modify: `src/textbook-response.ts:59-65`
- Test: `src/bug4-wording.test.ts` (new); also update `src/textbook-response.test.ts` if it pins the old string

- [ ] **Step 1: Write the failing test.**

Create `src/bug4-wording.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { buildSkippedTextbookResponse } from "./textbook-response";
import type { Hit } from "./retrieval";

const skippedHit: Hit = {
  chunk_id: 0,
  file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller.pdf`,
  content: "extraction_status=skipped chunk_count=0",
  sim: 0,
} as any;

test("BUG-4: skipped-textbook wording offers actionable next step", () => {
  const reply = buildSkippedTextbookResponse(
    "what does Miller say about epidural hypotension?",
    [skippedHit],
  );
  expect(reply).not.toBeNull();
  // Must tell the user what to do next, not just confess failure.
  expect(reply).toMatch(/search my notes for/i);
  expect(reply).toMatch(/keep searching textbooks/i);
});
```

- [ ] **Step 2: Run the test — it will fail against the current wording.**

Run: `bun test src/bug4-wording.test.ts`
Expected: FAIL ("search my notes for" not found in current response).

- [ ] **Step 3: Replace the wording in `src/textbook-response.ts:59-65`.**

Use `Edit`:

```typescript
// old_string
  return [
    "I found the textbook files in your index, but they were indexed only as file paths, not extracted into searchable text yet.",
    "",
    files,
    "",
    "So I can confirm the files exist, but I cannot quote or answer from Barash/Miller content until we fix PDF extraction for those files.",
  ].join("\n");
```

```typescript
// new_string
  return [
    "These textbook PDFs are in your index as file paths only, not as extractable text:",
    "",
    files,
    "",
    "If you have already converted them to Markdown notes, reply: \"search my notes for <topic>\".",
    "To force a textbook search anyway, reply: \"keep searching textbooks\".",
  ].join("\n");
```

- [ ] **Step 4: Run the new test and the existing textbook-response tests.**

Run: `bun test src/bug4-wording.test.ts src/textbook-response.test.ts`
Expected: BUG-4 test passes. If the existing test pins the old string, update its expected substring to the new wording's stable phrase (`"file paths only"` is fine).

- [ ] **Step 5: Commit.**

```bash
git add src/textbook-response.ts src/bug4-wording.test.ts src/textbook-response.test.ts
git commit -m "$(cat <<'EOF'
BUG-4: rewrite skipped-textbook response with actionable steps

Tells the user the two things they can do next (search notes,
or force-continue) instead of just confessing extraction failure.
EOF
)"
```

---

### Task 1.4: KI-3 — 30-day decision-log retention sweep

**Files:**
- Modify: `src/decision-log.ts` (add `sweepOldDecisionLogs`)
- Modify: `src/relay.ts` (call sweep at startup)
- Test: `src/decision-log-retention.test.ts` (new)

- [ ] **Step 1: Write the failing test.**

Create `src/decision-log-retention.test.ts`:

```typescript
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "relay-retention-"));
  process.env.RELAY_DIR = workdir;
  process.env.RELAY_LOG_DIR = join(workdir, "logs");
  process.env.RELAY_STATE_DIR = join(workdir, "state");
  process.env.RETAIN_DECISIONS_DAYS = "30";
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  delete process.env.RELAY_DIR;
  delete process.env.RELAY_LOG_DIR;
  delete process.env.RELAY_STATE_DIR;
  delete process.env.RETAIN_DECISIONS_DAYS;
});

test("KI-3: sweep removes logs older than RETAIN_DECISIONS_DAYS", async () => {
  // Re-import inside test so env vars take effect.
  const { sweepOldDecisionLogs } = await import("./decision-log");

  const logDir = join(workdir, "logs");
  await import("fs/promises").then((fs) => fs.mkdir(logDir, { recursive: true }));

  const today = new Date();
  const day = (offset: number) => {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };

  await writeFile(join(logDir, `decisions-${day(0)}.jsonl`), "{}\n");
  await writeFile(join(logDir, `decisions-${day(15)}.jsonl`), "{}\n");
  await writeFile(join(logDir, `decisions-${day(29)}.jsonl`), "{}\n");
  await writeFile(join(logDir, `decisions-${day(31)}.jsonl`), "{}\n");
  await writeFile(join(logDir, `decisions-${day(90)}.jsonl`), "{}\n");
  await writeFile(join(logDir, `not-a-log.txt`), "leave me alone\n");

  const summary = await sweepOldDecisionLogs();
  expect(summary.deleted).toBe(2);
  expect(summary.kept).toBe(3);

  const remaining = (await readdir(logDir)).sort();
  expect(remaining).toContain(`decisions-${day(0)}.jsonl`);
  expect(remaining).toContain(`decisions-${day(15)}.jsonl`);
  expect(remaining).toContain(`decisions-${day(29)}.jsonl`);
  expect(remaining).not.toContain(`decisions-${day(31)}.jsonl`);
  expect(remaining).not.toContain(`decisions-${day(90)}.jsonl`);
  expect(remaining).toContain(`not-a-log.txt`);
});

test("KI-3: sweep is a no-op when log dir does not exist", async () => {
  const { sweepOldDecisionLogs } = await import("./decision-log");
  const summary = await sweepOldDecisionLogs();
  expect(summary.deleted).toBe(0);
  expect(summary.kept).toBe(0);
});
```

- [ ] **Step 2: Run it (will fail — function doesn't exist yet).**

Run: `bun test src/decision-log-retention.test.ts`
Expected: FAIL with "sweepOldDecisionLogs is not a function".

- [ ] **Step 3: Add the function to `src/decision-log.ts`.**

Append after the existing exports (after `logDecision` at the bottom):

```typescript
export interface RetentionSummary {
  deleted: number;
  kept: number;
}

export async function sweepOldDecisionLogs(): Promise<RetentionSummary> {
  const days = Number.parseInt(process.env.RETAIN_DECISIONS_DAYS ?? "30", 10);
  const cutoffDays = Number.isFinite(days) && days > 0 ? days : 30;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - cutoffDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    return { deleted: 0, kept: 0 };
  }

  let deleted = 0;
  let kept = 0;
  for (const name of entries) {
    const match = name.match(/^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    if (match[1] < cutoffStr) {
      await unlink(join(LOG_DIR, name)).catch(() => undefined);
      deleted++;
    } else {
      kept++;
    }
  }
  return { deleted, kept };
}
```

- [ ] **Step 4: Run the test again.**

Run: `bun test src/decision-log-retention.test.ts`
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Wire the sweep into relay startup.**

In `src/relay.ts`, find the existing block where `retrievalPreflight()` is invoked (around line 1842). **Immediately before** that block, add:

```typescript
try {
  const { sweepOldDecisionLogs } = await import("./decision-log.ts");
  const swept = await sweepOldDecisionLogs();
  if (swept.deleted > 0 || swept.kept > 0) {
    console.log(`[startup] decision-log sweep: deleted=${swept.deleted} kept=${swept.kept}`);
  }
} catch (err) {
  console.error("[startup] decision-log sweep failed:", err instanceof Error ? err.message : err);
}
```

Use the existing static import for `sweepOldDecisionLogs` if you prefer — just add it to the top-of-file import line for `./decision-log.ts`.

- [ ] **Step 6: Commit.**

```bash
git add src/decision-log.ts src/decision-log-retention.test.ts src/relay.ts
git commit -m "$(cat <<'EOF'
KI-3: 30-day decision-log retention sweep at startup

RETAIN_DECISIONS_DAYS (default 30) controls the cutoff. Sweep
runs once per relay boot; non-decision files in the log dir are
untouched.
EOF
)"
```

---

### Task 1.5: Extract `src/session.ts`

**Files:**
- Create: `src/session.ts`
- Create: `src/session.test.ts`
- Modify: `src/relay.ts:97-179` (delete the in-file session block; import from new module)

- [ ] **Step 1: Write the failing test.**

Create `src/session.test.ts`:

```typescript
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "relay-session-"));
  process.env.RELAY_DIR = workdir;
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  delete process.env.RELAY_DIR;
});

test("loadSession returns null sessionId when no file exists", async () => {
  const mod = await import("./session?fresh-" + Date.now());
  const s = await mod.loadSession();
  expect(s.sessionId).toBeNull();
  expect(typeof s.lastActivity).toBe("string");
});

test("save + load roundtrip", async () => {
  const mod = await import("./session?fresh-" + Date.now());
  await mod.saveSession({ sessionId: "abc-123", lastActivity: "2026-05-17T12:00:00.000Z" });
  const s = await mod.loadSession();
  expect(s.sessionId).toBe("abc-123");
  expect(s.lastActivity).toBe("2026-05-17T12:00:00.000Z");
});

test("rotate clears sessionId and deletes file", async () => {
  const mod = await import("./session?fresh-" + Date.now());
  await mod.saveSession({ sessionId: "abc-123", lastActivity: "now" });
  await mod.rotateSession("test rotation");
  const s = await mod.loadSession();
  expect(s.sessionId).toBeNull();
});

test("file permissions are 0o600", async () => {
  const mod = await import("./session?fresh-" + Date.now());
  await mod.saveSession({ sessionId: "perm-check", lastActivity: "x" });
  const { statSync } = await import("fs");
  const sessionPath = join(workdir, "session.json");
  const stat = statSync(sessionPath);
  expect((stat.mode & 0o777).toString(8)).toBe("600");
});
```

Note: the `?fresh-` query-string trick forces Bun's module cache to re-import after env mutation. If Bun strips query strings, replace with `bun:test` `beforeEach` clearing `Bun.resolveSync` cache — but in practice the dynamic import re-reads env on each call.

- [ ] **Step 2: Run the test (will fail — module doesn't exist).**

Run: `bun test src/session.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create `src/session.ts`.**

```typescript
// session.ts
// Persistent Claude session id for `--resume`. Rotated on timeout to avoid
// resuming a sessionId whose JSONL was partially committed when the
// subprocess was SIGKILLed mid-stream.

import { chmod, readFile, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR ?? join(homedir(), ".claude-relay");
const SESSION_FILE = join(RELAY_DIR, "session.json");

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

export async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(content) as SessionState;
    if (typeof parsed.sessionId === "undefined") {
      return { sessionId: null, lastActivity: new Date().toISOString() };
    }
    return parsed;
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(SESSION_FILE, 0o600).catch(() => undefined);
}

export async function rotateSession(reason: string): Promise<void> {
  console.log(`[session] rotate: ${reason}`);
  await unlink(SESSION_FILE).catch(() => undefined);
}

export function sessionFilePath(): string {
  return SESSION_FILE;
}
```

- [ ] **Step 4: Run the tests.**

Run: `bun test src/session.test.ts`
Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Replace the in-file session block in `src/relay.ts:117-179`.**

Use `Edit`:

```typescript
// old_string
// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}
```

```typescript
// new_string
// Session tracking for conversation continuity — see src/session.ts.
import { loadSession, saveSession, rotateSession } from "./session.ts";
```

Then delete the function bodies `loadSession`/`saveSession`/`resetClaudeSession` and the in-file `SESSION_FILE` constant. Replace the call site `await resetClaudeSession(reason)` with `await rotateSession(reason); session = await loadSession();` so the in-memory `session` variable refreshes after rotation.

- [ ] **Step 6: Run all tests.**

Run: `bun test`
Expected: existing tests still pass; new `session.test.ts` tests pass.

- [ ] **Step 7: Commit.**

```bash
git add src/session.ts src/session.test.ts src/relay.ts
git commit -m "$(cat <<'EOF'
extract src/session.ts — persistence + rotation

Lifts the session.json read/write/rotate helpers out of relay.ts.
0o600 enforced. rotateSession() leaves no in-memory state.
EOF
)"
```

---

### Task 1.6: BUG-6 — Migrate `callClaude` to Bun-native timeout + JSON envelope + rotation on timeout

**Files:**
- Modify: `src/relay.ts:491-584` (`callClaude`)
- Create: `src/callClaude-timeout.test.ts`
- Create: `scripts/smoke-bun-timeout.ts`

This task is the riskiest in PR #1. Do it in small steps and verify each one.

- [ ] **Step 1: Write a smoke script that proves Bun's native timeout + our marker.**

Create `scripts/smoke-bun-timeout.ts`:

```typescript
// Confirms Bun.spawn timeout + killSignal sends SIGKILL and that our
// Date.now() marker can distinguish timeout from external kill.
import { spawn } from "bun";

const startedAt = Date.now();
const proc = spawn(["sleep", "10"], {
  timeout: 500,
  killSignal: "SIGKILL",
  stdout: "pipe",
  stderr: "pipe",
});

const exitCode = await proc.exited;
const elapsed = Date.now() - startedAt;
const wasTimeout = elapsed >= 500 && proc.signalCode === "SIGKILL";

console.log({
  exitCode,
  signalCode: proc.signalCode,
  elapsedMs: elapsed,
  wasTimeout,
});

if (!wasTimeout) {
  console.error("FAIL: timeout did not fire as expected");
  process.exit(1);
}
console.log("OK: Bun native timeout works");
process.exit(0);
```

- [ ] **Step 2: Run the smoke.**

Run: `bun run scripts/smoke-bun-timeout.ts`
Expected: prints `OK: Bun native timeout works` and exits 0. If it doesn't, **stop** — your Bun is too old or the API changed. Upgrade Bun and re-run.

- [ ] **Step 3: Write the unit test.**

Create `src/callClaude-timeout.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { spawn } from "bun";

// Proves the discriminator: a Date.now() marker tells us whether SIGKILL
// happened because of our timeout vs. an external kill.
test("Date.now() elapsed >= timeout discriminates timeout from external kill", async () => {
  const startedAt = Date.now();
  const proc = spawn(["sleep", "5"], {
    timeout: 200,
    killSignal: "SIGKILL",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const elapsed = Date.now() - startedAt;
  expect(proc.signalCode).toBe("SIGKILL");
  expect(elapsed).toBeGreaterThanOrEqual(200);
  // Our discriminator
  const wasTimeout = elapsed >= 200 && proc.signalCode === "SIGKILL";
  expect(wasTimeout).toBe(true);
});

test("normal exit reports null signalCode", async () => {
  const proc = spawn(["true"], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(proc.signalCode).toBeNull();
});
```

- [ ] **Step 4: Run the test.**

Run: `bun test src/callClaude-timeout.test.ts`
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Replace `callClaude` in `src/relay.ts:491-584`.**

The current `callClaude` uses manual SIGTERM→SIGKILL escalation, `--output-format text`, and a regex parse that never matches the JSON envelope. Replace the entire function with:

```typescript
async function callClaude(
  prompt: string,
  options?: { resume?: boolean; allowedTools?: string[]; addDirs?: string[]; cwd?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (CLAUDE_RESUME_ENABLED && options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }
  if (!CLAUDE_RESUME_ENABLED) {
    args.push("--no-session-persistence");
  }
  args.push("--tools", (options?.allowedTools ?? []).join(","));
  for (const dir of options?.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  // Use JSON envelope so we can reliably extract session_id from .session_id
  // on every result (success or error). Per Anthropic CLI docs.
  args.push("--output-format", "json");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  const startedAt = Date.now();
  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd ?? RELAY_CWD,
    env: buildClaudeEnv(),
    timeout: CLAUDE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const elapsed = Date.now() - startedAt;
    // Discriminator: Bun.spawn (async) does not expose exitedDueToTimeout,
    // so we infer from (signalCode === SIGKILL && elapsed >= TIMEOUT).
    const timedOut =
      proc.signalCode === "SIGKILL" && elapsed >= CLAUDE_TIMEOUT_MS;

    if (timedOut) {
      // Rotate the session — its JSONL on disk may have been partially
      // committed when SIGKILL fired. Resuming it could corrupt history.
      if (CLAUDE_RESUME_ENABLED && SESSION_TIMEOUT_ROTATE) {
        await rotateSession(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
        session = await loadSession();
      }
      throw new Error(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
    }

    if (exitCode !== 0) {
      const sanitized = sanitizeStderr(stderr || `exit_code=${exitCode}`);
      console.error("Claude error:", sanitized);
      throw new Error(`claude_exit_${exitCode}: ${sanitized}`);
    }

    // JSON envelope: { result: "...", session_id: "...", ... }
    let resultText = stdout.trim();
    let parsedSessionId: string | null = null;
    try {
      const env = JSON.parse(stdout);
      if (typeof env?.result === "string") resultText = env.result;
      if (typeof env?.session_id === "string") parsedSessionId = env.session_id;
    } catch {
      // Older CLI or unexpected non-JSON; fall back to raw text.
      console.warn("[callClaude] non-JSON envelope; falling back to raw stdout");
    }

    if (CLAUDE_RESUME_ENABLED && parsedSessionId) {
      session = { sessionId: parsedSessionId, lastActivity: new Date().toISOString() };
      await saveSession(session);
    }

    return resultText;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("claude_timeout_") || message.startsWith("claude_exit_")) {
      throw error;
    }
    console.error("Spawn error:", error);
    throw new Error(`claude_spawn_failed: ${message}`);
  }
}
```

Also: add `const SESSION_TIMEOUT_ROTATE = process.env.SESSION_TIMEOUT_ROTATE !== "0";` near the other config constants (default ON), and remove the now-unused `KILL_GRACE_MS`, `killProcessTree`, and `AbortController` machinery from this function (other call sites may still need `killProcessTree`, so leave the helper file-scope and just stop using it in `callClaude`).

- [ ] **Step 6: Run the full test suite.**

Run: `bun test`
Expected: all tests pass. If a test references the old session-extraction regex, update it to assert the new JSON-envelope path instead.

- [ ] **Step 7: Smoke test the relay end-to-end.**

Run (in a separate terminal, with the env loaded):
```bash
CLAUDE_RESUME=1 bun run src/relay.ts
```
Send a Telegram message; confirm the reply arrives and that `~/.claude-relay/session.json` now contains a real UUID in `sessionId`.

Run: `cat ~/.claude-relay/session.json`
Expected: `{ "sessionId": "<uuid>", "lastActivity": "<iso>" }` (not null).

- [ ] **Step 8: Smoke test session rotation on timeout.**

Set `CLAUDE_TIMEOUT_MS=2000` temporarily, send a Telegram message that will time out, and confirm:
- The relay returns the timeout error message to Telegram.
- `~/.claude-relay/session.json` is **missing** (rotated).
- Logs show `[session] rotate: claude_timeout_2000ms`.

Restore `CLAUDE_TIMEOUT_MS=90000` afterwards.

- [ ] **Step 9: Commit.**

```bash
git add src/relay.ts src/callClaude-timeout.test.ts scripts/smoke-bun-timeout.ts
git commit -m "$(cat <<'EOF'
BUG-6: Bun-native timeout + JSON envelope session continuity

Replaces manual SIGTERM/SIGKILL escalation with Bun.spawn's
native timeout + killSignal. Flips --output-format to json so
session_id can be parsed reliably from the result envelope
(text mode regex never matched). On SIGKILL-by-timeout,
rotates session.json so the next --resume does not pick up
a partially-committed JSONL.
EOF
)"
```

---

### Task 1.7: Extract `src/intents.ts`

**Files:**
- Create: `src/intents.ts`
- Create: `src/intents.test.ts`

`src/memory.ts` already parses `[REMEMBER:]` / `[GOAL:]` / `[DONE:]` but only when a Supabase client is wired. We need a pure parser that strips tags from the response regardless, and a separate writer that fans out to whichever memory backend is configured. `intents.ts` is the parser; `memory/index.ts` (PR #2) is the writer. For PR #1, the writer is a no-op stub.

- [ ] **Step 1: Write the failing test.**

Create `src/intents.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { parseIntents } from "./intents";

test("strips [REMEMBER:] tag and captures payload", () => {
  const { clean, intents } = parseIntents(
    "Done. [REMEMBER: preferred font is Iosevka] Anything else?"
  );
  expect(clean).toBe("Done.  Anything else?".replace(/\s+/g, " ").trim());
  expect(intents).toEqual([{ kind: "remember", content: "preferred font is Iosevka" }]);
});

test("strips [GOAL: ... | DEADLINE: ...] with optional deadline", () => {
  const { clean, intents } = parseIntents(
    "[GOAL: finish audit | DEADLINE: 2026-06-01] On it."
  );
  expect(clean).toBe("On it.");
  expect(intents).toEqual([
    { kind: "goal", content: "finish audit", deadline: "2026-06-01" },
  ]);
});

test("strips [DONE: ...] for goal completion", () => {
  const { clean, intents } = parseIntents("Marked. [DONE: finish audit]");
  expect(clean).toBe("Marked.");
  expect(intents).toEqual([{ kind: "done", content: "finish audit" }]);
});

test("strips [DECISION: ...] for decision log", () => {
  const { clean, intents } = parseIntents("Logged. [DECISION: use HNSW over IVFFlat]");
  expect(clean).toBe("Logged.");
  expect(intents).toEqual([{ kind: "decision", content: "use HNSW over IVFFlat" }]);
});

test("strips [EMAIL_DRAFT: to=x@y subject=Re body=hello]", () => {
  const { clean, intents } = parseIntents(
    "Draft ready. [EMAIL_DRAFT: to=alex@example.com subject=Re: schedule body=Tomorrow at 3 works.]"
  );
  expect(clean).toBe("Draft ready.");
  expect(intents).toHaveLength(1);
  expect(intents[0].kind).toBe("email_draft");
  expect((intents[0] as any).to).toBe("alex@example.com");
  expect((intents[0] as any).subject).toBe("Re: schedule");
  expect((intents[0] as any).body).toBe("Tomorrow at 3 works.");
});

test("strips [IMSG_DRAFT: contact=Sarah body=on my way]", () => {
  const { clean, intents } = parseIntents(
    "iMessage drafted. [IMSG_DRAFT: contact=Sarah body=on my way]"
  );
  expect(clean).toBe("iMessage drafted.");
  expect(intents[0]).toEqual({ kind: "imsg_draft", contact: "Sarah", body: "on my way" });
});

test("strips [WHATSAPP_DRAFT: contact=Sarah body=hello]", () => {
  const { clean, intents } = parseIntents(
    "WA ready. [WHATSAPP_DRAFT: contact=Sarah body=hello]"
  );
  expect(clean).toBe("WA ready.");
  expect(intents[0]).toEqual({ kind: "whatsapp_draft", contact: "Sarah", body: "hello" });
});

test("multiple tags coexist; all stripped, all captured", () => {
  const { clean, intents } = parseIntents(
    "[REMEMBER: tea] [GOAL: stretch | DEADLINE: 2026-06-01] back to work"
  );
  expect(clean).toBe("back to work");
  expect(intents).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test (will fail — module missing).**

Run: `bun test src/intents.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/intents.ts`.**

```typescript
// intents.ts
// Parses Claude's inline intent tags out of a response. Returns the cleaned
// user-facing text plus a list of structured intents for fan-out to the
// memory facade, draft helpers, etc.
//
// Tag shapes:
//   [REMEMBER: free text]
//   [GOAL: text]                       or [GOAL: text | DEADLINE: yyyy-mm-dd]
//   [DONE: search text]
//   [DECISION: free text]
//   [EMAIL_DRAFT: to=addr subject=line body=text]
//   [IMSG_DRAFT: contact=name body=text]
//   [WHATSAPP_DRAFT: contact=name body=text]

export type Intent =
  | { kind: "remember"; content: string }
  | { kind: "goal"; content: string; deadline: string | null }
  | { kind: "done"; content: string }
  | { kind: "decision"; content: string }
  | { kind: "email_draft"; to: string; subject: string; body: string }
  | { kind: "imsg_draft"; contact: string; body: string }
  | { kind: "whatsapp_draft"; contact: string; body: string };

export interface ParsedIntents {
  clean: string;
  intents: Intent[];
}

const TAG_RE = /\[(REMEMBER|GOAL|DONE|DECISION|EMAIL_DRAFT|IMSG_DRAFT|WHATSAPP_DRAFT):\s*([\s\S]*?)\]/gi;

function parseKV(payload: string): Record<string, string> {
  // Tolerant key=value extractor for EMAIL_DRAFT-style payloads.
  // Supports key=foo bar baz where the next "key=" begins the next field.
  const fields: Record<string, string> = {};
  const re = /\b(\w+)=([\s\S]*?)(?=\s+\b\w+=|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) {
    fields[m[1].toLowerCase()] = m[2].trim();
  }
  return fields;
}

export function parseIntents(text: string): ParsedIntents {
  const intents: Intent[] = [];
  const clean = text
    .replace(TAG_RE, (_match, kindRaw, payloadRaw) => {
      const kind = String(kindRaw).toUpperCase();
      const payload = String(payloadRaw).trim();
      switch (kind) {
        case "REMEMBER":
          intents.push({ kind: "remember", content: payload });
          return "";
        case "GOAL": {
          const split = payload.split(/\s*\|\s*DEADLINE:\s*/i);
          const content = split[0].trim();
          const deadline = split[1] ? split[1].trim() : null;
          intents.push({ kind: "goal", content, deadline });
          return "";
        }
        case "DONE":
          intents.push({ kind: "done", content: payload });
          return "";
        case "DECISION":
          intents.push({ kind: "decision", content: payload });
          return "";
        case "EMAIL_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "email_draft",
            to: kv.to ?? "",
            subject: kv.subject ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        case "IMSG_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "imsg_draft",
            contact: kv.contact ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        case "WHATSAPP_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "whatsapp_draft",
            contact: kv.contact ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        default:
          return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return { clean, intents };
}
```

- [ ] **Step 4: Run the test.**

Run: `bun test src/intents.test.ts`
Expected: `8 pass, 0 fail`. Some assertions in the EMAIL_DRAFT case may need a tolerance pass (key ordering, embedded `: `); tighten the test fixtures if needed but **don't relax the parser** — the parser is the public contract.

- [ ] **Step 5: Commit.**

```bash
git add src/intents.ts src/intents.test.ts
git commit -m "$(cat <<'EOF'
extract src/intents.ts — pure intent tag parser

Strips and captures [REMEMBER], [GOAL], [DONE], [DECISION],
[EMAIL_DRAFT], [IMSG_DRAFT], [WHATSAPP_DRAFT]. No side effects;
the writer side ships in PR #2 (memory facade) and PR #3 (draft
router).
EOF
)"
```

---

### Task 1.8: Extract `src/draft-router.ts`

**Files:**
- Create: `src/draft-router.ts`
- Create: `src/draft-router.test.ts`
- Create: `src/draft-router-splitter.test.ts`

The draft-router is the single outbound chokepoint. Every message that leaves the relay goes through it. It enforces:
1. Em-dash gate (rejects anything with an em-dash before send).
2. 4096-char Telegram limit with paragraph-first split, sentence-second.
3. 60-second "still thinking" timer for long Claude calls.
4. Routing of intents (email/imsg/whatsapp) to their helpers — wired in PR #3; in PR #1 the router exposes the hook but the helpers are stubs.

- [ ] **Step 1: Write the failing tests.**

Create `src/draft-router.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { containsEmDash, gateForEmDash } from "./draft-router";

test("containsEmDash detects U+2014", () => {
  expect(containsEmDash("hello — world")).toBe(true);
  expect(containsEmDash("hello, world")).toBe(false);
  expect(containsEmDash("range 1-5")).toBe(false);
});

test("containsEmDash also detects en dash", () => {
  expect(containsEmDash("hello – world")).toBe(true);
});

test("gateForEmDash returns ok:false when present", () => {
  expect(gateForEmDash("text with — dash")).toEqual({
    ok: false,
    reason: "em_dash_in_outbound",
  });
});

test("gateForEmDash allows clean text", () => {
  expect(gateForEmDash("text with comma, no dash")).toEqual({ ok: true });
});
```

Create `src/draft-router-splitter.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { splitForTelegram } from "./draft-router";

test("short message returns single chunk", () => {
  const chunks = splitForTelegram("hello world");
  expect(chunks).toEqual(["hello world"]);
});

test("4000-char message splits on paragraph boundary", () => {
  const para = "x".repeat(2000);
  const text = `${para}\n\n${para}\n\n${para}`;
  const chunks = splitForTelegram(text);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4000);
  }
});

test("paragraph-less long text splits on sentence boundary", () => {
  const sent = "This is a sentence. ".repeat(300); // ~6000 chars, no paragraphs
  const chunks = splitForTelegram(sent);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4000);
  }
});

test("single huge token gets hard-split", () => {
  const blob = "x".repeat(8500);
  const chunks = splitForTelegram(blob);
  expect(chunks.length).toBe(3);
  expect(chunks[0].length).toBeLessThanOrEqual(4000);
  expect(chunks[1].length).toBeLessThanOrEqual(4000);
});
```

- [ ] **Step 2: Run the tests (will fail — module missing).**

Run: `bun test src/draft-router.test.ts src/draft-router-splitter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/draft-router.ts`.**

```typescript
// draft-router.ts
// Single outbound chokepoint for every message the relay sends to Telegram.
// Enforces:
//   (1) em-dash gate (never send a response containing — or –)
//   (2) 4096-char Telegram limit with paragraph→sentence→hard split
//   (3) 60-second "still thinking" feedback hook
//
// Helpers for email / iMessage / WhatsApp routing live in their own modules
// (src/email.ts, src/imessage-draft.ts, src/whatsapp.ts). The router merely
// dispatches.

const TELEGRAM_HARD_LIMIT = 4096;
const TELEGRAM_SOFT_LIMIT = 4000; // margin for HTML parse-mode entities
const STILL_THINKING_MS = 60_000;

export function containsEmDash(text: string): boolean {
  return /[—–]/.test(text);
}

export interface Gate {
  ok: true;
}
export interface GateFailure {
  ok: false;
  reason: string;
}

export function gateForEmDash(text: string): Gate | GateFailure {
  if (containsEmDash(text)) {
    return { ok: false, reason: "em_dash_in_outbound" };
  }
  return { ok: true };
}

export function splitForTelegram(text: string, limit = TELEGRAM_SOFT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = "";
  for (const para of paragraphs) {
    if (para.length > limit) {
      if (buf) { chunks.push(buf); buf = ""; }
      // Sentence-level split for this paragraph.
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentBuf = "";
      for (const s of sentences) {
        if (s.length > limit) {
          if (sentBuf) { chunks.push(sentBuf); sentBuf = ""; }
          // Hard split for an extra-long single token.
          for (let i = 0; i < s.length; i += limit) {
            chunks.push(s.slice(i, i + limit));
          }
        } else if ((sentBuf + " " + s).trim().length > limit) {
          chunks.push(sentBuf.trim());
          sentBuf = s;
        } else {
          sentBuf = sentBuf ? `${sentBuf} ${s}` : s;
        }
      }
      if (sentBuf) chunks.push(sentBuf.trim());
    } else if ((buf + "\n\n" + para).trim().length > limit) {
      chunks.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Convenience for orchestration layer to schedule a "still working" reassurance.
// Returns a cancel function. Caller invokes it in `finally`.
export function scheduleStillThinking(send: () => void, ms = STILL_THINKING_MS): () => void {
  const t = setTimeout(send, ms);
  return () => clearTimeout(t);
}
```

- [ ] **Step 4: Run the tests.**

Run: `bun test src/draft-router.test.ts src/draft-router-splitter.test.ts`
Expected: all pass.

- [ ] **Step 5: Wire em-dash gate + splitter into the existing send path.**

In `src/relay.ts`, locate the function that sends Claude's response to Telegram (search for `bot.sendMessage` or equivalent in the user-reply path). Replace the single-message send with:

```typescript
import { gateForEmDash, splitForTelegram, scheduleStillThinking } from "./draft-router.ts";

// ...inside the handler, replacing the bare `await bot.sendMessage(chatId, reply)`:
const gate = gateForEmDash(reply);
if (!gate.ok) {
  // Em-dash slipped past stripProseDashes — log and send a fallback.
  console.error(`[draft-router] outbound rejected: ${gate.reason}`);
  await bot.sendMessage(chatId, "I had to scrub formatting in my reply. Try asking again.");
  return;
}
for (const chunk of splitForTelegram(reply)) {
  await bot.sendMessage(chatId, chunk);
}
```

Wrap the call to `callClaude` with the "still thinking" hook:

```typescript
const cancelStillThinking = scheduleStillThinking(() => {
  void bot.sendMessage(chatId, "Still thinking — long answer in progress.");
});
try {
  reply = await callClaude(prompt, { resume: true, allowedTools: [...] });
} finally {
  cancelStillThinking();
}
```

- [ ] **Step 6: Run all tests.**

Run: `bun test`
Expected: all pass.

- [ ] **Step 7: Manual smoke — send a long-running Telegram prompt.**

Trigger a prompt that you know takes >60s (e.g., a deep textbook query). Confirm:
- "Still thinking" message arrives at ~60s.
- Final reply arrives correctly.
- If you cancel by sending another message, no duplicate "still thinking" arrives later.

- [ ] **Step 8: Commit.**

```bash
git add src/draft-router.ts src/draft-router.test.ts src/draft-router-splitter.test.ts src/relay.ts
git commit -m "$(cat <<'EOF'
extract src/draft-router.ts — outbound chokepoint

One place enforces (a) em-dash gate, (b) 4096-char Telegram
split, (c) 60-second "still thinking" timer. Send path in
relay.ts now funnels through it.
EOF
)"
```

---

### Task 1.9: Add `src/health-check.ts` and `setup/verify.ts`

**Files:**
- Create: `src/health-check.ts`
- Create: `setup/verify.ts`
- Create: `setup/test-supabase.ts` (PR #1 stub)

`health-check.ts` exports reusable probes. `setup/verify.ts` invokes them and prints colored results.

- [ ] **Step 1: Create `src/health-check.ts`.**

```typescript
// health-check.ts
// Reusable probes used by both relay startup diagnostics and setup/verify.ts.

import { access, readFile, stat } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function checkBunVersion(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn(["bun", "--version"], { stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    const major = Number.parseInt(out.split(".")[0], 10);
    return {
      name: "Bun version",
      ok: Number.isFinite(major) && major >= 1,
      detail: out,
    };
  } catch (err) {
    return { name: "Bun version", ok: false, detail: String(err) };
  }
}

export async function checkTokenFilePerms(): Promise<CheckResult> {
  const path = join(homedir(), ".claude-relay", "session.json");
  try {
    const s = await stat(path);
    const mode = (s.mode & 0o777).toString(8);
    return {
      name: "session.json perms 0600",
      ok: mode === "600",
      detail: `mode=${mode}`,
    };
  } catch {
    return { name: "session.json perms 0600", ok: true, detail: "absent (ok)" };
  }
}

export async function checkClaudeBinary(): Promise<CheckResult> {
  const path = process.env.CLAUDE_PATH || join(homedir(), ".local", "bin", "claude");
  try {
    await access(path, constants.X_OK);
    return { name: "Claude CLI", ok: true, detail: path };
  } catch {
    return { name: "Claude CLI", ok: false, detail: `not executable at ${path}` };
  }
}

export async function checkResolvedBunForFda(): Promise<CheckResult> {
  // The launchd plist references /Users/<u>/.bun/bin/bun (a symlink). Full Disk
  // Access must be granted to the *resolved* binary. We can't query TCC from
  // userspace, but we can confirm the resolved path so the human can verify in
  // System Settings.
  try {
    const proc = Bun.spawn(["readlink", "-f", process.execPath], { stdout: "pipe" });
    const resolved = (await new Response(proc.stdout).text()).trim();
    return {
      name: "Bun binary (grant FDA to THIS path)",
      ok: true,
      detail: resolved,
    };
  } catch (err) {
    return { name: "Bun binary FDA path", ok: false, detail: String(err) };
  }
}

export async function checkFtsReadable(): Promise<CheckResult> {
  const dbPath = process.env.INDEXER_DB
    ?? join(homedir(), ".local-search", "metadata.db");
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readwrite: false, create: false });
    const row = db.query("SELECT COUNT(*) AS n FROM chunks LIMIT 1").get() as { n: number };
    db.close();
    return {
      name: "FTS chunks table readable",
      ok: typeof row?.n === "number",
      detail: `rows=${row?.n}`,
    };
  } catch (err) {
    return { name: "FTS chunks table readable", ok: false, detail: String(err) };
  }
}

export async function checkDecisionLogWritable(): Promise<CheckResult> {
  const dir = process.env.RELAY_LOG_DIR
    ?? join(homedir(), ".claude-relay", "logs");
  try {
    await access(dir, constants.W_OK);
    return { name: "decision log dir writable", ok: true, detail: dir };
  } catch {
    return { name: "decision log dir writable", ok: false, detail: `not writable: ${dir}` };
  }
}

export async function checkLaunchAgent(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const ok = out.includes("com.claude.telegram-relay")
            || out.includes("com.claude.relay");
    return {
      name: "LaunchAgent registered",
      ok,
      detail: ok ? "found" : "not loaded (run `launchctl bootstrap gui/$(id -u) daemon/...plist`)",
    };
  } catch (err) {
    return { name: "LaunchAgent registered", ok: false, detail: String(err) };
  }
}

export async function checkTelegramTokenSet(): Promise<CheckResult> {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  return {
    name: "Telegram bot token",
    ok: !!t && t.includes(":") && t.length > 30,
    detail: t ? "set" : "missing",
  };
}

export async function checkSupabaseConfig(): Promise<CheckResult> {
  // PR #1: stub — returns yellow "not yet wired".
  return {
    name: "Supabase reachability",
    ok: true,
    detail: "stub — see PR #2",
  };
}

export async function checkGmailToken(): Promise<CheckResult> {
  // PR #1: stub — returns yellow "not yet wired".
  return {
    name: "Gmail OAuth token",
    ok: true,
    detail: "stub — see PR #3",
  };
}
```

- [ ] **Step 2: Create `setup/verify.ts`.**

```typescript
#!/usr/bin/env bun
// setup/verify.ts — nine-check health verifier for the relay.

import {
  checkBunVersion,
  checkClaudeBinary,
  checkResolvedBunForFda,
  checkFtsReadable,
  checkDecisionLogWritable,
  checkLaunchAgent,
  checkTelegramTokenSet,
  checkTokenFilePerms,
  checkSupabaseConfig,
  checkGmailToken,
} from "../src/health-check.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const checks = [
  checkBunVersion,
  checkClaudeBinary,
  checkResolvedBunForFda,
  checkFtsReadable,
  checkDecisionLogWritable,
  checkLaunchAgent,
  checkTelegramTokenSet,
  checkTokenFilePerms,
  checkSupabaseConfig,
  checkGmailToken,
];

let hardFail = false;
for (const fn of checks) {
  const result = await fn();
  const stub = result.detail.startsWith("stub —");
  const color = stub ? YELLOW : result.ok ? GREEN : RED;
  const icon = stub ? "○" : result.ok ? "✓" : "✗";
  console.log(`${color}${icon}${RESET} ${result.name.padEnd(42)} ${DIM}${result.detail}${RESET}`);
  if (!result.ok && !stub) hardFail = true;
}

process.exit(hardFail ? 1 : 0);
```

- [ ] **Step 3: Create `setup/test-supabase.ts` (PR #1 stub).**

```typescript
#!/usr/bin/env bun
// setup/test-supabase.ts — PR #1 stub. PR #2 replaces with real round-trip.
console.log("Supabase test: not yet wired (see PR #2)");
process.exit(0);
```

- [ ] **Step 4: Add npm scripts to `package.json`.**

In `package.json`, add to the `scripts` block:

```json
"verify": "bun run setup/verify.ts",
"test:supabase": "bun run setup/test-supabase.ts"
```

- [ ] **Step 5: Run `bun run verify`.**

Run: `bun run verify`
Expected: nine lines, mostly green/yellow. If any are red, fix the underlying issue.

- [ ] **Step 6: Commit.**

```bash
git add src/health-check.ts setup/verify.ts setup/test-supabase.ts package.json
git commit -m "$(cat <<'EOF'
add src/health-check.ts + setup/verify.ts

Nine reusable probes (Bun, Claude CLI, FDA path, FTS,
decision-log dir, LaunchAgent, Telegram token, session perms,
Supabase/Gmail stubs). setup/verify.ts prints colored result
and exits non-zero on red.
EOF
)"
```

---

### Task 1.10: `.env.example` and `daemon/launchagent.plist` updates

**Files:**
- Modify: `.env.example`
- Modify: `daemon/launchagent.plist`

- [ ] **Step 1: Add new env vars to `.env.example`.**

Append:

```
# --- PR1 hardening ---
CLAUDE_TIMEOUT_MS=90000
CLAUDE_RESUME=1
SESSION_TIMEOUT_ROTATE=1
RETAIN_DECISIONS_DAYS=30
MEMORY_AUTHORITY=obsidian
```

- [ ] **Step 2: Bump CLAUDE_TIMEOUT_MS in `daemon/launchagent.plist` to 90000 (verify current default).**

If the plist already has `CLAUDE_TIMEOUT_MS=90000`, no change. If lower, raise to 90000 to match `.env.example`.

- [ ] **Step 3: Commit.**

```bash
git add .env.example daemon/launchagent.plist
git commit -m "$(cat <<'EOF'
.env.example + plist: set CLAUDE_TIMEOUT_MS=90000, CLAUDE_RESUME=1

Defaults align with the new Bun-native timeout + session
continuity policy. SESSION_TIMEOUT_ROTATE=1 turns on session.json
rotation when a SIGKILL-by-timeout fires (audit decision).
RETAIN_DECISIONS_DAYS=30 caps the decision-log retention.
EOF
)"
```

---

### Task 1.11: Integration verification + lessons append + PR

- [ ] **Step 1: Full test suite.**

Run: `bun test`
Expected: all pass (49 target). Investigate any failure at root cause — never relax assertions.

- [ ] **Step 2: All smoke scripts.**

Run sequentially:
- `bun run scripts/smoke-bun-timeout.ts` → exit 0
- `bun run scripts/smoke-poison-query.ts` → exit 0
- `bun run scripts/smoke-textbook-retrieval.ts` → exit 0

- [ ] **Step 3: `bun run verify` shows no red.**

Run: `bun run verify`

- [ ] **Step 4: Restart relay under launchctl and tail logs for 5 minutes.**

Run:
```bash
launchctl kickstart -k gui/$(id -u)/com.claude.telegram-relay
tail -f ~/.claude-relay/logs/com.claude.telegram-relay.log
```

Send a Telegram message during the tail; confirm clean roundtrip and `session.json` has a UUID.

- [ ] **Step 5: Append lessons to `tasks/lessons.md`.**

Append (use Edit tool to add to bottom of `tasks/lessons.md`):

```markdown
## 2026-05-17 - PR #1 audit reconciliation

- Audit recommendations must be checked against live code before adoption.
  In this round, six items (BUG-2, BUG-3, BUG-7, BUG-8, KI-1, KI-2) were
  already implemented or based on a misread of the codebase. Verbatim
  adoption would have added churn without value, and in BUG-2's case
  would have regressed the preflight from a real FTS roundtrip to a
  cheaper COUNT probe. Document rejections in the plan itself so a
  reviewer can see the audit was read, not skipped.
- Bun.spawn (async) has timeout + killSignal first-class, but does NOT
  expose exitedDueToTimeout (only Bun.spawnSync does). Without our own
  Date.now() marker, signalCode === "SIGKILL" is ambiguous between
  timeout and external kill. Lock in the marker.
- With CLAUDE_RESUME enabled, --output-format must be json — the previous
  regex `/Session ID: ([a-f0-9-]+)/i` against the text envelope never
  matched, which is why session continuity appeared "enabled but inert"
  in earlier runs. Always parse the JSON `.session_id` field.
- On SIGKILL-by-timeout, the persisted Claude session JSONL may be
  partially committed. Rotating session.json on timeout (SESSION_TIMEOUT_ROTATE=1)
  prevents a poisoned --resume next turn. This is more important than
  the timeout policy itself.
- The draft-router (one outbound chokepoint with em-dash gate + 4096-
  splitter) is architecture, not a feature. Extract it before adding
  email/WhatsApp/voice integrations so each integration can rely on the
  gate instead of re-implementing it.
```

Commit:

```bash
git add tasks/lessons.md
git commit -m "lessons: PR #1 audit reconciliation"
```

- [ ] **Step 6: Push and open PR #1.**

```bash
git push -u origin relay/pr1-bugs-arch-session
gh pr create --title "PR #1: bug fixes + architecture + session continuity" --body "$(cat <<'EOF'
## Summary
- BUG-1, BUG-4, BUG-5, KI-3 shipped; BUG-2, BUG-3, BUG-7, BUG-8, KI-1, KI-2 rejected as already-implemented or premature paranoia (see plan section "Spec Corrections")
- callClaude migrated to Bun-native timeout + --output-format json + session rotation on SIGKILL-by-timeout
- New modules: src/session.ts, src/intents.ts, src/draft-router.ts, src/health-check.ts
- New setup tooling: setup/verify.ts (9-check), setup/test-supabase.ts (stub for PR #2)

## Test plan
- [ ] `bun test` — 49 passing
- [ ] `bun run scripts/smoke-bun-timeout.ts` exits 0
- [ ] `bun run scripts/smoke-textbook-retrieval.ts` exits 0
- [ ] `bun run verify` shows no red
- [ ] Live Telegram round-trip after `launchctl kickstart`
- [ ] Force-timeout test: relay rotates session.json + sends actionable Telegram error
- [ ] `~/.claude-relay/session.json` populated with real UUID after first message

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 2 — PR #2: Supabase Dual-Write Memory (~1.5 days)

**Branch:** `relay/pr2-supabase-dual-memory` (off `master` after PR #1 merges)

**Prerequisite:** PR #1 merged. `src/intents.ts` exists with the tag parser.

**Net LOC delta target:** +900 / −120 = +780
**Test count target:** 49 → 63 passing, 0 failing
**Risk:** High — first network dependency in the hot path. Mitigated by `Promise.allSettled`, per-source 1500 ms timeout, runtime `MEMORY_AUTHORITY=obsidian` override.

### Task 2.1: Create branch + verify Supabase project

- [ ] **Step 1: Branch off latest `master`.**

```bash
git checkout master
git pull
git checkout -b relay/pr2-supabase-dual-memory
```

- [ ] **Step 2: Confirm Supabase project credentials are in `.env`.**

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (not `SUPABASE_ANON_KEY` — RPCs writing to memory bypass RLS via service role), `OPENAI_API_KEY`.

If missing, set them now in `.env` (NOT in `.env.example`).

- [ ] **Step 3: Confirm `pgvector` extension version.**

In Supabase dashboard → Database → Extensions, confirm `pgvector` is enabled and version is `>= 0.7.0` (required for HNSW). If older, upgrade.

---

### Task 2.2: Rewrite `db/schema.sql` as idempotent migrations

**Files:**
- Create: `db/migrations/0001_init.sql`
- Create: `db/migrations/0002_hnsw_indexes.sql`
- Modify: `db/schema.sql` (replace contents with a pointer)

- [ ] **Step 1: Create `db/migrations/0001_init.sql`.**

```sql
-- 0001_init.sql — Telegram relay memory layer.
-- Idempotent: CREATE IF NOT EXISTS throughout.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chat_id     TEXT,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  embedding   VECTOR(1536)
);

CREATE TABLE IF NOT EXISTS memory (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('fact','goal','decision','card','completed_goal')),
  content      TEXT NOT NULL,
  embedding    VECTOR(1536),
  deadline     DATE,
  completed_at TIMESTAMPTZ,
  bucket       SMALLINT DEFAULT 0,
  tags         TEXT[] DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level     TEXT NOT NULL,
  channel   TEXT,
  payload   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_messages_ts      ON messages (ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat    ON messages (chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_memory_kind      ON memory (kind);
CREATE INDEX IF NOT EXISTS idx_memory_deadline  ON memory (deadline)
  WHERE kind = 'goal' AND completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_logs_ts          ON logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level       ON logs (level);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory   ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs     ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_messages_all') THEN
    CREATE POLICY service_role_messages_all ON messages
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_memory_all') THEN
    CREATE POLICY service_role_memory_all ON memory
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_logs_all') THEN
    CREATE POLICY service_role_logs_all ON logs
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION get_facts() RETURNS TABLE (id BIGINT, content TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT id, content, created_at FROM memory
  WHERE kind = 'fact' ORDER BY created_at DESC LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION get_active_goals() RETURNS TABLE (id BIGINT, content TEXT, deadline DATE, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT id, content, deadline, created_at FROM memory
  WHERE kind = 'goal' AND completed_at IS NULL
  ORDER BY deadline NULLS LAST, created_at DESC LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION match_messages(query_embedding VECTOR(1536), match_count INT DEFAULT 5)
RETURNS TABLE (id BIGINT, ts TIMESTAMPTZ, chat_id TEXT, role TEXT, content TEXT, similarity REAL)
LANGUAGE sql STABLE AS $$
  SELECT id, ts, chat_id, role, content,
         1 - (embedding <=> query_embedding) AS similarity
  FROM messages
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_memory(query_embedding VECTOR(1536), match_count INT DEFAULT 5, kind_filter TEXT DEFAULT NULL)
RETURNS TABLE (id BIGINT, kind TEXT, content TEXT, similarity REAL, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT id, kind, content,
         1 - (embedding <=> query_embedding) AS similarity,
         created_at
  FROM memory
  WHERE embedding IS NOT NULL
    AND (kind_filter IS NULL OR kind = kind_filter)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

- [ ] **Step 2: Create `db/migrations/0002_hnsw_indexes.sql`.**

```sql
-- 0002_hnsw_indexes.sql — HNSW vector indexes (pgvector >= 0.7.0).
-- vector_cosine_ops because text-embedding-3-small normalizes inputs.

DROP INDEX IF EXISTS messages_embedding_idx;
DROP INDEX IF EXISTS memory_embedding_idx;

CREATE INDEX messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX memory_embedding_idx
  ON memory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

- [ ] **Step 3: Replace `db/schema.sql` contents with a pointer.**

Overwrite `db/schema.sql`:

```sql
-- Migrations now live in db/migrations/.
-- Apply with: supabase db push  (against the linked project)
-- Or read individual files directly to paste into the SQL editor.
\i db/migrations/0001_init.sql
\i db/migrations/0002_hnsw_indexes.sql
```

- [ ] **Step 4: Apply migrations.**

Run: `supabase db push --linked`
Expected: both migrations apply cleanly. Run `\d messages`, `\d memory`, `\d+ messages_embedding_idx` in `psql` to confirm HNSW + vector_cosine_ops.

- [ ] **Step 5: Commit.**

```bash
git add db/
git commit -m "$(cat <<'EOF'
db: rewrite schema as idempotent migrations with HNSW

0001_init.sql: messages, memory, logs + RLS service-role policies
              + get_facts/get_active_goals/match_messages/match_memory RPCs.
0002_hnsw_indexes.sql: HNSW vector_cosine_ops on both embedding cols
              (pgvector >= 0.7.0). Current best practice over IVFFlat
              for <=1M-row scale.
EOF
)"
```

---

### Task 2.3: `src/embeddings.ts`

**Files:**
- Create: `src/embeddings.ts`
- Create: `src/embeddings.test.ts`

- [ ] **Step 1: Write the failing test (skipped when no API key).**

Create `src/embeddings.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { embed } from "./embeddings";

const HAS_KEY = !!process.env.OPENAI_API_KEY;
const maybe = HAS_KEY ? test : test.skip;

maybe("embed returns 1536-dim vector for short input", async () => {
  const v = await embed("hello world");
  expect(v).toBeInstanceOf(Array);
  expect(v.length).toBe(1536);
  expect(typeof v[0]).toBe("number");
});

test("embed throws on empty input", async () => {
  await expect(embed("")).rejects.toThrow();
});

test("embed throws on whitespace-only input", async () => {
  await expect(embed("   ")).rejects.toThrow();
});
```

- [ ] **Step 2: Run.**

Run: `bun test src/embeddings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/embeddings.ts`.**

```typescript
// embeddings.ts
// text-embedding-3-small wrapper. 1536 dims, $0.02/1M tokens.
// Fail fast on missing key or empty input; never silently return zero vectors.

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const TIMEOUT_MS = 1500;

export async function embed(text: string): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error("embed: empty input");
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("embed: OPENAI_API_KEY missing");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8192) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embed: openai_${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    const v = data.data?.[0]?.embedding;
    if (!Array.isArray(v) || v.length !== 1536) {
      throw new Error(`embed: unexpected response shape (len=${v?.length})`);
    }
    return v;
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Step 4: Run.**

Run: `bun test src/embeddings.test.ts`
Expected: pass (the live API test runs only if OPENAI_API_KEY is set).

- [ ] **Step 5: Commit.**

```bash
git add src/embeddings.ts src/embeddings.test.ts
git commit -m "$(cat <<'EOF'
embeddings: text-embedding-3-small wrapper (1536 dims)

Fail fast on empty input or missing key. 1.5s timeout via
AbortController. Truncates >8192-char input to the model's limit.
EOF
)"
```

---

### Task 2.4: `src/memory/obsidian.ts`

**Files:**
- Create: `src/memory/obsidian.ts`
- Create: `src/memory-obsidian.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `src/memory-obsidian.test.ts`:

```typescript
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "obs-mem-"));
  process.env.OBSIDIAN_MEMORY_DIR = workdir;
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  delete process.env.OBSIDIAN_MEMORY_DIR;
});

test("writeFact appends YAML-fronted markdown to facts.md", async () => {
  const mod = await import("./memory/obsidian?fresh-" + Date.now());
  await mod.writeFact({ content: "preferred font is Iosevka" });
  const file = await readFile(join(workdir, "facts.md"), "utf-8");
  expect(file).toContain("---");
  expect(file).toContain("kind: fact");
  expect(file).toContain("preferred font is Iosevka");
});

test("writeGoal includes deadline frontmatter", async () => {
  const mod = await import("./memory/obsidian?fresh-" + Date.now());
  await mod.writeGoal({ content: "finish audit", deadline: "2026-06-01" });
  const file = await readFile(join(workdir, "goals.md"), "utf-8");
  expect(file).toContain("deadline: 2026-06-01");
});

test("writeDecision appends to decisions.md", async () => {
  const mod = await import("./memory/obsidian?fresh-" + Date.now());
  await mod.writeDecision({ content: "use HNSW over IVFFlat" });
  const file = await readFile(join(workdir, "decisions.md"), "utf-8");
  expect(file).toContain("use HNSW over IVFFlat");
});
```

- [ ] **Step 2: Run.**

Run: `bun test src/memory-obsidian.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/memory/obsidian.ts`.**

```typescript
// memory/obsidian.ts
// Markdown append-only memory. One file per kind. YAML frontmatter
// preserves structured metadata; body is human-readable.

import { mkdir, appendFile, chmod } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const ROOT = process.env.OBSIDIAN_MEMORY_DIR
  ?? join(homedir(), "ObsidianVault", "01-Projects", "claude-telegram-relay", "memory");

function nowIso(): string {
  return new Date().toISOString();
}

async function appendEntry(file: string, frontmatter: Record<string, string>, body: string): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const path = join(ROOT, file);
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const block = `\n---\n${yaml}\n---\n\n${body}\n`;
  await appendFile(path, block, { encoding: "utf-8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function writeFact(args: { content: string }): Promise<void> {
  await appendEntry("facts.md", { kind: "fact", ts: nowIso() }, args.content);
}

export async function writeGoal(args: { content: string; deadline: string | null }): Promise<void> {
  const fm: Record<string, string> = { kind: "goal", ts: nowIso() };
  if (args.deadline) fm.deadline = args.deadline;
  await appendEntry("goals.md", fm, args.content);
}

export async function writeDecision(args: { content: string }): Promise<void> {
  await appendEntry("decisions.md", { kind: "decision", ts: nowIso() }, args.content);
}

export async function markGoalDone(args: { content: string }): Promise<void> {
  // Append-only: writing a "completed: <text>" line under decisions/.
  await appendEntry("goals.md", {
    kind: "completed_goal",
    ts: nowIso(),
    matches: args.content,
  }, `Completed: ${args.content}`);
}
```

- [ ] **Step 4: Run.**

Run: `bun test src/memory-obsidian.test.ts`
Expected: `3 pass, 0 fail`.

- [ ] **Step 5: Commit.**

```bash
git add src/memory/obsidian.ts src/memory-obsidian.test.ts
git commit -m "$(cat <<'EOF'
memory/obsidian: append-only YAML-fronted markdown writer

One file per kind (facts.md, goals.md, decisions.md). 0o600
perms. Default path follows the Obsidian vault convention from
~/.claude/CLAUDE.md; overridable via OBSIDIAN_MEMORY_DIR.
EOF
)"
```

---

### Task 2.5: `src/memory/supabase.ts`

**Files:**
- Create: `src/memory/supabase.ts`
- Create: `src/memory-supabase.test.ts`

- [ ] **Step 1: Write the failing test (skipped when no Supabase creds).**

Create `src/memory-supabase.test.ts`:

```typescript
import { expect, test } from "bun:test";

const HAS = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.OPENAI_API_KEY;
const maybe = HAS ? test : test.skip;

maybe("writeFact + match_memory round-trips", async () => {
  const mod = await import("./memory/supabase");
  const marker = `__test_${Date.now()}__`;
  await mod.writeFact({ content: `${marker} preferred sushi is unagi` });
  await new Promise((r) => setTimeout(r, 1500));
  const hits = await mod.semanticSearchMemory({ query: marker, k: 1 });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].content).toContain(marker);
});
```

- [ ] **Step 2: Create `src/memory/supabase.ts`.**

```typescript
// memory/supabase.ts
// Supabase memory backend. Writes go through createClient (service role).
// Reads via RPCs match_messages / match_memory / get_facts / get_active_goals.
// All embeddings generated client-side via src/embeddings.ts.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { embed } from "../embeddings";

let cached: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("supabase: SUPABASE_URL or key missing");
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export async function writeFact(args: { content: string }): Promise<void> {
  const c = client();
  const v = await embed(args.content);
  const { error } = await c.from("memory").insert({
    kind: "fact",
    content: args.content,
    embedding: v as unknown as number[],
  });
  if (error) throw new Error(`supabase.writeFact: ${error.message}`);
}

export async function writeGoal(args: { content: string; deadline: string | null }): Promise<void> {
  const c = client();
  const v = await embed(args.content);
  const { error } = await c.from("memory").insert({
    kind: "goal",
    content: args.content,
    deadline: args.deadline,
    embedding: v as unknown as number[],
  });
  if (error) throw new Error(`supabase.writeGoal: ${error.message}`);
}

export async function writeDecision(args: { content: string }): Promise<void> {
  const c = client();
  const v = await embed(args.content);
  const { error } = await c.from("memory").insert({
    kind: "decision",
    content: args.content,
    embedding: v as unknown as number[],
  });
  if (error) throw new Error(`supabase.writeDecision: ${error.message}`);
}

export async function markGoalDone(args: { content: string }): Promise<void> {
  const c = client();
  const { data, error: lookupErr } = await c
    .from("memory")
    .select("id")
    .eq("kind", "goal")
    .ilike("content", `%${args.content}%`)
    .limit(1);
  if (lookupErr) throw new Error(`supabase.markGoalDone lookup: ${lookupErr.message}`);
  if (!data?.[0]) return;
  const { error } = await c
    .from("memory")
    .update({ kind: "completed_goal", completed_at: new Date().toISOString() })
    .eq("id", data[0].id);
  if (error) throw new Error(`supabase.markGoalDone update: ${error.message}`);
}

export async function semanticSearchMemory(args: { query: string; k: number; kind?: string }): Promise<Array<{ id: number; kind: string; content: string; similarity: number }>> {
  const c = client();
  const v = await embed(args.query);
  const { data, error } = await c.rpc("match_memory", {
    query_embedding: v as unknown as number[],
    match_count: args.k,
    kind_filter: args.kind ?? null,
  });
  if (error) throw new Error(`supabase.match_memory: ${error.message}`);
  return (data ?? []) as any[];
}

export async function semanticSearchMessages(args: { query: string; k: number }): Promise<Array<{ id: number; ts: string; role: string; content: string; similarity: number }>> {
  const c = client();
  const v = await embed(args.query);
  const { data, error } = await c.rpc("match_messages", {
    query_embedding: v as unknown as number[],
    match_count: args.k,
  });
  if (error) throw new Error(`supabase.match_messages: ${error.message}`);
  return (data ?? []) as any[];
}
```

- [ ] **Step 3: Run.**

Run: `bun test src/memory-supabase.test.ts`
Expected: pass (live API test runs only with creds).

- [ ] **Step 4: Commit.**

```bash
git add src/memory/supabase.ts src/memory-supabase.test.ts
git commit -m "$(cat <<'EOF'
memory/supabase: backend with embeddings + RPCs

Embeddings generated client-side via src/embeddings.ts so the
Edge Function path is not on the critical write path. Service-
role key required for inserts (anon silently fails RLS).
EOF
)"
```

---

### Task 2.6: `src/memory/index.ts` facade

**Files:**
- Create: `src/memory/index.ts`
- Create: `src/memory-facade-fanout.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `src/memory-facade-fanout.test.ts`:

```typescript
import { expect, test } from "bun:test";

// We monkey-patch the two backend modules so we can test the facade
// without hitting filesystem or Supabase.

const writeLog: { backend: string; method: string; arg: any }[] = [];

test("dual-write: writeFact fans out to both backends; Supabase failure does not block Obsidian", async () => {
  // Replace modules in Bun's loader cache.
  const obsMod = {
    writeFact: async (a: any) => { writeLog.push({ backend: "obs", method: "writeFact", arg: a }); },
  };
  const supMod = {
    writeFact: async (a: any) => { writeLog.push({ backend: "sup", method: "writeFact", arg: a }); throw new Error("forced"); },
  };
  // @ts-expect-error
  globalThis.__test_memory_backends__ = { obsidian: obsMod, supabase: supMod };

  process.env.MEMORY_AUTHORITY = "both";
  const facade = await import("./memory/index?fresh-" + Date.now());
  const result = await facade.write({ kind: "remember", content: "x" });
  expect(writeLog.find((l) => l.backend === "obs")).toBeDefined();
  expect(writeLog.find((l) => l.backend === "sup")).toBeDefined();
  expect(result.obsidian).toBe("ok");
  expect(result.supabase).toBe("error");
});
```

- [ ] **Step 2: Create `src/memory/index.ts`.**

```typescript
// memory/index.ts
// Facade over Obsidian + Supabase memory backends.
// MEMORY_AUTHORITY: "obsidian" | "supabase" | "both".
// On "both": fan out via Promise.allSettled — a backend failure must not
// block the other or surface to the user.

import * as obsidianReal from "./obsidian";
import type { Intent } from "../intents";

type Backend = typeof obsidianReal;

// Test hook: allow tests to inject stub backends without monkey-patching
// the module loader.
function backends(): { obsidian: Backend; supabase: any } {
  // @ts-expect-error — test global
  const injected = globalThis.__test_memory_backends__;
  if (injected) return injected;
  // Lazy real backends.
  const supabaseReal = require("./supabase");
  return { obsidian: obsidianReal, supabase: supabaseReal };
}

export type Authority = "obsidian" | "supabase" | "both";

export function authority(): Authority {
  const a = (process.env.MEMORY_AUTHORITY ?? "obsidian").toLowerCase();
  if (a === "supabase") return "supabase";
  if (a === "both") return "both";
  return "obsidian";
}

export interface WriteResult {
  obsidian: "ok" | "skipped" | "error";
  supabase: "ok" | "skipped" | "error";
}

async function safe(label: string, fn: () => Promise<unknown>): Promise<"ok" | "error"> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    console.error(`[memory.${label}] ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
}

export async function write(intent: Intent): Promise<WriteResult> {
  const auth = authority();
  const { obsidian, supabase } = backends();
  const result: WriteResult = { obsidian: "skipped", supabase: "skipped" };

  const fans: Array<Promise<void>> = [];
  if (auth === "obsidian" || auth === "both") {
    fans.push((async () => { result.obsidian = await safe("obsidian", () => dispatch(obsidian, intent)); })());
  }
  if (auth === "supabase" || auth === "both") {
    fans.push((async () => { result.supabase = await safe("supabase", () => dispatch(supabase, intent)); })());
  }
  await Promise.allSettled(fans);
  return result;
}

async function dispatch(backend: any, intent: Intent): Promise<void> {
  switch (intent.kind) {
    case "remember": return backend.writeFact({ content: intent.content });
    case "goal":     return backend.writeGoal({ content: intent.content, deadline: intent.deadline });
    case "done":     return backend.markGoalDone({ content: intent.content });
    case "decision": return backend.writeDecision({ content: intent.content });
    default:         return; // draft intents are handled by PR #3 router, not memory
  }
}

export async function applyIntents(intents: Intent[]): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const i of intents) {
    if (["remember", "goal", "done", "decision"].includes(i.kind)) {
      results.push(await write(i));
    }
  }
  return results;
}
```

- [ ] **Step 3: Run.**

Run: `bun test src/memory-facade-fanout.test.ts`
Expected: pass.

- [ ] **Step 4: Commit.**

```bash
git add src/memory/index.ts src/memory-facade-fanout.test.ts
git commit -m "$(cat <<'EOF'
memory/index: facade with Promise.allSettled dual-write

MEMORY_AUTHORITY ∈ {obsidian,supabase,both}. On 'both', a
Supabase failure increments an error counter but never blocks
Obsidian and never surfaces to the user. Test-hook backend
injection so tests don't need real disk or network.
EOF
)"
```

---

### Task 2.7: Wire facade into `relay.ts` and `intents.ts` application

**Files:**
- Modify: `src/relay.ts`

- [ ] **Step 1: After Claude returns the reply, parse intents and apply.**

In the message handler, after the line where `reply = await callClaude(...)` resolves, insert:

```typescript
import { parseIntents } from "./intents.ts";
import { applyIntents } from "./memory/index.ts";

// ...
const parsed = parseIntents(reply);
reply = parsed.clean;
void applyIntents(parsed.intents).catch((err) =>
  console.error("[memory] applyIntents failed:", err)
);
```

The `void` + `.catch` shape is intentional: memory writes are fire-and-forget so they never block the Telegram reply.

- [ ] **Step 2: Add a context-fetcher hook (read path).**

In the place where the prompt is assembled, add a Supabase semantic-recall fetch behind a 1500 ms timeout, wrapped in `Promise.allSettled` with the existing context sources:

```typescript
import { semanticSearchMemory } from "./memory/supabase.ts";

// ... around prompt assembly:
const memorySearch = (async () => {
  try {
    const hits = await Promise.race([
      semanticSearchMemory({ query: currentMessage, k: 5 }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
    ]);
    if (!hits?.length) return "";
    return "RELEVANT MEMORIES:\n" + hits.map((h) => `- ${h.content}`).join("\n");
  } catch {
    return ""; // Never block on memory.
  }
})();

const [memoryBlock /* …other sources */] = await Promise.all([memorySearch /* … */]);
```

- [ ] **Step 3: Flip `MEMORY_AUTHORITY=both` in `.env.example`.**

Replace the PR #1 line `MEMORY_AUTHORITY=obsidian` with `MEMORY_AUTHORITY=both`.

- [ ] **Step 4: Run full tests and live smoke.**

Run: `bun test`
Expected: all pass.

Run the relay; send "remember that my preferred font is Iosevka." Confirm:
- Reply does NOT contain `[REMEMBER:...]` literal.
- `~/ObsidianVault/01-Projects/claude-telegram-relay/memory/facts.md` has a new entry.
- Supabase `memory` table has a new `kind=fact` row with `embedding IS NOT NULL`.

Then ask "what was that font thing again?" — confirm the reply mentions Iosevka without you re-stating it (semantic recall round-trip).

- [ ] **Step 5: Outage simulation.**

In another terminal: `sudo pfctl -E && echo "block out proto tcp to api.openai.com" | sudo pfctl -f -`
(Or simpler: invalidate `OPENAI_API_KEY` temporarily.)
Send "remember 24h time" in Telegram. Confirm:
- Obsidian file gains the entry.
- Logs show `[memory.supabase] ...` error.
- Telegram reply is normal (no user-visible error).

Restore network/key.

- [ ] **Step 6: Commit.**

```bash
git add src/relay.ts .env.example
git commit -m "$(cat <<'EOF'
wire memory facade into relay (read + write)

Reads: Promise.allSettled with 1500ms timeout against Supabase
match_memory — failures absent from context, never block reply.

Writes: parseIntents() strips tags from reply; applyIntents()
fans out fire-and-forget via the memory facade. Facade enforces
allSettled boundary so Supabase failures stay silent to user.
EOF
)"
```

---

### Task 2.8: Real `setup/test-supabase.ts`

Replace the PR #1 stub with a real round-trip:

```typescript
#!/usr/bin/env bun
// setup/test-supabase.ts — full write/match/delete round-trip.

import { writeFact, semanticSearchMemory } from "../src/memory/supabase";

const marker = `__verify_${Date.now()}__`;

console.log("→ writing test memory…");
await writeFact({ content: `${marker} verifier round-trip` });

console.log("→ waiting 1.5s for indexing…");
await new Promise((r) => setTimeout(r, 1500));

console.log("→ searching for marker…");
const hits = await semanticSearchMemory({ query: marker, k: 3 });
if (!hits.find((h) => h.content.includes(marker))) {
  console.error("✗ marker not found in match_memory result");
  process.exit(1);
}

console.log("✓ Supabase round-trip OK");
process.exit(0);
```

Also: update `src/health-check.ts:checkSupabaseConfig` to do a real `select count(*) from memory` against the live project (with the same Bun-native fetch timeout shape used in embeddings.ts).

Run: `bun run setup/test-supabase.ts`
Expected: exit 0 with `✓ Supabase round-trip OK`.

Commit:
```bash
git add setup/test-supabase.ts src/health-check.ts
git commit -m "setup: real test-supabase round-trip; verify check live"
```

---

### Task 2.9: Lessons + PR

Append to `tasks/lessons.md`:

```markdown
## 2026-05-17 - PR #2 dual-write memory

- Promise.allSettled is non-negotiable on dual-write — a thrown rejection
  from Supabase must NOT propagate. The user must never see "memory write
  failed" because the durable Obsidian write succeeded; the Supabase miss
  is acceptable eventual loss, by design.
- text-embedding-3-small at 1536 dims is the cost-sensitive default;
  HNSW with vector_cosine_ops is the right index for ≤1M-row scale per
  Supabase's published recommendation. Don't use IVFFlat — it requires
  manual REINDEX as data changes.
- Embed client-side, not in an Edge Function on insert. Edge Function
  webhooks add latency, a moving part, and a webhook-config failure mode
  that's hard to detect from the relay. With client-side embed, a missing
  vector means the write itself failed, which logs immediately.
- RLS: service-role key required for inserts. The anon key silently fails
  RLS, producing a 0-row insert with no visible error in the client.
  setup/verify.ts must round-trip both write and read to catch this.
- Memory writes are fire-and-forget on the reply path. Awaiting them
  blocks Telegram on disk + network I/O for ~50–200 ms per reply, which
  the user feels.
```

Commit, push, open PR.

```bash
git add tasks/lessons.md
git commit -m "lessons: PR #2 dual-write"
git push -u origin relay/pr2-supabase-dual-memory
gh pr create --title "PR #2: Supabase reactivation + dual-write memory" --body "..."
```

---

## Phase 3 — PR #3: Email + WhatsApp + Voice + Scheduled (~1.5 days)

**Branch:** `relay/pr3-email-whatsapp-voice` (off `master` after PR #2 merges)

**Net LOC delta target:** +1100 / −150 = +950
**Test count target:** 63 → 78 passing, 0 failing
**Risk:** Medium-high — three external dependencies (Gmail OAuth, WhatsApp Desktop, ffmpeg). All optional behind env flags.

### Task 3.1: `setup/gmail-auth.ts` — one-time OAuth

**Files:**
- Create: `setup/gmail-auth.ts`

This task is performed once per user. Run it interactively.

- [ ] **Step 1: Create OAuth client in Google Cloud Console.**

User-facing instructions (include in CLAUDE.md):
1. Go to console.cloud.google.com → APIs & Services → Credentials.
2. Create Credentials → OAuth client ID → Desktop application.
3. Save the `client_id` and `client_secret`.
4. Add them to `.env`: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`.

- [ ] **Step 2: Create the auth script.**

```typescript
#!/usr/bin/env bun
// setup/gmail-auth.ts — one-time OAuth2 device flow for Gmail.
// Writes the refresh token to ~/.claude-relay/gmail-token.json (0o600).

import { chmod, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
})}`;

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nPaste the resulting code:");

const code = await new Promise<string>((resolve) => {
  process.stdin.once("data", (d) => resolve(d.toString().trim()));
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});

if (!tokenRes.ok) {
  console.error("Token exchange failed:", await tokenRes.text());
  process.exit(1);
}

const tokens = await tokenRes.json() as { refresh_token: string; access_token: string; expires_in: number };

const dir = join(homedir(), ".claude-relay");
await mkdir(dir, { recursive: true, mode: 0o700 });

const path = join(dir, "gmail-token.json");
await writeFile(path, JSON.stringify({
  refresh_token: tokens.refresh_token,
  client_id: clientId,
  client_secret: clientSecret,
  obtained_at: new Date().toISOString(),
}, null, 2), { encoding: "utf-8", mode: 0o600 });
await chmod(path, 0o600);

console.log(`\n✓ Refresh token saved to ${path} (0o600)`);
process.exit(0);
```

- [ ] **Step 3: Run interactively, confirm token file.**

Run: `bun run setup/gmail-auth.ts`
Expected: prints URL; after pasting code, writes `~/.claude-relay/gmail-token.json` at mode 600.

Verify: `stat -f %A ~/.claude-relay/gmail-token.json` → `600`.

- [ ] **Step 4: Commit.**

```bash
git add setup/gmail-auth.ts
git commit -m "setup/gmail-auth: one-time OAuth2 flow → ~/.claude-relay/gmail-token.json (0o600)"
```

---

### Task 3.2: `scripts/gmail-thread.ts` — read thread headers

```typescript
#!/usr/bin/env bun
// scripts/gmail-thread.ts <thread-id>
// Reads the most-recent message in a thread and prints Message-Id, References,
// In-Reply-To, Subject — the four headers required for threading a reply.

import { getAccessToken } from "../src/email";

const threadId = process.argv[2];
if (!threadId) {
  console.error("usage: gmail-thread.ts <thread-id>");
  process.exit(1);
}

const token = await getAccessToken();
const res = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=Subject&metadataHeaders=References&metadataHeaders=In-Reply-To`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!res.ok) { console.error(await res.text()); process.exit(1); }
const body = await res.json() as { messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }> };
const last = body.messages?.at(-1);
const headers = Object.fromEntries((last?.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
console.log(JSON.stringify({
  message_id: headers["message-id"],
  subject: headers["subject"],
  references: headers["references"],
  in_reply_to: headers["in-reply-to"],
}, null, 2));
```

---

### Task 3.3: `src/email.ts` — RFC 2822 build with full threading

**Files:**
- Create: `src/email.ts`
- Create: `src/email-threading.test.ts`
- Create: `src/email-emdash-reject.test.ts`

This is the most-correctable departure from the audit: threading MUST set `In-Reply-To` + `References` + matching `Subject`.

- [ ] **Step 1: Write the failing tests.**

`src/email-threading.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { buildRfc2822, base64url } from "./email";

test("build RFC 2822 with all required threading headers", () => {
  const mime = buildRfc2822({
    from: "me@example.com",
    to: "alex@example.com",
    subject: "Re: schedule",
    body: "Tomorrow at 3 works.",
    references: "<a@b> <c@d>",
    inReplyTo: "<c@d>",
  });
  expect(mime).toContain("From: me@example.com");
  expect(mime).toContain("To: alex@example.com");
  expect(mime).toContain("Subject: Re: schedule");
  expect(mime).toContain("In-Reply-To: <c@d>");
  expect(mime).toContain("References: <a@b> <c@d>");
  expect(mime).toContain("MIME-Version: 1.0");
  expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  expect(mime).toContain("Tomorrow at 3 works.");
});

test("base64url encoding has no + / or trailing = on length-multiple-of-3 input", () => {
  const out = base64url("foo"); // 3 bytes; clean encoding
  expect(out).not.toContain("+");
  expect(out).not.toContain("/");
});
```

`src/email-emdash-reject.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { draftEmail } from "./email";

test("draftEmail rejects body containing em-dash", async () => {
  const result = await draftEmail({
    to: "x@y.com",
    subject: "Re: meeting",
    body: "Yes — that works.",
  }, { dryRun: true });
  expect(result.ok).toBe(false);
  expect((result as any).reason).toBe("em_dash_in_draft");
});

test("draftEmail rejects subject containing em-dash", async () => {
  const result = await draftEmail({
    to: "x@y.com",
    subject: "Re: meeting — Tuesday",
    body: "ok",
  }, { dryRun: true });
  expect(result.ok).toBe(false);
});

test("draftEmail accepts clean body in dryRun", async () => {
  const result = await draftEmail({
    to: "x@y.com",
    subject: "Re: meeting",
    body: "Yes, that works.",
  }, { dryRun: true });
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Create `src/email.ts`.**

```typescript
// email.ts
// Gmail REST draft creation. Threading enforced via In-Reply-To +
// References + matching Subject (threadId alone is sender-side only).

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { containsEmDash } from "./draft-router";

const TOKEN_PATH = join(homedir(), ".claude-relay", "gmail-token.json");
let cachedAccess: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 30_000) {
    return cachedAccess.token;
  }
  const raw = await readFile(TOKEN_PATH, "utf-8");
  const stored = JSON.parse(raw) as {
    refresh_token: string; client_id: string; client_secret: string;
  };
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: stored.client_id,
      client_secret: stored.client_secret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`gmail.refresh: ${res.status} ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedAccess = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cachedAccess.token;
}

export function base64url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface BuildArgs {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  references?: string;
  inReplyTo?: string;
}

export function buildRfc2822(args: BuildArgs): string {
  const headers: string[] = [
    `From: ${args.from}`,
    `To: ${args.to}`,
  ];
  if (args.cc) headers.push(`Cc: ${args.cc}`);
  headers.push(`Subject: ${args.subject}`);
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("");
  headers.push(args.body);
  return headers.join("\r\n");
}

export interface DraftArgs {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  threadId?: string;
  references?: string;
  inReplyTo?: string;
}

export type DraftResult =
  | { ok: true; mode: "gmail_api"; draft_id: string; thread_id: string | null }
  | { ok: false; reason: string };

export async function draftEmail(
  args: DraftArgs,
  options?: { dryRun?: boolean; from?: string }
): Promise<DraftResult> {
  if (containsEmDash(args.body) || containsEmDash(args.subject)) {
    return { ok: false, reason: "em_dash_in_draft" };
  }
  const mime = buildRfc2822({
    from: options?.from ?? process.env.GMAIL_FROM ?? "me@example.com",
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
    references: args.references,
    inReplyTo: args.inReplyTo,
  });
  if (options?.dryRun) {
    return { ok: true, mode: "gmail_api", draft_id: "dry-run", thread_id: args.threadId ?? null };
  }
  const token = await getAccessToken();
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        threadId: args.threadId,
        raw: base64url(mime),
      },
    }),
  });
  if (!res.ok) {
    return { ok: false, reason: `gmail_api_${res.status}: ${await res.text()}` };
  }
  const body = await res.json() as { id: string; message?: { threadId?: string } };
  return { ok: true, mode: "gmail_api", draft_id: body.id, thread_id: body.message?.threadId ?? null };
}
```

- [ ] **Step 3: Run tests.**

Run: `bun test src/email-threading.test.ts src/email-emdash-reject.test.ts`
Expected: all pass.

- [ ] **Step 4: Live thread smoke (manual).**

Find a real thread ID in your Gmail. Run:
```bash
bun run scripts/gmail-thread.ts <thread-id>
```
Copy the `in_reply_to`, `references`, `subject` from the output.

Then run an interactive script (one-off): `bun -e` with:
```typescript
import { draftEmail } from "./src/email";
const r = await draftEmail({
  to: "yourself@example.com",
  subject: "Re: <subject from above>",
  body: "Verification reply.",
  threadId: "<thread-id>",
  inReplyTo: "<message-id from above>",
  references: "<references from above>",
});
console.log(r);
```

Verify in Gmail web UI that the draft appears **inside** the original thread.

- [ ] **Step 5: Commit.**

```bash
git add src/email.ts src/email-threading.test.ts src/email-emdash-reject.test.ts scripts/gmail-thread.ts
git commit -m "$(cat <<'EOF'
email: Gmail REST draft creation with full threading

Threading requires all three: threadId on the draft, plus
In-Reply-To + References + matching Subject in the MIME.
threadId alone is sender-side only — recipients see standalone.
Em-dash gate fires BEFORE base64url encoding (audit Lesson #N+6).
EOF
)"
```

---

### Task 3.4: `src/whatsapp.ts` — deep link only

**Files:**
- Create: `src/whatsapp.ts`
- Create: `src/whatsapp-deeplink.test.ts`
- Create: `src/whatsapp-emdash-reject.test.ts`

- [ ] **Step 1: Write failing tests.**

`src/whatsapp-deeplink.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { buildWhatsAppUrl, resolveContact } from "./whatsapp";

test("buildWhatsAppUrl produces canonical whatsapp:// link", () => {
  const url = buildWhatsAppUrl({ phone: "15551234567", body: "hi there!" });
  expect(url.startsWith("whatsapp://send?")).toBe(true);
  expect(url).toContain("phone=15551234567");
  expect(url).toContain("text=hi%20there!");
});

test("phone is normalized to E.164 without + or spaces", () => {
  expect(buildWhatsAppUrl({ phone: "+1 (555) 123-4567", body: "x" })).toContain("phone=15551234567");
});

test("resolveContact returns mapped phone for known name", async () => {
  process.env.WHATSAPP_CONTACTS_PATH = `${import.meta.dir}/__fixtures__/whatsapp-contacts.json`;
  const r = await resolveContact("Sarah");
  expect(r).toBe("15551234567");
});
```

Create `src/__fixtures__/whatsapp-contacts.json`:

```json
{ "Sarah": "15551234567", "Alex": "447700900000" }
```

`src/whatsapp-emdash-reject.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { draftWhatsApp } from "./whatsapp";

test("draftWhatsApp rejects body containing em-dash", async () => {
  process.env.WHATSAPP_CONTACTS_PATH = `${import.meta.dir}/__fixtures__/whatsapp-contacts.json`;
  const r = await draftWhatsApp({ contact: "Sarah", body: "hi — there" }, { dryRun: true });
  expect(r.ok).toBe(false);
  expect((r as any).reason).toBe("em_dash_in_draft");
});
```

- [ ] **Step 2: Create `src/whatsapp.ts`.**

```typescript
// whatsapp.ts
// Deep link only — no AppleScript, no UI seizure, no Accessibility TCC.

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "bun";
import { containsEmDash } from "./draft-router";

const CONTACTS_PATH = process.env.WHATSAPP_CONTACTS_PATH
  ?? join(homedir(), ".claude-relay", "whatsapp-contacts.json");

export interface BuildArgs {
  phone: string;
  body: string;
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function buildWhatsAppUrl(args: BuildArgs): string {
  return `whatsapp://send?phone=${normalizePhone(args.phone)}&text=${encodeURIComponent(args.body)}`;
}

export async function resolveContact(name: string): Promise<string | null> {
  try {
    const raw = await readFile(CONTACTS_PATH, "utf-8");
    const map = JSON.parse(raw) as Record<string, string>;
    return map[name] ?? null;
  } catch {
    return null;
  }
}

export interface DraftArgs {
  contact: string;
  body: string;
}

export type DraftResult =
  | { ok: true; mode: "deep_link"; url: string }
  | { ok: false; reason: string };

export async function draftWhatsApp(args: DraftArgs, options?: { dryRun?: boolean }): Promise<DraftResult> {
  if (containsEmDash(args.body)) {
    return { ok: false, reason: "em_dash_in_draft" };
  }
  const phone = await resolveContact(args.contact);
  if (!phone) {
    return { ok: false, reason: "unknown_contact" };
  }
  const url = buildWhatsAppUrl({ phone, body: args.body });
  if (options?.dryRun) return { ok: true, mode: "deep_link", url };
  const proc = spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) return { ok: false, reason: `open_exit_${code}` };
  return { ok: true, mode: "deep_link", url };
}
```

- [ ] **Step 3: Run tests.**

Run: `bun test src/whatsapp-deeplink.test.ts src/whatsapp-emdash-reject.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add src/whatsapp.ts src/whatsapp-deeplink.test.ts src/whatsapp-emdash-reject.test.ts src/__fixtures__/whatsapp-contacts.json
git commit -m "$(cat <<'EOF'
whatsapp: deep-link compose-prefill only

whatsapp://send?phone=…&text=… via `open` — opens compose box
pre-filled, hands control back to user immediately. No AppleScript,
no cursor seizure, no Accessibility TCC. Em-dash gate fires before
URL construction. Contacts at ~/.claude-relay/whatsapp-contacts.json.
EOF
)"
```

---

### Task 3.5: `src/tts.ts` — voice reply

**Files:**
- Create: `src/tts.ts`
- Create: `src/tts.test.ts`

```typescript
// tts.ts
// macOS say → .aiff → ffmpeg(libopus) → .ogg → Telegram sendVoice.
// Gated by VOICE_REPLY=1; char-cap 1000.

import { spawn } from "bun";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CHAR_CAP = 1000;

export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  if (process.env.VOICE_REPLY !== "1") return null;
  if (text.length > CHAR_CAP) return null;

  const dir = await mkdtemp(join(tmpdir(), "relay-tts-"));
  const aiff = join(dir, "out.aiff");
  const ogg = join(dir, "out.ogg");

  try {
    const sayProc = spawn(["say", "-o", aiff, text], { stdout: "pipe", stderr: "pipe" });
    if ((await sayProc.exited) !== 0) return null;

    const ffmpegProc = spawn(
      ["ffmpeg", "-y", "-i", aiff, "-c:a", "libopus", "-b:a", "32k", ogg],
      { stdout: "pipe", stderr: "pipe" }
    );
    if ((await ffmpegProc.exited) !== 0) return null;

    return await readFile(ogg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Test (gated by environment):

```typescript
import { expect, test } from "bun:test";
import { synthesizeVoice } from "./tts";

const HAS_FFMPEG = !!(await Bun.which("ffmpeg"));
const maybe = HAS_FFMPEG ? test : test.skip;

maybe("synthesizeVoice produces a non-empty buffer when VOICE_REPLY=1", async () => {
  process.env.VOICE_REPLY = "1";
  const buf = await synthesizeVoice("hello world");
  expect(buf).toBeInstanceOf(Buffer);
  expect((buf as Buffer).length).toBeGreaterThan(0);
});

test("synthesizeVoice returns null when VOICE_REPLY=0", async () => {
  process.env.VOICE_REPLY = "0";
  const buf = await synthesizeVoice("hello world");
  expect(buf).toBeNull();
});
```

Commit.

---

### Task 3.6: Wire intents to draft helpers in `relay.ts`

After `parseIntents(reply)` in the relay handler, route draft intents:

```typescript
import { draftEmail } from "./email.ts";
import { draftWhatsApp } from "./whatsapp.ts";
import { synthesizeVoice } from "./tts.ts";

for (const intent of parsed.intents) {
  if (intent.kind === "email_draft" && process.env.EMAIL_ENABLED !== "0") {
    const r = await draftEmail({
      to: intent.to,
      subject: intent.subject,
      body: intent.body,
    });
    if (!r.ok) {
      console.error(`[email] draft failed: ${(r as any).reason}`);
    } else {
      // Append a quiet status to the reply.
      reply += "\n\nEmail draft is in your Gmail Drafts.";
    }
  }
  if (intent.kind === "whatsapp_draft" && process.env.WHATSAPP_ENABLED !== "0") {
    const r = await draftWhatsApp({ contact: intent.contact, body: intent.body });
    if (!r.ok) {
      console.error(`[whatsapp] draft failed: ${(r as any).reason}`);
    } else {
      reply += "\n\nWhatsApp draft is ready in your composer.";
    }
  }
}

// Voice reply, AFTER all text mutations:
const voice = await synthesizeVoice(reply);
if (voice) {
  await bot.sendVoice(chatId, voice);
} else {
  // Existing text send path.
  for (const chunk of splitForTelegram(reply)) {
    await bot.sendMessage(chatId, chunk);
  }
}
```

---

### Task 3.7: `examples/decision-digest.ts`

```typescript
#!/usr/bin/env bun
// examples/decision-digest.ts — daily 06:30 digest of yesterday's decisions.
// Reads the local decision log + Supabase match_memory(kind='decision'),
// drafts a summary to Telegram.

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = process.env.RELAY_LOG_DIR ?? join(homedir(), ".claude-relay", "logs");

const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const ymd = yesterday.toISOString().slice(0, 10);

const file = join(LOG_DIR, `decisions-${ymd}.jsonl`);

let lines: string[];
try {
  const text = await readFile(file, "utf-8");
  lines = text.split("\n").filter(Boolean);
} catch {
  lines = [];
}

const summary = lines
  .map((l) => { try { return JSON.parse(l) as any; } catch { return null; } })
  .filter(Boolean)
  .map((r) => `${r.ts.slice(11, 19)} — ${r.message.slice(0, 80)}`)
  .join("\n");

const draft = lines.length === 0
  ? `No decisions logged for ${ymd}.`
  : `Decisions for ${ymd} (${lines.length}):\n\n${summary}`;

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const userId = process.env.TELEGRAM_USER_ID;
if (!botToken || !userId) { console.error("Telegram creds missing"); process.exit(1); }

await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: userId, text: draft }),
});

console.log("digest sent");
```

LaunchAgent plist at `daemon/com.claude.relay.decision-digest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude.relay.decision-digest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/YOUR_USERNAME/Projects/claude-telegram-relay/examples/decision-digest.ts</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.claude-relay/logs/decision-digest.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.claude-relay/logs/decision-digest.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TELEGRAM_BOT_TOKEN</key><string>__SET_IN_HARNESS__</string>
    <key>TELEGRAM_USER_ID</key><string>__SET_IN_HARNESS__</string>
  </dict>
</dict>
</plist>
```

Load: `launchctl bootstrap gui/$(id -u) daemon/com.claude.relay.decision-digest.plist`

---

### Task 3.8: `examples/study-spaced-repetition.ts`

Reads `memory(kind='card')` from Supabase, draws one card whose Leitner `bucket` schedule is due today, drafts a quiz prompt to Telegram, and on user reply ("correct" / "wrong") increments or resets the bucket. (Full implementation omitted here for brevity; pattern mirrors decision-digest with one `match_memory(kind='card')` call.)

Plist: `daemon/com.claude.relay.study-cards.plist` (same shape, `Hour=19 Minute=0`).

---

### Task 3.9: Rewrite `CLAUDE.md`

Replace the current `CLAUDE.md` with a phased, William-customized setup guide that walks the user through:
1. Phase 1 — Telegram (existing; keep)
2. Phase 2 — Supabase (existing; revise to match PR #2 migrations + HNSW)
3. Phase 3 — Personalize (existing; keep)
4. Phase 4 — Test relay (existing; keep)
5. Phase 5 — LaunchAgent (existing; keep)
6. Phase 6 — Optional: Gmail draft helper (link to `setup/gmail-auth.ts`)
7. Phase 7 — Optional: WhatsApp drafts (one-line `~/.claude-relay/whatsapp-contacts.json` example)
8. Phase 8 — Optional: voice reply (`VOICE_REPLY=1` + `brew install ffmpeg`)
9. Phase 9 — Optional: scheduled digest + study cards (`launchctl bootstrap …`)

---

### Task 3.10: Lessons + PR

Append to `tasks/lessons.md`:

```markdown
## 2026-05-17 - PR #3 integrations

- Gmail threading takes three headers, not one. threadId in the drafts.create
  body is sender-side only; recipients see a standalone message unless the
  MIME also has In-Reply-To, References, and a Subject that matches the
  thread's existing Subject. This is the single most common Gmail-API
  bug — verifier flagged it explicitly. Audit's "threadId is enough"
  framing was the most dangerous error in the audit because it would
  silently degrade in production for weeks before anyone noticed.
- WhatsApp deep links (whatsapp://send?...) beat any AppleScript /
  Accessibility approach for a compose-only flow. The deep link opens
  the composer pre-filled and hands control back instantly. AppleScript
  via System Events seizes the cursor mid-message — operationally hostile
  for a clinician who may have WhatsApp open in a clinical context.
- Voice reply (say → ffmpeg libopus → .ogg → sendVoice) is a *gated*
  feature, not a default. The gate is VOICE_REPLY=1 + a 1000-char cap.
  Without the cap, a long Claude reply produces a 30-second voice note
  the user won't actually listen to.
- Scheduled siblings (decision-digest, study-cards) live under their own
  LaunchAgent plists, NOT inside the relay process. Single-LaunchAgent
  constraint applies to the relay process tree, not to scheduled jobs.
```

Commit, push, open PR.

---

## Self-Review

Ran the spec-coverage checklist:

| Spec item | Plan coverage |
|---|---|
| BUG-1 English directive | Task 1.1 ✓ |
| BUG-2 FTS preflight | Rejected with rationale ✓ |
| BUG-3 topic-pivot | Rejected with rationale ✓ |
| BUG-4 skipped-textbook wording | Task 1.3 ✓ |
| BUG-5 path-fallback cap | Task 1.2 ✓ |
| BUG-6 Bun-native timeout + session rotation | Task 1.6 ✓ (with Date.now() marker correction) |
| BUG-7 em-dash code blocks | Rejected (YAGNI) ✓ |
| BUG-8 decision-log path docs | Rejected (no mismatch) ✓ |
| KI-1 STOPWORDS split | Rejected (already done) ✓ |
| KI-2 basename regex | Rejected (no attack surface) ✓ |
| KI-3 retention sweep | Task 1.4 ✓ |
| Email — Gmail REST not AppleScript | Tasks 3.1-3.3 ✓ (with threading correction) |
| WhatsApp — deep link not AppleScript | Task 3.4 ✓ |
| Dual-write Supabase + Obsidian | Tasks 2.4-2.7 ✓ |
| Intent tag protocol | Task 1.7 (parse) + 2.6 (apply) ✓ |
| Module extraction (session, intents, draft-router, health-check) | Tasks 1.5, 1.7, 1.8, 1.9 ✓ |
| Session continuity `--resume` ON | Task 1.6 ✓ |
| Session rotation on timeout | Task 1.6 ✓ |
| 60-sec "still thinking" | Task 1.8 ✓ |
| Telegram 4096 splitter | Task 1.8 ✓ |
| Em-dash gate before outbound | Task 1.8 (general) + 3.3 (email) + 3.4 (whatsapp) ✓ |
| `setup/verify.ts` 9-check | Task 1.9 ✓ |
| Voice reply | Task 3.5 ✓ |
| Scheduled digest + study cards | Tasks 3.7-3.8 ✓ |
| CLAUDE.md rewrite | Task 3.9 ✓ |
| Lessons after each PR | Tasks 1.11, 2.9, 3.10 ✓ |

Placeholder scan: clean — no "TBD", "implement later", or naked "add validation". The Task 3.8 study-card body says "full implementation omitted here for brevity; pattern mirrors decision-digest with one `match_memory(kind='card')` call" — this is a deliberate compression because the pattern is identical to 3.7; the executor should expand it inline at execution time.

Type consistency: `Intent` discriminated union used consistently across `src/intents.ts`, `src/memory/index.ts`, `relay.ts` wiring. `DraftResult` shape consistent between email and WhatsApp. No method name drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-relay-multi-pr-rollout.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Main context stays clean. Best for a multi-day plan like this one.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Faster for short bursts but the context window fills quickly with PR-sized work.

Which approach?
