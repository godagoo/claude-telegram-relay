# Handover: Python Contact Resolver Issue

Date: 2026-05-16  
Project: `/Users/williamregan/Projects/claude-telegram-relay`  
Audience: Claude Code

## Executive Answer

Do **not** redo the project.

The Python problem was localized to the contact-resolution boundary, not evidence that the whole relay should be rewritten.

The failure path was:

```text
bun relay
  -> scripts/imessage-thread.sh
  -> scripts/resolve-contact.py
  -> AddressBook SQLite contact resolution
```

Previously, if `scripts/resolve-contact.py` failed because of a missing, old, broken, or wrong `python3`, `scripts/imessage-thread.sh` suppressed stderr and treated the failure like "no contact found." That empty result could then flow into `NEW_COMPOSE_SENTINEL` (`?`), which opens a blank Messages compose window instead of the intended contact thread.

That failure mode has now been hardened.

## Answers To The Screenshot Questions

### Can the Python version contribute to the relay issue?

Yes, Python can contribute, but the current machine is not failing because of an old Python version.

Observed environment:

```text
Interactive shell python3: /opt/homebrew/bin/python3
Interactive shell version: 3.14.4

Launchd-style relay PATH python3: /usr/local/bin/python3
Launchd-style relay PATH version: 3.13.4

System python3: /usr/bin/python3
System python version: 3.9.6
```

All observed interpreters are new enough for the current resolver.

The actual bug was weaker than "wrong Python version" and more dangerous:

- `setup:verify` did not prove the launchd/Bun runtime could execute `scripts/resolve-contact.py`.
- `scripts/imessage-thread.sh` only checked `command -v python3`.
- The resolver was executed through its shebang instead of an explicit interpreter.
- Resolver stderr was discarded.
- Resolver failure was treated like an unresolved contact.
- Relay placement could then fall back to `NEW_COMPOSE_SENTINEL`.

### Is `scripts/iphone-diagnose.cjs` a Python issue?

Probably not.

`scripts/iphone-diagnose.cjs` is a Node/CommonJS diagnostic script. The Python-sensitive path for this bug is `scripts/resolve-contact.py`, which is called from `scripts/imessage-thread.sh`.

### Is AddressBook framework binding behavior relevant?

Not directly.

The resolver does **not** use Python AddressBook framework bindings. It reads AddressBook SQLite databases using Python stdlib `sqlite3`.

The relevant risks are:

- wrong `python3` on PATH
- broken Python shim
- missing Python
- resolver syntax/runtime failure
- resolver stderr swallowed by shell script
- empty resolution treated as "no match"

### Should Python checks be added to `setup/verify.ts`?

Yes.

A version-only check is not enough. The verifier needs to prove the same operational path the relay depends on.

`setup:verify` now checks:

- `scripts/resolve-contact.py` exists
- resolver is executable
- current `python3` exists
- current `python3` is new enough
- launchd-style PATH resolves `python3`
- resolver compiles under the launchd-style Python
- resolver smoke-test returns a direct phone identifier

## Files Changed

### `setup/verify.ts`

Path:

```text
/Users/williamregan/Projects/claude-telegram-relay/setup/verify.ts
```

Change:

- Added a reusable `runCommand()` helper.
- Added an `iMessage Contact Resolver` health-check section.
- Checks the resolver under a launchd-style PATH:

