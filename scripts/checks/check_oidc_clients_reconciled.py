#!/usr/bin/env python3
"""Every OIDC client the repo REFERENCES must be created by something on the deploy path.

WHY THIS EXISTS — AND WHAT IT IS NOT
====================================

It is NOT a fix for a present break. It was written after a report that a VPS
rebuild would produce a realm without the `grafana` and `portainer` clients,
because `platform/auth/keycloak/platform-realm.json` declares only
`hill90-vault`, `hill90-ui` and `hill90-api`, and `start --import-realm` is
IGNORE_EXISTING against an existing realm.

That premise was checked and does not hold. `scripts/keycloak.sh apply` already
reconciles `grafana`, `portainer`, `minio` and `hill90-vault` from SOPS via
`ensure_client`, and `scripts/deploy.sh` runs `keycloak.sh apply` on the auth
deploy — which `deploy.sh all` reaches, which is what the disaster-recovery
runbook runs. The realm JSON being short is therefore survivable: the reconcile,
not the import, is what puts those clients in an existing realm.

WHAT WOULD MAKE IT TRUE is the regression this guards: someone adds a fifth OIDC
integration — another `*_CLIENT_ID=` in a compose file, another service wired to
Keycloak — and does not add a matching `ensure_client` call. Then the realm JSON
is inert, nothing on the deploy path creates that client, and the integration
fails on a rebuilt host while looking fine on the running one. Nothing else in
this repository would catch it: the compose file is valid, the deploy succeeds,
and SSO for that one service simply never works after a rebuild.

HOW IT DECIDES
==============

Referenced   parsed from deploy/compose/prod/*.yml and scripts/*.sh — the places
             that name a client id to authenticate WITH.
Provisioned  parsed from scripts/keycloak.sh: `ensure_client "<id>"` (the
             platform path) plus the ids cmd_tenant_clients creates.
Declared     clientIds in platform-realm.json — enough for a from-nothing realm,
             and deliberately NOT enough on its own for an existing one.

A referenced client passes if it is provisioned OR declared. It fails if it is
neither, because then nothing puts it in the realm.

Both sides are PARSED, never hardcoded. A hardcoded expectation would keep
passing after someone renamed a client, which is the failure this whole file is
about.

Usage: check_oidc_clients_reconciled.py [keycloak.sh] [platform-realm.json]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Client ids the repo authenticates WITH. Each pattern is anchored on the
# specific setting rather than on a bare word, so a mention in prose or a
# comment cannot be mistaken for a dependency.
REFERENCE_PATTERNS = [
    # Grafana, MinIO and anything else following the *_CLIENT_ID= convention.
    re.compile(r"^\s*-?\s*(?:GF_AUTH_GENERIC_OAUTH|MINIO_IDENTITY_OPENID)_CLIENT_ID=([A-Za-z0-9._-]+)", re.M),
    # Portainer's API payload: "ClientID": "portainer"
    re.compile(r'"ClientID"\s*:\s*"([A-Za-z0-9._-]+)"'),
    # vault.sh: oidc_client_id="hill90-vault"
    re.compile(r'oidc_client_id="([A-Za-z0-9._-]+)"'),
]

# Interpolated values cannot be resolved statically; a client id that is a
# variable is out of scope rather than silently treated as a literal.
INTERPOLATED = re.compile(r"[$\{]")


def referenced(root: Path) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    files = sorted(root.glob("deploy/compose/prod/*.yml")) + sorted(root.glob("scripts/*.sh"))
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        for pat in REFERENCE_PATTERNS:
            for m in pat.finditer(text):
                cid = m.group(1)
                if INTERPOLATED.search(cid):
                    continue
                found.setdefault(cid, []).append(f.relative_to(root).as_posix())
    return found


def provisioned(keycloak_sh: Path) -> set[str]:
    text = keycloak_sh.read_text(encoding="utf-8", errors="replace")
    ids = set(re.findall(r'^\s*ensure_client\s+"([A-Za-z0-9._-]+)"', text, re.M))
    # cmd_tenant_clients creates these directly rather than through ensure_client.
    ids |= set(re.findall(r'client_uuid\s+"([A-Za-z0-9._-]+)"', text))
    return ids


def declared(realm_json: Path) -> set[str]:
    data = json.loads(realm_json.read_text(encoding="utf-8"))
    return {c.get("clientId") for c in data.get("clients", []) if c.get("clientId")}


def main() -> int:
    keycloak_sh = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "scripts/keycloak.sh"
    realm_json = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "platform/auth/keycloak/platform-realm.json"

    for p in (keycloak_sh, realm_json):
        if not p.is_file():
            print(f"FAIL — missing input: {p}", file=sys.stderr)
            return 1

    refs = referenced(ROOT)
    prov = provisioned(keycloak_sh)
    decl = declared(realm_json)

    if not refs:
        # A zero-reference result is indistinguishable from every pattern having
        # rotted, and would pass vacuously. Refuse instead.
        print("FAIL — no client references found at all. The patterns no longer match "
              "anything, which is a broken check, not a clean estate.", file=sys.stderr)
        return 1

    missing = {cid: where for cid, where in refs.items() if cid not in prov and cid not in decl}

    for cid in sorted(refs):
        how = "ensure_client" if cid in prov else ("realm.json" if cid in decl else "NOTHING")
        mark = "ok  " if cid not in missing else "FAIL"
        print(f"  {mark} {cid:<16} referenced by {', '.join(sorted(set(refs[cid])))}  ->  provisioned by {how}")

    print(f"\n{len(refs)} referenced client(s); {len(prov)} provisioned by keycloak.sh; {len(decl)} declared in the realm JSON.")

    if missing:
        print("\nFAIL — referenced but created by nothing on the deploy path:", file=sys.stderr)
        for cid, where in sorted(missing.items()):
            print(f"  {cid}  (referenced by {', '.join(sorted(set(where)))})", file=sys.stderr)
        print("\nAdd an ensure_client call in scripts/keycloak.sh. Declaring it in\n"
              "platform-realm.json alone is NOT enough: start --import-realm is\n"
              "IGNORE_EXISTING, so that file is inert against a realm that already exists.",
              file=sys.stderr)
        return 1

    print("PASS — every referenced OIDC client is created on the deploy path.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
