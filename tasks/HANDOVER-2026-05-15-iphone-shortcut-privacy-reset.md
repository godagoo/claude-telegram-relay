# Handover: iPhone ClaudeDraft Shortcut Install, Smoke Test, And Privacy Reset

Date: 2026-05-15  
Project: `/Users/williamregan/Projects/claude-telegram-relay`  
Audience: Claude Code

## Executive Summary

The iPhone-side `ClaudeDraft` Shortcut is now installed under the correct name, reads the relay's iCloud Drive handoff file, and has been smoke-tested through iPhone Mirroring with `mirroir-mcp`.

The accidental `Always Allow` selection on the iOS Shortcuts Send Message privacy prompt was also cleared from the iPhone. The reset was done from the Shortcut editor's Details screen:

`ClaudeDraft` -> bottom info button -> `Privacy` -> `Reset Privacy`

After reset, the `Allow Send Message ... Always Allow` row disappeared. That is the expected visual confirmation that the accidental OS-level send-message permission grant was cleared.

The safety contract remains:

1. The relay writes a JSON draft to iCloud Drive.
2. The iPhone Shortcut reads `recipient` and `body`.
3. Messages opens a compose sheet with `Show When Run` enabled.
4. A human still reviews and taps Send manually.

The relay must never silently send an iMessage.

## Current Phone State

The phone was last observed in the iOS Shortcuts privacy screen for `ClaudeDraft`.

Visible after reset:

- `Privacy`
- `Allow Running When Locked`

No longer visible:

- `Allow Send Message to use ... Always Allow`

That absence is the important confirmation that the accidental `Always Allow` grant was removed.

## What Was Done On The iPhone

### 1. Used `mirroir-mcp` Directly

The active Codex tool list did not expose a direct mirroir tool, so mirroir was invoked over MCP stdio from the local shell.

Working invocation pattern:

```sh
npx -y -p @modelcontextprotocol/sdk -p mirroir-mcp -c 'MODROOT=$(python3 -c "import os; print(os.environ[\"PATH\"].split(\":\")[0].removesuffix(\"/.bin\"))"); NODE_PATH="$MODROOT" node - << "NODE"
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "codex-mirroir-bridge", version: "1.0.0" });
  await client.connect(transport);
  const result = await client.callTool({
    name: "describe_screen",
    arguments: { skip_ocr: false },
  });
  for (const c of result.content || []) {
    if (c.type === "text") console.log(c.text);
  }
  await client.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
NODE'
```

Useful mirroir tools that worked:

- `describe_screen`
- `tap`
- `type_text`
- `press_key`
- `press_home`
- `swipe`

### 2. Installed The Correct iPhone Shortcut

Earlier failure pattern:

- A signed file named `ClaudeDraft-install.shortcut` imported onto iOS as a separate shortcut named `ClaudeDraft-install`.
- That did not replace the live relay target named `ClaudeDraft`.

Fix:

- Install a signed shortcut file named exactly `ClaudeDraft.shortcut`.
- iOS uses the `.shortcut` filename minus extension as the installed shortcut name.
- Replacing the shortcut under the exact `ClaudeDraft` name is required.

The correct installed Shortcut action chain was verified visually on the phone:

1. `Get file from claude-relay-drafts at path latest.json`
2. `Get dictionary from File`
3. `Get Value for recipient in Dictionary`
4. `Get Value for body in Dictionary`
5. `Send Dictionary Value to Dictionary Value`

The Send Message action is intentionally interactive because `Show When Run` must remain enabled.

### 3. Smoke-Tested The Handoff

The current iCloud handoff file existed at:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

Shape observed:

```json
{
  "recipient": "wregan599@gmail.com",
  "recipient_label": "myself",
  "body": "<body omitted>",
  "ts": "2026-05-15T01:11:51.840Z",
  "body_sha256": "cf80cd8aed482d5d1527d7dc72fceff84e6326592848447d2dc0b0e87dfc9a90"
}
```

The Shortcut was run from the phone editor. It opened Messages with:

- Recipient: `wregan599@gmail.com`
- Body present in the compose field

The body used for the smoke test was `testing`.

Safety verification:

```sh
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where text='testing' and is_from_me=1 and date > ((strftime('%s','now','-12 hours') - 978307200) * 1000000000);" 2>/dev/null || true
```

Result:

```text
0
```

No test iMessage was sent.

### 4. Removed Temporary iCloud Shortcut Artifacts

Temporary install artifacts were removed from iCloud Drive.

Verification command:

```sh
find "$HOME/Library/Mobile Documents/com~apple~CloudDocs" -maxdepth 1 -name 'ClaudeDraft*.shortcut' -print
```

Expected and observed result:

```text
<no output>
```

There are no pending `ClaudeDraft.shortcut` or `ClaudeDraft-install.shortcut` files waiting to be imported.

### 5. Reset The Accidental `Always Allow` Grant

The user accidentally pressed `Always Allow` on the iOS Shortcuts prompt:

```text
Allow ClaudeDraft to send 1 dictionary in a message?
```

Recovery path performed through mirroir:

1. Pressed Home.
2. Opened Spotlight/Search.
3. Searched for `Shortcuts`.
4. Opened the `ClaudeDraft` shortcut editor.
5. Pressed the bottom info button.
6. Opened `Privacy`.
7. Confirmed it showed:
   - `Allow Send Message to use`
   - `iCloud Drive`
   - `Always Allow`
8. Pressed `Reset Privacy`.
9. Confirmed the `Always Allow` row disappeared.

Important distinction:

- `Reset Privacy` clears the iOS prompt grant.
- It does not change the Shortcut actions or the relay handoff data.
- Code safety still depends on verifying `ShowWhenRun=true`.

## Source And Memory Updates

### Relay Lessons

Updated:

```text
/Users/williamregan/Projects/claude-telegram-relay/tasks/lessons.md
```

Added lesson:

- If `Always Allow` is accidentally granted, reset it from `ClaudeDraft` editor -> bottom info button -> `Privacy` -> `Reset Privacy`.
- After reset, the `Allow Send Message ... Always Allow` row disappears.
- The verifier must still enforce `ShowWhenRun=true`.

### Obsidian Memory

Updated:

```text
/Users/williamregan/ObsidianVault/01-Projects/claude-telegram-relay/memory/imessage-draft-handoff-and-style.md
```

Added durable memory:

- Same iPhone recovery path.
- Same distinction between OS privacy reset and code-level `ShowWhenRun=true` safety.

## Relevant Source Hardening Already In The Working Tree

The broader relay fix set is already present in the current working tree. Do not revert it.

Important files:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.test.ts
/Users/williamregan/Projects/claude-telegram-relay/scripts/draft-imessage.sh
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.ts
/Users/williamregan/Projects/claude-telegram-relay/src/imessage-draft.test.ts
/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts
```

Key hardening behavior:

- `setup:verify` checks the installed Mac `ClaudeDraft` Shortcut.
- `setup:verify` checks for pending iPhone install artifacts in iCloud Drive.
- A file named `ClaudeDraft-install.shortcut` is treated as wrong because it imports as `ClaudeDraft-install`.
- A file named `ClaudeDraft.shortcut` still sitting in iCloud Drive is treated as pending because it still needs to be installed and then deleted.
- Shortcut validation rejects:
  - old Shortcuts-container provider paths
  - corrupted paths such as `latest.jsoneon`
  - missing Get File action
  - Get File action in the wrong position
  - dictionary parser not wired to Get File output
  - raw body attachments in Send Message
  - `Show When Run` disabled
  - extra actions after Send Message
  - a second Send Message action
- Mac fallback no longer claims `open sms:...` proves body placement. It reports clipboard/opened status honestly unless a UI verifier exists.

## Verification Results

### Setup Verifier

Command:

```sh
bun run setup:verify
```

Result:

```text
17 passed
6 warnings
```

Critical iMessage handoff checks passed:

- Relay iCloud draft dir avoids the Shortcuts container.
- Latest iCloud draft exists.
- Latest iCloud draft payload shape is OK.
- No stale Shortcuts-container draft file.
- `shortcuts` CLI installed.
- Mac-installed `ClaudeDraft` reads the CloudDocs `latest.json` handoff and preserves `Show When Run`.
- No pending `ClaudeDraft` iPhone install artifact.

Warnings are non-blocking for iMessage handoff:

- No `profile.md`.
- `SUPABASE_URL` not set.
- `com.claude.smart-checkin` not loaded.
- `com.claude.morning-briefing` not loaded.
- `VOICE_PROVIDER` not set.
- `USER_TIMEZONE` is UTC.

### Full Test Suite

Command:

```sh
bun run verify
```

Result observed before the privacy reset:

```text
173 pass
0 fail
```

Smoke checks passed:

- `scripts/smoke-poison-query.ts`
- `scripts/smoke-textbook-retrieval.ts`

### Diff Hygiene

Command:

```sh
git diff --check
```

Result:

```text
clean
```

### No Accidental Test Send

Command:

```sh
sqlite3 "$HOME/Library/Messages/chat.db" \
  "select count(*) from message where text='testing' and is_from_me=1 and date > ((strftime('%s','now','-12 hours') - 978307200) * 1000000000);" 2>/dev/null || true
