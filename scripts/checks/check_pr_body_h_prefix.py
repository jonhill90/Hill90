#!/usr/bin/env python3
"""A PR body closing keyword followed by 'h#NNN' never closes the issue.

    PR_BODY="$body" python3 scripts/checks/check_pr_body_h_prefix.py

WHY. This repo's own convention prefixes issue references with 'h#' in prose
(e.g. "h#844's fix"), which reads fine and is fine — GitHub just doesn't
parse "h#123" as an issue reference at all, closing keyword or not; it wants
a bare "#123" (or "owner/repo#123"). That's harmless everywhere except one
place: a PR body's own closing-keyword line ("Closes h#844"), where a human
reading it sees a closed issue and GitHub silently does nothing. Nobody
notices, because both the check runner and the PR author read the same text
and see intent, not GitHub's literal parser.

This is not hypothetical — a live scan of every merged PR (2026-08-07) found
it in 20 merged PRs total; 18 were later closed by hand and 2 (h#786, h#844)
sat open for hours to days on nothing but this, indistinguishable in the
issue tracker from real unfinished work. h#844 in particular needed a full
independent re-verification pass to confirm nothing was actually left to do
before it could safely be called resolved — exactly the cost this check
exists to stop paying repeatedly.

Deliberately narrow: this does NOT ban 'h#NNN' in prose, which is this
repo's normal and correct way to reference an issue outside a closing
line — only 'h#NNN' sitting directly after a GitHub closing keyword
(close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved), where the
'h#' silently defeats the auto-close GitHub would otherwise perform on plain
'#NNN'. A check that flagged every 'h#NNN' anywhere would be wrong on its
own terms — it would make people stop writing 'h#NNN' in prose, where nothing
is broken, to dodge a check that was never actually about prose.

A PR body has to be able to DISCUSS the bad pattern without being accused of
using it — this check's own introducing PR (h#864) quoted "Closes h#844" in
backticks as its own positive-control evidence and failed its own CI on
itself, a better positive control than anything either of us wrote by hand.
So fenced code blocks (```...```) and inline code spans (`...`) are blanked
out before matching — a quoted or fenced example of the defect is not the
defect.
"""

from __future__ import annotations

import os
import re
import sys

# GitHub's own closing-keyword set: close/closes/closed, fix/fixes/fixed,
# resolve/resolves/resolved. Keyword, optional colon, then either same-line
# whitespace or a single newline (not a blank-line paragraph break) before
# 'h#NNN'. The single-newline-not-double distinction matters: it is what
# keeps a markdown heading like "## What this fixes" followed, paragraphs
# later, by unrelated prose that happens to mention "h#NNN" from being
# flagged as a closing-keyword usage it never was.
PATTERN = re.compile(
    r"\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?(?:[ \t]+|\n(?!\n))h#(\d+)",
    re.IGNORECASE,
)

# Fenced blocks first (so a stray single backtick inside one can't be misread
# as the start of an inline span once the fence itself is blanked), then
# inline spans. Blanked with same-length whitespace, not removed, so a
# keyword right before a fence and 'h#NNN' right after it can never end up
# adjacent to each other by the deletion itself.
FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def _blank(match: re.Match[str]) -> str:
    return " " * len(match.group(0))


def _strip_code(text: str) -> str:
    text = FENCE_RE.sub(_blank, text)
    text = INLINE_CODE_RE.sub(_blank, text)
    return text


def main() -> int:
    body = os.environ.get("PR_BODY", "")
    scannable = _strip_code(body)

    matches = list(PATTERN.finditer(scannable))

    if not matches:
        print(
            f"PR body h#-prefix check passed: no closing keyword followed by "
            f"'h#NNN' found ({len(body)} chars scanned)."
        )
        return 0

    print("PR body h#-prefix check FAILED.")
    print()
    print(
        "GitHub does not parse 'h#NNN' as an issue reference — only '#NNN' "
        "(or 'owner/repo#NNN') closes an issue. The following closing-keyword "
        "usage will silently fail to close its issue:"
    )
    print()
    for m in matches:
        keyword, issue_num = m.group(1), m.group(2)
        snippet = body[m.start() : m.end()].replace("\n", "\\n")
        print(f"  {snippet!r} -> write '{keyword} #{issue_num}' instead")
    print()
    print(
        "'h#NNN' in prose elsewhere in the body (not right after a closing "
        "keyword) is fine and unaffected by this check."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
