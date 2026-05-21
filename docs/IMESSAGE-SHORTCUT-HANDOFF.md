# iMessage Staging Shortcut Handoff

The relay does not drive the final Messages compose field directly. It sends a
normal iMessage to a dedicated staging handle, and a Shortcuts automation
watching that staging thread opens the target Messages compose sheet with the
draft body filled in. The user still reviews and sends manually.

```
Telegram draft request
  -> relay resolves the target contact
  -> relay reads recent iMessage context from chat.db
  -> relay injects Obsidian memory, project anchors, and retrieval context
  -> Claude drafts under the writing rules
  -> relay strips prose dashes from the final draft body
  -> relay writes the same draft to iCloud Drive latest.json for ClaudeDraft
  -> relay sends CLDRAFT/1 payload to RELAY_IMESSAGE_STAGING_HANDLE
  -> iPhone Shortcuts automation triggers on the staging message
  -> ClaudeDraft reads latest.json from iCloud Drive
  -> Send Message opens the target compose sheet with Show When Run enabled
```

This supersedes the older CloudDocs `latest.json` / `ClaudeDraft` handoff for
manual phone launching. The same file is now written as part of the staging
handoff, and the staging iMessage acts as the wake-up signal.

## Payload Format

The staging iMessage body is JSON:

```json
{
  "version": "CLDRAFT/1",
  "to": "+15195551234",
  "label": "Conor",
  "body": "Hey Conor, thanks for sending that over. I can take a look tonight."
}
```

Fields:

- `version`: version marker and automation filter string. Configure the
  Message trigger with `Message Contains` = `CLDRAFT/1`.
- `to`: the target iMessage handle resolved by the relay, usually E.164 phone
  or an iMessage email address. The Shortcut uses this as the Send Message
  recipient.
- `label`: human-readable contact label for debugging the staging thread.
- `body`: the exact draft text that should appear in the target compose field.

The relay helper never prints the draft body to stdout. Its JSON envelope only
reports success/failure and a SHA-256 of the staging payload.

## Relay Configuration

Set the staging handle in the relay environment:

```bash
RELAY_IMESSAGE_STAGING_HANDLE=+15555555555
```

Use a handle that arrives in one staging thread on this Mac. A self iMessage
handle works if Messages receives your own iMessages locally.

Keep the staging handle different from the final target recipient. The helper
fails closed with `staging_handle_matches_recipient` if they match, because
otherwise the target recipient would receive the CLDRAFT/1 JSON payload.
Only set `RELAY_IMESSAGE_ALLOW_SELF_STAGING=1` for an intentional self-staging
test.

The relay runs under launchd as `com.claude.telegram-relay`; on this Mac the
responsible binary is currently:

```text
/opt/homebrew/Cellar/bun/1.3.13/bin/bun
```

If macOS asks for Automation permission for this hop, grant it to that bun
binary, not Terminal, Cursor, or a GUI shell.

## Shortcut Rebuild

Personal automations are local app state, not a portable `.shortcut` artifact.
Rebuild this once in Shortcuts.app on the Mac that receives the staging
iMessage.

1. Open Shortcuts.app -> Automation -> plus button.
2. Choose `Message`.
3. Set `Message Contains` to `CLDRAFT/1`.
4. Set `Sender` to the staging sender/handle if you want to restrict it. Leave
   `Any Sender` if the staging sender is ambiguous during setup.
5. Choose `Run Immediately`.
6. On iPhone, run the `ClaudeDraft` shortcut. It reads
   `iCloud Drive/claude-relay-drafts/latest.json` and opens Messages with
   `Show When Run` enabled.

iPhone note: `ClaudeStageDraft` can look correct and still open a blank compose
sheet because iOS may fire the Message automation without passing usable
message content into a nested shortcut. The production iPhone path therefore
uses the staging message as the trigger and the iCloud file as the payload.

Mac-only parser shortcut:

If rebuilding the macOS parser shortcut, run the `ClaudeStageDraft` shortcut,
or add the action chain below. The first action must read `Shortcut Input` ->
`Content`. If it reads the whole `Message` object, Messages opens a blank
compose sheet with `No recipients`.
7. In the automation's `Run Shortcut` action, tap the small round arrow next
   to `ClaudeStageDraft` and set `Input` to `Shortcut Input`. If this field is
   left blank, or points at a stale deleted variable such as `Text`, the
   automation still fires but opens an empty compose sheet.

