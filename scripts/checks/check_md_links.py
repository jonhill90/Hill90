#!/usr/bin/env python3
"""Validate local Markdown links in repository-owned docs."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCAN_ROOTS = [
    ROOT / "README.md",
    ROOT / "CONTRIBUTING.md",
    ROOT / "docs",
    ROOT / ".github",
]
IGNORE_SEGMENTS = {"node_modules", ".git"}
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


def should_scan(path: Path) -> bool:
    return path.suffix == ".md" and not any(segment in IGNORE_SEGMENTS for segment in path.parts)


def iter_md_files() -> list[Path]:
    files: list[Path] = []
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        if root.is_file() and should_scan(root):
            files.append(root)
            continue
        for path in root.rglob("*.md"):
            if should_scan(path):
                files.append(path)
    return sorted(set(files))


def is_external(link: str) -> bool:
    return link.startswith(("http://", "https://", "mailto:", "#"))


def resolve_target(source: Path, link: str) -> Path:
    if link.startswith("/"):
        return ROOT / link.lstrip("/")
    return (source.parent / link).resolve()


def main() -> int:
    missing: list[tuple[Path, int, str]] = []

    md_files = iter_md_files()
    # h#734: the same 0==0 trap check_destructive_commands.sh had — if every
    # entry in SCAN_ROOTS stops existing (a directory renamed or moved),
    # iter_md_files() returns [], `missing` stays empty, and this printed
    # "no missing local links found" having scanned nothing. Same fix shape:
    # count what was actually examined, and refuse to call zero of them a
    # clean pass.
    if not md_files:
        print(
            f"CANNOT DETERMINE: none of {', '.join(str(r) for r in SCAN_ROOTS)} "
            "exist — nothing was scanned. Run this from the repository root."
        )
        return 2

    for md_file in md_files:
        text = md_file.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in LINK_RE.finditer(line):
                raw_link = match.group(1).strip()
                if not raw_link or is_external(raw_link):
                    continue

                # Strip optional title (e.g. 'path "title"') and anchor
                link_path = raw_link.split(" ", 1)[0].split("#", 1)[0]
                if not link_path:
                    continue

                target = resolve_target(md_file, link_path)
                if not target.exists():
                    missing.append((md_file.relative_to(ROOT), line_no, raw_link))

    if missing:
        print("Missing local markdown links:")
        for file_path, line_no, link in missing:
            print(f"- {file_path}:{line_no} -> {link}")
        print(f"\nTotal missing links: {len(missing)}")
        return 1

    print(f"Markdown link check passed: no missing local links found ({len(md_files)} files scanned).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
