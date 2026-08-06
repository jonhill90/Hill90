#!/usr/bin/env python3
"""A secret stored in two repositories, under two names, must still agree.

    python3 scripts/checks/check_shared_secret_agrees.py \\
        --label testuser01 \\
        --this-file infra/secrets/prod.enc.env --this-key TEST_USER_PASSWORD \\
        --other-file tenant/infra/secrets/test-accounts.enc.env --other-key TESTUSER01_PASSWORD

WHY THIS EXISTS (Hill90#839). testuser01's Keycloak password lives here as
TEST_USER_PASSWORD (infra/secrets/prod.enc.env) and in hill90-app as
TESTUSER01_PASSWORD (infra/secrets/test-accounts.enc.env) — two repositories,
two key names, nothing linking them. hill90-app#588 rotated it, updated only
its own store, and the next observability deploy's Grafana-role login check
failed an hour later because it reads THIS repo's copy. The rotation PR was
correct on its own terms; the consumer was in a different repository under a
different name, and nothing compared them (repaired in #838).

CHECKED AND RULED OUT AS THE SAME SHAPE: this same script's account map also
carries `jon -> JON_KC_PASSWORD` and `hill90admin -> HILL90ADMIN_KC_PASSWORD`.
hill90-app's stores (infra/secrets/prod.enc.env, test-accounts.enc.env) were
read directly and carry no equivalent key for either — only TESTUSER01_PASSWORD
exists there. So this is one duplicated account, not three; jon and hill90admin
are single-sourced in this repository and out of scope for this check.

WHY A SHARED KEY, NOT A SHARED SECRET COMPARISON SERVICE. Both repositories'
prod stores encrypt to the SAME age recipient (hill90-app's own
infra/secrets/.sops.yaml says so explicitly: "this repository's SOPS_AGE_KEY
GitHub secret therefore holds a key that can also decrypt Hill90's store" —
one age key per host, deliberately, per that file's own comment). Verified
directly against the VPS before relying on it: the single key at
/opt/hill90/secrets/keys/keys.txt decrypts both
/opt/hill90/infra/secrets/prod.enc.env and
/opt/hill90-app/infra/secrets/test-accounts.enc.env. That means THIS repo's
existing SOPS_AGE_KEY secret is already sufficient to decrypt a checked-out
copy of hill90-app's store — no new cross-repo credential, matching
option 2's stated appeal (works across the repo boundary without new
infrastructure) — checked rather than assumed, since the issue's own author
noted a different preferred option (app#579) turned out to violate a written
invariant on the same day.

HASHES, NOT RAW VALUES, IN EVERY MESSAGE THIS SCRIPT PRINTS. The two
plaintexts are compared directly (there is no security benefit to hashing
before an in-process comparison — both are already in memory) but never
appear in any print/log line, only their sha256 prefix, so a stray debug
line or CI log scrape cannot leak the credential itself.

Exit codes:
  0  the two stores agree — same non-empty value
  1  DIVERGED — both decrypted, both non-empty, and they differ
  2  CANNOT COMPARE (a file is missing, sops failed, or a value decrypted
     empty). Never a pass: a check that cannot read one side must not
     report agreement — the exact shape this estate keeps closing.
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def secrets_agree(a: str, b: str) -> bool:
    """Pure comparison: both must be non-empty AND equal. Never true on
    either side being empty — an unset/undecryptable value is not agreement,
    it is the absence of information, and this function must not launder
    that into a pass."""
    if not a or not b:
        return False
    return hash_secret(a) == hash_secret(b)


def decrypt(path: Path, key: str) -> tuple[str | None, str]:
    """Returns (value, error). value is None if decryption failed or the
    key decrypted to an empty string — both are failures, not distinguished
    further, since either way there is nothing to compare."""
    if not path.is_file():
        return None, f"{path} does not exist"
    proc = subprocess.run(
        ["sops", "-d", "--extract", f'["{key}"]', str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "no stderr"
        return None, f"sops could not decrypt {key} from {path}: {stderr}"
    value = proc.stdout.strip()
    if not value:
        return None, f"{key} decrypted to an empty value in {path}"
    return value, ""


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--label", required=True, help="account name, for messages only")
    p.add_argument("--this-file", required=True, type=Path)
    p.add_argument("--this-key", required=True)
    p.add_argument("--other-file", required=True, type=Path)
    p.add_argument("--other-key", required=True)
    args = p.parse_args()

    this_value, this_err = decrypt(args.this_file, args.this_key)
    other_value, other_err = decrypt(args.other_file, args.other_key)

    if this_value is None or other_value is None:
        print(
            f"::error::CANNOT COMPARE {args.label}'s password across repositories. "
            "This is NOT agreement — a check that cannot read one side must not report a pass.",
            file=sys.stderr,
        )
        if this_err:
            print(f"  this repo ({args.this_key} in {args.this_file}): {this_err}", file=sys.stderr)
        if other_err:
            print(f"  other repo ({args.other_key} in {args.other_file}): {other_err}", file=sys.stderr)
        return 2

    if secrets_agree(this_value, other_value):
        print(f"{args.label}: agrees across repositories (sha256 {hash_secret(this_value)[:12]}...).")
        return 0

    print(
        f"::error::{args.label}'s password has DIVERGED between repositories. "
        f"{args.this_key} in {args.this_file} does not match {args.other_key} in {args.other_file} "
        f"(sha256 {hash_secret(this_value)[:12]}... vs {hash_secret(other_value)[:12]}...). "
        "One side was rotated without the other — see Hill90#839.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
