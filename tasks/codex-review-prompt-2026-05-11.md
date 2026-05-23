# Prompt for codex code review

You are an expert code reviewer auditing a working session on a production-bound Telegram-to-Claude relay. The relay forwards Telegram messages to the Claude Code CLI (`claude -p`), runs SQLite FTS over indexed Markdown for retrieval, and returns Claude's reply to the user. It runs as a launchd service on macOS Sequoia.

## Inputs

- **Working directory:** `/Users/williamregan/Projects/claude-telegram-relay`
- **Branch under review:** `master`, 8 commits ahead of `fork/master`
- **Primary input (read this first, cover to cover):** `tasks/codex-review-2026-05-11.md`
- **Companion durable log:** `tasks/lessons.md` (every entry dated 2026-05-10 was added in this session)
- **Source modules:** `src/relay.ts`, `src/retrieval.ts`, `src/query-builder.ts`, `src/trigger.ts`, `src/textbook-response.ts`, `src/response-sanitize.ts`
- **Tests:** `src/*.test.ts`, plus `scripts/smoke-*.ts`

Commit range to consider: `6f914e2..HEAD` (8 commits). All eight are summarized in the writeup with symptom, root cause, fix, and live decision-log evidence.

## Your task

The writeup ends with 10 open questions (OQ-1 through OQ-10). For each:

1. **Validate the hypothesis** by reading the cited file and lines. If the writeup is wrong on a fact, say so. If it is right, confirm with a quoted code snippet.
2. **Propose a concrete fix.** Either a unified diff against the current source, or a tight pseudo-code sketch when the change is structural. Reference file paths and line numbers.
3. **Rate severity:** P0 (user-visible bug or data loss risk), P1 (latency, fragility, or future-proofing), P2 (nice to have, low blast radius).
4. **Note test coverage** the fix would need: new unit test, new smoke test, or none if the change is purely additive defense.

After the per-question section, give:

- A short list of **any issues the writeup missed.** Likely candidates: race conditions, error handling gaps, lock acquisition logic, retrieval cache invalidation, secret handling on `.env` reload.
- A **priority order** for the next coding session. Three to five items, ranked, with one-sentence justifications.

## Constraints

Inherited from the original handoff that produced this branch:

- Do not propose embeddings, Qdrant, vector search, FastAPI sidecars, `chunks_vec`, PDF extraction, DB migrations, crawls, purges, or full reindexing. These are explicitly out of scope for the relay loop.
- Do not propose changes to the Claude CLI installation, account configuration, or model selection.
- Do not propose re-enabling the official Claude Telegram plugin.
- Do not propose creating a second Telegram long-polling consumer.
- Do not propose anything that prints or logs the Telegram bot token or other secrets.

Operational constraints:

- The relay is live and serving traffic. Prefer additive, defense-in-depth fixes over invasive refactors when they buy the same safety.
- macOS-specific behavior matters. The launchd plist at `~/Library/LaunchAgents/com.claude.telegram-relay.plist` is part of the surface area for OQ-3.

## Output format

```
## OQ-1
**Validation:** <quoted snippet or correction>
**Proposed fix:** <diff or sketch>
**Severity:** P0 | P1 | P2
**Tests needed:** <list>

## OQ-2
...

## Issues the writeup missed
- ...

## Priority order for the next session
1. <item> because <one sentence>
2. ...
```

Keep total length under ~1500 lines. Per-question depth should be proportional to severity. Skip the polite preamble. Lead with findings.

## Style note

If any part of your output drafts user-facing text (Telegram replies, email copy, log messages displayed to humans), follow the writing-style rules in `~/ObsidianVault/02-Cross-Project/writing_style_for_william.md`. Zero em dashes. Conversational, confident voice. No AI vocabulary. This does not apply to internal code comments or your review prose.