The `ClaudeStageDraft` shortcut must also be saved as a shortcut that accepts
input. A shortcut can visually contain a `Shortcut Input` token while its saved
metadata still says it accepts no input; iOS then passes an empty value to the
nested shortcut. Re-save or reinstall the helper if `setup:verify` reports
empty accepted input classes.

Action chain:

1. `Get Text from Input`
   - Input: `Shortcut Input`
   - Click the `Shortcut Input` variable and set `Get` to `Content`
2. `Get Dictionary from Input`
   - Input: output of `Get Text`
3. `Get Dictionary Value`
   - Key: `to`
   - Dictionary: output of Get Dictionary
4. `Get Dictionary Value`
   - Key: `body`
   - Dictionary: output of Get Dictionary
5. `Send Message`
   - Recipients: output of the `to` lookup
   - Message: output of the `body` lookup
   - Expand details and set `Show When Run` ON.

`Show When Run` is the safety boundary. ON opens a compose sheet for review.
OFF can send automatically and must not be used.

## TCC Permissions

This hop needs:

- Messages signed in to iMessage.
- Shortcuts Automation permission to control Messages when the watcher runs.
- The relay's bun binary allowed to control Messages if the staging-send
  AppleScript prompt appears.

This hop does not need Full Disk Access. Full Disk Access is only for reading
`~/Library/Messages/chat.db` when the relay fetches recent thread context via
`scripts/imessage-thread.sh`; that permission is already covered by
`docs/IMESSAGE-SETUP.md` and `bun run setup:verify`.

## Test Round Trip

Dry-run the payload formatter without sending an iMessage:

```bash
tmp_payload="$(mktemp)"
printf 'test body' | \
  RELAY_IMESSAGE_STAGING_HANDLE='+15555555555' \
  RELAY_STAGE_IMESSAGE_DRY_RUN_PATH="$tmp_payload" \
  /Users/williamregan/Projects/claude-telegram-relay/scripts/stage-imessage.sh '+15195551234' 'Conor'
cat "$tmp_payload"
rm -f "$tmp_payload"
```

Live staging-send test after the automation is built:

```bash
printf 'staging handoff smoke test' | \
  RELAY_IMESSAGE_STAGING_HANDLE='<your staging handle>' \
  /Users/williamregan/Projects/claude-telegram-relay/scripts/stage-imessage.sh '<safe target handle>' 'ClaudeDraft self-test'
```

Expected:

- The staging thread receives the `CLDRAFT/1` payload.
- The automation fires.
- Messages opens a compose sheet to the safe target handle.
- The body reads `staging handoff smoke test`.
- Nothing is sent until the user presses Send.

End-to-end Telegram test:

1. Restart the launchd relay after setting `RELAY_IMESSAGE_STAGING_HANDLE`.
2. Send Telegram: `Text <safe contact> saying staging handoff smoke test`.
3. Confirm the target Messages compose field contains the draft.
4. Close the compose sheet without sending.
5. Confirm the decision log contains:

```json
"imessage_draft_status":"staging_handoff_sent"
"imessage_draft_mode":"staging_imessage"
"imessage_draft_payload_sha256":"..."
```

## Troubleshooting

- `staging_handle_missing`: set `RELAY_IMESSAGE_STAGING_HANDLE` in the relay
  environment and restart `com.claude.telegram-relay`.
- `staging_handle_matches_recipient`: the staging handle equals the target
  handle. Use a separate staging handle/thread, or set
  `RELAY_IMESSAGE_ALLOW_SELF_STAGING=1` only for an intentional self-staging
  test.
- Staging message arrives but no compose sheet opens: check Shortcuts.app ->
  Automation; the trigger must be Message, sender must match the staging
  thread, `Message Contains` must be `CLDRAFT/1`, and `Run Immediately` must
  be selected.
- Compose sheet opens but sends immediately: edit the Send Message action and
  turn `Show When Run` ON.
- macOS permission prompt names the wrong app: the relay runs as bun under
  launchd. Grant Automation to the resolved bun path printed above or by
  `launchctl print gui/$(id -u)/com.claude.telegram-relay`.
