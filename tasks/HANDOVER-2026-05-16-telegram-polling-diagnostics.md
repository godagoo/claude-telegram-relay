# Handover: Telegram Polling Diagnostics Fix

Date: 2026-05-16  
Project: `/Users/williamregan/Projects/claude-telegram-relay`  
Audience: Claude Code

## Executive Answer

Do not redo the project.

The live issue shown in the terminal was not caused by the Python contact resolver. The root problem was Telegram `getUpdates` ownership contention plus weak/misleading relay diagnostics.

The relay is now running cleanly after source fixes, launchd reload, tests, smoke checks, setup verification, and live log checks.

## What Was Wrong

### 1. Telegram 409 Was Token-Level Polling Contention

The terminal showed:

```text
409 Conflict: terminated by other getUpdates request
```

That means another long-polling consumer was using the same Telegram bot token at some point. This is not a bad token and not a Python version issue.

Important detail: a direct `getUpdates` call with `timeout=0` can succeed during a quiet window even when another 30-second long poller later wins the race. It proves token reachability, not exclusive ownership.

### 2. Relay Logs Over-Claimed Ownership

The relay logged:

```text
[telegram] long polling owner: claude-telegram-relay pid=<pid>
```

That was misleading. grammY can invoke `onStart` before the later long-poll request fails with a 409. So `onStart` proves the polling loop was started, not that this relay owns polling.

### 3. The 409 Classifier Was Too Broad

The prior classifier treated object-shaped `error_code=409` responses as polling conflicts without requiring the method to be `getUpdates`.

That could incorrectly suppress unrelated Telegram 409s, such as a `sendMessage` conflict, and put the relay into an infinite retry loop.

### 4. Setup Verification Missed Operational Polling Checks

`setup:verify` already checked the official Claude Telegram plugin config file, but it did not verify:

- active official Telegram plugin processes
- Telegram webhook state
- duplicate local relay processes
- `bot.lock` consistency with the running relay PID

Those gaps mattered because Telegram 409s are operational ownership failures as much as application exceptions.

## Source Changes Made

### `src/telegram-polling.ts`

File: `/Users/williamregan/Projects/claude-telegram-relay/src/telegram-polling.ts`

Added a stricter, typed classifier:

```ts
classifyTelegramPollingConflictError(error)
```

It now distinguishes:

- `competing_poller`
- `webhook_active`
- `unknown_getupdates_409`

The classifier now requires the conflict to be tied to `getUpdates` when method information is available.

Also added:

```ts
formatTelegramPollingConflictLog(...)
formatTelegramPollingConflictHint(...)
shouldEscalateTelegramPollingConflict(...)
```

These produce token-safe operator diagnostics with:

- conflict kind
- PID
- attempt count
- elapsed seconds
- retry delay
- lock path
- Claude Telegram plugin `.env` presence

No token, token hash, or full Telegram API URL is printed.

### `src/relay.ts`

File: `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Changed the startup log from:

```text
Bot is running!
[telegram] long polling owner: claude-telegram-relay pid=<pid>
```

to:

```text
Bot polling loop started.
[telegram] long polling attempt: claude-telegram-relay pid=<pid>
```

The polling retry loop now:

- uses the stricter `classifyTelegramPollingConflictError`
- rethrows non-polling conflicts instead of swallowing them
- logs structured token-safe diagnostics on every polling conflict
- emits a stronger operator hint at bounded intervals
- keeps the short fixed retry delay of `1000ms`

### `setup/verify.ts`

File: `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`

Added token-safe checks for:

- active official Claude Telegram plugin process
- Telegram webhook state through `getWebhookInfo`
- duplicate local relay processes
- `bot.lock` PID consistency

The verifier reports webhook activity only as status and pending count. It does not print the token.

### `package.json`

File: `/Users/williamregan/Projects/claude-telegram-relay/package.json`

Updated:

```json
"verify": "bun test && bun run test:smoke && bun run setup:verify"
```

This makes the main verification path include operational health checks, not just unit and smoke tests.

### `tasks/lessons.md`

File: `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

Added the 2026-05-16 lesson:

- `bot.start({ onStart })` does not prove polling ownership.
- zero-timeout `getUpdates` is not proof of exclusive token ownership.
- Telegram 409 handling must stay scoped to `getUpdates`.
- persistent conflicts need token-safe diagnostics.

