#!/usr/bin/env python3
"""Vault-based contact fallback.

PR3.5 audit #4 (Codex 2026-05-21). When the AddressBook resolver returns
no match, the relay should consult the user's vault before falling back
to message-text search. Per-contact notes live at:

    $RELAY_OBSIDIAN_VAULT_DIR/02-Cross-Project/people/<slug>.md

(default vault root: ~/ObsidianVault). Each note has YAML frontmatter
that may include `handle:` (phone in E.164 or an email). This helper:

    1. slugifies the user-typed alias (lowercase, kebab, strip punctuation)
    2. opens 02-Cross-Project/people/<slug>.md
    3. parses just enough of the frontmatter to extract `handle`
    4. prints the handle (or empty string) to stdout

Exit 0 always. Empty output means "no fallback available, keep going to
the message-text path."

Intentionally minimal:
    - no external YAML dependency (we parse a single string field)
    - no fuzzy matching (audit asked for simplest deterministic fallback
      first); users who want fuzzy lookup can add multiple slug files
    - no local-search or local-rag MCP usage (those are Claude-session
      tools, not callable from the relay subprocess runtime)
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

DEFAULT_VAULT_ROOT = "~/ObsidianVault"
PEOPLE_SUBPATH = "02-Cross-Project/people"


def slugify(alias: str) -> str:
    """Match the slug convention used by src/vault-writer.ts:slugifyContact
    so a note created by the vault writer is the same file looked up here."""
    lowered = alias.strip().lower()
    # Replace any run of non-alphanumeric (other than hyphens) with a hyphen,
    # collapse runs, strip leading/trailing hyphens.
    kebab = re.sub(r"[^a-z0-9]+", "-", lowered)
    kebab = re.sub(r"-+", "-", kebab).strip("-")
    return kebab


def _vault_root() -> Path:
    raw = os.environ.get("RELAY_OBSIDIAN_VAULT_DIR", "") or DEFAULT_VAULT_ROOT
    return Path(raw).expanduser()


def _read_frontmatter_handle(path: Path) -> str:
    """Return the `handle:` value from the YAML frontmatter of `path`, or
    empty string if absent / unparseable. We don't import a YAML library
    so we can stay dependency-free; the field shape we accept is the
    common one:
        handle: +15551234567
        handle: "alice@example.com"
        handle: 'bob@example.com'
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    if not text.startswith("---"):
        return ""
    # Find the closing frontmatter delimiter.
    rest = text[3:]
    end = rest.find("\n---")
    if end == -1:
        return ""
    frontmatter = rest[:end]
    for raw_line in frontmatter.splitlines():
        line = raw_line.strip()
        if not line.startswith("handle"):
            continue
        # Accept "handle: value" or "handle:value" with optional quotes.
        m = re.match(r"^handle\s*:\s*(.*?)\s*$", line)
        if not m:
            continue
        value = m.group(1)
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        return value.strip()
    return ""


def lookup(alias: str) -> str:
    if not alias.strip():
        return ""
    slug = slugify(alias)
    if not slug:
        return ""
    path = _vault_root() / PEOPLE_SUBPATH / f"{slug}.md"
    if not path.exists():
        return ""
    return _read_frontmatter_handle(path)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 0
    handle = lookup(argv[1])
    if handle:
        sys.stdout.write(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
