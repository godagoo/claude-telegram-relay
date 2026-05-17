#!/usr/bin/env bash
# imessage-thread.sh — print the most recent iMessages with a given contact
# as JSON. Used by the bot to gather context before drafting a reply.
#
# Usage:
#   scripts/imessage-thread.sh +16043154583 [LIMIT]
#
# Output (stdout, JSON envelope):
#   {"resolved":"<phone-or-email>","messages":[
#     {"id":<int>,"sender":"me"|"them","ts":"<localtime>","text":"<message>"},
#     ...
#   ]}
# When the recipient cannot be resolved, "resolved" is the empty string and
# "messages" is an empty array. The relay reuses the resolved value to address
# Messages.app deterministically when placing a draft.
#
# Requires:
#   Full Disk Access on the process that ends up running sqlite3. The relay
#   invokes this directly from bun before Claude runs, so FDA must be granted
#   to the resolved bun Cellar binary (`readlink -f "$(which bun)"`), not to
#   Terminal and not to the Claude CLI.
#   See docs/IMESSAGE-SETUP.md for the one-time setup.
#
# Output goes to the relay's local short-term context, never to a remote
# service. Read-only access to chat.db is enforced via -readonly.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 RECIPIENT [LIMIT] (RECIPIENT: phone like +16043154583, or email)" >&2
  exit 64
fi

RECIPIENT="$1"
LIMIT="${2:-20}"

# Pin the Python interpreter. Set RELAY_PYTHON in .env to match the interpreter
# that launchd will actually find (may differ from the interactive shell's python3).
PYTHON3="${RELAY_PYTHON:-python3}"

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "error: LIMIT must be a positive integer" >&2
  exit 64
fi
if (( LIMIT < 1 )); then
  LIMIT=1
elif (( LIMIT > 50 )); then
  LIMIT=50
fi

DB="$HOME/Library/Messages/chat.db"
CONTACTS_DB="$HOME/Library/Application Support/AddressBook/AddressBook-v22.abcddb"

if [[ ! -r "$DB" ]]; then
  cat <<EOF >&2
error: cannot read $DB
Full Disk Access is not granted for the current process. See
docs/IMESSAGE-SETUP.md for the one-time setup.
EOF
  exit 77
fi

sql_string() {
  # SQLite single-quoted string escaping.
  printf "%s" "$1" | sed "s/'/''/g"
}

