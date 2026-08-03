#!/usr/bin/env python3
"""No consumer's role mapping may name a legacy realm role.

    python3 scripts/checks/check_role_mappings_repointed.py

WHY THIS EXISTS. Stage 2a (#637) repointed Grafana's `role_attribute_path` from
the zero-holder realm role `admin` to `platform-admin` — and repointed only that
ARM of the expression. The `editor` arm was left naming another zero-holder role,
and the env var read as though the work was done. #666 found it two days later.

A half-repointed expression is worse than an unrepointed one, because it looks
finished. And Grafana's failure mode is silent by construction:
`role_attribute_strict` defaults to false, so an arm matching nothing does not
error — the JMESPath falls through to the last term. No log line, no failed
login. Nothing would ever have reported it.

WHAT IT CHECKS. Every realm role name appearing in a consumer's role-mapping
configuration must be in the platform-* scheme. The legacy four — admin, user,
editor, viewer — are being removed precisely because they have no holders, so a
mapping that still names one authorises nobody.

It deliberately does NOT check holders; that needs a live Keycloak and belongs to
the deletion change. This is the static half: it runs on every pull request and
fails before a half-repoint can merge.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

LEGACY = {"admin", "user", "editor", "viewer"}

# Where a realm role name can appear as a MAPPING TARGET. Each entry is a file
# and a regex whose captures are role names the consumer authorises on.
SITES = [
    (
        "deploy/compose/prod/docker-compose.observability.yml",
        "Grafana role_attribute_path",
        re.compile(r"GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH=(.*)"),
        re.compile(r"realm_access\.roles\[\*\],\s*'([^']+)'"),
    ),
    (
        "scripts/vault.sh",
        "OpenBao admin-sso bound_claims",
        re.compile(r'"bound_claims":\s*\{[^}]*\}'),
        re.compile(r'"realm_roles":\s*\[([^\]]*)\]'),
    ),
]


def main() -> int:
    problems: list[str] = []
    checked = 0

    print("Consumer role mappings must name platform-* roles")
    print("=================================================")

    for rel, label, line_re, role_re in SITES:
        path = ROOT / rel
        if not path.exists():
            problems.append(f"{rel} is missing — this check cannot see {label}")
            continue
        text = path.read_text()
        found_any = False
        for m in line_re.finditer(text):
            found_any = True
            roles = []
            for rm in role_re.finditer(m.group(0)):
                roles += [r.strip().strip('"\'') for r in rm.group(1).split(",") if r.strip()]
            if not roles:
                continue
            checked += 1
            bad = sorted(set(roles) & LEGACY)
            status = "MISS" if bad else "ok  "
            print(f"  {status}  {label}: {', '.join(roles)}")
            if bad:
                problems.append(
                    f"{rel}: {label} still names legacy role(s) {', '.join(bad)}. "
                    f"Those have zero holders, so that arm authorises nobody — and "
                    f"because role_attribute_strict defaults to false it fails silently."
                )
        if not found_any:
            # A site that stops matching is a check that stopped checking.
            problems.append(
                f"{rel}: no {label} found. Either it moved, or this check has gone "
                f"blind — which is the same failure it exists to prevent."
            )

    print()
    if problems:
        print(f"FAIL — {len(problems)} problem(s):\n")
        for p in problems:
            print(f"  {p}")
        return 1
    print(f"PASS — {checked} mapping(s) checked, none names a legacy realm role")
    return 0


if __name__ == "__main__":
    sys.exit(main())
