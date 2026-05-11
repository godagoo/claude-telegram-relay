#!/usr/bin/env bash
# draft-imessage.sh — place an iMessage draft into Messages.app's compose
# surface without sending it. Reads the body from stdin and the recipient
# from $1.
#
# Behavior:
#   1. Body → clipboard via pbcopy.
#   2. open sms:RECIPIENT&body=ENCODED_BODY — Messages opens a compose
#      draft for that recipient with the body prefilled. This avoids blind
#      Cmd+V UI scripting and does not require Accessibility.
#   3. If the URL open fails, fall back to clipboard + imessage:// thread
#      open and report clipboard_only mode.
#
# Output: a single JSON envelope on stdout. Body content is NEVER printed.
#   {"ok":true,"mode":"pasted","recipient":"+15196816391"}
#   {"ok":true,"mode":"clipboard_only","recipient":"+15196816391","reason":"..."}
#   {"ok":false,"recipient":"...","reason":"..."}
#
# Exit code:
#   0  — pasted or clipboard_only (both are usable)
#   64 — usage error (missing recipient)
#   65 — empty body on stdin
#   66 — pbcopy failed
#   67 — open imessage:// failed
#
# Hard rule: NEVER sends. This script never presses Return/Enter.

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 RECIPIENT (phone like +16043154583 or email)" >&2
  printf '{"ok":false,"reason":"usage"}\n'
  exit 64
fi

RECIPIENT="$1"
BODY="$(cat)"

if [[ -z "$BODY" ]]; then
  echo "error: empty draft body on stdin" >&2
  printf '{"ok":false,"recipient":"%s","reason":"empty_body"}\n' "$RECIPIENT"
  exit 65
fi

if ! printf '%s' "$BODY" | pbcopy; then
  printf '{"ok":false,"recipient":"%s","reason":"pbcopy_failed"}\n' "$RECIPIENT"
  exit 66
fi

if ! command -v python3 >/dev/null 2>&1; then
  if open "imessage://$RECIPIENT"; then
    printf '{"ok":true,"mode":"clipboard_only","recipient":"%s","reason":"python3_missing_for_url_encoding"}\n' "$RECIPIENT"
    exit 0
  fi
  printf '{"ok":false,"recipient":"%s","reason":"open_failed"}\n' "$RECIPIENT"
  exit 67
fi

COMPOSE_URL="$(
  RECIPIENT="$RECIPIENT" BODY="$BODY" python3 - <<'PY'
import os
from urllib.parse import quote

recipient = os.environ["RECIPIENT"]
body = os.environ["BODY"]
print(f"sms:{quote(recipient, safe='+@._-')}&body={quote(body, safe='')}")
PY
)"

if open "$COMPOSE_URL"; then
  printf '{"ok":true,"mode":"pasted","recipient":"%s"}\n' "$RECIPIENT"
else
  if open "imessage://$RECIPIENT"; then
    printf '{"ok":true,"mode":"clipboard_only","recipient":"%s","reason":"sms_body_url_open_failed"}\n' "$RECIPIENT"
    exit 0
  fi
  printf '{"ok":false,"recipient":"%s","reason":"open_failed"}\n' "$RECIPIENT"
  exit 67
fi
