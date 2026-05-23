# Codex Review Response - 2026-05-11

Scope: reviewed `/Users/williamregan/Downloads/codex-review-2026-05-11.md` against the live relay code and applied the low-risk fixes that preserve the current SQLite FTS architecture.

Hard boundaries honored:
- No embeddings, Qdrant, FastAPI sidecar, `chunks_vec`, migrations, crawls, purges, or reindexing.
- No Claude account/model changes.
- No service restart during the code-edit phase.
- Existing unrelated `.gitignore` changes and the deleted `tasks/codex-review-prompt-2026-05-11.md` were left untouched.

## OQ-by-OQ Result

### OQ-1 - 300-second timeout on meta-instructions

Verdict: real operational risk.

Fix applied:
- `CLAUDE_TIMEOUT_MS` is now configurable and defaults to `90000` instead of a hard-coded 5 minutes.
- Startup logs the active timeout.
- `daemon/launchagent.plist` documents `CLAUDE_TIMEOUT_MS=90000`.

Not added:
- No unverified Claude CLI flags such as `--max-turns`.
- No streaming/progress-message loop yet. That is useful but larger than this hardening pass.

### OQ-2 - Sanitization gap on voice/image/document handlers

Verdict: confirmed bug.

Fix applied:
- Added shared `postProcessClaudeResponse()` in `src/relay.ts`.
- Text, voice, image, and document handlers now share the same response pipeline:
  - Supabase memory-intent processing when Supabase is configured.
  - Memory tag stripping.
  - Wrapper tag stripping.
  - Unicode prose dash replacement.
  - Empty-response fallback.

### OQ-3 - `CLAUDE_PATH` resolution under launchd

Verdict: confirmed fragility.

Fix applied:
- Default `CLAUDE_PATH` is now `~/.local/bin/claude`, not bare `claude`.
- Startup preflight verifies the configured CLI is executable.
- `daemon/launchagent.plist` now includes explicit `CLAUDE_PATH`, `CLAUDE_TIMEOUT_MS`, and `CLAUDE_RESUME` environment variables.
- `setup/configure-launchd.ts` now emits the same variables so future setup runs do not regress the plist.

### OQ-4 - No automated em-dash lint on outgoing drafts

Verdict: worth a low-risk sanitizer.

Fix applied:
- Added `stripProseDashes()` to `src/response-sanitize.ts`.
- Replaces Unicode em/en dashes outside inline code and fenced code blocks.
- Preserves technical code examples.
- Added regression tests.

Note: this intentionally does not rewrite ordinary ASCII hyphens.

### OQ-5 - Resumed-session poisoning recovery

Verdict: root cause is the `--resume` path plus unbounded model session memory.

Fix applied:
- `--resume` is now opt-in with `CLAUDE_RESUME=1`; default is fresh Claude CLI calls plus bounded `RECENT CONVERSATION`.
- If resume is explicitly enabled and wrapper tags are stripped, the relay resets the stored Claude session.

### OQ-6 - iMessage and Mail access architecture

Verdict: do not grant broad Full Disk Access to the relay or Claude by default.

Recommendation:
- Prefer pre-extraction or a narrow helper that writes a scoped cache file the relay can read.
- Do not make this part of the normal relay path until there is a separate privacy and permissions design.

No code change in this pass.

### OQ-7 - Three-way book-name drift

Verdict: confirmed maintainability bug.

Fix applied:
- Added `src/books.ts` as the single source of truth for:
  - book keys,
  - display names,
  - converted-markdown path segments,
  - trigger aliases.
- `src/query-builder.ts`, `src/trigger.ts`, `src/retrieval.ts`, and `src/textbook-response.ts` now derive from that shared catalog.

### OQ-8 - `session.json` never written

Verdict: current effective design is fresh session per call.

Fix applied:
- Made that behavior explicit by disabling resume unless `CLAUDE_RESUME=1`.
- Session parsing/saving now only runs when resume is enabled.

Reasoning:
- The relay already injects bounded short-term context.
- Fresh sessions avoid reintroducing the previously observed `<response>` poisoning loop.

### OQ-9 - Decision-log telemetry blind spots

Verdict: cheap, high-signal fields are worth adding.

Fix applied:
- Added optional telemetry fields:
  - `memory_tags_stripped`
  - `wrapper_tags_stripped`
  - `prose_dashes_stripped`
  - `response_chars`
  - `catalog_response_used`
  - `skipped_textbook_response_used`

Not added:
- p50/p95 rollups. Those belong in a separate summarizer over the JSONL logs.

### OQ-10 - Voice/image handlers do not persist turns

Verdict: confirmed bug.

Fix applied:
- Voice, image, and document handlers now append both user and assistant turns into the local short-term buffer.
- Future text requests can see these replies in `RECENT CONVERSATION`.

## Verification

Commands run:

```bash
bun test
bun build src/relay.ts --target bun --outdir /tmp/relay-codex-review-build
git diff --check
bun run scripts/smoke-textbook-retrieval.ts
bun run scripts/smoke-poison-query.ts
```

Results:
- `49 pass / 0 fail / 109 expect() calls`
- Relay bundle built successfully.
- `git diff --check` clean.
- Textbook smoke passed, including catalog and Miller converted-markdown retrieval.
- Poison query smoke passed within bound.

## Remaining Items

- Decide whether to restart the live launchd service so these relay changes become active.
- The unrelated dirty `.gitignore` and deleted `tasks/codex-review-prompt-2026-05-11.md` still need owner review before any broad commit.
- iMessage/Mail access remains a separate architecture decision.
- JSONL p50/p95 latency rollups remain a future observability helper, not a relay runtime requirement.
