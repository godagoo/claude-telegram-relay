#!/usr/bin/env python3
"""resolve-contact.py — resolve a contact alias to phone/email.

Reads all AddressBook source databases under
  ~/Library/Application Support/AddressBook/
including iCloud/Exchange/CardDAV source subdirs, NOT just the top-level
abcddb (which on this Mac holds only the local "me" record). Returns the
best-match identifier (phone or email) on stdout, or empty if no match.

Match order:
  1. Direct identifier (phone/email shape) → return as-is.
  2. Exact case-insensitive substring against "first last nickname org" → use it.
  3. Fuzzy match (difflib SequenceMatcher) against name tokens, with a
     similarity cutoff. Handles typos like "gailene" → "Gaileen".

Usage: resolve-contact.py "gailene"
Exit codes: 0 always (no match prints empty line).
"""

from __future__ import annotations

import difflib
import glob
import os
import re
import sqlite3
import sys
from pathlib import Path

# Lower than ratio() < 0.75 misses obvious typos (e.g. "gailene" vs "Gaileen"
# scores 0.857). Higher than 0.80 starts gating legit nicknames. 0.75 is the
# sweet spot. Keep in lockstep with tests/scripts that depend on this.
FUZZY_CUTOFF = 0.75

# Same hard-block list as scripts/imessage-thread.sh's relationship-alias
# guard. These are too ambiguous to fuzzy-match — a contact named "Mona"
# should not pick up "mom".
BLOCKED_FUZZY = {
    "me", "myself", "mom", "mum", "mother", "dad", "father",
    "wife", "husband", "son", "daughter", "brother", "sister",
    "parent", "parents",
}

DIRECT_PHONE_RE = re.compile(r"^[+0-9][0-9\s().\-]{6,}$")
DIRECT_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def is_direct_identifier(s: str) -> bool:
    return bool(DIRECT_PHONE_RE.match(s) or DIRECT_EMAIL_RE.match(s))


def normalize_phone(phone: str) -> str:
    """Return the Messages-friendly E.164-ish shape for AddressBook phones."""
    digits = re.sub(r"\D", "", phone or "")
    if not digits:
        return ""
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if phone.strip().startswith("+"):
        return f"+{digits}"
    return digits


# Each contact may have phone AND email rows; we pick the primary phone if
# present, otherwise the primary email, otherwise the first non-empty. We
# deduplicate per (source_db, record_id) to avoid duplicating the same person
# across joins.
QUERY_SQL = """
SELECT
  r.Z_PK AS rid,
  TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) AS name,
  COALESCE(r.ZNICKNAME,'') AS nickname,
  COALESCE(r.ZORGANIZATION,'') AS org,
  COALESCE(p.ZFULLNUMBER,'') AS phone,
  COALESCE(p.ZISPRIMARY, 0) AS phone_primary,
  COALESCE(e.ZADDRESS,'') AS email,
  COALESCE(e.ZISPRIMARY, 0) AS email_primary
FROM ZABCDRECORD r
LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK OR p.Z22_OWNER = r.Z_PK
LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK OR e.Z22_OWNER = r.Z_PK
WHERE (COALESCE(p.ZFULLNUMBER,'') != '' OR COALESCE(e.ZADDRESS,'') != '')
"""


def addressbook_paths() -> list[Path]:
    base = Path.home() / "Library" / "Application Support" / "AddressBook"
    paths = [base / "AddressBook-v22.abcddb"]
    paths.extend(
        Path(p)
        for p in glob.glob(str(base / "Sources" / "*" / "AddressBook-v22.abcddb"))
    )
    return [p for p in paths if p.exists() and os.access(p, os.R_OK)]


def collect_contacts() -> list[dict]:
    """Return one record per person across all source DBs, with the primary
    phone/email chosen (phone preferred over email when both exist)."""
    by_record: dict[tuple, dict] = {}
    for db in addressbook_paths():
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=4.0)
        except sqlite3.Error:
            continue
        try:
            for row in conn.execute(QUERY_SQL):
                rid, name, nick, org, phone, phone_primary, email, email_primary = row
                key = (str(db), rid)
                cur = by_record.get(key)
                if cur is None:
                    cur = {
                        "name": (name or "").strip(),
                        "nickname": (nick or "").strip(),
                        "org": (org or "").strip(),
                        "phone": "",
                        "phone_primary": 0,
                        "email": "",
                        "email_primary": 0,
                    }
                    by_record[key] = cur
                # Keep primary phone if seen; otherwise first non-empty phone.
                if phone and (cur["phone"] == "" or phone_primary > cur["phone_primary"]):
                    cur["phone"] = phone.strip()
                    cur["phone_primary"] = int(phone_primary or 0)
                if email and (cur["email"] == "" or email_primary > cur["email_primary"]):
                    cur["email"] = email.strip()
                    cur["email_primary"] = int(email_primary or 0)
        except sqlite3.Error:
            pass
        finally:
            conn.close()
    return list(by_record.values())


