#!/usr/bin/env python3
"""Validate local Markdown links in repository-owned docs."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCAN_ROOTS = [
    ROOT / "README.md",
    ROOT / "AGENTS.md",
    ROOT / "docs",
    ROOT / ".github",
    ROOT / ".claude",
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

    for md_file in iter_md_files():
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

    print("Markdown link check passed: no missing local links found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
