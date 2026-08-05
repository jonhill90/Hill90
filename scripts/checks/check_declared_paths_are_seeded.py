#!/usr/bin/env python3
"""Every vault path a service declares must be one the seed actually writes.

    python3 scripts/checks/check_declared_paths_are_seeded.py

WHY THIS EXISTS. `vault_paths_for_service` in scripts/_common.sh is what deploy
time reads a service's secrets from. `cmd_seed` in scripts/vault.sh is what puts
them there. Nothing tied the two together, and they drifted for months:

  #495  removed Keycloak and Postgres, and with them the seed blocks for
        secret/shared/database and secret/auth/config. Correct at the time.
  #531  brought both services back and restored their DECLARATIONS — but not
        the seed. From then on `db` and `auth` pointed at paths that had never
        existed on the live vault.

That is the 404 underneath the 2026-08-03 auth outage. The missing AppRole policy
(#660) produced a 403 on top of it, so every diagnosis stopped at the 403 and the
absent data was never reached. Fixing the policy alone changed "permission
denied" into "No value found" — a different error and an identical outcome.

The same shape has now cost this estate three separate defects: one list
enumerating something a second list must match, with nothing checking. The policy
files were the first (#653), the seed is this one. So this check exists as much
for the NEXT pair as for these two.

Exit 0 if every declared path is seeded.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMMON = ROOT / "scripts/_common.sh"
VAULT = ROOT / "scripts/vault.sh"


def declared_paths() -> dict[str, list[str]]:
    """Parse the case arms of vault_paths_for_service()."""
    body = COMMON.read_text()
    m = re.search(r"vault_paths_for_service\(\)\s*\{(.*?)\n\}", body, re.S)
    if not m:
        sys.exit("could not find vault_paths_for_service() in scripts/_common.sh")

    out: dict[str, list[str]] = {}
    for arm in re.finditer(r"^\s*([a-z0-9_|]+)\)\s*echo\s+\"([^\"]*)\"", m.group(1), re.M):
        service, paths = arm.group(1), arm.group(2).split()
        if service == "*" or not paths:
            continue
        for name in service.split("|"):
            out[name] = paths
    return out


def seeded_paths() -> set[str]:
    """Paths cmd_seed actually writes.

    Matches `kv put secret/...` invocations only. A path named in a comment or
    echoed as advice is not a write — the same distinction that made
    check_root_revoke_fails_closed.py misread a summary step as a revoke.
    """
    body = VAULT.read_text()
    m = re.search(r"^cmd_seed\(\)\s*\{(.*?)^\}", body, re.S | re.M)
    if not m:
        sys.exit("could not find cmd_seed() in scripts/vault.sh")

    lines = [
        ln for ln in m.group(1).splitlines()
        if not ln.lstrip().startswith(("#", "echo", "printf"))
    ]
    return set(re.findall(r"kv put\s+(secret/\S+)", "\n".join(lines)))


def required_keys() -> set[str]:
    body = VAULT.read_text()
    m = re.search(r"local required_keys=\((.*?)\)", body, re.S)
    return set(m.group(1).split()) if m else set()


def seeded_keys(path: str) -> set[str]:
    """The KEY NAMES a given kv put writes. Names only — this never touches a value."""
    body = VAULT.read_text()
    m = re.search(rf"kv put\s+{re.escape(path)}\s+((?:.|\n)*?)(?=\n\n|\n    [a-z#])", body)
    if not m:
        return set()
    return set(re.findall(r"\"([A-Z0-9_]+)=", m.group(1)))


def main() -> int:
    declared = declared_paths()

    # h#730: declared_paths() returning empty is indistinguishable from every
    # case arm in vault_paths_for_service() having rotted out of the regex,
    # and would pass vacuously — "every declared path is seeded" having
    # checked zero of them. Refuse instead, matching the sibling check this
    # one is modelled on: check_oidc_clients_reconciled.py's identical guard
    # on `refs` a few lines into its own main().
    if not declared:
        print("FAIL — no declared paths found at all. The pattern no longer matches "
              "anything in vault_paths_for_service(), which is a broken check, not a "
              "clean estate.", file=sys.stderr)
        return 1

    seeded = seeded_paths()
    required = required_keys()

    problems: list[str] = []
    all_declared: set[str] = set()

    print("Declared vault paths must be seeded")
    print("===================================")
    for service in sorted(declared):
        for path in declared[service]:
            all_declared.add(path)
            ok = path in seeded
            print(f"  {'ok  ' if ok else 'MISS'}  {service:<14} {path}")
            if not ok:
                problems.append(
                    f"service {service!r} declares {path} but cmd_seed never writes it — "
                    f"the role will authenticate, be authorised, and read nothing"
                )

    # The reverse direction is not an error, but it is worth surfacing: a seeded
    # path no service declares is dead weight, and dead weight is where the next
    # stale credential hides.
    orphans = sorted(seeded - all_declared)

    # A seeded key that is not in required_keys can be written BLANK, because
    # get_secret returns "" for an absent key and `kv put K=` accepts it. That is
    # the CF_DNS_API_TOKEN failure mode the seed already documents.
    unguarded: list[str] = []
    for path in sorted(seeded):
        for key in sorted(seeded_keys(path)):
            if key not in required:
                unguarded.append(f"{path} writes {key}, which is not in required_keys")

    print()
    if orphans:
        print(f"  note: seeded but declared by no service: {', '.join(orphans)}")
    for u in unguarded:
        problems.append(u + " — an absent key seeds as an empty string")

    if problems:
        print(f"\nFAIL — {len(problems)} problem(s):\n")
        for p in problems:
            print(f"  {p}")
        print(
            "\nA declared-but-unseeded path is invisible until something reads it, and\n"
            "then it looks like a vault fault rather than a missing write."
        )
        return 1

    print("\nPASS — every declared path is seeded, and every seeded key is guarded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
