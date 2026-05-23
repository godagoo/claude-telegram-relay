# Handover: iMessage Staging Architecture Rebuilt

Date: 2026-05-20

Project: `/Users/williamregan/Projects/claude-telegram-relay`

> **Update 2026-05-22 (partially superseded).** The current production path
> uses the **iPhone** `ClaudeDraft` shortcut (not the Mac `ClaudeStageDraft`)
> with iCloud Drive `claude-relay-drafts/latest.json` as the payload store and
> the staging iMessage as the wake signal. The Mac `ClaudeStageDraft` shortcut
> documented below is now an **optional Mac-side diagnostic**, not the runtime.
> See `docs/IMESSAGE-SHORTCUT-HANDOFF.md` for the canonical current flow. The
> "do not reintroduce CloudDocs `latest.json`" rule in the Do Not Regress
> section below is rewritten accordingly: `latest.json` is now production
> *when paired with the staging iMessage as the wake signal*; the regression
> to avoid is using `latest.json` *without* the staging wake.

## Executive Summary

The production iMessage draft path must be:

```text
Telegram request
  -> relay resolves the Messages contact
  -> relay reads recent iMessage context from ~/Library/Messages/chat.db
  -> relay injects Obsidian durable memory, project anchors, and retrieval context
  -> Claude drafts under William's writing/style rules
  -> relay strips prose em/en dashes from the final draft body
  -> relay sends JSON payload as a normal iMessage to the staging handle
  -> Shortcuts Message automation watches for CLDRAFT/1
  -> ClaudeStageDraft parses JSON and opens the target Messages chatbox
  -> William manually reviews and taps Send
```

This architecture is not optional. It is the old working design adapted to the
current Mac. Do not replace it with direct Messages compose driving from the
relay, `sms:&body=` placement, System Events paste, or iPhone Mirroring as the
production path.

The relay must never send the final target iMessage. The only automatic send is
the staging iMessage to the staging handle.

## Why This Architecture Matters

The relay runs headless under launchd as `com.claude.telegram-relay`. Ordinary
Telegram turns have no Bash approval surface and no reliable GUI scripting
surface. Recent macOS releases also make direct compose-field placement through
AppleScript or URL schemes unreliable.

The staging design separates responsibilities:

- Relay: safe headless work, context read, draft generation, and a normal
  iMessage send to one staging handle.
- Shortcuts: local UI-aware automation, triggered by Messages, allowed to open
  the final Messages compose sheet.
- Human: final Send.

This preserves the user's hard rule: drafts only, never send final outbound
messages.

## Current Implementation

### Relay Runtime Path

Main file:

`/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`

Relevant flow:

1. `extractIMessageDraftRequest(text)` identifies iMessage/text/SMS draft
   requests.
2. `fetchIMessageContext(PROJECT_ROOT, ...)` reads the target Messages thread
   before Claude runs.
3. `renderIMessageContext(...)` is prepended to the relevant context block.
4. Obsidian memory, project anchors, indexed retrieval, short-term turns, and
   optional Supabase context are injected into the prompt.
5. Claude is instructed to emit the draft body between:

   ```text
   <<<IMESSAGE_DRAFT>>>
   ...
   <<<END_IMESSAGE_DRAFT>>>
   ```

6. `extractDraftBody(...)` extracts the body.
7. `stripProseDashes(...)` is applied again to the final draft body before
   staging. This protects deterministic direct-body fallback paths from passing
   em/en dashes through.
8. `stageIMessageDraft(...)` sends the payload to the staging iMessage handle.
9. Decision log uses:

   ```json
   "imessage_draft_status": "staging_handoff_sent",
   "imessage_draft_mode": "staging_imessage"
   ```

### Staging Helper

File:

`/Users/williamregan/Projects/claude-telegram-relay/scripts/stage-imessage.sh`

Contract:

- Reads target draft body from stdin.
- Takes target recipient as `$1`.
- Takes human contact label as optional `$2`.
- Requires `RELAY_IMESSAGE_STAGING_HANDLE`.
- Emits only JSON metadata to stdout. It never prints the draft body.
- Supports dry-run through `RELAY_STAGE_IMESSAGE_DRY_RUN_PATH`.
- Uses `osascript` to send one normal iMessage to the staging handle.
- Has a timeout guard via `RELAY_STAGE_IMESSAGE_TIMEOUT_SECONDS`, default 25.

Payload sent to staging thread:

```json
{
  "version": "CLDRAFT/1",
  "to": "+15195551234",
  "label": "Conor",
  "body": "Hey Conor, thanks for sending that over. I can take a look tonight."
}
```

Rationale for JSON:

- Still human-readable in the staging Messages thread.
- Native Shortcuts can parse it with `Get Dictionary from Input` and
  `Get Dictionary Value`.
- Avoids fragile multiline text splitting.

### Shortcuts Automation

Installed local automation state exists in:

`/Users/williamregan/Library/Shortcuts/Shortcuts.sqlite`

Verified installed shape:

- Automation count shows `Automation 1` in Shortcuts.app.
- Trigger is Message.
- Trigger contains `CLDRAFT/1`.
- `ZENABLED=1`.
- `ZSHOULDPROMPT=0`, meaning Run Immediately.
- Associated shortcut is `ClaudeStageDraft`.
- The shortcut body contains `is.workflow.actions.sendmessage`.
- The shortcut body contains `ShowWhenRun`.

Shortcut action chain:

1. `Get Dictionary from Input`
2. `Get Dictionary Value`, key `to`
3. `Get Dictionary Value`, key `body`
4. `Send Message`
   - Recipients: `to`
   - Message: `body`
   - `Show When Run`: ON

`Show When Run` is load-bearing. If OFF, the shortcut could auto-send, which is
not allowed.

