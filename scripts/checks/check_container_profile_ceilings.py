#!/usr/bin/env python3
"""Does every live container_profiles row still fit under hill90-app's own
resource ceilings?

    python3 scripts/checks/check_container_profile_ceilings.py \\
        --max-cpus 4 --max-mem-bytes 16761118720 --max-pids-limit 300 \\
        --profiles-json '[{"name":"standard","default_cpus":"1.0", ...}]'

WHY THIS EXISTS (Hill90#845, split from hill90-app#598). hill90-app#593 added
MAX_AGENT_CPUS/MAX_AGENT_MEM_BYTES/MAX_AGENT_PIDS_LIMIT and a startup check,
containerProfileCeilingViolations(), that queries container_profiles on boot
and console.error()s a violation. Nothing reads that. hill90-app#598 asked
whether the api already exposes Prometheus metrics for this — checked
directly, it does not, and hill90-app#598 itself says do not build one
sideways for a single rare gauge. This is the alternative: piggyback on
Hill90's existing deploy-drift.yml, a scheduled workflow that already SSHes
into the VPS every four hours and already has a reader (Alertmanager email,
plus #712's scheduled-workflow-not-triggering watchdog) — reuse a machine
that already works rather than build a new one for this single condition.

WHERE THE CEILINGS COME FROM, NOT A HARDCODED COPY. MAX_AGENT_CPUS/
MAX_AGENT_MEM_BYTES/MAX_AGENT_PIDS_LIMIT live in hill90-app's
services/api/src/routes/agents.ts, a different repository. Typing three
numbers into THIS repo would be exactly the twin-drift shape this session
has already closed five times (h#839's shared-secret-agreement,
hill90-app#141/#153's resource-bound literals, among others) — a second copy
that can silently disagree with the first the moment either changes. The
caller (deploy-drift.yml) sparse-checks-out agents.ts and greps the three
`export const MAX_AGENT_*` lines directly out of the source on every run, so
this script always compares against whatever hill90-app's main branch
currently says, not a number typed here once and forgotten.

CANNOT-DETERMINE IS NOT A PASS (Hill90#845's own point, stated as a
constraint rather than left to chance). An unreachable host, a failed psql
query, or an EMPTY profiles list are not "zero violations" — they are
"nothing was checked". At least one profile (`standard`) has existed since
container_profiles was created (Hill90-app migration 032) and is seeded on
every fresh bootstrap, so an empty result here is itself suspicious, not a
clean state — treated as CANNOT DETERMINE, not PASS, same as an unauthenticated
`bao list` returning empty is not "no AppRoles" (app#791's own instrument
trap, the same shape one level over).

Exit codes:
  0  every profile fits under every ceiling
  1  ACTIONABLE — at least one profile's own default exceeds a ceiling,
     each one named
  2  CANNOT DETERMINE (a ceiling could not be parsed, the profiles JSON
     could not be parsed, or the profiles list came back empty). Never a
     pass: a check that cannot see the thing it compares must not report
     agreement.
"""
from __future__ import annotations

import argparse
import json
import re
import sys


def parse_mem_limit(raw: object) -> float | None:
    """Same shape as hill90-app's parseMemLimit/memLimitValidationError
    (services/api/src/services/docker.ts, services/api/src/routes/agents.ts)
    — bare bytes, or a number with a k/m/g unit, case-insensitive, optional
    trailing 'b'. Returns None (never raises) on anything that does not
    match, since a malformed value here is itself a finding, not a crash."""
    if not isinstance(raw, str):
        return None
    m = re.match(r'^(\d+(?:\.\d+)?)\s*([kmg]?)b?$', raw.strip(), re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1))
    unit = m.group(2).lower()
    multiplier = {'k': 1024, 'm': 1024 * 1024, 'g': 1024 * 1024 * 1024}.get(unit, 1)
    return value * multiplier


def parse_cpus(raw: object) -> float | None:
    if not isinstance(raw, str):
        return None
    m = re.match(r'^(\d+(?:\.\d+)?)$', raw.strip())
    if not m:
        return None
    return float(m.group(1))


