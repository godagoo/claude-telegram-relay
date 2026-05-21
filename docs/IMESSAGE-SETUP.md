# iMessage and email draft setup

This relay can do two things with iMessages and email:

1. **Read iMessage context** (recent thread with a contact) so the bot can draft a reply that matches your actual conversation history.
2. **Drop a draft into your native compose surface** (Messages.app or Mail.app) addressed to the right recipient, ready for you to review and send manually.

The bot will never send a message for you. That is a hard rule.

These two capabilities have different macOS permission requirements. Setup is one-time per machine.

## Capability 1: stage an iMessage draft (Shortcuts + Automation)

The production iMessage path is the staging Shortcut handoff:

```bash
echo "Hey Peggy, ..." | \
  RELAY_IMESSAGE_STAGING_HANDLE='+15555555555' \
  scripts/stage-imessage.sh +16043154583 Peggy
```

Mechanism:

- The relay resolves the target contact, reads recent iMessage context from
  `chat.db`, and injects Obsidian memory plus retrieval/project-anchor context
  before Claude drafts.
- Claude writes the draft under the user writing rules. The relay runs a final
  prose-dash sanitizer before staging.
- The relay sends a normal iMessage to `RELAY_IMESSAGE_STAGING_HANDLE`.
- The staging body is a JSON payload with `version: "CLDRAFT/1"`, `to`,
  `label`, and `body`.
- A Shortcuts.app Message automation watches for `CLDRAFT/1`, runs
  `ClaudeStageDraft`, and uses Send Message with `Show When Run` ON. That
  opens the target compose sheet for manual review.

This hop does not require Full Disk Access or Accessibility. It does require
Messages to be signed in, and macOS may ask for Automation permission so
Shortcuts can control Messages. If the relay's staging-send AppleScript
triggers a prompt, grant Automation to the launchd bun binary printed by
`bun run setup:verify`, not Terminal or a GUI shell.

Detailed payload, Shortcut rebuild steps, and tests:
`docs/IMESSAGE-SHORTCUT-HANDOFF.md`.

Email drafts still use the mailto helper:

```bash
echo "Body text" | scripts/draft-email.sh wregan599@gmail.com "Subject line"
```

## Capability 2: read iMessage context (requires Full Disk Access)

The bot needs to read `~/Library/Messages/chat.db` to pull recent messages with a contact. macOS protects this file behind Full Disk Access (FDA).

### One-time setup

The target binary is **`bun`** at its resolved Cellar path — not the Claude CLI. See the "Why this exact binary" section below for the process-tree explanation.

1. Find the resolved bun path:

   ```bash
   bun run setup:verify
   ```

   Look for the line `FDA responsible target: <path>`. On Apple Silicon + Homebrew this is typically `/opt/homebrew/Cellar/bun/<version>/bin/bun`; on Intel + Homebrew it's `/usr/local/Cellar/bun/<version>/bin/bun`. Always use the resolved Cellar path, never the `/opt/homebrew/bin/bun` or `/usr/local/bin/bun` symlink — symlinks re-point on every `brew upgrade bun` and TCC then silently denies again. `setup:verify` resolves the symlink for you via `fs.promises.realpath`, which works on stock macOS unlike GNU `readlink -f`.

   > **macOS 28 compatibility check:** Rosetta (Intel app translation) ends in macOS 28.
   > If your `bun` binary is Intel-only, both the FDA grant and the relay itself will
   > stop working on upgrade. Run `bun run setup/verify.ts` — the "Binary Architecture"
   > section tells you which binaries are at risk and how to fix them.
   > To fix an Intel bun: `curl -fsSL https://bun.sh/install | bash` (reinstalls the
   > Apple silicon native build), then re-grant Full Disk Access to the new path.

2. Open **System Settings → Privacy & Security → Full Disk Access**.
3. Click the **+** button.
4. Press **Cmd+Shift+G** to open the path picker.
5. Paste the resolved Cellar path from step 1 and press Return.
6. Select the binary and click Open.
7. Make sure the toggle next to that entry is **on**.
8. Restart the relay so the launchd-spawned bun inherits the new TCC grant:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.claude.telegram-relay
   ```

9. (Optional) Verify by running the read helper directly with one of your contacts:

   ```bash
   ~/Projects/claude-telegram-relay/scripts/imessage-thread.sh +16043154583 5
   ```

   If FDA is correctly granted you will see JSON rows for the last 5 messages. If you see `error: cannot read /Users/.../chat.db`, FDA is not granted to the bun binary that ran sqlite3.

### Why this exact binary

The relay does not run from a terminal. It runs as a launchd service. The iMessage context prefetch is executed deterministically by the relay process itself, **not** by a Claude subprocess. The actual process tree is:

```
launchd → bun (relay.ts) → bash → imessage-thread.sh → sqlite3
```

`src/imessage-context.ts` was rewritten on 2026-05-11 so that `fetchIMessageContext` spawns the helper script via bun's native `spawn` API before Claude is ever invoked. Claude is not in this chain at all anymore. macOS TCC (Transparency, Consent, Control) checks Full Disk Access against the responsible process that opens the protected file; that process is **bun**. Granting FDA to the bun binary covers the whole prefetch chain.

If you upgrade bun (`brew upgrade bun`), a new versioned folder appears under Cellar (e.g. `/opt/homebrew/Cellar/bun/1.3.14/`). macOS will block reads again until you grant FDA to the new versioned binary. Re-run the grant if that happens.

### What does NOT work

- Granting FDA to Terminal.app, iTerm, Warp, Ghostty, or any GUI shell. The relay does not run inside any of them.
- Granting FDA to the Claude CLI binary at `~/.local/share/claude/versions/<vN>`. The iMessage context prefetch no longer routes through Claude — `src/imessage-context.ts:fetchIMessageContext` spawns the helper from bun directly. Older versions of this doc (and older relay code) DID route through Claude and instructed granting FDA there; that path is gone.
- Granting FDA only to the symlink at `/opt/homebrew/bin/bun` or `/usr/local/bin/bun`. macOS TCC may or may not follow the symlink correctly, and any `brew upgrade bun` re-points it to a new Cellar binary that has no grant. Use the resolved Cellar path printed by `bun run setup:verify` (the `FDA responsible target` line).

### Privacy note

When FDA is granted, the bot reads `chat.db` directly. Messages stay on this machine and never leave the bot's local context unless you tell it to forward them somewhere. The helper script enforces read-only mode (`sqlite3 -readonly`) so the bot cannot accidentally modify your message history.

## When this is unavailable

If the user has not granted FDA, the bot should not pretend it read iMessages. It should draft from the description the user gives and say explicitly that it had no real conversation history to draw on.
