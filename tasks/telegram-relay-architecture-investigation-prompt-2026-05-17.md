# Prompt For LLM: Senior Architecture Investigation Of Telegram Relay Bugs

You are the LLM receiving this document. Treat it as the complete context needed to investigate recurring bugs in a Telegram to Claude to iMessage relay project. The user is nontechnical and wants a senior engineering answer, not hand waving.

Your task is to identify the most elegant durable solution to the problems described below. Do not jump straight to patches. First reason about the architecture, state machine, failure modes, and verification gaps. Then recommend the smallest robust redesign or set of changes.

## Role

Act as a senior software engineer and AI systems architect for an AI software development company.

Standards:

- Simplicity first.
- Prefer boring, observable, testable designs.
- Do not rewrite the whole project unless the evidence proves it is necessary.
- Avoid regex sprawl unless it is the simplest correct fix.
- Never mark a task done without proof from tests, logs, files, and, where relevant, actual iPhone UI verification.
- Treat user-visible plausible success as insufficient. Telegram saying a draft exists is not proof that iMessage has the right draft.

## User Context

The user is Dr. William Regan, an anesthesiology resident physician who uses this relay to draft iMessages and answer study questions through Telegram.

The user is nontechnical. He wants the relay to work reliably without repeatedly debugging the same failures.

Hard behavior rule:

- The relay must never send real iMessages.
- It may only create drafts.
- The user manually reviews and sends from the iPhone Messages app.

Writing style expected for drafted messages:

- Natural, conversational, warm, and human.
- Preserve the user's intended meaning.
- Match the relationship and cadence from the recent iMessage thread.
- Avoid robotic wording.
- Avoid stiff formal phrasing.
- Do not include salutations or signoffs in short text messages unless the context clearly calls for it.
- Do not use hyphens, en dashes, or em dashes inside drafted message bodies.

## Project Location

Repository:

```text
/Users/williamregan/Projects/claude-telegram-relay
```

Current branch:

```text
relay/anesthesia-corpus-portability
```

Remote:

```text
https://github.com/wregan599-jpg/claude-telegram-relay.git
```

As of the latest work, the branch is pushed through:

```text
e105186 fix: prevent stale iMessage draft handoffs
```

Known untracked files that should not be assumed to be part of the fix:

```text
models/
tasks/HANDOVER-2026-05-17-pr-merge-shortcut-recovery.md
```

## Current High Level Architecture

The system is a relay pipeline:

```text
Telegram user command
  -> local Telegram bot relay running under launchd
  -> deterministic intent and contact parsing
  -> iMessage context lookup from ~/Library/Messages/chat.db
  -> optional Claude CLI call for context-aware draft rewriting
  -> write iCloud Drive handoff file
  -> iPhone Shortcut named ClaudeDraft reads the handoff
  -> iPhone Messages compose box opens with recipient and body
  -> user manually sends or edits
```

Important runtime details:

- The launchd service is `com.claude.telegram-relay`.
- The relay process is Bun, not Terminal and not the Claude CLI.
- Full Disk Access for iMessage context lookup must apply to the process path that actually reads `~/Library/Messages/chat.db`.
- The Shortcut is named `ClaudeDraft`.
- The iPhone Shortcut reads:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

Current handoff format:

```json
{
  "recipient": "+16134102233",
  "recipient_label": "Nater",
  "body": "looking forward to the next fire brotha",
  "ts": "2026-05-17T20:59:08.470Z",
  "body_sha256": "474bb2ecdae4dd4e351590737fc6637656b932d5f1543c9c802a3bc8e1597e03"
}
```

This single file is a major design pressure point because it can be overwritten, cleared, or remain stale after a failed request.

## Important Local Files To Inspect

Inspect at minimum:

```text
src/relay.ts
src/imessage-context.ts
src/imessage-context.test.ts
src/icloud-drive-draft.ts
src/icloud-drive-draft.test.ts
src/imessage-draft.ts
src/iphone-mirror-draft.ts
scripts/imessage-thread.sh
scripts/imessage-normalize-messages.py
scripts/resolve-contact.py
setup/verify.ts
setup/shortcut-verify.ts
setup/run-claudedraft-shortcut.test.ts
tasks/lessons.md
.env.example
```