```

Result:

```text
0
```

## Current Working Tree Note

The relay repo is intentionally dirty from the broader bug-fix and hardening pass. Do not assume all modified files came from the privacy reset work.

Observed modified and untracked files include broad relay hardening changes across:

```text
docs/
scripts/
setup/
src/
tasks/
package.json
```

Notable untracked files:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.ts
/Users/williamregan/Projects/claude-telegram-relay/setup/shortcut-verify.test.ts
/Users/williamregan/Projects/claude-telegram-relay/src/telegram-response.ts
/Users/williamregan/Projects/claude-telegram-relay/src/telegram-response.test.ts
/Users/williamregan/Projects/claude-telegram-relay/tasks/HANDOVER-2026-05-14-shortcut-fix.md
/Users/williamregan/Projects/claude-telegram-relay/tasks/relay-bug-fixes-2026-05-14.md
```

This handover file is also intentionally new:

```text
/Users/williamregan/Projects/claude-telegram-relay/tasks/HANDOVER-2026-05-15-iphone-shortcut-privacy-reset.md
```

## Operational Guidance For Claude Code

1. Do not press Send in Messages during Shortcut tests.
2. If running `ClaudeDraft` again, expect iOS to prompt again for Send Message permission because privacy was reset.
3. Prefer `Allow Once` during tests, not `Always Allow`.
4. If `Always Allow` is pressed again accidentally, repeat:
   `ClaudeDraft` -> info -> `Privacy` -> `Reset Privacy`.
5. Keep `Show When Run` enabled. This is the actual safety gate that prevents silent sending.
6. Use `setup:verify` after any Shortcut edit.
7. Use a Messages DB count check after any live smoke test to prove no test body was sent.
8. Do not rely on Mac `shortcuts run ClaudeDraft` as proof that the iPhone has the updated Shortcut. Mac validation and iPhone installation are separate surfaces.

## Quick Acceptance Checklist

- [x] iPhone mirroring connected through mirroir.
- [x] `ClaudeDraft` opens on the iPhone.
- [x] Shortcut action chain visibly reads CloudDocs `claude-relay-drafts/latest.json`.
- [x] Shortcut uses `recipient` and `body` dictionary values.
- [x] Send Message remains interactive through `Show When Run`.
- [x] Live smoke test staged recipient and body in Messages.
- [x] No `testing` message was sent.
- [x] Temporary iCloud `.shortcut` artifacts removed.
- [x] Accidental `Always Allow` grant reset.
- [x] `tasks/lessons.md` updated.
- [x] Obsidian memory updated.
- [x] `bun run setup:verify` passed critical handoff checks.
- [x] `git diff --check` clean.

