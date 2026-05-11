#!/usr/bin/env bash
# imessage-thread.sh — print the most recent iMessages with a given contact
# as JSON. Used by the bot to gather context before drafting a reply.
#
# Usage:
#   scripts/imessage-thread.sh +16043154583 [LIMIT]
#
# Output (stdout, JSON array, one object per row):
#   [{"id":<int>,"sender":"me"|"them","ts":"<localtime>","text":"<message>"}, ...]
#
# Requires:
#   Full Disk Access on the process that ends up running sqlite3. When the
#   bot invokes this via the Claude CLI's Bash tool, that means FDA must be
#   granted to the resolved Claude binary at
#     /Users/williamregan/.local/share/claude/versions/<vN>
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

is_direct_identifier() {
  [[ "$1" =~ ^[+0-9][0-9[:space:]().-]{6,}$ || "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

resolve_recipient() {
  local input="$1"
  if is_direct_identifier "$input"; then
    printf "%s" "$input"
    return 0
  fi

  local q
  q="$(sql_string "$input")"

  if [[ -r "$CONTACTS_DB" ]]; then
    local contact
    contact="$(sqlite3 -readonly "$CONTACTS_DB" <<SQL
SELECT COALESCE(p.ZFULLNUMBER, e.ZADDRESS, '')
FROM ZABCDRECORD r
LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK OR p.Z22_OWNER = r.Z_PK
LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK OR e.Z22_OWNER = r.Z_PK
WHERE lower(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'') || ' ' || COALESCE(r.ZNICKNAME,'') || ' ' || COALESCE(r.ZORGANIZATION,'')) LIKE '%' || lower('$q') || '%'
  AND COALESCE(p.ZFULLNUMBER, e.ZADDRESS, '') != ''
ORDER BY p.ZISPRIMARY DESC, e.ZISPRIMARY DESC, r.ZMODIFICATIONDATE DESC
LIMIT 1;
SQL
)"
    if [[ -n "$contact" ]]; then
      printf "%s" "$contact"
      return 0
    fi
  fi

  # Fallback for contacts not saved in AddressBook: find a one-on-one thread
  # where the name appears in message text, then use that chat identifier.
  sqlite3 -readonly "$DB" <<SQL
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
}

RESOLVED_RECIPIENT="$(resolve_recipient "$RECIPIENT")"
if [[ -z "$RESOLVED_RECIPIENT" ]]; then
  printf '[]\n'
  exit 0
fi

# Normalize: strip a leading + so we can match both '+16045555555' and
# '16045555555' shapes in chat_identifier.
NAKED="${RESOLVED_RECIPIENT#+}"
SQL_RECIPIENT="$(sql_string "$RESOLVED_RECIPIENT")"
SQL_NAKED="$(sql_string "$NAKED")"

sqlite3 -readonly "$DB" <<SQL
.mode json
SELECT
  m.ROWID AS id,
  CASE WHEN m.is_from_me = 1 THEN 'me' ELSE 'them' END AS sender,
  datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') AS ts,
  m.text
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE c.chat_identifier IN ('$SQL_RECIPIENT', '+$SQL_NAKED', '$SQL_NAKED', '+1$SQL_NAKED')
  AND m.text IS NOT NULL
  AND m.text != ''
ORDER BY m.date DESC
LIMIT $LIMIT;
SQL
