# Handover: Telegram Relay Runtime Audit And Fixes

Date: 2026-05-16  
Project: `/Users/williamregan/Projects/claude-telegram-relay`  
Audience: Claude Code  
Role: Senior-engineer audit handoff

## Executive Summary

The relay did **not** need a rewrite. The audit found several concrete integration bugs around launchd, Telegram long polling, iCloud Drive handoff, Shortcut validation, and iMessage parser safety. They were localized and fixed directly.

The highest-impact live issue was a Telegram long-polling conflict:

```text
GrammyError: Call to 'getUpdates' failed!
409: Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```

That error was causing launchd to restart the relay repeatedly. The relay now stays alive and retries with bounded backoff instead of crash-looping.

A local competing poller was also found:

```text
bun run --cwd /Users/williamregan/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start
```

The official Claude Telegram plugin token file was disabled without printing the token, and the plugin process was stopped.

## Source Of Truth Checked

Runtime logs:

```text
/Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.error.log
/Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.log
/Users/williamregan/.claude-relay/logs/decisions-2026-05-15.jsonl
/Users/williamregan/.claude-relay/logs/decisions-2026-05-14.jsonl
```

Project lessons:

```text
/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md
```

Key code paths:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts
/Users/williamregan/Projects/claude-telegram-relay/src/telegram-polling.ts
/Users/williamregan/Projects/claude-telegram-relay/src/arch-check.ts
/Users/williamregan/Projects/claude-telegram-relay/src/icloud-drive-draft.ts
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.ts
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-context.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/configure-launchd.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts
```

## Findings And Fixes

### 1. Telegram `getUpdates` 409 Crash Loop

#### Evidence

`com.claude.telegram-relay.error.log` repeatedly showed:

```text
GrammyError: Call to 'getUpdates' failed!
409: Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```

`launchctl list com.claude.telegram-relay` initially showed the relay loaded but with failing restarts.

#### Root Cause

`bot.start()` threw on Telegram long-polling conflict. Because launchd has `KeepAlive`, the service restarted, hit the same conflict, and repeated the loop.

The local `bot.lock` protects only one `RELAY_DIR` on this machine. It cannot prove token-level exclusivity across:

- another local process not using the same lock
- an official Claude Telegram plugin process
- another machine using the same bot token
- a remote process using the same bot token

#### Fix

Added a new polling helper:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/telegram-polling.ts
```

It provides:

```ts
isTelegramPollingConflictError(error)
nextTelegramPollingConflictDelayMs(currentDelayMs)
```

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts
```

The relay now starts Telegram polling through a backoff loop:

```text
409 getUpdates conflict -> log contention -> sleep -> retry
```

Instead of:

```text
409 getUpdates conflict -> uncaught startup failure -> launchd restart loop
```

#### Live Local Poller Cleanup

A competing local official Telegram plugin process was found:

```text
bun run --cwd /Users/williamregan/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start
```

The plugin token file was moved aside without printing the token:

```text
/Users/williamregan/.claude/channels/telegram/.env
-> /Users/williamregan/.claude/channels/telegram/.env.disabled-2026-05-16
```

The plugin process was killed.

#### Residual Runtime Status

After disabling the local plugin, only the relay process was visible locally:

```text
/opt/homebrew/bin/bun run src/relay.ts
```

The relay stayed alive with:

```text
LastExitStatus = 0
PID = 23341
```

Telegram still reported a `409` after one retry window, which means one of these remains true:

- another machine is still polling the same bot token
- a remote process is polling the same bot token
- a stale external process still owns long polling

Do **not** rotate or print the bot token. Project memory says the token is canonical and should not be rotated.

### 2. Launchd Could Not Find `sysctl`

#### Evidence

The relay error log repeatedly showed:

```text
[preflight] arch check failed: Executable not found in $PATH: "sysctl"
```

#### Root Cause

`src/arch-check.ts` used bare `sysctl`, but the generated launchd PATH omitted `/usr/sbin`.

Old generated launchd PATH:

```text
/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

`sysctl` lives at:

```text
/usr/sbin/sysctl
```

#### Fix

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/arch-check.ts
```

`isRosettaProcess()` now uses:

```text
/usr/sbin/sysctl
```

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/configure-launchd.ts
```

Generated launchd PATH now includes:

```text
/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

The service was reloaded. Current plist confirms the new PATH.

### 3. Internal Shortcut URL Leaked Into Telegram Replies

#### Evidence

The previous formatting path converted internal handoff status into user-visible Telegram text:

```text
Phone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft
```

or:

```text
Open on iPhone: shortcuts://run-shortcut?name=ClaudeDraft
```

That conflicts with the project lesson from 2026-05-15:

```text
Telegram chatbot should still show the draft itself, not an operational instruction line.
Strip internal Phone handoff ready: shortcuts://... from the user-visible reply.
```

#### Root Cause

`formatPhoneHandoffForTelegram()` preserved the Shortcut URL as visible text.

#### Fix

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.ts
```

