#!/usr/bin/env bash
# stage-imessage.sh - send an iMessage draft payload to the staging thread.
#
# Reads the target-recipient draft body from stdin and sends a structured,
# human-readable payload to RELAY_IMESSAGE_STAGING_HANDLE. A Shortcuts personal
# automation watches that staging thread. For iPhone reliability, this helper
# also writes the same draft to the existing ClaudeDraft iCloud handoff file;
# the iPhone automation uses the staging iMessage as the wake-up signal and
# ClaudeDraft reads latest.json to open the target Messages compose sheet with
# Show When Run enabled. This helper never sends the final target message.
#
# Payload contract:
#   {
#     "version": "CLDRAFT/1",
#     "to": "<target iMessage handle>",
#     "label": "<human contact label>",
#     "body": "<draft body>"
#   }
#
# Output: a single JSON envelope on stdout. Body content is NEVER printed.
#   {"ok":true,"mode":"staging_imessage","recipient":"+15196816391","payload_sha256":"..."}
#   {"ok":false,"recipient":"+15196816391","reason":"..."}
#
# Exit code:
#   0  - staging payload sent
#   64 - usage error or RELAY_IMESSAGE_STAGING_HANDLE missing
#   65 - empty body on stdin
#   66 - python3 missing
#   67 - osascript/Messages send failed

set -uo pipefail

OSASCRIPT_CMD="${RELAY_OSASCRIPT_CMD:-osascript}"
STAGING_HANDLE="${RELAY_IMESSAGE_STAGING_HANDLE:-}"
DRY_RUN_PATH="${RELAY_STAGE_IMESSAGE_DRY_RUN_PATH:-}"
SEND_TIMEOUT_SECONDS="${RELAY_STAGE_IMESSAGE_TIMEOUT_SECONDS:-25}"
ALLOW_SELF_STAGING="${RELAY_IMESSAGE_ALLOW_SELF_STAGING:-}"
MESSAGES_DB_PATH="${RELAY_MESSAGES_DB_PATH:-$HOME/Library/Messages/chat.db}"
WRITE_ICLOUD_DRAFT="${RELAY_STAGE_IMESSAGE_WRITE_ICLOUD_DRAFT:-1}"
ICLOUD_DRAFT_DIR="${RELAY_ICLOUD_DRAFT_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts}"
# Pre-built payload from the TypeScript caller (src/cldraft-payload.ts). When
# set, the script uses it verbatim and skips the legacy Python builder. The
# legacy path is retained for direct CLI use, recovery, and the dry-run
# fixture tests in src/imessage-draft.test.ts.
PRE_BUILT_PAYLOAD="${RELAY_CLDRAFT_PAYLOAD_JSON:-}"
# Pre-generated UUIDv4. Used by both the CLDRAFT/1 envelope (when the legacy
# Python builder runs) and the iCloud fallback file so the two stay correlated.
PRE_GENERATED_DRAFT_ID="${RELAY_CLDRAFT_DRAFT_ID:-}"

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
  local payload_sha="${4:-}"

  if command -v python3 >/dev/null 2>&1; then
    JSON_OK="$ok" \
      JSON_MODE="$mode" \
      JSON_RECIPIENT="$RECIPIENT" \
      JSON_REASON="$reason" \
      JSON_PAYLOAD_SHA="$payload_sha" \
      python3 - <<'PY'
import json
import os

obj = {
    "ok": os.environ["JSON_OK"] == "true",
    "recipient": os.environ.get("JSON_RECIPIENT", ""),
}
mode = os.environ.get("JSON_MODE", "")
reason = os.environ.get("JSON_REASON", "")
payload_sha = os.environ.get("JSON_PAYLOAD_SHA", "")
if mode:
    obj["mode"] = mode
if reason:
    obj["reason"] = reason
if payload_sha:
    obj["payload_sha256"] = payload_sha
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
  if [[ -n "$payload_sha" ]]; then
    printf ',"payload_sha256":"%s"' "$(json_escape "$payload_sha")"
  fi
  printf '}\n'
}

normalize_handle_for_compare() {
  local s="$1"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$s" in
    *@*)
      printf '%s' "$s"
      ;;
    *)
      printf '%s' "$s" | tr -d '().-'
      ;;
  esac
}

