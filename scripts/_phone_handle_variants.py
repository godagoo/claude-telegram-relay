#!/usr/bin/env python3
"""Canonical phone-handle variant expansion.

Single source of truth used by resolve-contact.py (Python import) and
imessage-thread.sh (subprocess call). Both scripts must see the same
candidate set when comparing against `chat.chat_identifier` in
~/Library/Messages/chat.db, otherwise the recency tie-breaker in
resolve-contact.py can return last_messaged_at=0 for a number whose
real chat row uses one of the variants imessage-thread.sh checks.

PR3.5 audit #2 (Codex 2026-05-21): resolve-contact.py previously checked
four variants (identifier, +naked, naked, +1naked) while imessage-thread.sh
built up to seven (identifier, digits, +digits, plus 10/11-digit variants
with and without the country prefix). Same input, different scripts,
different answer. The wrong duplicate contact could win ambiguity.

Usage:
  As a module:
    from _phone_handle_variants import phone_handle_variants
    variants = phone_handle_variants("+16043154583")
  As a CLI (used by bash):
    python3 _phone_handle_variants.py +16043154583
      -> one variant per line on stdout, deduped, order preserved
"""
from __future__ import annotations

import re
import sys


_DIGITS_RE = re.compile(r"\D")


def phone_handle_variants(identifier: str) -> list[str]:
    """Return all chat_identifier shapes worth checking for `identifier`.

    Always includes `identifier` itself first. For phone-shaped inputs,
    expands digit-only / plus-prefixed / NANP-prefixed forms. For email
    inputs (contains '@'), returns only the identifier. Returns an empty
    list for an empty identifier.

    The list is deduplicated in stable order: first occurrence wins.
    """
    if not identifier:
        return []
    candidates: list[str] = [identifier]
    if "@" not in identifier:
        digits = _DIGITS_RE.sub("", identifier)
        if digits:
            candidates.append(digits)
            candidates.append(f"+{digits}")
            if len(digits) == 10:
                candidates.append(f"1{digits}")
                candidates.append(f"+1{digits}")
            elif len(digits) == 11 and digits.startswith("1"):
                without_country = digits[1:]
                candidates.append(without_country)
                candidates.append(f"+{without_country}")
    seen: set[str] = set()
    unique: list[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 0
    for v in phone_handle_variants(argv[1]):
        print(v)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
