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


def main() -> int:
    body = os.environ.get("PR_BODY", "")

    matches = list(PATTERN.finditer(body))

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
