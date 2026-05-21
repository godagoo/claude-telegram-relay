#!/usr/bin/env python3
"""Emit newline-delimited key=value pairs from resolve-contact.py --meta JSON.

Used by imessage-thread.sh in place of the previous tab-separated emit, which
combined with `IFS=$'\\t' read` collapsed adjacent empty fields. With an
empty display_name, `handle\\t\\t0\\n` split into two tokens, so
RESOLVED_DISPLAY_NAME received "0" and RESOLVED_LAST_MESSAGED_AT was lost.
Newline-delimited key=value pairs, read by bash via `while IFS='=' read -r k v`,
preserve empty values correctly.

PR3.5 audit #1 (Codex 2026-05-21).
"""
import json
import sys


def main() -> int:
    payload = sys.argv[1] if len(sys.argv) > 1 else "{}"
    try:
        data = json.loads(payload) if payload else {}
    except json.JSONDecodeError:
        data = {}
    handle = data.get("handle", "") or ""
    display_name = data.get("display_name", "") or ""
    display_name = display_name.replace("\n", " ").replace("\r", " ")
    try:
        ts = int(data.get("last_messaged_at", 0) or 0)
    except (TypeError, ValueError):
        ts = 0
    print(f"handle={handle}")
    print(f"display_name={display_name}")
    print(f"last_messaged_at={ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
