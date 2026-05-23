# Handover: ClaudeDraft Shortcut iPhone Sync Fix

**Date:** 2026-05-14  
**Project:** `/Users/williamregan/Projects/claude-telegram-relay`  
**Author:** Claude Code session  
**For:** Codex (has local disk access)

---

## Executive Summary

The relay is working end-to-end **except** that the iPhone's `ClaudeDraft` Shortcuts shortcut has a stale body token (`WFTextTokenAttachment`). When the user taps the shortcut link on iPhone, Messages opens to the correct thread but the compose field is empty because iOS drops the body silently.

The **fix is already built** — a signed `.shortcut` file with the corrected token (`WFTextTokenString`) lives at:

```
~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft-install.shortcut
```

**Codex's task:** Install that file on the user's iPhone. The preferred path is automated iPhone Mirroring via the Playwright MCP (the app is on the Mac). The fallback is to print clear user instructions.

---

## Context: What the Relay Does

The Claude Telegram Relay (`~/Projects/claude-telegram-relay`) lets the user send Telegram messages to a bot (`@wr_claude_20260427_bot`) which routes them through Claude Code. For iMessage drafts:

1. User sends e.g. "respond back to my mom" in Telegram
2. Relay calls `scripts/imessage-thread.sh "mom" 10` to fetch the last 10 iMessages with mom
3. Relay calls Claude with the thread context injected
4. Claude returns a draft body wrapped between `<<<IMESSAGE_DRAFT_START>>>` / `<<<IMESSAGE_DRAFT_END>>>` markers
5. Relay writes the draft to iCloud Drive as `~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json`
6. Relay also pastes the draft into the Mac Messages.app compose window (silent bonus)
7. Relay sends to Telegram: `[draft text]\n\nOpen on iPhone: shortcuts://run-shortcut?name=ClaudeDraft`
8. User taps that link on iPhone → Shortcuts opens → `ClaudeDraft` reads `latest.json` from iCloud Drive → opens Messages with recipient + body pre-filled

Step 8 is broken because the iPhone's `ClaudeDraft` shortcut has the old body token.

---

## Root Cause: SQL Patch Did Not Sync to iPhone

On 2026-05-14, a prior session patched the body token in the Mac's `Shortcuts.sqlite` directly:

```
~/Library/Shortcuts/Shortcuts.sqlite
```

The patch changed `WFSendMessageContent.WFSerializationType` from `WFTextTokenAttachment` to `WFTextTokenString` in the installed ClaudeDraft shortcut.

**Why iPhone didn't get it:** macOS Shortcuts sync to iPhone via CloudKit (not file-system events). Direct SQL modifications bypass the CloudKit machinery — the Shortcuts app's sync daemon never saw a change, so the iPhone never received a push update.

**Evidence:**
```bash
# iCloud sync dir was last modified at 09:43 AM, BEFORE the 10:23 AM SQL patch
ls -la ~/Library/Mobile\ Documents/iCloud~is~workflow~my~workflows/
# → Documents  May 14 09:43

# Mac shortcut body token = correct
# (confirmed by validator: ok: true, errors: [], WFSerializationType: WFTextTokenString)

# iPhone shortcut body token = still the OLD value
# (inferred: CloudKit was never notified, so iPhone never pulled the update)
```

**Symptom observed by user:** Shortcut opens Messages to the correct thread but compose field is empty. User has to manually type/paste the draft.

---

## The Fix: `ClaudeDraft-install.shortcut`

A signed, installable `.shortcut` file was built from the current (patched) Mac state:

```python
# Source: ~/Library/Shortcuts/Shortcuts.sqlite
# ZSHORTCUTACTIONS.ZDATA (binary plist) → verified WFTextTokenString body token
# Packaged as proper .shortcut binary plist
# Signed with: shortcuts sign --mode people-who-know-me
```

File details:
```
~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft-install.shortcut
Size: 27562 bytes
Created: 2026-05-14 13:25
```

**Verification of body token in the signed shortcut:**

```bash
cd ~/Projects/claude-telegram-relay && bun -e '
import { readInstalledShortcutActions, validateClaudeDraftShortcutActions } from "./setup/shortcut-verify.ts";
const r = await readInstalledShortcutActions("ClaudeDraft");
const v = validateClaudeDraftShortcutActions(r.actions);
console.log("ok:", v.ok, "errors:", v.errors);
' 2>&1
# Expected: ok: true errors: []
```

---

## Codex Task: Install on iPhone

### Option A — Automated via iPhone Mirroring (preferred)

The Mac has the iPhone Mirroring app. The signed `.shortcut` file is in iCloud Drive. The full flow can be automated using the Playwright MCP to control the iPhone Mirroring window:

**Steps:**

