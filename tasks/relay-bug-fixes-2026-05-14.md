# Relay Bug Fix Report - 2026-05-14

Repository: `/Users/williamregan/Projects/claude-telegram-relay`  
Prepared for: Claude Code upload / review  
Prepared by: Codex  
Status: Implemented in working tree and verified locally

## Executive Summary

This pass fixed a set of security, correctness, and operations bugs in the Claude Telegram Relay. The changes are currently uncommitted in the relay repository.

At the latest verification point, the relay diff covered the relay runtime, setup scripts, helper scripts, tests, and operational docs across the hardening pass:

```text
docs/IMESSAGE-SETUP.md
package.json
scripts/draft-imessage.sh
scripts/imessage-thread.sh
scripts/smoke-textbook-retrieval.ts
setup/configure-launchd.ts
setup/verify.ts
setup/install.ts
setup/test-voice.ts
src/decision-log.ts
src/imessage-context.test.ts
src/imessage-draft.test.ts
src/imessage-draft.ts
src/memory.ts
src/relay.ts
src/retrieval.test.ts
src/retrieval.ts
src/short-term.ts
src/telegram-response.ts
src/telegram-response.test.ts
tasks/lessons.md
```

The largest fixes were:

- Fail closed when `TELEGRAM_USER_ID` is missing, placeholder text, or non-numeric.
- Narrow Claude subprocess environment and tool access.
- Fix Telegram update redelivery semantics so crashes retry unsent work but do not duplicate sent replies.
- Sanitize uploaded document filenames and clean temporary uploads in `finally`.
- Harden iMessage draft/thread helper scripts with JSON-safe output, input validation, and correct Full Disk Access guidance.
- Fix textbook retrieval against the actual indexed corpus paths and add smoke verification.
- Make Supabase/memory persistence failures visible instead of silent.
- Implement the launchd unload command that setup output already told the operator to run.
- Add package-level verification that includes unit tests plus live smoke checks.
- Prevent Telegram `sendMessage` failures caused by unsupported `shortcuts://` inline keyboard button URLs.
- Persist the Telegram-visible handoff text to short-term history instead of the internal `Phone handoff ready:` marker.
- Add explicit partial-send semantics for multi-chunk Telegram replies.
- Add private permissions for runtime logs/state and per-update upload sandboxes.
- Add capped Telegram file downloads and safer Claude timeout/error handling.
- Harden launchd plist generation and setup verification.
- Align retrieval startup preflight with the passing smoke-test semantics.

## Verification Run

### Unit and Smoke Verification

Command:

```bash
/opt/homebrew/bin/bun run verify
```

Result:

```text
146 pass
0 fail
377 expect() calls
Ran 146 tests across 11 files.
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

Notable smoke evidence:

- Poison query was filtered to `"personal" "stack" "architecture"` and completed without timeout.
- Broad anesthesia textbook inventory queries returned the converted textbook catalog.
- The Miller arterial-line query returned converted Markdown hits under `/Users/williamregan/Downloads/anes-textbooks-markdown/miller10/`.

### Setup Verification

Command:

```bash
/opt/homebrew/bin/bun run setup:verify
```

Result:

```text
exit code: 0
6 passed
6 warnings
Your bot is ready
```

Warnings were configuration/optional-service warnings, not failing checks:

- `profile.md` is absent.
- `SUPABASE_URL` is not set, so memory persistence is disabled.
- `com.claude.smart-checkin` is not loaded.
- `com.claude.morning-briefing` is not loaded.
- `VOICE_PROVIDER` is not set, so voice messages are disabled.
- `USER_TIMEZONE` is still UTC.

### Diff Hygiene

Command:

```bash
/usr/bin/git -C /Users/williamregan/Projects/claude-telegram-relay diff --check
```

Result:

```text
exit code: 0
```

No whitespace or conflict-marker problems were reported.

### launchd State

Command:

```bash
/bin/launchctl list | /usr/bin/grep com.claude.telegram-relay
```

Result:

```text
54290  0  com.claude.telegram-relay
```

The relay service is loaded and running.

### iMessage Thread Lookup

Privacy-preserving verification command:

```bash
/Users/williamregan/Projects/claude-telegram-relay/scripts/imessage-thread.sh Mark 5 \
  | /usr/bin/python3 -c 'import json,sys; data=json.load(sys.stdin); print("resolved=%s, messages=%d" % ("redacted", len(data.get("messages", []))))'
