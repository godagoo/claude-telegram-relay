#!/usr/bin/env bash
# draft-imessage.sh — place an iMessage draft into Messages.app's compose
# surface without sending it. Reads the body from stdin and the recipient
# from $1.
#
# Behavior:
#   1. Body → clipboard via pbcopy.
#   2. open sms:RECIPIENT&body=ENCODED_BODY — Messages opens the target
#      surface. LaunchServices success does NOT prove Messages accepted the
#      body parameter, so this path is reported as clipboard_only unless a
#      separate UI verifier is added later.
#   3. If the URL open fails, fall back to clipboard + imessage:// thread
#      open and report clipboard_only mode.
#
# Output: a single JSON envelope on stdout. Body content is NEVER printed.
#   {"ok":true,"mode":"clipboard_only","recipient":"+15196816391","reason":"..."}
#   {"ok":false,"recipient":"...","reason":"..."}
#
# Exit code:
#   0  — clipboard_only (usable fallback)
#   64 — usage error (missing recipient)
#   65 — empty body on stdin
#   66 — pbcopy failed
#   67 — open imessage:// failed
#
# Hard rule: NEVER sends. This script never presses Return/Enter.

set -uo pipefail

OPEN_CMD="${RELAY_OPEN_CMD:-open}"
PBCOPY_CMD="${RELAY_PBCOPY_CMD:-pbcopy}"

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

emit_json() {
  local ok="$1"
  local mode="${2:-}"
  local reason="${3:-}"

  if command -v python3 >/dev/null 2>&1; then
    JSON_OK="$ok" JSON_MODE="$mode" JSON_RECIPIENT="$RECIPIENT" JSON_REASON="$reason" python3 - <<'PY'
import json
import os

obj = {
    "ok": os.environ["JSON_OK"] == "true",
    "recipient": os.environ["JSON_RECIPIENT"],
}
mode = os.environ.get("JSON_MODE", "")
reason = os.environ.get("JSON_REASON", "")
if mode:
    obj["mode"] = mode
if reason:
    obj["reason"] = reason
print(json.dumps(obj, separators=(",", ":")))
PY
    return
  fi

  printf '{"ok":%s,"recipient":"%s"' "$ok" "$(json_escape "$RECIPIENT")"
  if [[ -n "$mode" ]]; then
    printf ',"mode":"%s"' "$(json_escape "$mode")"
  fi
  if [[ -n "$reason" ]]; then
    printf ',"reason":"%s"' "$(json_escape "$reason")"
  fi
  printf '}\n'
}

is_blank_sentinel() {
  [[ "$1" == "?" || "$1" == "-" || -z "$1" ]]
}

open_url() {
  "$OPEN_CMD" "$1"
}

if [[ $# -lt 1 ]]; then
  echo "usage: $0 RECIPIENT (phone like +16043154583 or email)" >&2
  RECIPIENT=""
  emit_json false "" "usage"
  exit 64
fi

RECIPIENT="$1"
BODY="$(cat)"

if [[ -z "$BODY" ]]; then
  echo "error: empty draft body on stdin" >&2
  emit_json false "" "empty_body"
  exit 65
fi

if ! printf '%s' "$BODY" | "$PBCOPY_CMD"; then
  emit_json false "" "pbcopy_failed"
  exit 66
fi

if ! command -v python3 >/dev/null 2>&1; then
  FALLBACK_URL="imessage://$RECIPIENT"
  if is_blank_sentinel "$RECIPIENT"; then
    FALLBACK_URL="imessage://"
  fi
  if open_url "$FALLBACK_URL"; then
    emit_json true "clipboard_only" "python3_missing_for_url_encoding"
    exit 0
  fi
  emit_json false "" "open_failed"
  exit 67
fi

COMPOSE_URL="$(
  RECIPIENT="$RECIPIENT" BODY="$BODY" python3 - <<'PY'
import os
from urllib.parse import quote

recipient = os.environ["RECIPIENT"]
body = os.environ["BODY"]
if recipient in {"?", "-", ""}:
    print(f"sms:&body={quote(body, safe='')}")
else:
    print(f"sms:{quote(recipient, safe='+@._-')}&body={quote(body, safe='')}")
PY
)"

if open_url "$COMPOSE_URL"; then
  if is_blank_sentinel "$RECIPIENT"; then
    emit_json true "clipboard_only" "sms_body_url_opened_unverified_new_compose"
  else
    emit_json true "clipboard_only" "sms_body_url_opened_unverified"
  fi
else
  FALLBACK_URL="imessage://$RECIPIENT"
  if is_blank_sentinel "$RECIPIENT"; then
    FALLBACK_URL="imessage://"
  fi
  if open_url "$FALLBACK_URL"; then
    emit_json true "clipboard_only" "sms_body_url_open_failed"
    exit 0
  fi
  emit_json false "" "open_failed"
  exit 67
fi