1. **Verify the .shortcut file exists in iCloud Drive**
   ```bash
   ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/ClaudeDraft-install.shortcut
   # Must exist and be > 20000 bytes
   ```

2. **Open iPhone Mirroring**
   ```bash
   open -a "iPhone Mirroring"
   sleep 3
   ```
   Wait for the iPhone screen to appear in the window.

3. **Use Playwright to navigate to Files app on iPhone**
   - Take a screenshot of the iPhone Mirroring window to orient
   - Swipe/navigate to the Home screen if needed
   - Tap the Files app icon
   - Tap "iCloud Drive" in the sidebar
   - Scroll to find `ClaudeDraft-install.shortcut`
   - Tap the file

4. **Handle the Shortcuts install prompt**
   - Shortcuts.app opens showing a preview of ClaudeDraft
   - If an "Add Shortcut" or "Add to Shortcuts" button appears, tap it
   - If "Replace" is offered (because ClaudeDraft already exists), tap "Replace"
   - The shortcut is now installed with the fixed body token

5. **Verify on iPhone**
   - Open Shortcuts app on iPhone
   - Find ClaudeDraft
   - Confirm it can be opened (no import errors)

**Playwright automation pseudocode:**

```typescript
// Using mcp__playwright__ tools
await browser_navigate("about:blank");  // not needed for native app

// Open iPhone Mirroring
await bash('open -a "iPhone Mirroring"');
await browser_wait({ time: 3000 });

// Take screenshot to see current iPhone state
const shot = await browser_take_screenshot();
// Analyze: is iPhone unlocked and on home screen?

// Navigate to Files app
// Coordinates depend on iPhone model — take snapshot first, find Files icon
await browser_take_screenshot();  // see the iPhone Mirroring window
// Click on Files app icon in the screenshot
// Then navigate: iCloud Drive → tap ClaudeDraft-install.shortcut
// Handle the install prompt
```

> **Note for Codex:** iPhone Mirroring renders the iPhone screen in a window on the Mac. All interactions (taps, swipes) translate directly to iPhone touches. The Playwright MCP can click coordinates within the iPhone Mirroring window. Take screenshots first to determine exact coordinates for the Files app icon and iCloud Drive navigation.

### Option B — osascript approach

```bash
# Open iPhone Mirroring
open -a "iPhone Mirroring"
sleep 3

# Use osascript to check if iPhone Mirroring is running
osascript -e 'tell application "iPhone Mirroring" to activate'
# Then use Playwright MCP to interact with the window
```

### Option C — Fallback: print user instructions

If automation is not feasible, output these instructions for the user to follow manually:

```
On your iPhone:
1. Open the Files app
2. Tap iCloud Drive in the left sidebar
3. Find and tap: ClaudeDraft-install.shortcut
4. The Shortcuts app will open showing a preview
5. Tap "Replace" when asked (or "Add Shortcut" if Replace is not shown,
   then delete the old ClaudeDraft manually)
6. Done — delete ClaudeDraft-install.shortcut from iCloud Drive when finished
```

---

## Verification After Installation

After installing the shortcut on iPhone, verify the fix works end-to-end:

```bash
# 1. Relay is running
launchctl list | grep telegram-relay
# Expected: <PID>  0  com.claude.telegram-relay

# 2. Test suite passes
cd ~/Projects/claude-telegram-relay && bun test
# Expected: 170 pass, 0 fail

# 3. Setup verifier passes
cd ~/Projects/claude-telegram-relay && bun run setup:verify
# Expected: ClaudeDraft validator: ok true (among other checks)

# 4. iCloud Drive draft file is present
cat ~/Library/Mobile\ Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
# Expected: JSON with recipient, body, ts, body_sha256

# 5. Live end-to-end test:
# Send "respond back to my mom saying [something]" to @wr_claude_20260427_bot on Telegram
# Tap the "Open on iPhone: shortcuts://..." link in the Telegram reply
# Messages.app should open to mom's thread with the body pre-filled
# The compose field must NOT be empty
```

---

## All Code Changes Made in This Session

### `src/imessage-context.ts`

**What changed and why:**

1. **`MESSAGE_TYPE_RE`** — added `reply` and `response` as message-type keywords so "Please draft an iMessage response to mom" triggers the draft path even without the word "iMessage" or "text".

2. **`IMPLICIT_MESSAGE_VERB_RE`** — now allows "back" or "right back" between the verb and "to":
   ```
   /\b(respond|reply|ping)\s+(?:(?:right\s+)?back\s+)?to\b/
   ```
   Live failure: "Please respond back to my mom" → null (verb and "to" not adjacent).

3. **`EMAIL_REPLY_ALL_RE`** — new guard to prevent "reply all to" (email idiom) from triggering the iMessage draft path.