```

Result:

```text
resolved=redacted, messages=5
```

This verifies that the helper can read the local iMessage database and return the requested thread count without exposing message bodies in this report.

## Fix 1 - Relay Now Fails Closed Without a Numeric Telegram Allowlist

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`

Bug:

If `TELEGRAM_USER_ID` was unset, blank, placeholder text, or otherwise invalid, the relay could start without a real operator allowlist. Because this bot can spawn a local Claude Code process, that is a material security boundary failure.

Fix:

- Added placeholder detection with `isUnsetPlaceholder`.
- Added startup validation that requires `TELEGRAM_USER_ID` to be numeric.
- Startup exits with a clear error if the allowlist is missing or invalid.
- `setup:verify` now mirrors the same numeric check.

Impact:

The relay refuses to run as a public Telegram-to-local-Claude bridge. Setup catches the same misconfiguration before launchd is involved.

Verification:

- Covered by `setup:verify`.
- Included in full `/opt/homebrew/bin/bun run verify` run.

## Fix 2 - Claude Child Process Environment and Tool Access Are Now Bounded

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

Claude subprocesses previously inherited the relay's full process environment and did not have an explicit tool boundary per message type. That unnecessarily exposed environment variables and local capabilities to child processes.

Fix:

- Added `buildClaudeEnv()` to pass only a narrow auth/runtime allowlist:
  - `HOME`
  - `PATH`
  - `SHELL`
  - `USER`
  - `LOGNAME`
  - `TMPDIR`
  - locale/timezone variables
  - Anthropic/Claude auth and config variables
- Added explicit `--tools` handling.
- Ordinary text turns run with an empty tool list.
- Upload turns enable only `Read`.
- Upload turns add only the upload directory via `--add-dir`.
- Upload turns run with `cwd` set to the upload directory.
- Session persistence is explicitly disabled with `--no-session-persistence` when resume is disabled.

Impact:

The relay now gives Claude only the environment and file/tool access required for the current request. Image/document analysis can read the uploaded file without broad project or filesystem access.

Verification:

- Full unit/smoke suite passes.
- Runtime log shows `Claude resume: disabled`, matching the intended session-persistence behavior.

## Fix 3 - Telegram Update Markers Now Distinguish Started vs Sent

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/decision-log.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

The relay wrote update markers when work started and treated those markers as seen on restart. That could silently drop an update if the process crashed after marking it started but before sending a user-visible reply. Conversely, once Telegram accepted a reply, redelivery should not duplicate the response.

Fix:

- Marker files now carry phase semantics:
  - `{ "status": "started", "ts": "..." }`
  - `{ "status": "sent", "ts": "..." }`
- `loadSeenUpdateIds()` only treats `sent` markers as seen.
- `started` markers are retried after crash.
- Added `markUpdateSent(updateId)`.
- Relay now marks sent after successful replies and handled error replies across:
  - unauthorized user path
  - text messages
  - voice messages
  - image messages
  - document messages

Impact:

Crash recovery is now correct:

- unsent work is retried;
- sent replies are not duplicated.

Verification:

- Unit tests passed in the full suite.
- `tasks/lessons.md` records the rule to prevent regression.

## Fix 4 - Upload Filenames Are Sanitized and Temporary Files Are Cleaned Reliably

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

Telegram document filenames were previously incorporated directly into upload paths. User-controlled filenames should not be trusted for path construction. Also, upload cleanup happened only on the success path, so Claude failures/timeouts could leave sensitive files behind.

Fix:

- Added `safeUploadExtension(fileName)`.
- Generated document upload names now use:
  - controlled prefix;
  - timestamp;
  - sanitized extension only.