Also inspect logs:

```text
~/.claude-relay/logs/com.claude.telegram-relay.log
~/.claude-relay/logs/com.claude.telegram-relay.error.log
```

And state:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
~/.claude-relay/state/chats/8782062645.json
```

## Contact Facts Relevant To Recent Bugs

Use these only for local debugging and tests. Do not expose them unnecessarily in user-facing output.

```text
Dad: +16048092405
Mom: +16043154583
Jacqueline: +17788868975
Conor: +17786286826
Nater: +16134102233
```

Important prior contact bug:

- The user clarified that dad's phone number is `6048092405`.
- `6043154583` is mom's number.
- A previous analysis incorrectly inferred that dad should map to mom's active thread based on message volume. That was wrong.
- Contact aliases and contact resolution must not infer parent identity from chat volume alone.

## Current Verified Good State

Latest successful live flow:

User Telegram command:

```text
Okay, text Nater saying looking forward to our next fire
```

The relay wrote:

```text
recipient: +16134102233
recipient_label: Nater
body: looking forward to the next fire brotha
```

The mirrored iPhone showed actual Messages compose:

```text
New iMessage
To: Nater
looking forward to the next fire brotha
```

No send occurred. Database check returned `0` for that exact outbound body.

Latest verification:

```text
bun test
306 pass
0 fail

bun run setup:verify
34 passed
7 warnings
```

Warnings were existing environment warnings, not failing relay correctness:

- Supabase URL not set.
- Optional services not loaded.
- launchd logs live outside repo logs.
- long-lived Claude Code shell processes are present but not the launchd relay.
- `RELAY_PYTHON` not set, so launchd PATH python is used.
- voice provider not set.

## Recent Commits And What They Fixed

### `f0f51ad relay: use thread context for direct text drafts`

Problem:

- `Text jacqueline saying where you at?` resolved but the relay treated the body as literal and bypassed Claude/context.
- It wrote exactly `where you at?` without applying the thread context or user writing rules.

Fix:

- Named-contact direct body commands now still inject recent iMessage context.
- The direct body is treated as core meaning, not necessarily verbatim final wording.
- Direct phone/email targets may still bypass context because there is no safe local thread name to read.

### `36a1a76 fix: decode modern iMessage context rows`

Problem:

- `Respond to Conor's last message` produced:

```text
ha might need a full neuro exam at this point
```

Root cause:

- The iMessage reader only selected rows where `message.text` existed.
- Newer macOS Messages rows often keep visible text in `message.attributedBody` while `message.text` is null.
- The helper skipped current April 2026 Conor messages and fell back to an old October 2025 message:

```text
May have to check his reflexes
```

- Claude riffed from "reflexes" to "full neuro exam."

Fix:

- Added `scripts/imessage-normalize-messages.py`.
- Updated `scripts/imessage-thread.sh` to read `attributedBody`.
- Added regression tests in `src/imessage-context.test.ts`.
- Added logic to decline vague "respond to last message" when the latest decoded thread message is already from the user.

Correct Conor context after the fix:

```text
Latest decoded message from me: Thanks Creags
Previous Conor message: Good luck this week. Will give u a shout soon
```

Correct behavior:

- Do not invent another reply when the latest message is already from the user.
- Tell the user the latest message is already from them and ask what they want to add if they want a follow-up.

### `e105186 fix: prevent stale iMessage draft handoffs`

Problems:

1. `Okay, text Nater saying looking forward to our next fire` looked successful in Telegram but did not write a Nater handoff.
2. `latest.json` still pointed at Jacqueline.
3. ClaudeDraft reopened the old Jacqueline draft.
4. A null byte inside a decoded Nater context row caused Bun to refuse to spawn Claude:

```text
TypeError: The argument 'args[4]' must be a string without null bytes
```