json_string() {
  local s="$1"
  if command -v "$PYTHON3" >/dev/null 2>&1; then
    JSON_VALUE="$s" "$PYTHON3" - <<'PY'
import json
import os
print(json.dumps(os.environ["JSON_VALUE"]), end="")
PY
    return
  fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

chat_identifier_candidates_sql() {
  local identifier="$1"
  local digits without_country candidate seen already out
  local -a candidates unique

  candidates=("$identifier")

  if [[ "$identifier" != *"@"* ]]; then
    digits="$(printf "%s" "$identifier" | tr -cd '0-9')"
    if [[ -n "$digits" ]]; then
      candidates+=("$digits" "+$digits")
      if [[ ${#digits} -eq 10 ]]; then
        candidates+=("1$digits" "+1$digits")
      elif [[ ${#digits} -eq 11 && "$digits" == 1* ]]; then
        without_country="${digits#1}"
        candidates+=("$without_country" "+$without_country")
      fi
    fi
  fi

  unique=()
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" ]] || continue
    already=0
    if (( ${#unique[@]} > 0 )); then
      for seen in "${unique[@]}"; do
        if [[ "$seen" == "$candidate" ]]; then
          already=1
          break
        fi
      done
    fi
    (( already == 0 )) && unique+=("$candidate")
  done

  out=""
  if (( ${#unique[@]} > 0 )); then
    for candidate in "${unique[@]}"; do
      if [[ -n "$out" ]]; then
        out+=", "
      fi
      out+="'$(sql_string "$candidate")'"
    done
  fi
  printf "%s" "$out"
}

is_fda_sqlite_error() {
  local msg
  msg="$(printf "%s" "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$msg" == *"authorization"* ||
     "$msg" == *"operation not permitted"* ||
     "$msg" == *"unable to open database"* ||
     "$msg" == *"permission denied"* ]]
}

sqlite_query_or_exit() {
  local sql="$1"
  local err_file out status err
  err_file="$(mktemp "${TMPDIR:-/tmp}/imessage-thread-sqlite.XXXXXX")"
  set +e
  out="$(sqlite3 -readonly "$DB" 2>"$err_file" <<<"$sql")"
  status=$?
  set -e
  err="$(cat "$err_file")"
  rm -f "$err_file"
  if (( status != 0 )); then
    if is_fda_sqlite_error "$err"; then
      cat <<EOF >&2
error: cannot read $DB
Full Disk Access is not granted for the current process. See
docs/IMESSAGE-SETUP.md for the one-time setup.
$err
EOF
      exit 77
    fi
    printf "%s\n" "$err" >&2
    exit "$status"
  fi
  printf "%s" "$out"
}

is_direct_identifier() {
  [[ "$1" =~ ^[+0-9][0-9[:space:]().-]{6,}$ || "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

allow_message_text_fallback() {
  local input_lc
  input_lc="$(printf "%s" "$1" | tr '[:upper:]' '[:lower:]')"

  # The message-text fallback is inherently weak: it finds a thread where the
  # word appeared in message text, not a contact whose name is that word. Keep
  # it away from short or relationship-style aliases like "mom", which can
  # otherwise resolve to the wrong one-on-one thread.
  if [[ ${#input_lc} -lt 4 ]]; then
    return 1
  fi

  if [[ "$input_lc" =~ (^|[^[:alpha:]])(me|myself|mom|mum|mother|dad|father|wife|husband|son|daughter|brother|sister|parent|parents)([^[:alpha:]]|$) ]]; then
    return 1
  fi

  return 0
}

resolve_recipient() {
  local input="$1"
  if is_direct_identifier "$input"; then
    printf "%s" "$input"
    return 0
  fi

  # Primary resolver: a Python helper that searches every AddressBook source
  # database (iCloud/Exchange/CardDAV subdirs under
  # ~/Library/Application Support/AddressBook/Sources/*/) and fuzzy-matches
  # the input against name tokens. The top-level AddressBook-v22.abcddb on
  # this Mac holds only the "me" record, which is why the old strict
  # substring query against just that DB always missed real contacts. The
  # helper handles direct identifiers, blocks relationship aliases, and
  # returns an empty string if no good match exists.
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  local resolver="$script_dir/resolve-contact.py"
  if [[ ! -f "$resolver" ]]; then
    echo "error: contact resolver missing: $resolver" >&2
    return 66
  fi
  if ! command -v "$PYTHON3" >/dev/null 2>&1; then
    echo "error: python3 not found (RELAY_PYTHON=${RELAY_PYTHON:-unset}); required for contact aliases in $resolver" >&2
    return 66
  fi
  if ! "$PYTHON3" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 7) else 1)
PY
  then
    local version
    version="$("$PYTHON3" --version 2>&1 || true)"
    echo "error: python3 >= 3.7 required for $resolver; got ${version:-unknown} (RELAY_PYTHON=${RELAY_PYTHON:-unset})" >&2
    return 66
  fi

  local contact err_file
  err_file="$(mktemp "${TMPDIR:-/tmp}/resolve-contact.XXXXXX")"
  if contact="$("$PYTHON3" "$resolver" "$input" 2>"$err_file")"; then
    rm -f "$err_file"
    if [[ -n "$contact" ]]; then
      printf "%s" "$contact"
      return 0
    fi
  else
    local status=$?
    printf "error: contact resolver failed for recipient %q (exit %s)\n" "$input" "$status" >&2
    if [[ -s "$err_file" ]]; then
      sed 's/^/resolve-contact.py: /' "$err_file" >&2
    fi
    rm -f "$err_file"
    return 66
  fi

  if ! allow_message_text_fallback "$input"; then
    return 0
  fi

  # Last-resort fallback for contacts not saved in any AddressBook source:
  # find a one-on-one thread where the specific name appears in message
  # text, then use that chat identifier. Do not use this for short or
  # relationship-style aliases; those are too ambiguous to place a draft
  # safely.
  local q
  q="$(sql_string "$input")"
  local sql
  sql="$(cat <<SQL
SELECT c.chat_identifier
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE lower(m.text) LIKE '%' || lower('$q') || '%'
  AND c.chat_identifier NOT LIKE 'chat%'
GROUP BY c.ROWID
ORDER BY MAX(m.date) DESC
LIMIT 1;
SQL
)"
  sqlite_query_or_exit "$sql"
}

RESOLVED_RECIPIENT="$(resolve_recipient "$RECIPIENT")"
if [[ -z "$RESOLVED_RECIPIENT" ]]; then
  printf '{"resolved":"","messages":[]}\n'
  exit 0
fi

SQL_CHAT_IDENTIFIERS="$(chat_identifier_candidates_sql "$RESOLVED_RECIPIENT")"
QUERY_LIMIT=$(( LIMIT * 4 ))
if (( QUERY_LIMIT > 150 )); then
  QUERY_LIMIT=150
fi

SQL_MESSAGES="$(cat <<SQL
.mode json
SELECT
  m.ROWID AS id,
  CASE WHEN m.is_from_me = 1 THEN 'me' ELSE 'them' END AS sender,
  datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
  COALESCE(m.text, '') AS text,
  hex(m.attributedBody) AS attributed_body_hex,
  COALESCE(m.associated_message_type, 0) AS associated_message_type
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE c.chat_identifier IN ($SQL_CHAT_IDENTIFIERS)
  AND (
    (m.text IS NOT NULL AND m.text != '')
    OR m.attributedBody IS NOT NULL
  )
ORDER BY m.date DESC
LIMIT $QUERY_LIMIT;
SQL
)"
MESSAGES_JSON="$(sqlite_query_or_exit "$SQL_MESSAGES")"

# sqlite3 .mode json emits nothing for zero rows; coerce to an empty array so
# the envelope is always valid JSON.
[[ -z "$MESSAGES_JSON" ]] && MESSAGES_JSON='[]'

NORMALIZER="$(cd "$(dirname "$0")" && pwd)/imessage-normalize-messages.py"
printf "%s" "$MESSAGES_JSON" | "$PYTHON3" "$NORMALIZER" "$RESOLVED_RECIPIENT" "$LIMIT"