- Original filenames are kept only as prompt metadata.
- Image and document uploads are unlinked from `finally`.
- Claude upload analysis is restricted to `Read` and `UPLOADS_DIR`.

Impact:

The relay no longer joins untrusted names into `UPLOADS_DIR`, and temporary artifacts are cleaned even when Claude or Telegram handling fails.

Verification:

- Full unit/smoke suite passes.
- Claude subprocess hardening and upload behavior are exercised by existing relay tests.

## Fix 5 - iMessage Draft Helper Produces Valid JSON and Supports Blank Compose

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/scripts/draft-imessage.sh`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/docs/IMESSAGE-SETUP.md`

Bug:

The iMessage draft helper used raw `printf` interpolation for JSON. Recipients containing quotes or other special characters could break the helper's JSON envelope. The helper also did not robustly support the documented blank/new-compose sentinel path.

Fix:

- Added JSON escaping helper.
- Prefer Python JSON serialization when available.
- Added shell fallback escaping.
- Added injectable `RELAY_OPEN_CMD` and `RELAY_PBCOPY_CMD` so tests do not launch Messages or modify the real clipboard.
- Added sentinel handling for:
  - `?`
  - `-`
  - empty recipient
- Blank compose now opens:

```text
sms:&body=<encoded body>
```

- Normal recipient compose opens:

```text
sms:<encoded recipient>&body=<encoded body>
```

- Clipboard fallback still exists if the `sms:` body URL path fails.
- Documentation now states that Messages can be opened with a prefilled `sms:` URL and falls back to clipboard/open if prefill fails.

Tests added:

- Blank-recipient compose with `NEW_COMPOSE_SENTINEL`.
- JSON-safe recipient containing a quote.

Impact:

Draft placement is more deterministic, testable, and safe for unusual recipient strings.

Verification:

- `src/imessage-draft.test.ts` passed.
- Full `/opt/homebrew/bin/bun run verify` passed.

## Fix 6 - iMessage Thread Helper Validates Input and Classifies FDA Failures

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/scripts/imessage-thread.sh`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-context.test.ts`

Bug:

`scripts/imessage-thread.sh` accepted `LIMIT` without enforcing that it was a positive integer before building sqlite work. It also had weak sqlite error classification, which made Full Disk Access problems harder to distinguish from "no matching messages."

Fix:

- Validates `LIMIT` before touching `chat.db`.
- Rejects non-numeric `LIMIT` with exit 64.
- Clamps `LIMIT` to the range 1-50.
- Added `sqlite_query_or_exit`.
- FDA/open/authorization sqlite failures exit 77 with clear setup guidance.
- JSON output now escapes the resolved recipient safely.

Test added:

```text
imessage-thread helper rejects non-numeric LIMIT before touching chat.db
```

Impact:

The helper is now safer as a shell boundary and easier for the relay to diagnose. FDA failure is not confused with an empty thread lookup.

Verification:

- Full unit suite passed.
- Privacy-preserving live check returned `messages=5` for the Mark thread.

## Fix 7 - Full Disk Access Guidance Now Points to the Process That Actually Reads Messages

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/scripts/imessage-thread.sh`
- `/Users/williamregan/Projects/claude-telegram-relay/docs/IMESSAGE-SETUP.md`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

Bug:

The old guidance told the operator to grant Full Disk Access to Terminal or the Claude CLI. That was stale. The current relay performs deterministic iMessage context prefetch before Claude runs:

```text
launchd -> bun relay -> bash -> imessage-thread.sh -> sqlite3 -> ~/Library/Messages/chat.db
```

Claude is not the process responsible for the protected database read.

Fix:

- Updated script comments.
- Updated user-facing runtime prompt context in `src/relay.ts`.
- Updated docs to avoid Terminal/Claude CLI FDA guidance for this path.
- Recorded the lesson in `tasks/lessons.md`.
- The correct FDA target is the resolved bun Cellar binary:

```bash
readlink -f "$(which bun)"
```

On this machine, `bun` resolves through:

```text
/opt/homebrew/bin/bun -> ../Cellar/bun/1.3.13/bin/bun
```

Impact:

Future FDA troubleshooting should target the actual responsible binary. This prevents repeated false fixes where Terminal or Claude has FDA but the relay still cannot read `chat.db`.

Verification:

- Live iMessage helper check returned a resolved thread and five messages.
- `setup:verify` passed.

## Fix 8 - Textbook Retrieval Searches the Actual Indexed Corpus and Recovers From Strict FTS Misses

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/retrieval.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/retrieval.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/scripts/smoke-textbook-retrieval.ts`