Root causes:

- Parser expected `Text Nater...` at the start of the Telegram command and missed lead-ins like `Okay, text Nater...`.
- Decoded iMessage text preserved a null byte from one `attributedBody` row.
- The old single-slot `latest.json` stayed reachable while a new draft was generating or after the new draft failed.

Fixes:

- `COMMAND_POSITION_CONTACT_RE` now allows short lead-ins like `Okay`, `Ok`, `Alright`, and `Sure`.
- `scripts/imessage-normalize-messages.py` strips null and control bytes.
- The relay clears stale `latest.json` at the beginning of every new iMessage placement request.
- Added tests for the lead-in parser, null/control byte sanitation, and clearing stale handoffs.

## Recurring Failure Classes

### 1. Telegram plausible success but no real handoff

Observed with Nater:

```text
Telegram showed: Here's the draft for Nater...
latest.json still pointed to Jacqueline
ClaudeDraft opened Jacqueline
```

This is the core product failure. Telegram text is not proof.

The system must distinguish:

```text
Claude generated draft text
handoff file written
Shortcut consumed handoff
iPhone compose verified
message not sent
```

### 2. Single-slot `latest.json` can be stale

Single-slot file risks:

- New request can fail while old file remains.
- User can run ClaudeDraft and open the previous recipient/body.
- Clearing the file to fix one stale draft can erase a draft the user still wanted.
- Rapid successive commands race with the user's manual shortcut execution.

This may be the most important architecture question.

### 3. Parser gaps cause fallback to generic Claude chat

Examples:

- Lowercase names: `Text jacqueline saying where you at?`
- Conversational lead-ins: `Okay, text Nater saying looking forward to our next fire`

When parser misses an iMessage draft intent, the system may still generate Telegram prose that sounds like success while no handoff is written.

### 4. iMessage context format changed

Modern Messages rows may store body in `attributedBody`, not `message.text`.

The reader must:

- Decode `attributedBody`.
- Remove null and control bytes.
- Skip tapback rows where `associated_message_type` is nonzero.
- Avoid class names, plist fragments, and metadata leaking into prompts.
- Avoid stale fallback rows when current attributedBody rows exist.

### 5. Contact resolution can silently choose wrong target

Prior dad/mom issue:

- Dad must be `+16048092405`.
- Mom is `+16043154583`.
- Do not infer relationship aliases from chat volume.

Current system uses:

- `scripts/resolve-contact.py`
- optional `~/.claude-relay/contact-aliases.json`
- AddressBook
- `chat.db` activity for tie-breaking where appropriate

This area needs a strict fail-safe strategy.

### 6. ClaudeDraft shortcut and iPhone UI verification are separate from relay success

The relay can correctly write `latest.json`, but:

- The iPhone Shortcut may not run.
- The Shortcut editor may stay open.
- A stale compose screen may remain.
- A permission prompt may block.
- The iPhone compose may show the wrong recipient or body.

Actual proof requires mirrored iPhone UI verification or a reliable equivalent.

### 7. Long-polling 409 conflicts and process duplication

Historically, logs contained Telegram getUpdates 409 conflicts:

```text
Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
```

Recent `setup:verify` showed no active competing local plugin or process, but this should remain part of reliability investigation.

### 8. Python interpreter and launchd environment drift

The project has Python touchpoints:

- `scripts/resolve-contact.py`
- `scripts/imessage-normalize-messages.py`
- `scripts/imessage-thread.sh` uses `RELAY_PYTHON` or `python3`

`setup:verify` currently warns:

```text
RELAY_PYTHON not set - using python3 on launchd PATH
```

The launchd Python may differ from interactive shell Python. This is a reliability risk.

## User Commands That Must Work

The investigation should preserve or improve support for:

```text
Text dad saying heading to London
Text jacqueline saying where you at?
Respond to Conor's last message
Respond to Jacqueline's last message saying are you pregnant?
Okay, text Nater saying looking forward to our next fire
Message Peggy saying thanks
Ping Conor saying hi
Draft an iMessage to my mom
Reply to my dad saying on my way
```