## Verification Evidence

### Focused Polling Tests

Command:

```sh
/opt/homebrew/bin/bun test src/telegram-polling.test.ts
```

Result:

```text
10 pass
0 fail
19 expect() calls
```

Coverage added:

- detects Telegram `getUpdates` 409 conflict objects
- classifies competing long-polling conflicts
- classifies active webhook conflicts separately
- detects `getUpdates` 409 conflict messages
- ignores unrelated Telegram errors
- ignores non-polling `sendMessage` 409 objects
- confirms retry delay remains fixed at `1000ms`
- confirms diagnostic escalation intervals
- confirms conflict log output is token-safe
- confirms persistent conflict hints mention external ownership sources

### Full Verification

Command:

```sh
/opt/homebrew/bin/bun run verify
```

Result:

```text
211 pass
0 fail
520 expect() calls
```

Smoke checks passed:

```text
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

`setup:verify` result:

```text
31 passed
0 failed
6 warnings
```

Important successful setup checks:

```text
No competing Claude Telegram plugin config found
No competing Claude Telegram plugin process found
Telegram webhook inactive; pending updates: 0
com.claude.telegram-relay loaded
Exactly one local relay process found
bot.lock PID 27117 is consistent with local relay state
```

### Build

Command:

```sh
/opt/homebrew/bin/bun build src/relay.ts --target bun --outdir /tmp/claude-telegram-relay-build
```

Result:

```text
Bundled 112 modules in 51ms
relay.js  0.79 MB  (entry point)
```

### Diff Hygiene

Command:

```sh
git diff --check
```

Result: clean.

### Launchd Reload

Command:

```sh
/opt/homebrew/bin/bun run setup:launchd -- --service relay
```

Result:

```text
Generated com.claude.telegram-relay.plist
Loaded — Main bot (always running, restarts on crash)
```

Current launchd status:

```text
Label = com.claude.telegram-relay
PID = 27117
LastExitStatus = 0
Program = /opt/homebrew/bin/bun
ProgramArguments = /opt/homebrew/bin/bun run src/relay.ts
```

### Live Log Check

After reload, the current stdout tail shows the corrected wording:

```text
Bot polling loop started.
[telegram] long polling attempt: claude-telegram-relay pid=27117
```

Live five-second log watch after reload:

```text
error_lines_before=83438 after=83438 delta=0
stdout_lines_before=50043 after=50043 delta=0
```

That means no new 409 error churn appeared during the live watch.

## Residual Warnings

These are not current failures:

- `SUPABASE_URL` is not set, so Supabase history/search is disabled while Obsidian memory remains active.
- `com.claude.smart-checkin` is not loaded.
- `com.claude.morning-briefing` is not loaded.
- Legacy Shortcuts-container draft still exists at:
  `/Users/williamregan/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json`
- `RELAY_PYTHON` is not set, so launchd uses `python3` from launchd PATH.
- `VOICE_PROVIDER` is not set, so voice messages are disabled.

## Current Engineering Judgment

The active relay is healthy now.

The correct interpretation is:

- The project does not need a rewrite.
- The screenshot was showing a Telegram polling ownership race, not broad project corruption.
- Local Mac state is now clean:
  - one relay process
  - matching lock PID
  - no official Claude Telegram plugin process
  - no official Claude Telegram plugin config
  - webhook inactive
  - no new 409 log growth after reload
- If 409s reappear later, the likely cause is another Mac, hosted service, launchd job, or editor/plugin instance using the same bot token.

## Next Action If 409 Reappears

Do not rotate or print the Telegram token.

Run:

```sh
/opt/homebrew/bin/bun run setup:verify
launchctl list com.claude.telegram-relay
ps axww -o pid,ppid,command | rg -i 'claude-telegram-relay|telegram/0\\.0\\.6|src/relay\\.ts|getUpdates' | rg -v rg
tail -50 /Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.error.log
tail -50 /Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.log
```

Interpretation:

- If `setup:verify` finds a plugin config or plugin process, disable that local poller.
- If webhook is active, remove the webhook before polling.
- If local state is clean and 409 persists, the token is being held by another machine or remote service.

## Files Touched In This Fix

- `/Users/williamregan/Projects/claude-telegram-relay/src/telegram-polling.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/telegram-polling.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/package.json`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`

