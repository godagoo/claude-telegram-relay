# Handover: Late Session iMessage Handoff Reliability Fixes

Date: 2026-05-17
Project: `/Users/williamregan/Projects/claude-telegram-relay`
Branch: `relay/anesthesia-corpus-portability`
Remote: `https://github.com/wregan599-jpg/claude-telegram-relay.git`

## Executive Summary

The last few turns focused on repeated Telegram relay failures where Telegram showed a plausible draft but the actual iPhone handoff was stale, wrong, missing, or unverified. The project is not a total rewrite candidate, but the iMessage draft path needs a clearer state machine and likely a more robust handoff contract than one global `latest.json`.

Two real bug classes were fixed and pushed:

1. Modern macOS Messages rows stored visible text in `attributedBody`, not `message.text`, causing stale thread context and bad drafts.
2. Stale `latest.json` handoffs could survive failed new draft attempts, causing ClaudeDraft to reopen the wrong recipient or body.

Latest pushed commit:

```text
e105186 fix: prevent stale iMessage draft handoffs
```

Current live handoff file is correct for Nater:

```text
recipient: +16134102233
recipient_label: Nater
body: looking forward to the next fire brotha
```

This was verified on the mirrored iPhone compose screen:

```text
New iMessage
To: Nater
looking forward to the next fire brotha
```

No iMessage was sent. The database check for that exact body returned `0`.

## Current Git State

Recent commits:

```text
e105186 fix: prevent stale iMessage draft handoffs
36a1a76 fix: decode modern iMessage context rows
f0f51ad relay: use thread context for direct text drafts
e53941b relay: parse lowercase command-position draft names
417decf docs: record claudedraft iphone verification
```

Current status after this handover file was created:

```text
## relay/anesthesia-corpus-portability...origin/relay/anesthesia-corpus-portability
?? models/
?? tasks/HANDOVER-2026-05-17-pr-merge-shortcut-recovery.md
?? tasks/telegram-relay-architecture-investigation-prompt-2026-05-17.md
?? tasks/HANDOVER-2026-05-17-late-session-imessage-handoff-reliability.md
```

Do not assume `models/` or `tasks/HANDOVER-2026-05-17-pr-merge-shortcut-recovery.md` are related to this session.

## Files Changed In The Fixes

Relevant changed and pushed files:

```text
scripts/imessage-thread.sh
scripts/imessage-normalize-messages.py
src/imessage-context.ts
src/imessage-context.test.ts
src/icloud-drive-draft.ts
src/icloud-drive-draft.test.ts
src/relay.ts
tasks/lessons.md
```

New architecture investigation prompt file created but not committed:

```text
tasks/telegram-relay-architecture-investigation-prompt-2026-05-17.md
```

That file is intended as an upload-ready prompt for another LLM to evaluate the most elegant long-term architecture.

## Contact Facts Used During Debugging

These mappings were relevant to the recent failures:

```text
Dad: +16048092405
Mom: +16043154583
Jacqueline: +17788868975
Conor: +17786286826
Nater: +16134102233
```

Important prior correction:

- Dad is `6048092405`.
- Mom is `6043154583`.
- Do not infer dad from mom's active chat volume.

## User Requirements Reinforced

The relay must:

1. Never send real iMessages.
2. Only create drafts.
3. Verify the actual iPhone compose screen before claiming success.
4. Use recent iMessage context for named contacts when drafting.
5. Preserve the user's intended meaning, but rewrite naturally when context is available.
6. Avoid robotic text.
7. Avoid stale handoff files.
8. Never treat Telegram prose as proof that ClaudeDraft has a valid iPhone draft.

Draft style rules:

- Natural, conversational, warm.
- Match the recipient relationship and thread cadence.
- No signoffs for short text drafts unless clearly needed.
- No hyphen, en dash, or em dash in the final draft body.

## Failure 1: Conor Neuro Exam Draft

User asked:

```text
Respond to Conor's last message
```

Bad draft:

```text
ha might need a full neuro exam at this point
```

Why it happened:

- The relay logged `contact=Conor status=found messages=10 render_context=true`.
- But the actual context was stale.
- `scripts/imessage-thread.sh` selected only rows where `message.text` was non-null.
- Current macOS Messages rows often store visible bodies in `message.attributedBody`.
- The helper skipped current April 2026 messages and used an older October 2025 message:

```text
May have to check his reflexes
```

- Claude extrapolated from "reflexes" to "full neuro exam."

Fix:

- Added `scripts/imessage-normalize-messages.py`.
- Updated `scripts/imessage-thread.sh` to read `attributedBody`.
- The normalizer decodes the visible string from the streamtyped blob.
- It skips tapback rows via `associated_message_type`.
- It strips null and control bytes.
- Added unit tests in `src/imessage-context.test.ts`.
- Added logic in `src/relay.ts` to decline vague `respond to last message` commands when the latest decoded thread message is already from the user.

Correct current Conor context:

```text
Latest visible message from me: Thanks Creags
Previous Conor message: Good luck this week. Will give u a shout soon
```

Correct current behavior:

```text
The latest message I can see in Conor's thread is already from you: "Thanks Creags". I did not open a new draft. Tell me what you want to add if you still want a follow up.
```

Verification:

```bash
scripts/imessage-thread.sh Conor 10
bun test
bun run setup:verify
```

## Failure 2: Jacqueline Draft Disappeared

User asked:

```text
Respond to Jacqueline's last message saying are you pregnant?
```

Relay produced:

```text
wait are you pregnant?
```

At one point ClaudeDraft correctly opened:

```text
To: Jacqueline Big JR
wait are you pregnant?
```

But the draft later disappeared because the relay uses one global handoff file:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

When a later Conor safety check cleared `latest.json`, the Jacqueline handoff was removed.

Important lesson:

- A single-slot `latest.json` is fragile.
- Clearing stale state protects against wrong drafts, but it can also erase a draft the user still wanted.
- This is why the architecture prompt asks whether the system should move to draft ids or a small file-based queue.

## Failure 3: Nater Telegram Looked Successful But Handoff Was Still Jacqueline

User command:

```text
Okay, text Nater saying looking forward to our next fire
```

Telegram showed:

```text
Here's the draft for Nater:

looking forward to our next fire

Drafting to Nater. Run ClaudeDraft in Shortcuts on your iPhone.
```

But `latest.json` still pointed to Jacqueline:

```text
recipient: +17788868975
recipient_label: Jacqueline
body: wait are you pregnant?
```

Root cause:

- `COMMAND_POSITION_CONTACT_RE` only recognized command-position drafts at the start of the message.
- It accepted `Text Nater saying ...`.
- It missed `Okay, text Nater saying ...`.
- The turn fell through to generic Claude chat, which returned plausible Telegram prose but did not write a handoff.

Fix:

- Updated `COMMAND_POSITION_CONTACT_RE` in `src/imessage-context.ts`.
- It now allows short conversational lead-ins:

```text
Okay
Ok
Alright
Sure
```

Regression test added:

```text
command-position drafts allow short conversational lead-ins
```

## Failure 4: Null Byte In Nater Context Crashed Claude CLI Spawn

After the parser fix, the first proper Nater route still failed.

Error in `~/.claude-relay/logs/com.claude.telegram-relay.error.log`:

```text
TypeError: The argument 'args[4]' must be a string without null bytes
```

Root cause:

- One decoded Nater context row began with a null byte:

```text
\0All good bro...
```

- This was injected into the Claude CLI prompt.
- Bun refuses to spawn a process when an argv string contains null bytes.

Fix:

- `scripts/imessage-normalize-messages.py` now strips null and control bytes:

```python
value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
```

Regression test added in `src/imessage-context.test.ts`.

Verified real Nater context now contains:

```text
All good bro. Was just wanting to let you know that it appears my lawyer may have checkmated Van Horn. Nothing official yet, bu
```

No null byte remains.

## Failure 5: Stale latest.json Stayed Available During New Draft Attempts

Even after improving parsing and context decoding, a core state bug remained:

- A new request could start.
- Old `latest.json` could still point to a previous recipient.
- If Claude failed or was slow, ClaudeDraft could reopen the old handoff.

Fix:

- `src/relay.ts` now calls `clearICloudDriveDraft()` as soon as a new iMessage placement request is recognized.
- `src/icloud-drive-draft.ts` exports `clearICloudDriveDraft()`.
- Tests added in `src/icloud-drive-draft.test.ts`.

Relevant log line after fix:

```text
[imessage-draft] cleared stale iCloud handoff before new placement request path=/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

This does not fully solve the single-slot architecture risk, but it prevents the worst failure: opening an old recipient after a new draft fails.

## Latest Verified Nater Flow

Command sent through real Mac Telegram UI:

```text
Okay, text Nater saying looking forward to our next fire
```

Live relay log showed:

```text
Message: Okay, text Nater saying looking forward to our nex...
[imessage-context] contact=Nater status=found messages=10 render_context=true placement=true
[imessage-draft] cleared stale iCloud handoff before new placement request path=/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
Calling Claude: Okay, text Nater saying looking forward to our next fire...
[imessage-draft] icloud_drive_file for Nater (+16134102233) path=/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json sha256=474bb2ecdae4dd4e351590737fc6637656b932d5f1543c9c802a3bc8e1597e03
```

`latest.json`:

```text
body: looking forward to the next fire brotha
body_sha256: 474bb2ecdae4dd4e351590737fc6637656b932d5f1543c9c802a3bc8e1597e03
recipient: +16134102233
recipient_label: Nater
```

Mirrored iPhone OCR showed:

```text
New iMessage
To: Nater
looking forward to the next
fire brotha
```

The OCR split the body across two lines, but the compose field clearly contained:

```text
looking forward to the next fire brotha
```

No-send check:

```bash
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where is_from_me=1 and text='looking forward to the next fire brotha' and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);"
```

Result:

```text
0
```

## Verification Completed

Full test suite:

```text
bun test
306 pass
0 fail
```

Setup verification:

```text
bun run setup:verify
34 passed
7 warnings
```

Known warnings are existing environment warnings:

- Supabase URL not set.
- Optional launchd services not loaded.
- Launchd writes logs outside repo logs.
- Long-lived Claude Code shell processes exist but are not the launchd relay.
- `RELAY_PYTHON` not set, using launchd PATH python.
- Voice provider not set.

## Created Architecture Investigation Prompt

A self-contained prompt file was created for upload to another LLM:

```text
tasks/telegram-relay-architecture-investigation-prompt-2026-05-17.md
```

It is 865 lines and includes:

- Project context
- Current architecture
- Recent bugs
- Root causes
- Recent commits
- Live verified states
- Relevant files
- Log paths
- Verification commands
- Safety invariants
- Required output format

Use it to ask another LLM for the most elegant durable redesign. It specifically asks whether `latest.json` should remain or be replaced by draft ids, a queue, or a pointer file.

## Open Architecture Question

The code is currently working for the latest verified case, but the single-slot handoff design remains the largest systemic risk.

Current handoff:

```text
latest.json
```

Risk:

- Only one pending draft can exist.
- New commands can overwrite or clear previous drafts.
- User can run ClaudeDraft while a new draft is being generated.
- A failed new request used to leave old state available.
- Even after clearing-before-new-request, a user might lose a previous draft they intended to use.

Likely better options to evaluate:

1. Keep `latest.json` but make it a pointer to the active draft id.
2. Store drafts as individual files:

```text
drafts/<draft_id>.json
```

3. Have ClaudeDraft consume the newest unconsumed draft.
4. Archive or delete a draft after ClaudeDraft reads it.
5. Add `request_id`, `draft_id`, and `body_sha256` to logs and Telegram replies.

Do not over-engineer with a database unless clearly necessary.

## Recommended Next Steps For Claude Code

1. Read the new architecture prompt:

```text
tasks/telegram-relay-architecture-investigation-prompt-2026-05-17.md
```

2. Inspect the latest fixes:

```bash
git show --stat e105186
git show --stat 36a1a76
```

3. Re-run baseline verification:

```bash
bun test
bun run setup:verify
scripts/imessage-thread.sh Nater 10
scripts/imessage-thread.sh Conor 10
scripts/imessage-thread.sh Jacqueline 10
```

4. Decide whether to keep `latest.json` or replace it with draft ids.

5. If changing the handoff design, keep it file-based and simple.

6. Add explicit state logging before expanding features:

```text
request_id
telegram_update_id
chat_id
contact_raw
contact_normalized
resolved_recipient
draft_id
body_sha256
context_status
context_message_count
context_latest_sender
context_latest_ts
handoff_status
handoff_path
handoff_written_at
shortcut_consumed_at
ui_verified
no_send_checked
error_kind
```

7. Update `tasks/lessons.md` after any architecture change.

## Safety Invariants To Preserve

Do not break these:

```text
Never send iMessages.
Never claim iPhone compose success without UI proof.
Never leave a stale draft reachable after a failed new request.
Never inject raw null/control bytes into the Claude CLI prompt.
Never use stale context when current attributedBody rows exist.
Never silently choose an ambiguous recipient.
Never treat Telegram prose as proof of handoff.
Never infer dad or mom identity from chat volume alone.
```

## Exact Live Handoff State At Handover

At handover creation, the active iCloud handoff was:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

Contents:

```text
body: looking forward to the next fire brotha
body_sha256: 474bb2ecdae4dd4e351590737fc6637656b932d5f1543c9c802a3bc8e1597e03
recipient: +16134102233
recipient_label: Nater
ts: 2026-05-17T20:59:08.470Z
```

The mirrored iPhone compose was verified as:

```text
To: Nater
looking forward to the next fire brotha
```

No send occurred.