Bug:

Retrieval constants assumed a single converted textbook root:

```text
~/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown
```

But the active live corpus on this machine can also be indexed under:

```text
~/Downloads/anes-textbooks-markdown
```

Also, strict book-scoped FTS queries using all clinical tokens could return zero hits even when adjacent phrases would find relevant converted content. That allowed lower-quality path fallback or skipped-PDF hits to displace real converted Markdown content.

Fix:

- Replaced single `TEXTBOOK_MARKDOWN_ROOT` with `TEXTBOOK_MARKDOWN_ROOTS`.
- Book filters now expand across both roots.
- Broad textbook queries scope across both roots.
- Converted-textbook detection accepts either root.
- Added `runScopedFts`.
- Added `relaxedBookQueries` fallback for long book-scoped clinical queries.
- If strict book FTS returns zero, the search tries adjacent token pairs, right-to-left, before path fallback.
- Smoke test now accepts either converted corpus root but still requires converted/path hits.

Tests added/updated:

- Book tokens become path filters across both roots.
- Broad textbook FTS is scoped to converted Markdown across both roots.
- Book-scoped fallback relaxes long clinical queries to adjacent pairs.
- Smoke check for Miller arterial-line retrieval.

Impact:

Clinical textbook questions now find converted Markdown pages instead of failing strict FTS or falling back to skipped paths.

Verification:

From `/opt/homebrew/bin/bun run verify`:

```text
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

The Miller arterial-line smoke query returned five converted Markdown hits under:

```text
/Users/williamregan/Downloads/anes-textbooks-markdown/miller10/
```

## Fix 9 - Package Verification Now Includes Smoke Tests

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/package.json`

Bug:

`bun test` alone could pass while live retrieval behavior was broken against the actual sqlite/index state.

Fix:

Added scripts:

```json
{
  "test": "bun test",
  "test:smoke": "bun run scripts/smoke-poison-query.ts && bun run scripts/smoke-textbook-retrieval.ts",
  "verify": "bun test && bun run test:smoke"
}
```

Impact:

The standard verification command now checks both unit behavior and the high-risk live retrieval paths.

Verification:

`/opt/homebrew/bin/bun run verify` passed.

## Fix 10 - Supabase and Memory Failures Are No Longer Silent

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/memory.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

Several Supabase inserts, RPC calls, updates, and searches ignored returned errors. That meant memory and message persistence could fail silently while the relay appeared healthy.

Fix:

- `saveMessage` now logs insert errors with role context.
- `[REMEMBER]` inserts log dropped insert errors.
- `[GOAL]` inserts log dropped insert errors.
- `[DONE]` lookup and update errors are logged separately.
- `get_facts` and `get_active_goals` RPC failures are logged.
- Relevant-context search errors are logged before returning an empty context.

Impact:

Persistence failures are now visible in relay logs, which makes memory loss diagnosable.

Verification:

- Full unit/smoke suite passed.
- `setup:verify` explicitly warns that `SUPABASE_URL` is unset, which explains disabled memory persistence in this environment.

## Fix 11 - launchd Unload Is Implemented and Setup Output Is Correct

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/setup/configure-launchd.ts`

Bug:

Setup output printed an unload command that was not actually implemented in the script. This is operationally dangerous because duplicate launchd pollers cause Telegram `409 Conflict` failures and nondeterministic reply behavior.

Fix:

- Added `--unload` parsing.
- Added `unloadService(config)`.
- Supports unloading selected services or all services.
- Corrected printed stop command to:

```bash
bun run setup/configure-launchd.ts --unload --service all
```

Impact:

Operators now have a working command to unload stale relay/checkin/briefing services, especially during migrations between machines.

Verification:

- `setup:verify` passed.
- `launchctl list` shows a single loaded relay service:

```text
54290  0  com.claude.telegram-relay
```

## Fix 12 - Setup Verification Checks Actual Voice Provider Configuration

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`

