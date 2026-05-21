# Handover: 2026-05-17 PR Merge + ClaudeDraft Shortcut Recovery

## Audience

Claude Code. This handover summarizes the last Codex-assisted session on
`/Users/williamregan/Projects/claude-telegram-relay`.

The user is non-technical. They asked Codex to take over the Mac-side project
work and recover the deleted iPhone Shortcuts setup. Codex performed the repo
work directly in the terminal and used iPhone Mirroring for the shortcut import.

## Final State

Repository:

```text
/Users/williamregan/Projects/claude-telegram-relay
```

Current branch:

```text
master
```

Current pushed commit:

```text
9325c61 draft-router: add outbound safety chokepoint
```

Git state at end:

```text
master clean and aligned with origin/master
No open GitHub PRs
Temporary PR branches deleted/pruned
```

Open PR state at end:

```text
[]
```

Runtime state:

```text
Exactly one relay process is running:
PID 48600 /opt/homebrew/bin/bun run src/relay.ts
```

Shortcut state:

```text
shortcuts list includes ClaudeDraft
bun run setup:verify passes
No pending ClaudeDraft iPhone install artifact remains in iCloud Drive
```

## What Codex Completed

### 1. Restored `ClaudeDraft`

The user's iPhone Shortcuts had been deleted, which caused:

```text
Shortcut not found: ClaudeDraft
```

Codex found a previously generated valid shortcut artifact at:

```text
/Users/williamregan/Library/Messages/ClaudeOutgoing/20260515-141830-ClaudeDraft.shortcut
/Users/williamregan/Library/Messages/Attachments/ff/15/4CE36936-C1BE-4371-9561-023EADBB1E3E/20260515-141830-ClaudeDraft.shortcut
```

Both files were validated with:

```ts
readSignedShortcutFileActions(...)
validateClaudeDraftShortcutActions(...)
```

Result:

```json
{
  "ok": true,
  "errors": [],
  "warnings": []
}
```

Codex copied the validated shortcut to:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

Then Codex used iPhone Mirroring to open Files, tap the file, and get to the
iPhone `Add Shortcut` screen. The user completed the final install action.

After install:

```text
shortcuts list | rg -i ClaudeDraft
```

returned:

```text
ClaudeDraft
```

`setup:verify` then confirmed:

```text
Mac-installed ClaudeDraft reads the CloudDocs latest.json handoff and preserves Show When Run
```

Codex then deleted the temporary iCloud install file:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

This was intentional. The installed shortcut remains in Apple Shortcuts; the
temporary import artifact should not remain in iCloud Drive because
`setup:verify` treats it as a pending install signal.

### 2. Merged PR #1: Session Extraction

Merged PR:

```text
#1 session: extract session persistence helpers
```

Resulting commit:

```text
ad3fe7a session: extract session persistence helpers
```

Files added/changed:

```text
src/session.ts
src/session.test.ts
tasks/lessons.md
```

Important fix before merge:

Codex had previously found and fixed a semantic extraction issue in the PR
branch. The original `rotateSession()` only deleted `session.json`. That would
have made future integration unsafe because `relay.ts` could delete the
persisted session while still keeping a stale in-memory `session.sessionId`.

The merged behavior is:

```ts
rotateSession(reason): Promise<SessionState>
```

It deletes the persisted session and returns a fresh in-memory `SessionState`.

Also important: `src/session.ts` now matches current relay path semantics:

```ts
process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay")
```

This PR is dormant infrastructure. It did not wire `src/relay.ts` to the new
module.

### 3. Merged PR #2: Intent Parser

Merged PR:

```text
#2 intents: pure intent tag parser as dormant infrastructure
```

Resulting commit:

```text
77b750c intents: add pure intent tag parser
```

Files added/changed:

```text
src/intents.ts
src/intents.test.ts
tasks/lessons.md
```

PR #2 initially became dirty after PR #1 because both touched
`tasks/lessons.md`. Codex rebased it onto the new `master`, resolved the
lessons conflict by preserving both lesson entries, force-updated the PR branch,
verified, and merged.

The parser is dormant infrastructure. It does not replace the current runtime
parser in `src/memory.ts`.

Tags handled:

```text
[REMEMBER: ...]
[GOAL: ...]
[GOAL: ... | DEADLINE: ...]
[DONE: ...]
[DECISION: ...]
[EMAIL_DRAFT: to=... subject=... body=...]
[IMSG_DRAFT: contact=... body=...]
[WHATSAPP_DRAFT: contact=... body=...]
```

### 4. Merged PR #3: Draft Router

Merged PR:

```text
#3 draft-router: outbound chokepoint as dormant infrastructure
```

Resulting commit:

```text
9325c61 draft-router: add outbound safety chokepoint
```

Files added/changed:

```text
src/draft-router.ts
src/draft-router.test.ts
src/draft-router-splitter.test.ts
tasks/lessons.md
```

Codex found and fixed a branch-level issue before merge:

1. `draft-router.ts` initially used a relay directory fallback that differed
   from the rest of the relay.
2. The missing-allowlist diagnostic initially logged the raw recipient.

Fixes added before merge:

```ts
process.env.IMESSAGE_ALLOWLIST_PATH
  || join(process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay"), "imessage-allowlist.json")
```

and:

```text
[draft-router] iMessage allowlist missing or invalid at <path>; refusing recipient
```

No raw phone number or email is included in the missing-allowlist log.

Additional tests added:

```text
gateForIMessageRecipient: default path matches relay HOME fallback
gateForIMessageRecipient: empty RELAY_DIR does not create a relative allowlist path
```

This PR is also dormant infrastructure. It did not wire `src/relay.ts` or
`src/icloud-drive-draft.ts` to the new gate yet.

## Final Verification Results

After all PRs and shortcut recovery, Codex ran:

```bash
bun test
bun run test:smoke
bun build src/relay.ts --target bun --outfile /tmp/claude-relay-build.js
git diff --check
bun run setup:verify
```

Final results:

```text
bun test                         268 pass, 0 fail
bun run test:smoke               pass
bun build src/relay.ts           pass
git diff --check                 pass
bun run setup:verify             34 passed, 0 failed, 7 warnings
```

`setup:verify` final success summary:

```text
34 passed    7 warnings
Your bot is ready! Run: bun run start
```

Warnings are currently non-blocking:

```text
SUPABASE_URL not set
com.claude.smart-checkin not loaded
com.claude.morning-briefing not loaded
Launchd writes active logs outside repo logs/
Long-lived Claude Code shell process found
RELAY_PYTHON not set
VOICE_PROVIDER not set
```

The important setup failures are gone:

```text
Shortcut not found: ClaudeDraft
Fixed ClaudeDraft iPhone install file still exists...
```

Both are now resolved.

## Current Git Log Shape

At end:

```text
9325c61 draft-router: add outbound safety chokepoint
77b750c intents: add pure intent tag parser
ad3fe7a session: extract session persistence helpers
0a4e654 wip: stabilize relay runtime fixes before PR reconciliation
02c4839 gitignore: exclude .worktrees/ used by superpowers worktree skill
0dc613f Fix: phone handoff reply must tell user to run ClaudeDraft
630e697 Harden Telegram polling diagnostics and setup verification
c7e38e3 Remove exponential backoff from Telegram polling conflict handler
```

Remote PR branches were deleted by `gh pr merge --delete-branch` and pruned:

```text
origin/relay/extract-session      deleted/pruned
origin/relay/extract-intents       deleted/pruned
origin/relay/extract-draft-router deleted/pruned
```

## Important Operational Notes

### Pushcut

The user mentioned they have Pushcut. Codex did not use Pushcut.

Reason: the current relay is built around an Apple Shortcuts shortcut named
`ClaudeDraft` and the existing `shortcuts://run-shortcut?name=ClaudeDraft`
handoff path. Pushcut can be a future automation-server design, but it is not
the immediate recovery path for this codebase.

Do not replace the current handoff with Pushcut unless that becomes a deliberate
separate project with acceptance tests.

### `ClaudeDraft` Live Test Was Not Run

Codex did not intentionally run `ClaudeDraft` after install because doing so can
open a real Messages compose sheet from the latest relay payload.