def violations(
    profiles: list[dict],
    max_cpus: float,
    max_mem_bytes: float,
    max_pids_limit: int,
) -> list[dict]:
    """Pure comparison — no I/O, no exit codes, so it can be unit tested
    directly against a fabricated fixture without a live host or database."""
    found = []
    for p in profiles:
        name = p.get('name', '<unnamed>')

        cpus = parse_cpus(p.get('default_cpus'))
        if cpus is None:
            found.append({'profile': name, 'field': 'default_cpus',
                           'detail': f"unparseable value {p.get('default_cpus')!r}"})
        elif cpus > max_cpus:
            found.append({'profile': name, 'field': 'default_cpus',
                           'detail': f"{cpus} exceeds MAX_AGENT_CPUS={max_cpus}"})

        mem = parse_mem_limit(p.get('default_mem_limit'))
        if mem is None:
            found.append({'profile': name, 'field': 'default_mem_limit',
                           'detail': f"unparseable value {p.get('default_mem_limit')!r}"})
        elif mem > max_mem_bytes:
            found.append({'profile': name, 'field': 'default_mem_limit',
                           'detail': f"{mem:.0f} bytes exceeds MAX_AGENT_MEM_BYTES={max_mem_bytes}"})

        pids = p.get('default_pids_limit')
        if not isinstance(pids, int) or isinstance(pids, bool):
            found.append({'profile': name, 'field': 'default_pids_limit',
                           'detail': f"not an integer: {pids!r}"})
        elif pids > max_pids_limit:
            found.append({'profile': name, 'field': 'default_pids_limit',
                           'detail': f"{pids} exceeds MAX_AGENT_PIDS_LIMIT={max_pids_limit}"})
    return found


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--max-cpus', required=True, type=float)
    p.add_argument('--max-mem-bytes', required=True, type=float)
    p.add_argument('--max-pids-limit', required=True, type=int)
    p.add_argument('--profiles-json', required=True,
                    help='JSON array of {name, default_cpus, default_mem_limit, default_pids_limit}, '
                         'or the literal string "ERROR" if the caller could not read the table at all.')
    args = p.parse_args()

    if args.profiles_json.strip() == 'ERROR':
        print("::error::CANNOT DETERMINE: the caller could not read container_profiles at all "
              "(host unreachable, or the psql query failed). This is NOT a pass — nothing was compared.",
              file=sys.stderr)
        return 2

    try:
        profiles = json.loads(args.profiles_json)
    except json.JSONDecodeError as e:
        print(f"::error::CANNOT DETERMINE: --profiles-json did not parse as JSON ({e}). "
              "NOT a pass.", file=sys.stderr)
        return 2

    if not isinstance(profiles, list) or len(profiles) == 0:
        print("::error::CANNOT DETERMINE: container_profiles returned zero rows. "
              "The 'standard' profile is seeded on every bootstrap (migration 032) and has "
              "never legitimately been absent — an empty result means the query silently "
              "matched nothing, not that there is nothing to violate. NOT a pass.",
              file=sys.stderr)
        return 2

    found = violations(profiles, args.max_cpus, args.max_mem_bytes, args.max_pids_limit)

    print(f"Checked {len(profiles)} container_profiles row(s) against "
          f"MAX_AGENT_CPUS={args.max_cpus}, MAX_AGENT_MEM_BYTES={args.max_mem_bytes:.0f}, "
          f"MAX_AGENT_PIDS_LIMIT={args.max_pids_limit} (read live from hill90-app's own source).")

    if not found:
        print("No violations. Every profile fits under every ceiling.")
        return 0

    print(f"::error::{len(found)} CEILING VIOLATION(S):", file=sys.stderr)
    for v in found:
        print(f"  {v['profile']}.{v['field']}: {v['detail']}", file=sys.stderr)
    print(
        "A profile whose own default exceeds hill90-app's MAX_AGENT_* ceiling cannot "
        "safely have that default wired into agent creation — see hill90-app#593's "
        "\"not in this fix\" section. Fix the profile row, or raise the ceiling in "
        "agents.ts with a deliberate reason.",
        file=sys.stderr,
    )
    return 1


if __name__ == '__main__':
    sys.exit(main())
