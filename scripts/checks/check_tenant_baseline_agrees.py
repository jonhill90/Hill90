#!/usr/bin/env python3
"""The tenant's copy of our container list must still match ours.

    TENANT_BASELINE=<path> python3 scripts/checks/check_tenant_baseline_agrees.py
    python3 scripts/checks/check_tenant_baseline_agrees.py <path>

WHY THIS EXISTS, AND WHY HERE. hill90-app checks after every deploy that this
platform's containers are present BY NAME, because its own step called "Hill90
baseline unchanged" ran only `docker ps --filter health=unhealthy` — and a
container that has VANISHED is not unhealthy, it is absent, which is precisely
what a baseline check exists to catch (hill90-app#176).

To do that the tenant had to COPY our list of names. Deriving it from our compose
files at deploy time was deliberately rejected on their side: a tenant reading
the platform's internals is a tenancy-boundary question, not a convenience.

So the list now lives in two repositories. This check is the one that compares
them, and it belongs HERE because THIS repo is the one that changes the number.
The tenant cannot know its copy has gone stale — by construction, the staleness
is caused by a commit it never sees (Hill90#699, hill90-app#177).

IT MUST FAIL IN BOTH DIRECTIONS. A container we REMOVE makes the tenant assert a
name that will never appear again: loud, and it would be noticed. A container we
ADD is the dangerous one — the tenant's list simply lacks it, every check on that
side still passes, and nothing anywhere reports that a new platform service is
unmonitored by the tenant. Silent agreement with a stale list is the failure this
exists to prevent, so a GAIN is a failure here exactly as a LOSS is.

DERIVING OUR OWN SIDE IS FINE. Reading our compose files is this repo reading its
own internals, which is what makes the asymmetry legitimate: we derive, they
copy, and this check reconciles.

Exit codes:
  0  the two lists agree
  1  they disagree — every difference named, in both directions
  2  CANNOT COMPARE (tenant file missing, unreadable or empty; or our own set
     came out empty). Never a pass: a check that cannot see the thing it
     compares must not report agreement, which is the rule this estate has
     re-learned in six other places.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_DIR = ROOT / "deploy/compose/prod"

# A container declared with `restart: "no"` that runs a one-shot command is not
# part of the running baseline. openbao-init chowns a directory and exits; the
# tenant would never see it in `docker ps`, so demanding it would make their
# check fail forever.
ONE_SHOT_RESTART = {'"no"', "'no'", "no"}


def platform_containers() -> set[str]:
    """The long-lived containers this platform declares, by name."""
    names: set[str] = set()
    for path in sorted(COMPOSE_DIR.glob("*.yml")):
        text = path.read_text()
        # Service blocks are two-space indented under `services:`. Walk them so a
        # container_name can be paired with its own restart policy rather than
        # with the file's.
        for block in re.split(r"\n(?=  [A-Za-z0-9_.-]+:\n)", text):
            m = re.search(r"^\s*container_name:\s*(\S+)", block, re.M)
            if not m:
                continue
            raw = m.group(1)
            # Names are written as ${CONTAINER_PREFIX:-}foo. The prefix defaults
            # to empty and is empty in production; strip the interpolation so the
            # comparison is against what actually appears in `docker ps`.
            name = re.sub(r"\$\{[^}]*\}", "", raw).strip().strip('"').strip("'")
            if not name:
                continue
            r = re.search(r"^\s*restart:\s*(\S+)", block, re.M)
            if r and r.group(1) in ONE_SHOT_RESTART:
                continue
            names.add(name)
    return names


def tenant_containers(path: Path) -> set[str]:
    names = set()
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        names.add(line)
    return names


def main() -> int:
    raw = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TENANT_BASELINE", "")
    if not raw:
        print(
            "::error::No tenant baseline supplied. Pass a path or set TENANT_BASELINE. "
            "NOTHING WAS COMPARED, which is not agreement.",
            file=sys.stderr,
        )
        return 2

    tenant_path = Path(raw)
    if not tenant_path.is_file():
        print(
            f"::error::Tenant baseline not readable at {tenant_path}. NOTHING WAS COMPARED — "
            "this is not a pass. The file lives in hill90-app at "
            "scripts/checks/hill90-platform-baseline.txt.",
            file=sys.stderr,
        )
        return 2

    ours = platform_containers()
    if not ours:
        print(
            f"::error::No container_name entries found under {COMPOSE_DIR}. Refusing to "
            "report agreement against an empty platform set — this check would pass "
            "vacuously if the compose layout moved.",
            file=sys.stderr,
        )
        return 2

    theirs = tenant_containers(tenant_path)
    if not theirs:
        print(
            f"::error::Tenant baseline {tenant_path} lists no names. NOTHING WAS COMPARED.",
            file=sys.stderr,
        )
        return 2

    we_added = sorted(ours - theirs)
    we_removed = sorted(theirs - ours)

    if not we_added and not we_removed:
        print(f"Tenant baseline agrees: {len(ours)} containers, both lists identical.")
        return 0

    print(
        f"::error::TENANT BASELINE IS STALE: this platform declares {len(ours)} containers, "
        f"the tenant's copy lists {len(theirs)}.",
        file=sys.stderr,
    )
    if we_added:
        print(
            "  WE ADDED, and the tenant does not know: " + ", ".join(we_added),
            file=sys.stderr,
        )
        print(
            "    This is the silent direction. The tenant's check still passes; it simply\n"
            "    never asserts these, so a new platform container is unmonitored by them.",
            file=sys.stderr,
        )
    if we_removed:
        print(
            "  WE REMOVED, and the tenant still expects: " + ", ".join(we_removed),
            file=sys.stderr,
        )
        print(
            "    Their deploy will fail on a container we deliberately took away.",
            file=sys.stderr,
        )
    print(
        "  Fix: update hill90-app/scripts/checks/hill90-platform-baseline.txt in the same\n"
        "  change that moved the number here, and say why in that commit.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