Bug:

Setup verification still checked an old `GEMINI_API_KEY` path even though relay voice support is provider-based.

Fix:

- Verification now checks `VOICE_PROVIDER`.
- For `VOICE_PROVIDER=groq`, it checks `GROQ_API_KEY`.
- For `VOICE_PROVIDER=local`, it checks:
  - `ffmpeg`
  - configured whisper binary
  - `WHISPER_MODEL_PATH`
- Unknown providers produce a warning.
- Missing provider clearly warns that voice messages are disabled.

Impact:

Setup verification now matches the relay's actual voice configuration surface.

Verification:

`setup:verify` exits 0 and correctly reports:

```text
VOICE_PROVIDER not set - voice messages are disabled
```

## Fix 13 - Runtime Prompt Context No Longer Gives Wrong macOS FDA Advice

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

The runtime prompt context still said the relay spawned Claude and that Claude's resolved binary was the relevant FDA target for protected reads. That is wrong for iMessage context prefetch, which is done by bun before Claude runs.

Fix:

Updated the prompt's runtime context to say:

- The relay runs as `com.claude.telegram-relay`.
- It is not Terminal, iTerm, Warp, or a GUI shell.
- It deterministically reads iMessage context before Claude runs.
- The relevant FDA target for `~/Library/Messages/chat.db` is the resolved bun Cellar binary.
- Do not tell the user to grant FDA to Terminal or Claude CLI for this path.

Impact:

The bot should stop giving the user ineffective FDA instructions when iMessage context access fails.

Verification:

- Full unit/smoke suite passed.
- Live iMessage helper check succeeded.

## Fix 14 - Operational Lessons Were Captured

File:

- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

Added dated lesson:

```text
2026-05-14 - Senior hardening pass: fail closed, prove smoke paths, bound side effects
```

The lesson records:

- `TELEGRAM_USER_ID` must be mandatory.
- Claude subprocesses should use narrow env/tool scope.
- Update markers need `started` vs `sent`.
- iMessage helper JSON must be escaped.
- `imessage-thread.sh` needs direct boundary validation.
- Retrieval must search both active textbook roots.
- `bun test` is insufficient without smoke tests.
- Telegram uploaded filenames are untrusted.
- Setup scripts are part of the operational surface.

Impact:

The mistakes and recovery rules are now part of the project memory trail, not just this chat.

## Fix 15 - iPhone Shortcut Handoff No Longer Uses an Invalid Telegram Inline Button

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

Bug:

The relay successfully generated an iMessage draft, wrote the iCloud Shortcut handoff file, then failed to send the Telegram response because it attached a Telegram inline keyboard button whose URL used the custom `shortcuts://` scheme.

Live failure from `logs/com.claude.telegram-relay.error.log`:

```text
GrammyError: Call to 'sendMessage' failed! (400: Bad Request: inline keyboard button URL 'shortcuts://run-shortcut?name=ClaudeDraft' is invalid: Unsupported URL protocol)
```

Fix:

- Moved phone handoff formatting into the side-effect-free `formatPhoneHandoffForTelegram`.
- The relay now converts:

```text
Phone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft
```

to:

```text
Open on iPhone: shortcuts://run-shortcut?name=ClaudeDraft
```

- The URL remains in the message body only.
- `sendResponse` no longer creates or sends `reply_markup` for iPhone Shortcut handoffs.
- Removed stale inline-keyboard handling from the relay response path.
- Added regression tests proving the handoff URL is formatted as Telegram-safe body text.
- Restarted launchd so the live relay process uses the fixed source.

Impact:

Telegram no longer rejects otherwise-successful iMessage draft responses after the draft has already been generated and written to iCloud.

Verification:

Focused test:

```text
bun test src/imessage-draft.test.ts
22 pass
0 fail
55 expect() calls
```

Full verification:

```text
bun run verify
146 pass
0 fail
377 expect() calls
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

Runtime restart:

```text
54290  0  com.claude.telegram-relay
54290  ... /opt/homebrew/bin/bun run src/relay.ts
```

## Fix 16 - Short-Term History Now Stores the User-Visible Handoff Text

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`
- `/Users/williamregan/.claude-relay/state/chats/8782062645.json`

Bug:

The previous fix formatted `Phone handoff ready: shortcuts://...` into `Open on iPhone: shortcuts://...` inside `sendResponse`, but the text handler still saved the preformatted internal line to short-term state. The next Claude prompt then included `Phone handoff ready:` inside `RECENT CONVERSATION`, which exposed an internal relay marker to the model and risked repeated malformed handoff wording.

Fix:

- Added `prepareTelegramResponseText` in `src/relay.ts`.
- The text handler now computes the final Telegram-visible response before:
  - `sendResponse`;
  - `markUpdateSent`;
  - Supabase save;
  - short-term `appendTurn`;
  - memory capture;
  - decision metrics.
- `sendResponse` now uses the same preparation function, making the formatting idempotent.
- Added an idempotency regression test for already-visible `Open on iPhone` responses.
- Sanitized the existing short-term chat state entry from `Phone handoff ready:` to `Open on iPhone:`.

Impact:

Prompt history now reflects what Telegram actually showed, and internal relay handoff markers do not leak back into subsequent Claude calls.

Verification:

Focused test:

```text
bun test src/imessage-draft.test.ts
23 pass
0 fail
56 expect() calls
```

Full verification:

```text
bun run verify
146 pass
0 fail
377 expect() calls
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

## Fix 17 - Multi-Chunk Telegram Sends Are Explicitly Crash-Safe

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/telegram-response.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/telegram-response.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Bug:

Long Telegram replies are split into multiple messages. If Telegram accepted chunk 1 and rejected chunk 2, the old code threw before `markUpdateSent`, leaving ambiguous retry semantics and risking duplicate partial replies.

Fix:

- Extracted response preparation/splitting/sending into `telegram-response.ts`.
- If zero chunks are accepted, the send still throws.
- If one or more chunks are accepted and a later chunk fails, the helper returns `partialFailure` instead of throwing.
- The text handler records that error in decision logs but still marks the update sent because the user has already seen a user-visible partial reply.
- Added regression tests for hard-boundary splitting, zero-send failure, and partial-send failure.

## Fix 18 - Runtime State and Upload Handling Are Privately Scoped

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/decision-log.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/short-term.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/install.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`

Fixes:

- Relay runtime directories are enforced as `0700`.
- Decision logs, update markers, and short-term chat state are written as `0600`.
- Existing runtime state/log files were corrected on disk.
- Setup now creates the actual `~/.claude-relay` runtime directories, not only repo-local folders.
- Setup verification checks the real runtime directories for private permissions.
- Upload handlers now create a private per-update upload directory, pass only that directory through Claude `--add-dir`, and remove it recursively in `finally`.

## Fix 19 - Telegram Downloads Are Size-Gated and Status-Checked

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Fixes:

- Voice, image, and document downloads now require a Telegram file path.
- Declared Telegram `file_size` is checked before download.
- HTTP `response.ok` is required.
- `Content-Length` is checked when present.
- The response body is streamed with a byte cap instead of blindly buffering unknown-size files.
- Logs record file id, declared bytes, downloaded bytes, max cap, and content type without logging the bot file URL.

## Fix 20 - Claude Timeout and CLI Failure Handling Is Safer

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Fixes:

- Claude timeout now attempts to terminate descendants as well as the direct Claude process.
- Grace-expiry uses the same process-tree kill path.
- Claude CLI nonzero stderr is logged locally with bounded redaction.
- Telegram receives a generic CLI failure message instead of raw stderr.