```text
/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

Key behavior added:

```text
Contact resolver is executable
python3 <version> available
launchd PATH resolves python3: <path> <version>
Contact resolver compiles with launchd python3
Contact resolver smoke test returns direct phone identifiers
```

### `scripts/imessage-thread.sh`

Path:

```text
/Users/williamregan/Projects/claude-telegram-relay/scripts/imessage-thread.sh
```

Change:

- Stopped invoking `resolve-contact.py` through the shebang.
- Now invokes it explicitly:

```bash
python3 "$resolver" "$input"
```

- Checks that `python3` exists.
- Checks that `python3` is new enough.
- Captures resolver stderr.
- Returns an explicit error if the resolver fails.
- Prevents Python/resolver failures from masquerading as "no contact found."

Important behavioral change:

```text
Broken Python/resolver -> nonzero helper failure
Genuine no match       -> {"resolved":"","messages":[]}
```

### `src/relay.ts`

Path:

```text
/Users/williamregan/Projects/claude-telegram-relay/src/relay.ts
```

Change:

- Prevents `NEW_COMPOSE_SENTINEL` fallback when iMessage context lookup failed.
- Blocks blank-recipient placement for these statuses:

```text
fda_denied
error
timeout
```

Blank compose is now reserved for a genuine unresolved contact, not a runtime/setup failure.

## Verification Run

### Passed Commands

```bash
bash -n scripts/imessage-thread.sh
```

```bash
PATH=/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  python3 -m py_compile scripts/resolve-contact.py
```

```bash
PATH=/Users/williamregan/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  scripts/imessage-thread.sh mom 1
```

```bash
bun test src/imessage-context.test.ts src/imessage-draft.test.ts
```

```bash
bun test
```

```bash
bun run test:smoke
```

```bash
bun build src/relay.ts --outdir /tmp/claude-telegram-relay-build --target bun
```

### Observed Results

`scripts/imessage-thread.sh mom 1` resolved correctly:

```json
{"resolved":"+16043154583","messages":[{"id":377432,"sender":"me","ts":"2025-12-15 19:55:36","text":"Kk"}]}
```

Targeted iMessage tests:

```text
62 pass
0 fail
154 expect() calls
```

Full test suite:

```text
195 pass
0 fail
484 expect() calls
```

Smoke checks:

```text
PASS: poison query handled within bound
PASS: textbook retrieval smoke checks returned scoped converted/path hits
```

Build:

```text
Bundled 111 modules
relay.js 0.78 MB
```

### `setup:verify` Status

The new Python/contact resolver checks pass.

The overall command still exits `1` because of an unrelated Shortcut install artifact:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

Verifier output:

```text
Fixed ClaudeDraft iPhone install file still exists at /Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut; install it on iPhone, confirm the body appears, then delete the file
```

That is an iPhone Shortcut handoff cleanup issue, not a Python issue.

## Current Engineering Judgment

Do **not** rewrite the whole project.

The project is buggy because it has real macOS automation boundaries:

- Telegram bot runtime
- launchd environment
- Bun process spawning
- macOS Full Disk Access
- Messages SQLite
- AddressBook SQLite
- iCloud Drive handoff
- iOS Shortcuts behavior
- optional iPhone Mirroring path

A rewrite would almost certainly reproduce the same integration problems unless those boundaries are tested and verified better.

The correct move is a stabilization pass, not a full rebuild.

## Recommended Next Steps

### 1. Add a regression test for broken Python

Add a test that creates a fake `python3` earlier on PATH, runs `scripts/imessage-thread.sh mom 1`, and asserts:

- exit code is nonzero
- stderr mentions Python/resolver failure
- stdout does **not** return `{"resolved":"","messages":[]}`

This locks in the most important behavior: resolver runtime failures must not degrade into blank compose.

### 2. Decide whether to keep Python or port resolver to TypeScript/Bun

Best long-term options:

#### Option A: Keep Python and pin interpreter

Add a `RELAY_PYTHON` env var and use it from both:

- `setup/verify.ts`
- `scripts/imessage-thread.sh`

Example:

```text
RELAY_PYTHON=/usr/local/bin/python3
```

Benefit:

- minimal rewrite
- preserves working resolver
- avoids PATH drift between Terminal and launchd

Risk:

- still has a polyglot boundary

#### Option B: Port `resolve-contact.py` to TypeScript/Bun

Move AddressBook SQLite contact resolution into the Bun runtime.

Benefit:

- removes Python dependency entirely
- one runtime
- simpler launchd setup

Risk:

- must carefully preserve resolver behavior:
  - direct identifier normalization
  - AddressBook source DB globbing
  - primary phone/email choice
  - relationship alias blocking
  - exact match handling for `mom`
  - self-card filtering
  - recent-message tie-breaking

Recommendation: **Option A first, Option B only if Python causes another real operational failure.**

### 3. Make `setup:verify` the operational truth source

`bun run setup:verify` should eventually prove:

- launchd service loaded
- launchd PATH sane
- Bun binary is Apple silicon/native
- Claude binary is Apple silicon/native
- Python resolver works under launchd PATH or pinned `RELAY_PYTHON`
- iMessage database readable by the relay process
- AddressBook resolver can resolve known direct identifiers
- Shortcut handoff file path is correct
- pending Shortcut artifacts are either intentionally present or cleaned up
- latest iCloud draft payload shape is valid

### 4. Clean up the unrelated Shortcut artifact

The current non-Python verifier failure is:

```text
/Users/williamregan/Library/Mobile Documents/com~apple~CloudDocs/ClaudeDraft.shortcut
```

Either install it on iPhone and confirm body handoff works, or remove the pending artifact after confirming it is no longer needed.

## Suggested Commit Message

```text
Harden iMessage contact resolver Python boundary

Verify launchd Python can compile and run resolve-contact.py, surface
resolver failures from imessage-thread.sh, and prevent failed context
lookups from falling through to blank-recipient compose.
```

## Bottom Line

This was a real bug, but not a rewrite-level bug.

The elegant solution is to harden the runtime boundary:

- verify the interpreter that launchd will actually use
- execute the resolver explicitly through that interpreter
- surface resolver errors
- keep `NEW_COMPOSE_SENTINEL` only for genuine unresolved contacts

The project should be stabilized, not restarted.