And should avoid false positives for:

```text
Your reply to Conor seemed off. What was that based on?
In your draft to Peggy did you read context?
Respond to John's email
Nono it needs to be in my iMessages compose box
```

## Recent Live Evidence

### Jacqueline

Telegram command:

```text
Respond to Jacqueline's last message saying are you pregnant?
```

Telegram output:

```text
Here's the draft for Jacqueline:

wait are you pregnant?

Drafting to Jacqueline (+17788868975). Run ClaudeDraft in Shortcuts on your iPhone.
```

Verified iPhone compose at one point:

```text
To: Jacqueline Big JR
wait are you pregnant?
```

Later this disappeared from handoff because another command cleared or overwrote the single-slot `latest.json`.

### Conor

Initial bad flow:

```text
Respond to Conor's last message
```

Bad draft:

```text
ha might need a full neuro exam at this point
```

Real root cause:

- Used stale October 2025 context due to `message.text` only query.

After fix, live Telegram response:

```text
The latest message I can see in Conor's thread is already from you: "Thanks Creags". I did not open a new draft. Tell me what you want to add if you still want a follow up.
```

### Nater

Initial bad flow:

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

After latest fixes, live verified state:

```text
recipient: +16134102233
recipient_label: Nater
body: looking forward to the next fire brotha
```

iPhone compose verified:

```text
To: Nater
looking forward to the next fire brotha
```

No send check:

```sql
select count(*)
from message
where is_from_me = 1
  and text = 'looking forward to the next fire brotha'
  and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);
```

Result:

```text
0
```

## Current Verification Commands

Run these during investigation:

```bash
bun test
bun run setup:verify
git diff --check
scripts/imessage-thread.sh Nater 10
scripts/imessage-thread.sh Conor 10
scripts/imessage-thread.sh Jacqueline 10
```

Inspect latest handoff:

```bash
plutil -p "$HOME/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json"
```

Check no-send for a body:

```bash
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where is_from_me=1 and text='BODY_HERE' and date > ((strftime('%s','now','-2 hours') - 978307200) * 1000000000);"
```

Check relay logs:

```bash
tail -120 "$HOME/.claude-relay/logs/com.claude.telegram-relay.log"
tail -120 "$HOME/.claude-relay/logs/com.claude.telegram-relay.error.log"
```

Restart relay:

```bash
launchctl kickstart -k "gui/$(id -u)/com.claude.telegram-relay"
```

## What The Investigation Must Answer

Answer these architecture questions explicitly.

### A. Handoff Design

Is the current single `latest.json` design salvageable, or should it be replaced?

Evaluate these options:

1. Keep `latest.json` with strict clearing, timestamps, and verification.
2. Store draft files as `drafts/<draft_id>.json`.
3. Maintain a small file-based queue of pending drafts.
4. Write `latest.json` as a pointer to a draft id.
5. Have Telegram responses include a draft id and have ClaudeDraft consume that id.
6. Have ClaudeDraft archive or delete a draft immediately after reading.
7. Have ClaudeDraft consume the newest unconsumed draft only.

Rank the options. Recommend one.

Constraints:

- Prefer file-based design if possible.
- Do not add a database unless clearly necessary.
- Keep the iPhone Shortcut simple enough to maintain.
- Avoid requiring the nontechnical user to choose files manually.

### B. State Machine

Define the correct state machine for draft placement.

At minimum:

```text
telegram_received
intent_parsed
contact_resolved
context_fetched
draft_generated
handoff_written
shortcut_consumed
compose_verified
not_sent_confirmed
```

Which states can be proven automatically?

Which states require iPhone UI verification?

Which states should be logged but not claimed to the user?

### C. Telegram Response Semantics

What should Telegram say at each stage?

Avoid false claims like:

```text
Drafting to Nater. Run ClaudeDraft...
```

if no actual handoff was written.

Should Telegram output say:

```text
Draft prepared for Nater.
```