## Fix 21 - launchd and Setup Scripts Are Hardened

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/setup/configure-launchd.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/test-voice.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/scripts/smoke-textbook-retrieval.ts`

Fixes:

- launchd install now fails if unload fails instead of silently loading over stale runtime state.
- Generated plist string values are XML-escaped.
- Plists are validated with `plutil -lint` before `launchctl load`.
- `setup/test-voice.ts` no longer imports undeclared `dotenv/config`; it uses the repo's simple `.env` loader pattern.
- Textbook retrieval smoke checks now fail on excessive wall-clock latency.

## Fix 22 - Retrieval Startup Preflight No Longer Uses the Poison Query

Files:

- `/Users/williamregan/Projects/claude-telegram-relay/src/retrieval.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

Bug:

Startup preflight probed `"personal" "stack" "architecture"`, but that same query is intentionally used by `scripts/smoke-poison-query.ts` to prove poisoned retrieval terms return zero rows quickly. The result was a false startup warning:

```text
[relay] retrieval preflight failed; will retry indexed retrieval per request: preflight: FTS returned 0 hits for stable architecture probe
```

Fix:

- Changed retrieval preflight to use the validated anesthesia textbook catalog probe.
- Updated the success log to `textbook catalog probe returns hits`.

Impact:

Startup logs now distinguish real retrieval failures from expected poison-query misses.

## Residual Operational Notes for Claude Code

### Historical 409 Conflict Logs

The relay error log still contains older Telegram poller conflict entries:

```text
409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
```

Observed near the end of the historical error log, but current `launchctl list` shows the active relay service as:

```text
54290  0  com.claude.telegram-relay
```

If this reappears, unload stale services on the other machine or old session:

```bash
/opt/homebrew/bin/bun run setup/configure-launchd.ts --unload --service all
```

### Error Log Also Contains Retrieval Preflight Warnings

The error log tail includes repeated warnings like:

```text
[relay] retrieval preflight failed; will retry indexed retrieval per request: preflight: FTS returned 0 hits for stable architecture probe
```

The current working-tree verification passes, including retrieval smoke tests. Treat this as runtime/log state to monitor, not as a current failing test.

### setup:verify Warnings Are Real but Non-Blocking

Current warnings:

- no `profile.md`;
- no `SUPABASE_URL`;
- smart-checkin not loaded;
- morning-briefing not loaded;
- voice provider disabled;
- timezone still UTC.

These are not part of the bug-fix pass unless Claude Code is asked to complete optional service/profile configuration.

## Suggested Commit Split

If Claude Code commits this work, use small commits by risk area:

1. Security/runtime hardening:
   - `src/relay.ts`
   - `src/decision-log.ts`
   - `package.json`
2. iMessage helper hardening:
   - `scripts/draft-imessage.sh`
   - `scripts/imessage-thread.sh`
   - `src/imessage-context.test.ts`
   - `src/imessage-draft.test.ts`
   - `docs/IMESSAGE-SETUP.md`
3. Retrieval fixes:
   - `src/retrieval.ts`
   - `src/retrieval.test.ts`
   - `scripts/smoke-textbook-retrieval.ts`
4. Setup/operations fixes:
   - `setup/configure-launchd.ts`
   - `setup/verify.ts`
5. Lessons:
   - `tasks/lessons.md`
   - this report file, if it should be versioned

## Commands Used for Final Verification

```bash
/usr/bin/git -C /Users/williamregan/Projects/claude-telegram-relay status --short
/usr/bin/git -C /Users/williamregan/Projects/claude-telegram-relay diff --stat
/usr/bin/git -C /Users/williamregan/Projects/claude-telegram-relay diff --check
/opt/homebrew/bin/bun run verify
/opt/homebrew/bin/bun test src/imessage-draft.test.ts
/opt/homebrew/bin/bun run setup:verify
/bin/launchctl list | /usr/bin/grep com.claude.telegram-relay
/bin/launchctl kickstart -k gui/$(/usr/bin/id -u)/com.claude.telegram-relay
/Users/williamregan/Projects/claude-telegram-relay/scripts/imessage-thread.sh Mark 5 | /usr/bin/python3 -c '...count only...'
```