messages_max_rowid() {
  if [[ ! -r "$MESSAGES_DB_PATH" ]]; then
    printf '0'
    return
  fi

  MESSAGES_DB_PATH="$MESSAGES_DB_PATH" python3 - <<'PY'
import os
import sqlite3

try:
    conn = sqlite3.connect(f"file:{os.environ['MESSAGES_DB_PATH']}?mode=ro", uri=True, timeout=1)
    row = conn.execute("SELECT COALESCE(MAX(ROWID), 0) FROM message").fetchone()
    print(int(row[0] if row else 0))
except Exception:
    print(0)
PY
}

payload_seen_after_rowid() {
  local start_rowid="$1"
  if [[ ! -r "$MESSAGES_DB_PATH" ]]; then
    return 1
  fi

  MESSAGES_DB_PATH="$MESSAGES_DB_PATH" \
    START_ROWID="$start_rowid" \
    PAYLOAD="$PAYLOAD" \
    python3 - <<'PY'
import os
import sqlite3
import sys

try:
    start_rowid = int(os.environ.get("START_ROWID", "0") or "0")
except ValueError:
    start_rowid = 0

try:
    conn = sqlite3.connect(f"file:{os.environ['MESSAGES_DB_PATH']}?mode=ro", uri=True, timeout=1)
    row = conn.execute(
        "SELECT 1 FROM message WHERE ROWID > ? AND text = ? ORDER BY ROWID DESC LIMIT 1",
        (start_rowid, os.environ["PAYLOAD"]),
    ).fetchone()
    sys.exit(0 if row else 1)
except Exception:
    sys.exit(1)
PY
}

write_icloud_draft() {
  if [[ "$WRITE_ICLOUD_DRAFT" == "0" ]]; then
    return 0
  fi

  ICLOUD_DRAFT_DIR="$ICLOUD_DRAFT_DIR" \
    RECIPIENT="$RECIPIENT" \
    CONTACT_LABEL="$CONTACT_LABEL" \
    BODY="$BODY" \
    PRE_GENERATED_DRAFT_ID="$PRE_GENERATED_DRAFT_ID" \
    python3 - <<'PY'
import hashlib
import json
import os
import socket
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

draft_dir = Path(os.environ["ICLOUD_DRAFT_DIR"]).expanduser()
body = os.environ["BODY"]
now = datetime.now(timezone.utc)
# Reuse the TypeScript-generated UUIDv4 when available so the iCloud file's
# draft_id matches the CLDRAFT/1 staging payload. Falls back to a fresh UUID
# for legacy direct-CLI invocations that bypass relay.ts.
existing_id = os.environ.get("PRE_GENERATED_DRAFT_ID", "").strip()
draft_id = existing_id if existing_id else str(uuid.uuid4())
payload = {
    "schema_version": 2,
    "draft_id": draft_id,
    "writer_host": socket.gethostname(),
    "created_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "expires_at": (now + timedelta(minutes=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "recipient": os.environ["RECIPIENT"],
    "recipient_label": os.environ["CONTACT_LABEL"],
    "body": body,
    "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
}

draft_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
target = draft_dir / "latest.json"
fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=str(draft_dir))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp_name, 0o600)
    os.replace(tmp_name, target)
except Exception:
    try:
        os.unlink(tmp_name)
    except OSError:
        pass
    raise
PY
}

