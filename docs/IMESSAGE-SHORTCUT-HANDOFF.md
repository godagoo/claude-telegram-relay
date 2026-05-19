# iMessage iPhone Handoff (ClaudeDraft Shortcut)

When the bot drafts an iMessage and a recipient resolves, the relay writes
the draft into an iCloud file on this Mac. The Telegram reply contains the
draft body alone — no "Run ClaudeDraft…" footer. The internal decision-log
state is `phone_handoff_ready`, but that label is not user-visible. On the
iPhone, William runs the `ClaudeDraft` Shortcut on his own schedule; it
reads `latest.json` and opens a pre-filled Messages compose sheet for
review. **The Shortcut never sends — only William's manual tap on the
compose Send button does.**

The only time the Telegram reply mentions the Shortcut is when the relay
detects the install file (`ClaudeDraft.shortcut` or
`ClaudeDraft-install.shortcut`) hasn't been opened yet. That message tells
him exactly which file to install and where to find it.

```
Telegram draft request  ─►  relay resolves recipient
                            └► writes latest.json to iCloud Drive (v2 schema)
                            └► Telegram reply is just the draft body
iPhone                  ─►  William runs ClaudeDraft from Shortcuts
                            └► ClaudeDraft reads latest.json
                            └► Messages compose sheet appears, body pre-filled
                            └► William reviews → taps Send (or cancels)
```

## Runtime contract

Path (atomic write, `wx` + rename, mode `0600`, parent dir `0700`):

```
~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

Source: [`src/icloud-drive-draft.ts`](../src/icloud-drive-draft.ts) (writer)
and [`src/relay.ts`](../src/relay.ts) (placement block).

Payload (always overwritten; no append, no history). v2 schema:

```json
{
  "schema_version": 2,
  "draft_id": "11111111-2222-3333-4444-555555555555",
  "writer_host": "macA.local",
  "created_at": "2026-05-13T13:30:00.000Z",
  "expires_at": "2026-05-13T13:40:00.000Z",
  "recipient": "+15198545324",
  "recipient_label": "William",
  "body": "draft text",
  "body_sha256": "9f86d081884c7d659a2feaa0c55ad015..."
}
```

Field semantics:

- `schema_version` is currently `2`. `setup:verify` fails on any other
  version; older drafts written by previous relay builds must be cleared.
- `draft_id` is a UUIDv4 generated per write. It lets the iPhone-side
  log correlate to a single relay write without needing the body.
- `writer_host` is the relay host that wrote the file. Mismatch with
  the running relay means a stale draft synced in from a different Mac.
- `created_at` and `expires_at` are ISO 8601 UTC. The relay defaults
  `expires_at` to `created_at + RELAY_DRAFT_TTL_MS` (default 10 minutes).
  `setup:verify` rejects payloads whose `expires_at` is in the past as
  a Mac-side validation gate (so an operator running verify sees a stale
  draft flagged). The iPhone Shortcut itself does NOT inspect
  `expires_at` — it consumes whatever `latest.json` it finds at run
  time. The relay clears `latest.json` on each new draft, so a stale
  file is not typically reachable to replay; see the Environment
  overrides section for the full TTL/replay semantics.
- `recipient` accepts either a phone number or an email; Messages picks
  the right transport.
- `body_sha256` is the lowercase hex SHA-256 of `body`. `setup:verify`
  recomputes the hash and rejects a payload whose `body` doesn't match.
  This is what `decision-log.jsonl` rows correlate against — they never
  store the body itself.

Backward-compatibility note: the v1 schema used a single `ts` field instead
of `created_at` / `expires_at` and did not include `schema_version`,
`draft_id`, or `writer_host`. A v1 file in `latest.json` will fail
`setup:verify` after upgrading; delete the file and let the relay rewrite
on the next draft.

## Build the Shortcut (do this once on the Mac)

The macOS Shortcut iCloud-syncs to the iPhone automatically — **Shortcuts →
Settings → iCloud Sync must be ON on both devices.** Build it on the Mac, not
the phone (Mac editor is easier and you can test before the iPhone copy lands).

Name it **exactly** `ClaudeDraft` (case-sensitive). The relay's URL is
hardcoded: `shortcuts://run-shortcut?name=ClaudeDraft`. Override only by
setting `RELAY_IMESSAGE_SHORTCUT_NAME` in the relay env (see below).

The chain is **5 actions** — no more, no less:

| # | UI action name (action identifier) | Settings that matter |
|---|---|---|
| 1 | **Get File** (`is.workflow.actions.documentpicker.open`) | File: `claude-relay-drafts/latest.json` in **iCloud Drive** · Show File Picker **OFF** · Error If Not Found **ON**. The editor must show iCloud Drive/CloudDocs, not "Shortcuts". "Shortcuts" is a separate app container on macOS and did not sync this relay's draft file to the iPhone on 2026-05-14. The filename must be exactly `latest.json`; `latest.jsoneon` is a known bad path from a stray edit. |
| 2 | **Get Dictionary from Input** (`is.workflow.actions.detect.dictionary`) | Defaults. Parses the JSON file contents. |
| 3 | **Get Dictionary Value** (`is.workflow.actions.getvalueforkey`) | Key: `recipient` |
| 4 | **Get Dictionary Value** (`is.workflow.actions.getvalueforkey`) | Key: `body` |
| 5 | **Send Message** (`is.workflow.actions.sendmessage`) | Recipient: the magic var from step 3 · Message: the magic var from step 4 · **"Show When Run" toggle: ON** (under "Show More"). |

> ### ⚠ The one rule that ships drafts vs. real messages
>
> Step 5's **"Show When Run"** toggle is the entire safety contract. When
> **ON**, the OS shows the compose sheet for manual review. When **OFF**, the
> shortcut auto-sends the iMessage with no confirmation. There is no other
> action, wrapper, or setting that prevents auto-send. **Never** wrap Send
> Message in a "Wait → Send", "Run Shortcut", or any auto-confirm step.

You do not need a separate "Get Contents of File" action between steps 1 and 2
— `Get File` with picker off returns the file content directly as the
downstream input for `Get Dictionary from Input`.

## First run (Mac verification — do this before iPhone)

Run from Terminal so you can observe failures without consuming the iPhone
link. Make sure a fixture exists first:

```bash
ls -la "$HOME/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json"
# If absent, send a draft via Telegram with a self-safe recipient
# (e.g. "Draft a message to William saying handoff-test"); the relay writes
# a fresh latest.json on every placement.

bun run setup:run-shortcut
```

First run only — macOS shows an OS-level prompt:

> Allow "ClaudeDraft" to send 1 dictionary in a message?
> [Don't Allow] [Allow Once] [Always Allow]

Pick **Allow Once** for testing (or **Always Allow** once you trust it). The
word "dictionary" is the OS describing the upstream data type — only the
extracted `body` string and the `recipient` reach Messages.app.

Expected after Allow Once:

- Messages compose sheet opens, recipient field pre-filled, body pre-filled.
- **No iMessage is sent.** Close the sheet (Cancel or ⌘W).
- Confirm in `~/Library/Messages/chat.db` that no new row appeared for that
  recipient during the test.

The bounded verifier exits instead of leaving a stuck terminal if Shortcuts or
Messages waits too long for UI. If it times out, close any open privacy prompt
or compose sheet, then rerun `bun run setup:verify`.

If `shortcuts run` instead exits with `Error: ... no such file`, the relay
hasn't written `latest.json` since the last cleanup — send a Telegram draft
request first.

If it exits with `Error: The provided file path must be contained within
the directory`, the Get File action has a file bookmark plus a conflicting
`WFGetFilePath` value. A folder bookmark to `com~apple~CloudDocs/claude-relay-drafts`
must use path `latest.json`; `claude-relay-drafts/latest.json` looks plausible
in the editor but resolves as a missing nested path at runtime. A file bookmark
directly to `.../latest.json` should have the path field empty.

Run `bun run setup:verify` after editing the Shortcut. The verifier reads the
installed `ClaudeDraft` action graph and fails if the path contains
`latest.jsoneon`, points at the Shortcuts app container, or disables Send
Message's **Show When Run** safety toggle.

## iPhone install and verification (once Mac path works)

If the iPhone opens Messages with the correct recipient but an empty body, the
phone still has a stale `ClaudeDraft` copy. Re-export a signed install file
from the validated Mac shortcut:

```bash
bun run setup:export-shortcut
```

That creates:

```text
~/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

Install it once from the iPhone Files app: iCloud Drive →
`ClaudeDraft.shortcut` → Add/Replace Shortcut. The filename must be exactly
`ClaudeDraft.shortcut`; `ClaudeDraft-install.shortcut` imports as a different
shortcut and does not replace the relay target.

Then verify:

1. Shortcuts.app on iPhone → All Shortcuts → `ClaudeDraft` appears.
2. Send a fresh draft request in Telegram (e.g. "Draft a message to William
   saying iphone-handoff-test").
3. Run `ClaudeDraft` from Shortcuts on the iPhone.
4. First run on iPhone may show the **Allow / Allow Once / Always Allow**
   prompt — same answer.
5. Messages compose sheet appears with the body. Close without sending.
6. Delete `ClaudeDraft.shortcut` from iCloud Drive after the phone is confirmed
   to have the fixed shortcut installed.

## Self-test fixture

The relay supports a self-addressed test payload by accepting William's own
email/phone as the resolved recipient (e.g. `wregan599@gmail.com`). A draft
with `recipient_label: "ClaudeDraft self-test"` arrives in his own iMessage
inbox if accidentally sent — recoverable. Use this shape for any end-to-end
test that might be tempted to tap Send.

## Environment overrides

Set in the relay environment if defaults don't fit:

```bash
RELAY_ICLOUD_DRAFT_DIR=/custom/abs/path/claude-relay-drafts
RELAY_IMESSAGE_SHORTCUT_NAME=ClaudeDraft
RELAY_DRAFT_TTL_MS=600000
```

`RELAY_ICLOUD_DRAFT_DIR` must point inside an iCloud-synced container that
the iOS Shortcut can read. The default is the real iCloud Drive container:
`~/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts`. The
Shortcut's `Get File` action must be pointed at the same iCloud Drive folder.
If it says "Get file from Shortcuts", it is reading the Shortcuts app
container instead of the relay's default path. Once CloudDocs is confirmed,
delete or ignore any stale
`~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/claude-relay-drafts/latest.json`
copy; it is a trap because it can look correct until it diverges.

`RELAY_IMESSAGE_SHORTCUT_NAME` only matters if you also rename the iOS
Shortcut — the relay just embeds it in the `shortcuts://` URL.

`RELAY_DRAFT_TTL_MS` controls the `expires_at` field on `latest.json`.
Default 600000 (10 minutes). The relay writes `expires_at` whenever it
writes a new draft, and `setup:verify` rejects payloads whose
`expires_at` is in the past — that's the upper bound on how long a
written draft is treated as live by the Mac-side machinery. The iPhone
`ClaudeDraft` Shortcut itself does NOT inspect `expires_at`; it
consumes whatever is in `latest.json` at the moment it's invoked,
because it has no clock-aware action shape we trust to enforce a TTL.
The relay clears `latest.json` on every new draft so a stale file is
not typically reachable, and the user is encouraged to delete the
file manually if they decline a draft and the next one is delayed.
Set higher on a slow-syncing iCloud connection; lower if you want
stricter Mac-side freshness gating. Non-numeric or non-positive
values silently fall back to the default.

## Verifying the handoff fired (from logs, not the Mac UI)

Each placement appends one row to today's
`~/.claude-relay/logs/decisions-YYYY-MM-DD.jsonl`. Relevant fields:

| field | value when handoff succeeded |
|---|---|
| `imessage_draft_mode` | `"icloud_drive_file"` |
| `imessage_draft_handoff_path` | absolute path to the written `latest.json` |
| `imessage_draft_body_sha256` | hex SHA-256 of the body, never the body itself |
| `imessage_draft_shortcut_url` | the `shortcuts://run-shortcut?name=...` URL the relay computed for the run. **Decision-log metadata only — this string is NOT included in the Telegram reply.** The Telegram reply contains just the draft body (or the install-pending warning when the Shortcut isn't on the iPhone yet). |

If `imessage_draft_mode` is `"pasted"` or `"new_compose"` instead, the iCloud
write failed and the relay fell back (see next section). If
`imessage_draft_mode` is absent for a draft request that resolved a recipient,
check `relay.err.log` for `[imessage-draft] iCloud Drive handoff failed`
— the message names the root cause (missing iCloud container, permission,
disk).

## Fallback path (kept; do not remove)

If the iCloud write throws (e.g. iCloud daemon offline, container missing
because the user hasn't opened Shortcuts.app once, disk full), the relay
falls through to `placeIMessageDraft()` in `src/relay.ts`, which uses the
existing AppleScript / Messages compose path on the Mac. The Telegram reply
in that case omits the `shortcuts://` URL and the body lands directly in the
Mac Messages compose box. This is the right behaviour for "I'm at my Mac
anyway" — but the iPhone won't get a tappable handoff.

## Anti-patterns (review these before editing)

- Adding any action after Send Message that auto-confirms ("Wait 5 seconds →
  Send", "Run Shortcut: AutoSend"). Show When Run + a human tap is the only
  legal path.
- Renaming the Shortcut without setting `RELAY_IMESSAGE_SHORTCUT_NAME`.
- Hard-coding the recipient or body in the Shortcut — they MUST come from
  `latest.json`. This is what makes the relay → phone hop work at all.
- Pointing the Shortcut at the Shortcuts provider while the relay writes
  iCloud Drive. The default relay path is `com~apple~CloudDocs`; keep the
  Shortcut's Get File action aligned with that path.
- Removing the Mac fallback path. The iCloud handoff is best-effort; the
  fallback is what keeps the relay useful when you're at the Mac and the
  cloud round-trip is unnecessary.

## Programmatic rebuild (for future automation)

The macOS `shortcuts` CLI has no `create` subcommand. Use the repo exporter
instead:

```bash
bun run setup:export-shortcut
```

It reads the installed Mac `ClaudeDraft` actions, validates the five-action
chain, wraps the actions in a proper workflow plist, signs the file with
`shortcuts sign`, writes `ClaudeDraft.shortcut` to iCloud Drive, then validates
the signed output. A raw `ZSHORTCUTACTIONS.ZDATA` array is not enough; passing
that directly to `shortcuts sign` can crash Apple's CLI because the signer
expects a workflow dictionary, not a top-level array.
