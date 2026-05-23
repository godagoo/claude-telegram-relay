#!/usr/bin/env bash
# draft-email.sh — drop an email draft into the user's default mail client
# without sending it. Reads the body from stdin, takes recipient and subject
# from args.
#
# Usage:
#   echo "Body text ..." | scripts/draft-email.sh wregan599@gmail.com "Subject line"
#
# Mechanism:
#   1. URL-encode the subject and body.
#   2. Open a mailto: URL. The default mail handler (Apple Mail, Gmail web,
#      Outlook, etc.) opens a new draft pre-filled.
#   3. If the body is large enough that mailto truncation could matter
#      (>1500 bytes is risky in some clients), also copy the body to the
#      clipboard so the user can paste cleanly. NEVER sends the email.
#
# Why this design:
#   - No FDA required.
#   - No Automation permission required.
#   - Works for whatever mail app the user has set as default (Apple Mail
#     handles mailto natively; users with Gmail can install Mailto handler
#     extensions to make Chrome route mailto: to Gmail).
#   - Honors the hard rule that the bot never sends; user reviews and sends.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 TO SUBJECT (body on stdin)" >&2
  exit 64
fi

TO="$1"
SUBJECT="$2"
BODY="$(cat)"

if [[ -z "$BODY" ]]; then
  echo "error: empty draft body on stdin" >&2
  exit 65
fi

urlencode() {
  python3 -c 'import sys, urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

ENC_SUBJECT="$(urlencode "$SUBJECT")"
ENC_BODY="$(urlencode "$BODY")"

# Copy body to clipboard as a safety net if mailto truncates.
printf '%s' "$BODY" | pbcopy

open "mailto:${TO}?subject=${ENC_SUBJECT}&body=${ENC_BODY}"

cat <<EOF
Email draft opened in your default mail client (to: $TO).
The full body is also on your clipboard in case the mail client truncated it.
Review and send manually. The relay will not send for you.
EOF
