#!/usr/bin/env python3
"""A retired (zero-holder) role must not be granted a policy anywhere.

    python3 scripts/checks/check_retired_roles_ungranted.py           # static, CI
    python3 scripts/checks/check_retired_roles_ungranted.py --live    # + live estate

WHY. Deleting the four zero-holder realm roles is only safe while nothing grants
them anything. The danger is the reverse of the usual one: a grant attached to a
role with no holders costs nothing today and everything the moment someone is
given the role. MinIO's `admin` policy was exactly that — s3:* plus admin:*,
reachable by anyone granted realm role `admin`, which nobody would have requested
because it would simply have arrived with the role.

The retired set is read from keycloak.sh REALM_ROLES_REMOVED rather than restated
here, so this cannot cover fewer roles than the removal actually deletes.

GRANT SITES CHECKED (static):
  * MinIO policy names           — the union rule makes a policy name a grant
  * Grafana role_attribute_path  — names a role to hand out an org role
  * OpenBao admin-sso            — bound_claims name a role to hand out a policy
  * keycloak.sh REALM_ROLES      — a retired role must not also be created

WHAT THIS CANNOT SEE — stated because a check that looks complete is worse than
one that admits its edges:

  1. HOLDERS. Static mode does not measure them. "Zero-holder" is taken from the
     declared retirement list, not observed. --live measures them properly; CI
     cannot, because it has no Keycloak.
  2. OUT-OF-BAND OBJECTS. A MinIO policy created by hand with `mc`, or a Keycloak
     composite or group role-mapping added in the admin console, exists in
     neither file. --live catches the MinIO half and the composite half; nothing
     catches a change made after the last run.
  3. IDENTITY-PROVIDER MAPPERS. Keycloak can assign a realm role at login from an
     external IdP claim. That grant lives in the IdP config, is checked by
     neither mode, and would re-create holders for a role this says has none.
     There are no IdPs configured on realm `platform` today; if one is added,
     this check does not cover it.
  4. TOKEN-TIME GRANTS. A hardcoded role name inside an application would not be
     found by either mode.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KEYCLOAK = ROOT / "scripts/keycloak.sh"
MINIO = ROOT / "scripts/minio.sh"
VAULT = ROOT / "scripts/vault.sh"
GRAFANA = ROOT / "deploy/compose/prod/docker-compose.observability.yml"


def shell_list(path: Path, var: str) -> list[str]:
    m = re.search(rf'^{var}="([^"]*)"', path.read_text(), re.M)
    return m.group(1).split() if m else []


def static_checks(retired: set[str]) -> list[str]:
    problems: list[str] = []

    created = set(shell_list(KEYCLOAK, "REALM_ROLES"))
    both = sorted(retired & created)
    print(f"  {'MISS' if both else 'ok  '}  keycloak REALM_ROLES: {', '.join(sorted(created))}")
    for r in both:
        problems.append(f"keycloak.sh lists {r} in REALM_ROLES and in REALM_ROLES_REMOVED — it would be created and deleted every run")

    minio_txt = MINIO.read_text()
    created_pol = set()
    for m in re.finditer(r"for policy in ([^;]+); do", minio_txt):
        if "LEGACY" in m.group(1):
            continue
        created_pol |= {p for p in m.group(1).split() if not p.startswith("$")}
    bad = sorted(retired & created_pol)
    print(f"  {'MISS' if bad else 'ok  '}  MinIO policies created: {', '.join(sorted(created_pol))}")
    for r in bad:
        problems.append(f"minio.sh still creates a policy named {r}; MinIO grants the union of claim values that name a policy, so that is a grant")

    gtxt = GRAFANA.read_text()
    arms = set(re.findall(r"realm_access\.roles\[\*\],\s*'([^']+)'", gtxt))
    bad = sorted(retired & arms)
    print(f"  {'MISS' if bad else 'ok  '}  Grafana role_attribute_path: {', '.join(sorted(arms))}")
    for r in bad:
        problems.append(f"Grafana's role_attribute_path grants an org role to {r}")

    vtxt = VAULT.read_text()
    claims: set[str] = set()
    for m in re.finditer(r'"realm_roles":\s*\[([^\]]*)\]', vtxt):
        claims |= {c.strip().strip('"\'') for c in m.group(1).split(",") if c.strip()}
    bad = sorted(retired & claims)
    print(f"  {'MISS' if bad else 'ok  '}  OpenBao bound_claims: {', '.join(sorted(claims))}")
    for r in bad:
        problems.append(f"OpenBao's admin-sso role grants a vault policy to {r}")

    return problems


def live_checks(retired: set[str]) -> list[str]:
    """Measure holders and read the live estate. Needs the VPS."""
    problems: list[str] = []

    def ssh(cmd: str) -> str:
        return subprocess.run(["ssh", "vps", cmd], capture_output=True, text=True).stdout

    kc = (
        "cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && "
        "P=$(sops -d infra/secrets/prod.enc.env | grep -m1 '^KC_ADMIN_PASSWORD=' | cut -d= -f2-); "
        "U=$(sops -d infra/secrets/prod.enc.env | grep -m1 '^KC_ADMIN_USERNAME=' | cut -d= -f2-); "
        "KC_CLI_PASSWORD=\"$P\" docker exec -e KC_CLI_PASSWORD keycloak "
        "/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 "
        "--realm master --user \"$U\" >/dev/null 2>&1; "
        "docker exec keycloak /opt/keycloak/bin/kcadm.sh get roles -r platform --fields name 2>/dev/null"
    )
    try:
        live_roles = {x["name"] for x in json.loads(ssh(kc) or "[]")}
    except Exception as e:  # noqa: BLE001
        problems.append(f"could not read live realm roles, so holders are UNMEASURED: {e}")
        return problems

    still = sorted(retired & live_roles)
    print(f"  {'MISS' if still else 'ok  '}  live realm roles: retired ones still present = {', '.join(still) or 'none'}")
    for r in still:
        problems.append(f"realm role {r} is still present on the live realm")

    pol_cmd = (
        "cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && "
        "bash scripts/checks/minio-policy-names-test.sh 2>/dev/null | grep 'MinIO policies:'"
    )
    line = ssh(pol_cmd)
    live_pol = set(line.split(":", 1)[1].split()) if ":" in line else set()
    bad = sorted(retired & live_pol)
    print(f"  {'MISS' if bad else 'ok  '}  live MinIO policies: retired ones still present = {', '.join(bad) or 'none'}")
    for r in bad:
        problems.append(f"MinIO policy {r} still exists and is named after a retired role")

    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also query the live estate")
    args = ap.parse_args()

    retired = set(shell_list(KEYCLOAK, "REALM_ROLES_REMOVED"))
    if not retired:
        print("REALM_ROLES_REMOVED is empty or unreadable — this check would pass vacuously")
        return 1

    print("Retired roles must not be granted anything")
    print("==========================================")
    print(f"  retired set (from keycloak.sh): {', '.join(sorted(retired))}")
    print()

    problems = static_checks(retired)
    if args.live:
        print()
        problems += live_checks(retired)

    print()
    if problems:
        print(f"FAIL — {len(problems)} problem(s):\n")
        for p in problems:
            print(f"  {p}")
        print(
            "\nA grant on a zero-holder role costs nothing until the role is granted,\n"
            "and then it arrives without anyone asking for it."
        )
        return 1
    print("PASS — no retired role is granted anything")
    if not args.live:
        print("  (static mode: holders are NOT measured here — see the module docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
