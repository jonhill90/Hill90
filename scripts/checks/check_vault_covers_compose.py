#!/usr/bin/env python3
"""Vault must carry every secret a service's compose file needs.

    python3 scripts/checks/check_vault_covers_compose.py

WHY THIS EXISTS — an outage on 2026-08-03, caused by a deploy that reported
success. `deploy.sh` is vault-first: on the generic service path it exports ONLY
the keys vault returns for that service, and does not merge SOPS underneath. So
a variable the compose file needs but the vault path does not hold resolves to
the empty string, and compose substitutes nothing.

`secret/observability/grafana` held one key. Deploying observability therefore
started Grafana with GRAFANA_OIDC_CLIENT_SECRET empty, and SSO failed with
`unauthorized_client`. The deploy printed:

    vault: loaded 1 variables for observability, none empty

which is true and worthless — "none empty" describes the keys vault RETURNED,
not the keys the service NEEDS. Nothing was reported, and local admin login kept
working, so the failure was invisible from the outside.

WHAT IT CHECKS. For every prod compose file, take the ${VARS} it interpolates,
keep the ones that are SOPS-backed — that is the definition of a secret here,
taken from the store rather than from a hand-maintained list — and require each
to be written by cmd_seed into one of the paths the service declares.

Services that declare NO vault paths are skipped: since #655 vault_load_secrets
returns non-zero for them and the deploy takes the SOPS path, which has
everything. minio is deliberately in that category.

PRE-UP HOOKS ARE PART OF THE SURFACE, and leaving them out was this check's own
blind spot. It originally read compose files only. SMTP_PASSWORD never appears in
a compose file — it reaches Alertmanager through a config rendered by
render-alertmanager-config.sh — so the check passed green while every vault-path
observability deploy skipped the render (#669). A hook runs inside the same
exported environment as compose, so it is the same exposure.

This is the static half of #665. The runtime guard — refusing a deploy whose
resolved value is empty — is still wanted, because this cannot see a key that is
present in vault but blank.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_DIR = ROOT / "deploy/compose/prod"
COMMON = ROOT / "scripts/_common.sh"
VAULT = ROOT / "scripts/vault.sh"
STORE = ROOT / "infra/secrets/prod.enc.env"


def sops_key_names() -> set[str]:
    """KEY NAMES from the store. Names only — no value is bound or printed."""
    env = {"SOPS_AGE_KEY_FILE": str(ROOT / "infra/secrets/keys/age-prod.key")}
    import os

    for candidate in (env["SOPS_AGE_KEY_FILE"], "/opt/hill90/secrets/keys/keys.txt"):
        if Path(candidate).exists():
            env["SOPS_AGE_KEY_FILE"] = candidate
            break
    try:
        out = subprocess.run(
            ["sops", "-d", str(STORE)],
            capture_output=True, text=True, check=True,
            env=dict(os.environ, **env),
        ).stdout
    except Exception as e:  # noqa: BLE001
        sys.exit(f"cannot decrypt the store, so this check cannot run: {e}")
    return {m.group(1) for m in re.finditer(r"^([A-Z0-9_]+)=", out, re.M)}


def required_vars() -> dict[str, set[str]]:
    """The runtime guard's manifest, parsed from vault_required_vars_for_service.

    The manifest is what the RUNTIME guard enforces. If it under-declares, the
    guard passes a load that is missing exactly the variable nobody listed — the
    2026-08-03 failure with an extra step. So this compares it against what the
    compose file and pre-up hook actually interpolate.
    """
    body = COMMON.read_text()
    m = re.search(r"vault_required_vars_for_service\(\)\s*\{(.*?)\n\}", body, re.S)
    if not m:
        sys.exit("could not find vault_required_vars_for_service() in scripts/_common.sh")
    out: dict[str, set[str]] = {}
    for arm in re.finditer(r"^\s*([a-z0-9_|]+)\)\s*echo\s+\"([^\"]*)\"", m.group(1), re.M):
        service, vars_ = arm.group(1), set(arm.group(2).split())
        if service == "*" or not vars_:
            continue
        for name in service.split("|"):
            out[name] = vars_
    return out


def declared() -> dict[str, list[str]]:
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


def seeded_keys_by_path() -> dict[str, set[str]]:
    body = VAULT.read_text()
    m = re.search(r"^cmd_seed\(\)\s*\{(.*?)^\}", body, re.S | re.M)
    text = "\n".join(
        ln for ln in m.group(1).splitlines()
        if not ln.lstrip().startswith(("#", "echo", "printf"))
    )
    out: dict[str, set[str]] = {}
    for blk in re.finditer(r"kv put\s+(secret/\S+)((?:.|\n)*?)(?=\n\s*\n|kv put|\Z)", text):
        out.setdefault(blk.group(1), set()).update(re.findall(r'"([A-Z0-9_]+)=', blk.group(2)))
    return out


def hook_vars(service_compose: Path) -> tuple[str, set[str]]:
    """The pre-up hook for THIS service, and the $VARS it reads.

    Association is by case ARM, not by proximity. A first attempt searched a
    fixed window after the compose filename and attributed observability's
    alertmanager hook to auth, db, minio and vault — four false positives, caught
    by reading the first red run instead of trusting it. deploy.sh's dispatcher is
    a `case` whose arms end in `;;`, so the arm is the unit that means "this
    service", and a hook set in another arm is another service's.
    """
    dep = (ROOT / "scripts/deploy.sh").read_text()
    for arm in dep.split(";;"):
        if service_compose.name not in arm:
            continue
        m = re.search(r'pre_up_hook="([^"]+)"', arm)
        if not m:
            continue
        hook = ROOT / "scripts" / m.group(1)
        if not hook.exists():
            return m.group(1), set()
        return m.group(1), set(re.findall(r"\$\{?([A-Z][A-Z0-9_]{3,})", hook.read_text()))
    return "", set()


def main() -> int:
    secrets = sops_key_names()
    decl = declared()
    seeded = seeded_keys_by_path()
    required = required_vars()

    # declared()/required_vars() returning empty is indistinguishable from
    # every case arm in vault_paths_for_service()/vault_required_vars_for_
    # service() having rotted out of the regex, and would pass vacuously —
    # every real service reads as "declares no vault paths -> SOPS path,
    # which has all keys" and gets skipped before ever being compared,
    # printing PASS having checked nothing. Same guard as the sibling this
    # check shares its regex with, check_declared_paths_are_seeded.py (h#730),
    # which was hardened after this exact drift happened for real once.
    if not decl:
        print("FAIL — no declared vault paths found at all. The pattern no longer "
              "matches anything in vault_paths_for_service(), which is a broken "
              "check, not a clean estate.", file=sys.stderr)
        return 1
    if not required:
        print("FAIL — no required-vars entries found at all. The pattern no longer "
              "matches anything in vault_required_vars_for_service(), which is a "
              "broken check, not a clean estate.", file=sys.stderr)
        return 1

    problems: list[str] = []

    print("Vault must carry every secret the compose file needs")
    print("====================================================")

    for f in sorted(COMPOSE_DIR.glob("docker-compose.*.yml")):
        service = f.stem.replace("docker-compose.", "")
        needed = {v for v in re.findall(r"\$\{([A-Z0-9_]+)", f.read_text()) if v in secrets}

        # The pre-up hook runs in the SAME exported environment as compose, so a
        # variable it reads is exposed identically. ALERT_EMAIL_TO is excluded
        # because deploy.sh derives it from ACME_EMAIL, which IS checked.
        hook_name, hvars = hook_vars(f)
        hook_needed = {v for v in hvars if v in secrets}
        if hook_needed:
            print(f"  ....  {service:<14} pre-up hook {hook_name} reads {', '.join(sorted(hook_needed))}")
        needed |= hook_needed

        if not needed:
            continue
        paths = decl.get(service)
        if not paths:
            print(f"  skip  {service:<14} declares no vault paths -> SOPS path, which has all keys")
            continue
        have: set[str] = set()
        for p in paths:
            have |= seeded.get(p, set())
        # The runtime manifest must cover everything this service actually needs,
        # or the guard enforces an incomplete list.
        under = sorted(needed - required.get(service, set()))
        for k in under:
            problems.append(
                f"{service}: {k} is needed at runtime but is NOT in "
                f"vault_required_vars_for_service — the runtime guard would not "
                f"notice it missing"
            )

        missing = sorted(needed - have)
        print(f"  {'MISS' if missing else 'ok  '}  {service:<14} needs {len(needed)}, vault carries {len(needed) - len(missing)}")
        for k in missing:
            # Name the real consumer. A hook variable reported as "needed by the
            # compose file" sends the reader to the wrong file.
            where = f"pre-up hook {hook_name}" if k in hook_needed else f.name
            problems.append(
                f"{service}: {k} is needed by {where} and is in SOPS, but no vault path "
                f"the service declares ({', '.join(paths)}) carries it. The deploy will "
                f"export it EMPTY and report success."
            )

    print()
    if problems:
        print(f"FAIL — {len(problems)} problem(s):\n")
        for p in problems:
            print(f"  {p}")
        print(
            "\ndeploy.sh does not merge SOPS underneath vault on the generic path, so a\n"
            "key vault does not hold is a blank in the container, not a fallback."
        )
        return 1
    print("PASS — every SOPS-backed compose variable is carried by a declared vault path")
    return 0


if __name__ == "__main__":
    sys.exit(main())