Backup made before direct Shortcuts DB patch:

`/Users/williamregan/Library/Shortcuts/Shortcuts.sqlite.backup-before-claudestage-json-20260520104930`

### Configuration

`.env` now sets `RELAY_IMESSAGE_STAGING_HANDLE`.

Do not paste the handle into public logs or external messages. It is local
configuration only.

Launchd relay:

```text
label: com.claude.telegram-relay
program: /opt/homebrew/Cellar/bun/1.3.13/bin/bun
args: run src/relay.ts
cwd: /Users/williamregan/Projects/claude-telegram-relay
```

FDA target remains the real bun path:

```text
/opt/homebrew/Cellar/bun/1.3.13/bin/bun
```

## Important Files Changed

- `/Users/williamregan/Projects/claude-telegram-relay/scripts/stage-imessage.sh`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/decision-log.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts`
- `/Users/williamregan/Projects/claude-telegram-relay/README.md`
- `/Users/williamregan/Projects/claude-telegram-relay/docs/IMESSAGE-SETUP.md`
- `/Users/williamregan/Projects/claude-telegram-relay/docs/IMESSAGE-SHORTCUT-HANDOFF.md`
- `/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md`
- `/Users/williamregan/.claude/projects/-Users-williamregan-Projects-claude-telegram-relay/memory/imessage-draft-handoff-and-style.md`

## Verification Already Run

Focused tests:

```bash
bun test /Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts /Users/williamregan/Projects/claude-telegram-relay/src/relay-strip.test.ts
```

Result:

```text
49 pass
0 fail
```

Full tests:

```bash
bun test
```

Result:

```text
529 pass
0 fail
```

Setup verifier:

```bash
bun run setup:verify
```

Result:

```text
43 passed
0 failed
8 warnings
```

Key staging verifier passes:

```text
Staging helper is executable
RELAY_IMESSAGE_STAGING_HANDLE is set
Staging helper dry-run payload validates
shortcuts CLI installed
Shortcuts Message automation installed for CLDRAFT/1 -> ClaudeStageDraft
```

Key remaining warning:

```text
Automation grant missing for launchd bun -> Messages:
/opt/homebrew/Cellar/bun/1.3.13/bin/bun
```

## Current Blocker

The final live end-to-end test has not been completed because launchd bun still
lacks Automation permission to control Messages.

Observed during smoke testing:

- Dry-run payload generation works.
- Shortcuts automation exists.
- Launchd relay is running and healthy.
- Manual staging send through `stage-imessage.sh` timed out while trying to
  AppleScript Messages. The helper now returns `osascript_timeout` instead of
  hanging indefinitely.
- TCC DB check confirms no Apple Events grant from:

  ```text
  /opt/homebrew/Cellar/bun/1.3.13/bin/bun
  ```

  to:

  ```text
  com.apple.MobileSMS
  ```

Next live test should intentionally trigger the real launchd relay to perform
the staging send so macOS prompts for the correct Automation grant.

## Recommended Next Steps

1. Use the mirrored iPhone or Telegram desktop to send a harmless test command
   to the bot, for example:

   ```text
   Text <safe contact> saying staging handoff smoke test
   ```

2. Watch for a macOS Automation prompt.

3. Grant permission to:

   ```text
   /opt/homebrew/Cellar/bun/1.3.13/bin/bun
   ```

   controlling:

   ```text
   Messages
   ```

4. Re-run:

   ```bash
   bun run setup:verify
   ```

   The warning `Automation grant missing for launchd bun -> Messages` should
   disappear.

5. Send one more test Telegram draft request.

6. Expected behavior:

   - Relay reads recent iMessage context.
   - Relay logs `staging_handoff_sent`.
   - Staging Messages thread receives JSON containing `CLDRAFT/1`.
   - Shortcuts automation fires.
   - Messages opens a target compose sheet with the body populated.
   - Nothing is sent until William manually presses Send.

7. After live success, query recent local Messages for the exact smoke-test body
   to confirm it was not sent as a final outbound message. The expected count is
   zero for the target chat unless William manually sent it.

## Do Not Regress These Rules

- Do not try to place the final draft directly from the relay process.
- Do not use `sms:&body=` as production success.
- Do not use iPhone Mirroring as production placement.
- Do not use System Events or UI scripting from launchd.
- Do not use CloudDocs `latest.json` / manual `ClaudeDraft` *without* the
  staging iMessage as the wake signal (the staging-paired pattern IS the
  current production path; standalone manual-launch ClaudeDraft is not).
- Do not let Claude call helper scripts from the prompt. The relay owns all
  side effects.
- Do not expose helper failure details in a way that implies Claude tried and
  was blocked for approval.
- Do not append "review and send manually" boilerplate to the user-visible
  Telegram draft.
- Do not allow em/en dashes in outgoing draft bodies.
- Do not claim the draft is in the compose box unless the relay has actually
  completed the staging handoff.

## Current Git State Notes

Known unrelated untracked files were present before this handoff work and
should not be modified unless specifically relevant:

```text
models/
tasks/HANDOVER-2026-05-17-late-session-imessage-handoff-reliability.md
tasks/HANDOVER-2026-05-17-pr-merge-shortcut-recovery.md
tasks/telegram-relay-architecture-investigation-prompt-2026-05-17.md
```

New file from this work:

```text
scripts/stage-imessage.sh
```

This handover file itself is also new:

```text
tasks/HANDOVER-2026-05-20-imessage-staging-architecture.md
```

## One-Sentence Canonical Rule

For iMessage drafts, the relay must gather context and draft locally, send only
a structured staging iMessage, and let Shortcuts open the final Messages
chatbox with `Show When Run` enabled; the relay must never drive or send the
final target message directly.
