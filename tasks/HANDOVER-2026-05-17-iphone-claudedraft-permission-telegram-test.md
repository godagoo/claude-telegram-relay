# Claude Telegram Relay Handover - iPhone ClaudeDraft Permission + Telegram UI Test

Date: 2026-05-17
Repo: `/Users/williamregan/Projects/claude-telegram-relay`
Branch: `relay/anesthesia-corpus-portability`
Relevant commits:

- `206d2c6 relay: fix dad handoff visibility and Barash typo retrieval`
- `dd487f1 relay: surface pending iPhone shortcut install`
- `aa5e72f docs: archive iphone claudedraft handover`

## Executive Summary

Final status: resolved and verified end to end.

The relay code correctly writes iMessage draft handoff data for Dad, the iPhone `ClaudeDraft` shortcut now reads the CloudDocs handoff, and a real Telegram UI command produced a visible iPhone Messages draft to Dad with the expected body.

Do not delete or rewrite the project. The failure was not architectural rot. It was a narrow stack of issues:

- Dad alias/address-book ambiguity.
- Misleading Telegram response while the fixed shortcut was still pending installation.
- iPhone Shortcuts permissions and a stale running shortcut instance.
- One Mirroir automation mistake caused by loose OCR matching.

The verified working path is now:

```text
Mac Telegram UI command
-> launchd relay
-> latest.json in iCloud Drive
-> iPhone ClaudeDraft shortcut
-> Messages draft to Dad
```

## What Was Changed In Code

Commit:

```text
dd487f1 relay: surface pending iPhone shortcut install
```

Files changed:

```text
src/relay.ts
src/telegram-response.test.ts
tasks/lessons.md
```

### Why

Before this patch, if the relay successfully wrote `latest.json`, it replied as if the iPhone shortcut was ready:

```text
Drafting to dad (+16048092405). Run ClaudeDraft in Shortcuts on your iPhone.
```

That was misleading while this file still existed:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

That file means the fixed shortcut still needs to be installed/replaced on the iPhone.

### New Behavior

When the pending install artifact exists, the relay now returns a truthful pending-install status:

```text
heading to London

ClaudeDraft is not installed on your iPhone yet. Open Files > iCloud Drive > ClaudeDraft.shortcut, tap Replace or Add Shortcut, then run ClaudeDraft. Draft target: dad (+16048092405).
```

Decision log now records:

```text
imessage_draft_status: phone_shortcut_install_pending
imessage_draft_mode: icloud_drive_file
```

This prevents another false-success loop.

## Mirroir / iPhone Work Performed

The user explicitly authorized:

```text
replace ClaudeDraft
allow folder
```

Codex used Mirroir MCP through the existing repo scripts.

### Attempt 1 - Install/Replace Shortcut

Command:

```bash
node scripts/iphone-final-install.cjs
```

Observed iPhone state:

```text
All Shortcuts
ClaudeDraft
Pipewrench
SearchMyFiles-final
SearchMyFiles-signed
...
```

The script tapped `ClaudeDraft`.

The iPhone then displayed this permission prompt:

```text
Allow "ClaudeDraft" to access your "claude-relay-drafts" folder?
OK
Cancel
```

That prompt is expected. It is the missing iPhone-side permission required for `ClaudeDraft` to read:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

The existing install script did not recognize `OK` as an install/permission button, so it stopped without tapping it.

### Attempt 2 - Tap OK

After the user authorized `allow folder`, Codex tried to tap `OK`.

However, iPhone Mirroring had disconnected. Mirroir repeatedly saw only:

```text
Connecting to
iPhone 14
```

Codex restarted iPhone Mirroring:

```bash
osascript -e 'tell application "iPhone Mirroring" to quit' || true
sleep 3
open -a "iPhone Mirroring"
```

Then rechecked through Mirroir. The screen still showed:

```text
Connecting to
iPhone 14
```

At that moment, the phone-side compose verification could not be completed. This was later resolved after the user reconnected iPhone Mirroring; see `Final iPhone Verification - Completed` below.

## Real Telegram UI Test Performed

Codex used the Mac Telegram app, not a fake API call, to send a real command into the Telegram bot chat.

Command used to open the bot:

```bash
open -a Telegram 'tg://resolve?domain=wr_claude_20260427_bot'
```

Then Codex typed and sent through Telegram UI:

```text
Text dad saying Codex relay verification test - do not send
```

### Relay Log Evidence

Log tail showed:

```text
Message: Text dad saying Codex relay verification test - do...
[imessage-context] contact=dad status=found messages=10 render_context=false placement=true
[imessage-draft] icloud_drive_file for dad (+16048092405) path=/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json sha256=10ab455d614b37edd187b174f9f045164d8ee7637d66176335e83194c0597829
```

### latest.json Evidence

After the Telegram UI test, the relay wrote:

```json
{
  "recipient": "+16048092405",
  "recipient_label": "dad",
  "body": "Codex relay verification test - do not send",
  "ts": "2026-05-17T19:12:40.212Z",
  "body_sha256": "10ab455d614b37edd187b174f9f045164d8ee7637d66176335e83194c0597829"
}
```

Path:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

### Decision Log Evidence

Decision log entry:

```json
{
  "ts": "2026-05-17T19:12:39.098Z",
  "message": "Text dad saying Codex relay verification test - do not send",
  "imessage_draft_status": "phone_shortcut_install_pending",
  "imessage_draft_mode": "icloud_drive_file",
  "imessage_draft_handoff_path": "/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json",
  "imessage_draft_body_sha256": "10ab455d614b37edd187b174f9f045164d8ee7637d66176335e83194c0597829",
  "response_chars": 228,
  "error": null
}
```

### No-Send Proof

Codex checked the local Messages database for an outgoing send of the exact test body:

```bash
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where is_from_me=1 and text='Codex relay verification test - do not send' and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);"
```

Result:

```text
0
```

No iMessage was sent.

## Verification Commands And Results

### Unit Tests

Command:

```bash
bun test
```

Result:

```text
302 pass
0 fail
727 expect() calls
```

### Diff Check

Command:

```bash
git diff --check
```

Result:

```text
clean
```

### Relay Restart

Command:

```bash
bun run setup:launchd -- --service relay
```

Result:

```text
com.claude.telegram-relay loaded
Services are running
```

Active process:

```text
PID 81092
com.claude.telegram-relay
```

### Setup Verify

Command:

```bash
bun run setup:verify
```

Result:

```text
33 passed
1 failed
7 warnings
```

The single failure is the expected remaining blocker:

```text
Fixed ClaudeDraft iPhone install file still exists at /Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut; install it on iPhone, confirm the body appears, then delete the file
```

## Current State

### Good

- Telegram relay is running.
- Telegram bot receives real UI-sent commands.
- Dad resolves to the correct number:

```text
+16048092405
```

- `latest.json` is written correctly.
- The relay no longer claims the iPhone shortcut works while install is pending.
- No iMessage was sent during testing.

### Final iPhone Verification - Completed

After the user reconnected iPhone Mirroring, Codex completed the phone-side verification.

Important details:

- `ClaudeDraft` was visible in Shortcuts.
- The first automation attempt incorrectly tapped `Quick Look` because loose OCR matching found `OK` inside the words `Quick Look`. This is documented in `tasks/lessons.md`.
- Codex corrected the approach by matching exact OCR labels and using a screenshot-confirmed tile coordinate.
- iOS prompted:

```text
Allow "ClaudeDraft" to send 1 dictionary in a message?
```

Codex tapped `Always Allow`. This does not mean messages auto-send: the installed shortcut still uses Send Message with Show When Run enabled, so the output remains a visible Messages draft requiring manual send.

The first successful phone-side run opened:

```text
New iMessage
To: Dad
Body: Codex relay verification test - do not send
```

No send button was tapped.

No-send database proof:

```bash
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where is_from_me=1 and text='Codex relay verification test - do not send' and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);"
```

Output:

```text
0
```

### Final Live Telegram UI Test - Completed

Codex then moved the pending installer out of iCloud Drive:

```text
from: /Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
to:   /Users/williamregan/Downloads/claude-relay-installed-shortcuts/ClaudeDraft.shortcut.installed-2026-05-17-1551
```

Codex opened the real Mac Telegram app UI:

```bash
open -a Telegram 'tg://resolve?domain=wr_claude_20260427_bot'
```

Then sent this real Telegram command through the UI:

```text
Text dad saying Codex final draft proof - do not send
```

The relay wrote:

```json
{
  "recipient": "+16048092405",
  "recipient_label": "dad",
  "body": "Codex final draft proof - do not send",
  "ts": "2026-05-17T19:52:00.724Z",
  "body_sha256": "6ab218893af2bc8bed9e35b9448c801bf53cf341d4046864daabfd6d242e6223"
}
```

Relay log evidence:

```text
Message: Text dad saying Codex final draft proof - do not s...
[imessage-context] contact=dad status=found messages=10 render_context=false placement=true
[imessage-draft] icloud_drive_file for dad (+16048092405) path=/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json sha256=6ab218893af2bc8bed9e35b9448c801bf53cf341d4046864daabfd6d242e6223
```

On iPhone, the previous shortcut run left the `ClaudeDraft` tile in a running state. Codex stopped it by tapping the tile's small stop control, then reran the shortcut. The iPhone opened Messages with:

```text
New iMessage
To: Dad
Body: Codex final draft proof - do not send
```

Mirroir verdict:

```json
{
  "hasMessages": true,
  "hasDadLabel": true,
  "hasFinalBody": true,
  "hasOldBody": false
}
```

No send button was tapped.

No-send database proof:

```bash
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where is_from_me=1 and text='Codex final draft proof - do not send' and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);"
```

Output:

```text
0
```

## Verification

### Setup Verify

Command:

```bash
bun run setup:verify
```

Result:

```text
34 passed
7 warnings
Your bot is ready!
```

The former blocker is cleared:

```text
✓ No pending ClaudeDraft iPhone install artifact
```

Remaining warnings are expected and non-blocking:

- `SUPABASE_URL` not set.
- optional check-in/briefing launchd services not loaded.
- voice provider disabled.
- long-lived Claude Code shell processes found.

### Unit Tests

Command:

```bash
bun test
```

Result:

```text
302 pass
0 fail
727 expect() calls
```

## Required Next Steps For Claude Code

No TypeScript bug fix is required for the Dad/iPhone draft path at this point.

Recommended next actions:

1. Do not rewrite the project.
2. Do not reintroduce the iCloud installer file unless you intentionally need to replace the iPhone shortcut again.
3. If the iPhone draft path appears stuck later, check Shortcuts first: if the `ClaudeDraft` tile shows a small running/stop control, stop the stale run before rerunning.
4. Preserve the Dad alias mapping:

```text
dad -> +16048092405
mom -> +16043154583
```

5. Keep Show When Run enabled in `ClaudeDraft`; the project should draft iMessages, not auto-send them.

## Staff-Engineer Assessment

This should not be solved by rewriting the project.

The current state is narrow:

- relay parser: working
- Dad alias: working
- Telegram polling: working
- handoff JSON: working
- iMessage no-send safety: preserved
- iPhone Shortcut permission/install: working and verified

The correct next action is normal usage plus focused follow-up hardening, not a rewrite. Rewriting the repo would not have fixed the real root causes: contact alias ambiguity, an iOS Shortcuts permission state, and a stale running Shortcuts tile.