4. **`META_DRAFT_QUESTION_RE`** — new guard for questions like "Did Claude send a response to Peggy?" which previously triggered the draft path.

5. **`RELATIONSHIP_CONTACT_RE`** — possessive prefix made optional so "to mom" fires, not just "to my mom":
   ```
   /\b(?:[Ww]ith|[Tt]o|[Ff]or)\s+(?:(?:my|our|the)\s+)?(mom|mum|mother|...)\b/
   ```

6. **`renderIMessageContext` empty status** — removed "Ask the user for the phone number or email if needed." Replaced with "Draft from the user's description without asking clarifying questions."

### `src/relay.ts`

**What changed and why:**

1. **`shouldInjectContext`** — changed from `status === "found"` guard to always inject when there's a result:
   ```typescript
   // Before:
   const shouldInjectContext = Boolean(imessageContextResult) && (
     draftRequest?.wantsContext ||
     (!draftRequest?.directBody && imessageContextResult?.status === "found")
   );

   // After:
   const shouldInjectContext =
     Boolean(imessageContextResult) && !draftRequest?.directBody;
   ```
   Effect: empty/error/timeout results are now injected so Claude knows WHY context is missing, instead of hallucinating "No iMessage context was injected for your morning thread."

2. **Prompt instruction** — changed from "ask the user for the contact's phone or email" to "do NOT ask the user for a phone number, prior messages, or any other clarifying information. Draft from the user's description."

### `src/imessage-context.test.ts`

Added regression tests:
- `"Please respond back to my mom"` → extracts `contact: "mom"` (regression 2026-05-14)
- `"draft a message to mom"` (without possessive) → extracts `contact: "mom"`
- `"reply back to Sarah saying I am on my way"` → extracts `contact: "Sarah"`, `directBody: "I am on my way"`
- `"draft a text to my sister"` → extracts `contact: "sister"`
- `"the text to Mom earlier"` → still null (past-reference guard)
- `"mum"` normalizes to `"mom"`, `"mother"` normalizes to `"mom"`
- `"respond back to"` with email keyword → null (email guard)

---

## Project Structure Reference

```
~/Projects/claude-telegram-relay/
├── src/
│   ├── relay.ts                  # Main bot handler (CHANGED)
│   ├── imessage-context.ts       # Draft request parser + context fetcher (CHANGED)
│   ├── imessage-draft.ts         # Draft placement + iCloud Drive write
│   ├── icloud-drive-draft.ts     # iCloud Drive file write
│   └── telegram-response.ts      # Telegram send helpers
├── scripts/
│   ├── imessage-thread.sh        # Reads chat.db for thread context
│   ├── resolve-contact.py        # Address book fuzzy/exact contact resolver
│   └── draft-imessage.sh         # Mac Messages.app compose via sms: URL
├── setup/
│   ├── shortcut-verify.ts        # ClaudeDraft shortcut validator
│   └── verify.ts                 # Full setup health check
└── tasks/
    └── this file
```

---

## Environment State

```bash
# Relay process
launchctl list | grep telegram-relay
# → <PID>  0  com.claude.telegram-relay
# Running at: /opt/homebrew/bin/bun run src/relay.ts
# Working dir: /Users/williamregan/Projects/claude-telegram-relay
# Config: ~/Projects/claude-telegram-relay/.env

# Latest relay log
tail -20 ~/.claude-relay/logs/com.claude.telegram-relay.log

# iCloud Drive draft dir
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/claude-relay-drafts/

# Signed shortcut for iPhone install
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/ClaudeDraft-install.shortcut
```

---

## What NOT to Change

- Do not modify `scripts/resolve-contact.py` — it already handles "mom" via exact-match step 0 which is explicitly designed for contacts named "Mom".
- Do not modify `scripts/imessage-thread.sh` — it correctly blocks "mom" from fuzzy fallback while allowing exact-match via resolve-contact.py.
- Do not modify the signed `.shortcut` file — it was built and verified from the correct Mac state.
- Do not restart the relay after the shortcut installation — the relay process is already running the correct code.

---

## Summary of What Remains

| Task | Status | Method |
|---|---|---|
| relay code fixes (imessage-context.ts, relay.ts) | ✅ Done | Code changed, 170 tests pass |
| ClaudeDraft shortcut fix on Mac | ✅ Done | Shortcuts.sqlite patched, validator: ok |
| Signed .shortcut file for iPhone | ✅ Done | In iCloud Drive at ClaudeDraft-install.shortcut |
| **Install fixed shortcut on iPhone** | ⏳ **Remaining** | iPhone Mirroring automation or manual |
| Clean up ClaudeDraft-install.shortcut from iCloud Drive | After install | `rm ~/Library/Mobile\ Documents/com~apple~CloudDocs/ClaudeDraft-install.shortcut` |
