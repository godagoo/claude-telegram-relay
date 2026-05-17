#!/usr/bin/env python3
"""Normalize raw chat.db rows into relay iMessage context JSON.

Newer macOS Messages rows often keep the visible body in `attributedBody`
while `message.text` is NULL. The relay must decode that body before drafting,
otherwise it silently falls back to older text-bearing rows and produces stale
context.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any


CLASS_MARKERS = (
    "NSAttributedString",
    "NSMutableAttributedString",
    "NSMutableString",
    "NSString",
    "NSObject",
    "NSDictionary",
    "NSNumber",
    "NSValue",
    "NSData",
    "__kIM",
    "streamtyped",
    "bplist",
)


def _clean_text(value: str) -> str:
    value = value.replace("\ufffc", " ")
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def _looks_like_metadata(value: str) -> bool:
    return any(marker in value for marker in CLASS_MARKERS)


def decode_attributed_body(hex_value: str | None) -> str:
    """Best-effort decode of Messages' streamtyped NSAttributedString blob."""

    if not hex_value:
        return ""

    try:
        data = bytes.fromhex(hex_value)
    except ValueError:
        return ""

    candidates: list[str] = []
    search_from = 0
    while True:
        marker = data.find(b"\x84\x01+", search_from)
        if marker < 0:
            break

        length_pos = marker + 3
        if length_pos >= len(data):
            break

        length = data[length_pos]
        start = length_pos + 1
        end = start + length
        if length > 0 and end <= len(data):
            text = _clean_text(data[start:end].decode("utf-8", errors="ignore"))
            if text and not _looks_like_metadata(text):
                candidates.append(text)

        search_from = marker + 1

    if candidates:
        return candidates[0]

    # Conservative fallback for archive variants that do not match the length
    # marker above. Keep class names and plist fragments out of prompts.
    for match in re.finditer(
        rb"[\x20-\x7E\xC2-\xF4][\x09\x0A\x0D\x20-\x7E\x80-\xBF\xC2-\xF4]{2,}",
        data,
    ):
        text = _clean_text(match.group(0).decode("utf-8", errors="ignore"))
        if text and not _looks_like_metadata(text):
            return text

    return ""


def normalize_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if int(row.get("associated_message_type") or 0) != 0:
            continue

        text = _clean_text(str(row.get("text") or ""))
        if not text:
            text = decode_attributed_body(row.get("attributed_body_hex"))
        if not text:
            continue

        normalized.append(
            {
                "id": row.get("id"),
                "sender": row.get("sender"),
                "ts": row.get("ts"),
                "text": text,
            }
        )
        if len(normalized) >= limit:
            break

    return normalized


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: imessage-normalize-messages.py RESOLVED_RECIPIENT LIMIT", file=sys.stderr)
        return 64

    resolved = sys.argv[1]
    try:
        limit = max(1, min(50, int(sys.argv[2])))
    except ValueError:
        print("error: LIMIT must be an integer", file=sys.stderr)
        return 64

    raw = sys.stdin.read().strip()
    rows = json.loads(raw) if raw else []
    if not isinstance(rows, list):
        rows = []

    print(json.dumps({"resolved": resolved, "messages": normalize_rows(rows, limit)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