The current latest handoff file is:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts/latest.json
```

`setup:verify` confirms the file shape and the installed Shortcut wiring.

If Claude Code wants to run a live `ClaudeDraft` acceptance test later, it
should be treated as an explicit user-approved action because it opens iMessage
compose UI.

### Runtime Logs

The launchd relay process is alive:

```text
48600 /opt/homebrew/bin/bun run src/relay.ts
```

The launchd logs had old historical 409 conflict entries, but at the end of the
session the active process was a single relay instance and `setup:verify`
confirmed:

```text
No competing Claude Telegram plugin config found
No competing Claude Telegram plugin process found
Telegram webhook inactive; pending updates: 0
Exactly one local relay process found
bot.lock PID 48600 is consistent with local relay state
```

## What Claude Code Should Do Next

Do not restart the project from scratch.

The repo is now in a much cleaner state:

1. Main runtime fixes are snapshotted and pushed.
2. Session, intents, and draft-router were landed as small independent dormant
   modules.
3. Shortcut health is restored.
4. Setup verification passes.

Recommended next engineering work, in order:

### 1. Create a small PR to wire `src/session.ts` into `src/relay.ts`

Acceptance criteria:

```text
- No behavior change except using the extracted helper.
- `session = await rotateSession(reason)` must be used when rotating.
- Never call `await rotateSession(reason)` without assigning the returned state.
- Preserve current `CLAUDE_RESUME=0` operational default unless explicitly changed.
```

Required tests:

```text
bun test src/session.test.ts
bun test
bun run test:smoke
bun build src/relay.ts --target bun --outfile /tmp/claude-relay-build.js
bun run setup:verify
```

### 2. Create a small PR to wire the iMessage allowlist gate

The new gate lives in:

```text
src/draft-router.ts
```

Likely future integration target:

```text
src/icloud-drive-draft.ts
```

Before writing `latest.json`, call:

```ts
gateForIMessageRecipient(recipient)
```

Important: this gate fails closed when the allowlist file is missing or invalid.
Before wiring it into the hot path, create the allowlist file and tests.

Expected allowlist path:

```text
~/.claude-relay/imessage-allowlist.json
```

Expected format:

```json
[
  "+15551234567",
  "person@example.com"
]
```

Do not log raw recipients on gate failure.

### 3. Create a small PR to wire `src/intents.ts` into memory handling

Current runtime parser remains embedded in:

```text
src/memory.ts
```

Future integration should preserve on-the-wire behavior and only replace the
parser with the standalone module after proving identical behavior for
REMEMBER/GOAL/DONE tags.

Do not wire draft-send behavior from the new EMAIL/IMSG/WHATSAPP tags until the
draft-router safety gate is integrated.

### 4. Optional Environment Hardening

`setup:verify` warns that `RELAY_PYTHON` is not pinned. This is not currently a
failure because both interactive and launchd paths resolve Python successfully.

Future hardening PR:

```text
Pin RELAY_PYTHON in launchd/env to the intended python3 binary.
```

Do not combine that with runtime feature work.

## Things Not To Do

- Do not delete the project and restart.
- Do not reintroduce broad worktree reconciliation commits.
- Do not wire all dormant modules at once.
- Do not add Pushcut to the hot path without a separate design and tests.
- Do not run live iMessage send/compose automation without explicit approval.
- Do not leave `ClaudeDraft.shortcut` in iCloud Drive after install; it is a
  temporary install artifact and `setup:verify` should fail if it remains.

## Useful Commands

Repo health:

```bash
cd /Users/williamregan/Projects/claude-telegram-relay
git status --short --branch
git log --oneline --decorate -8
gh pr list --state open --json number,title,headRefName,url,mergeStateStatus
```

Verification:

```bash
bun test
bun run test:smoke
bun build src/relay.ts --target bun --outfile /tmp/claude-relay-build.js
bun run setup:verify
```

Shortcut check:

```bash
shortcuts list | rg -i '^ClaudeDraft$|ClaudeDraft'
```

Runtime check:

```bash
ps -axo pid,ppid,etime,command | rg '(/opt/homebrew/bin/bun run src/relay.ts|src/relay.ts)' || true
```

Logs:

```bash
tail -80 /Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.log
tail -80 /Users/williamregan/.claude-relay/logs/com.claude.telegram-relay.error.log
```

## Bottom Line

The project is not a restart candidate right now. The previous mess was mainly
process and worktree drift plus a deleted Shortcut. The repository now has a
clean `master`, no open PRs, passing tests, passing setup health, and a restored
`ClaudeDraft` shortcut. Continue with small integration PRs only.