only after `latest.json` or `draft_id.json` is written?

Should it say:

```text
Handoff failed. No draft is available on iPhone.
```

if placement failed?

### D. Context Handling

How should iMessage context be normalized and injected safely?

Requirements:

- Decode `attributedBody`.
- Strip null and control bytes.
- Skip tapbacks and reactions.
- Preserve enough tone context.
- Cap length.
- Never let raw chat.db bytes reach Claude CLI.
- Avoid stale context if current attributedBody rows exist.

### E. Parser Strategy

Should command parsing remain regex based?

If yes, what is the minimal robust set of patterns?

If no, propose a simple parser structure that is safer than ad hoc regex.

Need to support:

```text
Okay, text Nater saying ...
Text jacqueline saying ...
Respond to Conor's last message
Reply to my dad saying ...
```

Need to avoid meta-question false positives:

```text
Why was your reply to Conor bad?
Did you read context in your draft to Peggy?
```

### F. Contact Resolution

Recommend a minimal safe contact resolution policy.

Must address:

- relationship aliases like mom and dad
- contact aliases file
- AddressBook
- chat.db fallback
- ambiguous matches
- direct phone numbers
- direct emails

Hard rule:

- Do not silently pick a recipient when ambiguous.

### G. Concurrency And Race Conditions

How should the relay handle:

- Rapid successive Telegram commands?
- User running ClaudeDraft while a new draft is generating?
- A new request failing after the old handoff existed?
- Multiple active devices or multiple ClaudeDraft runs?

Is a per-chat queue enough?

Should a draft id be part of the handoff?

### H. Shortcut Contract

Define exactly what ClaudeDraft should do.

Current rough behavior:

- Read CloudDocs `claude-relay-drafts/latest.json`
- Parse recipient and body
- Use Messages Send Message action with Show When Run enabled
- Opens compose without sending

Investigate whether the shortcut should:

- Delete or archive the handoff after reading
- Write a consumed marker
- Validate body hash
- Refuse stale drafts
- Display draft timestamp and recipient before opening compose

### I. Verification

Define "done" for this system.

Minimum proof should include:

```text
bun test passes
setup:verify passes or known warnings are explained
latest handoff file has correct recipient and body
iPhone compose UI shows correct recipient and body
Messages database confirms no send
logs show correct request lifecycle
```

## Required Output Format

Return a Markdown engineering report with these exact sections.

### 1. Executive Summary

State whether the project is salvageable and whether the core design should change.

### 2. Root Cause Map

For each bug class, list:

- Symptom
- Root cause
- Current mitigation
- Remaining risk
- Recommended durable fix

### 3. Architecture Recommendation

Recommend the single best design. Include a short ranking of alternatives.

### 4. Proposed State Machine

Define states, transitions, logs, and user-visible messages.

### 5. Implementation Plan

Break into small commits. For each commit:

- Files to edit
- Behavior change
- Tests to add
- Verification command

### 6. Test Plan

Include unit, integration, setup, and live iPhone verification.

### 7. Logging And Observability Plan

Specify exact log fields:

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

### 8. Safety Invariants

List nonnegotiable invariants:

- Never send iMessages.
- Never claim iPhone compose success without UI proof.
- Never leave a stale draft reachable after a failed new request.
- Never inject raw null/control bytes into Claude CLI prompt.
- Never use stale context when current attributedBody rows exist.
- Never silently choose an ambiguous recipient.
- Never let Telegram prose be the only proof of handoff.

### 9. Final Recommendation

Conclude with the single best next move and why.

## Important Bias

Do not over-engineer. The likely best answer is a small explicit state machine plus a safer file-based handoff contract, not a full rewrite.

But if the single-slot `latest.json` design is fundamentally too fragile, say so plainly and propose the simplest replacement.

The product failure is not that Claude phrased a draft badly. The product failure is that state was ambiguous:

```text
Telegram looked successful
latest.json was stale
ClaudeDraft opened the wrong recipient
```

The next design must make that impossible or immediately obvious.