def chosen_identifier(c: dict) -> str:
    """Prefer phone over email — Messages.app prefers iMessage to a phone
    when both are available, and most contacts have phones in this address
    book."""
    phone = normalize_phone(c["phone"])
    return phone or c["email"] or ""


def haystack(c: dict) -> str:
    return f"{c['name']} {c['nickname']} {c['org']}".lower()


def tokens(c: dict) -> list[str]:
    out = []
    for field in (c["name"], c["nickname"]):
        for tok in field.lower().split():
            if tok:
                out.append(tok)
    return out


def _most_recent_message_date(identifier: str) -> int:
    """Max(date) in `~/Library/Messages/chat.db` for any 1:1 chat whose
    chat_identifier matches `identifier` (with or without leading '+', and
    with the common '+1<naked>' US-prefix variant). Returns 0 if no messages
    or the DB is unreadable. Used to break ties when multiple address-book
    contacts share a name (e.g. multiple "Mark"s) — the one the user has
    actually been messaging wins.
    """
    if not identifier:
        return 0
    naked = identifier.lstrip("+")
    db_path = Path.home() / "Library" / "Messages" / "chat.db"
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=4.0)
    except sqlite3.Error:
        return 0
    try:
        cur = conn.execute(
            """
            SELECT MAX(m.date)
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE c.chat_identifier IN (?, ?, ?, ?)
              AND c.chat_identifier NOT LIKE 'chat%'
            """,
            (identifier, f"+{naked}", naked, f"+1{naked}"),
        )
        row = cur.fetchone()
        return int(row[0] or 0)
    except sqlite3.Error:
        return 0
    finally:
        conn.close()


def _pick_most_recently_messaged(candidates: list[str]) -> str:
    """Of `candidates` (already deduplicated, all valid identifiers), return
    the one with the most recent chat.db activity. Stable on tie: returns
    the first candidate in iteration order. Returns the first candidate if
    none has any activity — never returns empty when given a non-empty list.
    """
    if not candidates:
        return ""
    if len(candidates) == 1:
        return candidates[0]
    best_date = -1
    best = candidates[0]
    for ident in candidates:
        d = _most_recent_message_date(ident)
        if d > best_date:
            best_date = d
            best = ident
    return best


ALIAS_FILE_DEFAULT = Path.home() / ".claude-relay" / "contact-aliases.json"


def _alias_file_path() -> Path:
    override = os.environ.get("RELAY_CONTACT_ALIASES_PATH", "").strip()
    if override:
        return Path(override)
    return ALIAS_FILE_DEFAULT


def load_aliases() -> dict[str, str]:
    """Return a case-insensitive alias -> identifier map.

    The file is consulted BEFORE AddressBook lookup. It exists so the user
    can correct mismatches between contact-card data and the chat.db handle
    they actually message on (e.g. "Dad" -> +16048092405 when their
    AddressBook "Dad" card holds a different phone that has no message
    history). The file is optional; a missing or malformed file is silently
    ignored and the AddressBook lookup proceeds.

    Format (JSON object, keys lowercased before lookup):
      {
        "dad": "+16048092405",
        "mom": "+16043154583",
        "natalie": "natalie@example.com"
      }
    """
    path = _alias_file_path()
    try:
        import json
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        ident = value.strip()
        if not ident:
            continue
        if DIRECT_PHONE_RE.match(ident):
            ident = normalize_phone(ident)
        elif not DIRECT_EMAIL_RE.match(ident):
            # Reject non-identifier values silently; aliases must point at
            # something Messages.app can address.
            continue
        out[key.strip().lower()] = ident
    return out