if [[ $# -lt 1 ]]; then
  echo "usage: $0 TARGET_RECIPIENT [CONTACT_LABEL] (body on stdin)" >&2
  RECIPIENT=""
  emit_json false "" "usage"
  exit 64
fi

RECIPIENT="$1"
CONTACT_LABEL="${2:-$RECIPIENT}"
BODY="$(cat)"

if [[ -z "$STAGING_HANDLE" ]]; then
  emit_json false "" "staging_handle_missing"
  exit 64
fi

if [[ -z "$BODY" ]]; then
  echo "error: empty draft body on stdin" >&2
  emit_json false "" "empty_body"
  exit 65
fi

if ! command -v python3 >/dev/null 2>&1; then
  emit_json false "" "python3_missing"
  exit 66
fi

if [[ "$ALLOW_SELF_STAGING" != "1" ]]; then
  NORMALIZED_STAGING="$(normalize_handle_for_compare "$STAGING_HANDLE")"
  NORMALIZED_RECIPIENT="$(normalize_handle_for_compare "$RECIPIENT")"
  if [[ -n "$NORMALIZED_STAGING" && "$NORMALIZED_STAGING" == "$NORMALIZED_RECIPIENT" ]]; then
    emit_json false "" "staging_handle_matches_recipient"
    exit 64
  fi
fi

case "$SEND_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    SEND_TIMEOUT_SECONDS=25
    ;;
esac

if [[ -n "$PRE_BUILT_PAYLOAD" ]]; then
  # Production path: relay.ts built the CLDRAFT/1 envelope via
  # src/cldraft-payload.ts and passed it in verbatim. Single source of truth
  # for the schema lives in TypeScript.
  PAYLOAD="$PRE_BUILT_PAYLOAD"
else
  # Legacy path: direct CLI invocation, recovery scripts, and the dry-run
  # fixture tests in src/imessage-draft.test.ts. Builds an equivalent
  # envelope here. The schema (field names, version sentinel, draft_id) must
  # match src/cldraft-payload.ts; if you change one, change both, and the
  # round-trip test in src/cldraft-payload.test.ts will not catch drift on
  # this branch because the legacy path is only exercised in shell tests.
  PAYLOAD="$(
    RECIPIENT="$RECIPIENT" \
      CONTACT_LABEL="$CONTACT_LABEL" \
      BODY="$BODY" \
      PRE_GENERATED_DRAFT_ID="$PRE_GENERATED_DRAFT_ID" \
      python3 - <<'PY'
import json
import os
import uuid

def header(value: str) -> str:
    return " ".join(value.replace("\r", " ").replace("\n", " ").split())

existing_id = os.environ.get("PRE_GENERATED_DRAFT_ID", "").strip()
draft_id = existing_id if existing_id else str(uuid.uuid4())
payload = {
    "version": "CLDRAFT/1",
    "draft_id": draft_id,
    "to": header(os.environ["RECIPIENT"]),
    "label": header(os.environ["CONTACT_LABEL"]),
    "body": os.environ["BODY"],
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), end="")
PY
  )"
fi

PAYLOAD_SHA="$(
  PAYLOAD="$PAYLOAD" python3 - <<'PY'
import hashlib
import os

print(hashlib.sha256(os.environ["PAYLOAD"].encode("utf-8")).hexdigest())
PY
)"

if [[ -n "$DRY_RUN_PATH" ]]; then
  umask 077
  if printf '%s' "$PAYLOAD" > "$DRY_RUN_PATH"; then
    emit_json true "dry_run" "" "$PAYLOAD_SHA"
    exit 0
  fi
  emit_json false "" "dry_run_write_failed" "$PAYLOAD_SHA"
  exit 67
fi

if ! write_icloud_draft; then
  emit_json false "" "icloud_draft_write_failed" "$PAYLOAD_SHA"
  exit 67
fi

APPLESCRIPT_PATH="$(mktemp "${TMPDIR:-/tmp}/relay-stage-imessage.XXXXXX")"
trap 'rm -f "$APPLESCRIPT_PATH"' EXIT
cat > "$APPLESCRIPT_PATH" <<'APPLESCRIPT'
on run argv
    set stagingHandle to item 1 of argv
    set payloadText to item 2 of argv
    tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy stagingHandle of targetService
        send payloadText to targetBuddy
    end tell
end run
APPLESCRIPT
trap 'rm -f "$APPLESCRIPT_PATH"' EXIT

START_ROWID="$(messages_max_rowid)"
"$OSASCRIPT_CMD" "$APPLESCRIPT_PATH" "$STAGING_HANDLE" "$PAYLOAD" &
OSASCRIPT_PID=$!

elapsed=0
while (( elapsed < SEND_TIMEOUT_SECONDS )); do
  if payload_seen_after_rowid "$START_ROWID"; then
    kill "$OSASCRIPT_PID" 2>/dev/null || true
    wait "$OSASCRIPT_PID" 2>/dev/null || true
    emit_json true "staging_imessage" "" "$PAYLOAD_SHA"
    exit 0
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

kill "$OSASCRIPT_PID" 2>/dev/null || true
if wait "$OSASCRIPT_PID"; then
  if payload_seen_after_rowid "$START_ROWID"; then
    emit_json true "staging_imessage" "" "$PAYLOAD_SHA"
    exit 0
  fi
  emit_json true "staging_imessage" "" "$PAYLOAD_SHA"
  exit 0
fi

OSASCRIPT_CODE=$?
if payload_seen_after_rowid "$START_ROWID"; then
  emit_json true "staging_imessage" "" "$PAYLOAD_SHA"
  exit 0
fi
if (( elapsed >= SEND_TIMEOUT_SECONDS )); then
  emit_json false "" "osascript_timeout" "$PAYLOAD_SHA"
else
  emit_json false "" "osascript_send_failed_${OSASCRIPT_CODE}" "$PAYLOAD_SHA"
fi
exit 67