New behavior:

```text
Draft body + Phone handoff ready line -> draft body only
Phone handoff ready line only -> "Run ClaudeDraft in Shortcuts on your iPhone."
```

The URL remains internal and available through decision logs, not user-facing Telegram copy.

Updated tests:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts
/Users/williamregan/Projects/claude-telegram-relay/src/telegram-response.test.ts
```

### 4. Runtime Could Mark `phone_handoff_ready` For Non-CloudDocs Paths

#### Evidence

Historical decision logs showed a handoff path under the non-syncing Shortcuts container:

```text
/Users/williamregan/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json
```

That path is wrong for the iPhone handoff. The iPhone Shortcut reads from CloudDocs:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

#### Root Cause

`writeICloudDriveDraft()` trusted `RELAY_ICLOUD_DRAFT_DIR` and only checked whether the parent existed. A local or non-syncing path could return `ok: true`, letting `relay.ts` claim `phone_handoff_ready` even though the iPhone could not read the file.

#### Fix

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/icloud-drive-draft.ts
```

Added:

```ts
isCloudDocsDraftDir(dir, cloudDocsRoot)
```

`writeICloudDriveDraft()` now refuses any draft directory outside:

```text
~/Library/Mobile Documents/com~apple~CloudDocs
```

Failure shape:

```text
icloud_drive_draft_dir_not_clouddocs:<dir>
```

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts
```

`setup:verify` now fails if `RELAY_ICLOUD_DRAFT_DIR` is outside the CloudDocs iCloud Drive root.

Updated tests:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/icloud-drive-draft.test.ts
```

### 5. Shortcut Validation Did Not Verify Provider Identity

#### Evidence

`setup/shortcut-verify.ts` validated action order, path shape, dictionary lookup order, `ShowWhenRun`, and body token wrapping. It did not require the Get File bookmark to actually be an iCloud/CloudDocs provider.

#### Risk

A malformed Shortcut could have a relative path that looks correct while pointing at a provider the iPhone cannot read.

#### Fix

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.ts
```

The verifier now requires:

```text
WFFileLocationType = iCloud
fileProviderDomainID starts with com.apple.CloudDocs.iCloudDriveFileProvider
```

Updated tests:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.test.ts
```

New rejection cases:

- non-iCloud file location
- non-CloudDocs file provider

### 6. Multi-Recipient Relationship Requests Chose One Contact Silently

#### Evidence

Historical decision log:

```text
Please reply to mom and dad's message
```

The relay resolved context for `mom` only and ended with marker failure.

#### Root Cause

The relationship parser extracted a single relationship contact. It had no group-thread or multi-recipient support.

#### Fix

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-context.ts
```

Added a multi-relationship guard:

```text
mom and dad
mom & dad
```

Behavior now:

```text
multi-recipient relationship request -> no one-contact automation
```

This is safer than silently drafting to only one recipient.

Updated tests:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-context.test.ts
```

## Lessons Updated

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md
```

Added the 2026-05-16 live audit lessons covering:

- Telegram 409 conflicts must back off, not crash-loop.
- The official Telegram plugin can be the local competing poller.
- System probes used under launchd need absolute paths or a complete launchd PATH.
- Telegram copy must not expose internal `shortcuts://` handoff details.
- Runtime handoff must reject non-CloudDocs draft dirs.
- Shortcut verification must validate provider identity.
- `mom and dad` must not silently select only one contact.

## Verification

### Targeted Tests

Command:

```bash
/opt/homebrew/bin/bun test \
  src/arch-check.test.ts \
  src/telegram-polling.test.ts \
  src/icloud-drive-draft.test.ts \
  src/imessage-draft.test.ts \
  src/telegram-response.test.ts \
  src/imessage-context.test.ts \
  setup/shortcut-verify.test.ts
```

Result:

```text
106 pass
0 fail
240 expect() calls
```

### Full Test Suite

Command:

```bash
/opt/homebrew/bin/bun test
```

Result:

```text
205 pass
0 fail
506 expect() calls
```

### Build

Command:

```bash
/opt/homebrew/bin/bun build src/relay.ts --outdir /tmp/claude-telegram-relay-build --target bun
```

Result:

```text
Bundled 112 modules
relay.js 0.78 MB
```

### Smoke Tests

Command:

```bash
/opt/homebrew/bin/bun run test:smoke
```

Result:

```text
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

### Setup Verifier

Command:

```bash
/opt/homebrew/bin/bun run setup:verify
```

Result:

```text
27 passed
0 failed
5 warnings
```

Warnings are expected optional setup warnings:

- Supabase URL not set
- smart-checkin not loaded
- morning-briefing not loaded
- `RELAY_PYTHON` not set
- voice provider not set

Important passing checks:

```text
Relay iCloud draft dir targets the CloudDocs iCloud Drive container
Latest iCloud draft payload shape OK
No stale Shortcuts-container draft file
Contact resolver compiles with python3
Contact resolver smoke test returns direct phone identifiers
Mac-installed ClaudeDraft reads the CloudDocs latest.json handoff and preserves Show When Run
No pending ClaudeDraft iPhone install artifact
No Intel-only binaries detected
```

### Diff Hygiene

Command:

```bash
git diff --check
```

Result:

```text
clean
```

## Deployment Performed

Reloaded the relay launchd service:

```bash
/opt/homebrew/bin/bun run setup:launchd -- --service relay
```

Result:

```text
Generated com.claude.telegram-relay.plist
Loaded - Main bot
```

Current launchd status:

```text
Label = com.claude.telegram-relay
LastExitStatus = 0
PID = 23341
Program = /opt/homebrew/bin/bun
ProgramArguments = /opt/homebrew/bin/bun run src/relay.ts
```

Current generated PATH:

```text
/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

Local process check after disabling the official plugin:

```text
23341     1 /opt/homebrew/bin/bun run src/relay.ts
```

No local `telegram/0.0.6` plugin process remained visible.

## Residual Risk

Telegram still reported a `409 getUpdates` conflict after one retry window even after the local official plugin was stopped and its token file was disabled.

That means the remaining competing poller is likely:

- another machine using the same bot token
- a remote process using the same bot token
- a stale external service still using the same bot token

Do **not** rotate or print the bot token. Project memory explicitly says:

```text
Telegram token handling - never rotate, never print
```

The code-level failure mode is fixed: the relay stays alive and backs off instead of crash-looping.

The operational next step is to find and stop the remaining external poller if Telegram conflicts persist.

## Recommended Follow-Ups

### 1. Add a setup verifier check for local official Telegram plugin state

`setup:verify` should check:

```text
/Users/williamregan/.claude/channels/telegram/.env
```

If present, warn or fail because it can allow the official plugin to compete with this relay for the same bot token.

Do not print file contents.

### 2. Add a startup log line for effective Telegram ownership

At startup, log:

```text
[telegram] long polling owner: claude-telegram-relay pid=<pid>
```

This makes future log review faster.

### 3. Decide product behavior for multi-recipient iMessage drafts

Current safe behavior:

```text
"mom and dad" -> no single-contact automation
```

Future options:

- explicitly ask user to choose one recipient
- support group-thread lookup
- support multi-recipient Messages compose

Until then, do not silently choose the first relationship contact.

### 4. Consider pinning `RELAY_PYTHON`

`setup:verify` passes without it, but warns:

```text
RELAY_PYTHON not set - using python3 on launchd PATH
```

Pinning would remove one more Terminal-vs-launchd difference:

```text
RELAY_PYTHON=/usr/local/bin/python3
```

## Changed Files Of Interest

Core fixes:

```text
src/telegram-polling.ts
src/telegram-polling.test.ts
src/relay.ts
src/arch-check.ts
src/arch-check.test.ts
src/icloud-drive-draft.ts
src/icloud-drive-draft.test.ts
src/imessage-draft.ts
src/imessage-draft.test.ts
src/telegram-response.test.ts
src/imessage-context.ts
src/imessage-context.test.ts
setup/configure-launchd.ts
setup/shortcut-verify.ts
setup/shortcut-verify.test.ts
setup/verify.ts
tasks/lessons.md
```

Note: the repository was already heavily dirty from ongoing Claude work before this audit. Do not assume every modified file in `git status` came from this audit.

## Suggested Commit Message

```text
Harden Telegram relay runtime and iPhone handoff boundaries

Keep the relay alive on Telegram long-poll conflicts, make launchd
preflight deterministic, block non-CloudDocs iPhone handoff paths, hide
internal Shortcut URLs from Telegram copy, validate Shortcut provider
identity, and avoid silently choosing one recipient for multi-person
relationship drafts.
```

## Bottom Line

The relay is in materially better shape after this pass:

- launchd service is alive with `LastExitStatus = 0`
- full test suite passes
- setup verifier passes
- iCloud/Shortcut handoff boundaries are stricter
- Telegram user copy no longer leaks internal Shortcut URLs
- Telegram 409 no longer creates a launchd crash loop
- the local official Telegram plugin poller was disabled

The only remaining issue is external token-level polling contention if `409` continues after the local plugin shutdown. The code now handles that safely; the remaining fix is operational ownership of the bot token.