def resolve(query: str, contacts: list[dict] | None = None) -> str:
    q = query.strip()
    if not q:
        return ""
    if DIRECT_PHONE_RE.match(q):
        return normalize_phone(q)
    if DIRECT_EMAIL_RE.match(q):
        return q

    q_lower = q.lower()

    # 0a. User-curated alias overrides win over every AddressBook source.
    # This is the escape hatch for AddressBook/chat.db mismatches the
    # resolver cannot disambiguate on its own (e.g. a parent's shared
    # household phone stored under one parent's contact card while the
    # user verbally refers to it by the other parent's name).
    aliases = load_aliases()
    if q_lower in aliases:
        return aliases[q_lower]

    if contacts is None:
        contacts = collect_contacts()
    if not contacts:
        return ""

    # 0. Exact match against first-name OR nickname OR full name. This is
    # safe even for relationship aliases ("mom") because we're matching an
    # explicit contact card the user maintains, not fuzzy-guessing from
    # message text. William's iCloud has a contact literally named "Mom";
    # blocking it here would force him to type her phone every time.
    # If the BEST exact match is the user's own "Me" record, skip it — that
    # is the historical "mom → self" bug.
    # Collect ALL exact matches and disambiguate by chat.db activity below.
    # Live failure 2026-05-13T21:04Z: "Mark" matched a long-unused contact
    # with phone 2042956236 first (alphabetical/iteration order), so the
    # bot fetched zero context for the active "Mark - Azure Landlord"
    # (+15196394490) the user actually meant. Decision log:
    # imessage_context_status=empty, imessage_context_count=0.
    self_idents = {chosen_identifier(c) for c in contacts if _is_me_record(c)} \
        | {c["email"] for c in contacts if _is_me_record(c)}
    self_idents.discard("")
    exact_candidates: list[str] = []
    seen: set[str] = set()
    for c in contacts:
        if _is_me_record(c) and q_lower != "me" and q_lower != "myself":
            continue
        first = c["name"].split()[0].lower() if c["name"] else ""
        if q_lower in {first, c["nickname"].lower(), c["name"].lower()}:
            ident = chosen_identifier(c)
            if not ident:
                continue
            if ident in self_idents and q_lower not in {"me", "myself"}:
                continue
            if ident in seen:
                continue
            seen.add(ident)
            exact_candidates.append(ident)
    if exact_candidates:
        return _pick_most_recently_messaged(exact_candidates)

    # FUZZY/substring matching is blocked for relationship aliases. Exact
    # match (above) already handles the legitimate "Mom" contact case.
    if q_lower in BLOCKED_FUZZY:
        return ""

    # 1. Substring match (cheap, preserves prior behaviour). Skip "Me" records
    # so a contact card with notes mentioning "mom" or "wife" can't hijack
    # a relationship query. Collect all candidates, disambiguate by recency.
    substring_candidates: list[str] = []
    seen.clear()
    for c in contacts:
        if _is_me_record(c):
            continue
        if q_lower in haystack(c):
            ident = chosen_identifier(c)
            if not ident or ident in self_idents or ident in seen:
                continue
            seen.add(ident)
            substring_candidates.append(ident)
    if substring_candidates:
        return _pick_most_recently_messaged(substring_candidates)

    # 2. Fuzzy match against name tokens. Pick the contact whose best token
    # similarity is highest, gated by FUZZY_CUTOFF. Skip "Me" records.
    # Among contacts tied at the top score (e.g. two contacts with a token
    # "Sara" both scoring 1.0 against "Sara"), still disambiguate by recency.
    scored: list[tuple[float, str]] = []
    for c in contacts:
        if _is_me_record(c):
            continue
        ident = chosen_identifier(c)
        if not ident or ident in self_idents:
            continue
        c_best = 0.0
        for tok in tokens(c):
            score = difflib.SequenceMatcher(None, q_lower, tok).ratio()
            if score > c_best:
                c_best = score
        if c_best >= FUZZY_CUTOFF:
            scored.append((c_best, ident))
    if scored:
        top = max(score for score, _ in scored)
        # Pull all ties at the top score (within 0.01 to absorb float noise)
        # and disambiguate by chat.db recency.
        top_candidates: list[str] = []
        seen.clear()
        for score, ident in scored:
            if score >= top - 0.01 and ident not in seen:
                seen.add(ident)
                top_candidates.append(ident)
        return _pick_most_recently_messaged(top_candidates)
    return ""


def _is_me_record(c: dict) -> bool:
    """Best-effort detector for the user's own contact card. AddressBook
    doesn't expose a stable 'is_me' flag at the SQL level, so we go by
    convention: the local (non-Sources) DB on this Mac holds only the user's
    record. Until we wire a proper signal, the safest heuristic is to flag
    any record whose name/nickname is literally "me", "myself", or matches
    the USER_NAME env var. The hard "self" filtering in resolve() also uses
    chosen_identifier collisions, which catches the mom→self case even when
    this heuristic is wrong."""
    n = (c["name"] or "").strip().lower()
    nick = (c["nickname"] or "").strip().lower()
    user_name = (os.environ.get("USER_NAME", "") or "").strip().lower()
    if n in {"me", "myself"} or nick in {"me", "myself"}:
        return True
    if user_name and (n == user_name or nick == user_name):
        return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("", end="")
        return 0
    print(resolve(argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
