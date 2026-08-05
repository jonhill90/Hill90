#!/usr/bin/env python3
"""A host-checkout cleanup must not run when the copy-back it depends on failed.

WHY
===

Three workflows (vault-init.yml, vault-reinitialize.yml, vault-sync-to-sops.yml)
each run `scripts/vault.sh store-unseal-key`/`sync-to-sops` on the VPS, which
writes fresh secret material (a new unseal key, a sync token, synced values)
into the host's LOCAL, uncommitted copy of `infra/secrets/prod.enc.env`. The
very next step scp's that file back to the runner so it can be committed — the
whole point being, per vault-init.yml's own comment, "the key must survive
loss of the host". The step after THAT reverts the host's local checkout with
`git checkout -- infra/secrets/prod.enc.env`, so the host doesn't sit there
permanently modified between runs.

That revert step was `if: always()`, unconditionally — including when the
copy-back that was supposed to capture the new secret material never
succeeded (a network blip mid-scp, or the post-copy decrypt/length check
failing). In that case the host's copy — the only place the freshly-written
secret existed before the copy-back — gets discarded before anyone had a
durable copy of it. Not silent: the copy-back step's own failure stays visible
in the job log. But it destroys RECOVERABLE STATE the run existed to produce,
during exactly the disaster-recovery scenarios these workflows are for.

WHAT IS ACTUALLY ASSERTED
==========================

For each workflow, find any step whose `run:` block invokes
`git checkout -- infra/secrets/prod.enc.env` (the revert). Walk backward to
the nearest preceding step whose `run:` invokes `scp` of that same file FROM
the VPS (the copy-back). The revert step's own `if:` condition must reference
that copy-back step's `id` and `outcome` — evidence that the revert is gated
on the copy-back not having failed, not run unconditionally via a bare
`always()`. (`outcome != 'failure'` is accepted, not just `== 'success'`,
because vault-sync-to-sops.yml's copy-back step is itself conditional and can
legitimately be SKIPPED — the revert should still run in that case, since
`sync-to-sops` may have re-encrypted the host's file with no drift to
preserve.)

A revert step with no preceding copy-back step at all, or a copy-back step
with no `id:` to reference, is also a failure — there is nothing to gate on.

Exit 0 if every revert step is gated. Exit 1, naming the ungated step,
otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"

STEP = re.compile(r"^(\s*)-\s+name:\s*(.+?)\s*$")
STEP_ID = re.compile(r"^\s*id:\s*([A-Za-z0-9_.\-]+)\s*$")
STEP_IF = re.compile(r"^\s*if:\s*(.+?)\s*$")
REVERT_INVOCATION = re.compile(r"git\s+checkout\s+--\s+infra/secrets/prod\.enc\.env")
COPYBACK_INVOCATION = re.compile(
    r"scp\s.*deploy@.*:/opt/hill90/app/infra/secrets/prod\.enc\.env\s+.*infra/secrets/prod\.enc\.env",
    re.DOTALL,
)
# Accepts `steps.<id>.outcome == 'success'` or `!= 'failure'`, in any
# combination with `always()` (e.g. `always() && steps.copy.outcome != 'failure'`).
GATED_ON_OUTCOME = re.compile(
    r"steps\.([A-Za-z0-9_.\-]+)\.outcome\s*(==\s*'success'|!=\s*'failure')"
)


def parse_steps(text: str):
    """[(name, id_or_None, if_or_None, body_text)] in file order, one job or
    the whole file if `jobs:` boundaries don't matter here — cleanup/copy-back
    pairs live in the same job in all three files this check covers, so job
    splitting (unlike check_vault_revoke_order.py) is not needed."""
    out = []
    name = None
    step_id = None
    step_if = None
    buf: list[str] = []
    for line in text.splitlines():
        m = STEP.match(line)
        if m:
            if name is not None:
                out.append((name, step_id, step_if, "\n".join(buf)))
            name, step_id, step_if, buf = m.group(2), None, None, []
            continue
        idm = STEP_ID.match(line)
        if idm and step_id is None:
            step_id = idm.group(1)
        ifm = STEP_IF.match(line)
        if ifm and step_if is None:
            step_if = ifm.group(1)
        buf.append(line)
    if name is not None:
        out.append((name, step_id, step_if, "\n".join(buf)))
    return out


def check_workflow(path: Path) -> tuple[list[str], int]:
    """Returns (problems, revert steps found) — the count matters as much as
    the problems: a run that finds ZERO revert steps anywhere is not a clean
    estate, it is REVERT_INVOCATION's regex no longer matching a renamed or
    reshaped `git checkout` line, which would otherwise report a vacuous PASS
    having checked nothing. See main()'s CANNOT-DETERMINE guard."""
    problems = []
    reverts_found = 0
    steps = parse_steps(path.read_text(encoding="utf-8"))
    for i, (name, _step_id, step_if, body) in enumerate(steps):
        if not REVERT_INVOCATION.search(body):
            continue
        reverts_found += 1

        # Nearest preceding copy-back step.
        copyback_id = None
        for j in range(i - 1, -1, -1):
            prior_name, prior_id, _prior_if, prior_body = steps[j]
            if COPYBACK_INVOCATION.search(prior_body):
                if not prior_id:
                    problems.append(
                        f"{path.name}: revert step {name!r} follows copy-back step "
                        f"{prior_name!r}, but that copy-back step has no `id:` — "
                        f"there is nothing for the revert's `if:` to reference."
                    )
                    copyback_id = "<no-id>"
                else:
                    copyback_id = prior_id
                break
        if copyback_id is None:
            problems.append(
                f"{path.name}: revert step {name!r} has no preceding copy-back "
                f"(scp .../prod.enc.env) step in this file — nothing to gate on."
            )
            continue
        if copyback_id == "<no-id>":
            continue  # already reported above

        if not step_if:
            problems.append(
                f"{path.name}: revert step {name!r} has no `if:` condition at all — "
                f"it runs unconditionally, including when {copyback_id!r} failed."
            )
            continue

        m = GATED_ON_OUTCOME.search(step_if)
        if not m or m.group(1) != copyback_id:
            problems.append(
                f"{path.name}: revert step {name!r}'s `if:` ({step_if!r}) does not "
                f"reference steps.{copyback_id}.outcome — a failed copy-back still "
                f"gets its host-side state discarded by this step."
            )
    return problems, reverts_found


# Known, current count of `git checkout -- infra/secrets/prod.enc.env` revert
# steps across the estate (vault-init.yml, vault-reinitialize.yml,
# vault-sync-to-sops.yml — one each). Not a ceiling: a workflow gaining a
# fourth is fine. A total that drops to ZERO is not — REVERT_INVOCATION's
# regex has gone blind, the same way check_declared_paths_are_seeded.py's
# regex did in h#730, and this must refuse rather than report a PASS having
# examined nothing.
MIN_EXPECTED_REVERTS = 1


def main() -> int:
    wfs = sorted(WORKFLOWS.glob("*.yml"))
    if not wfs:
        print("FAIL — no workflows found; the check would pass vacuously.", file=sys.stderr)
        return 1

    problems: list[str] = []
    total_reverts = 0
    for wf in wfs:
        wf_problems, wf_reverts = check_workflow(wf)
        problems += wf_problems
        total_reverts += wf_reverts

    if total_reverts < MIN_EXPECTED_REVERTS:
        print(
            "\nCANNOT DETERMINE — found zero `git checkout -- infra/secrets/"
            "prod.enc.env` revert steps across every workflow in this repo. "
            "Either every such step was genuinely removed (update "
            "MIN_EXPECTED_REVERTS and this message if so, deliberately), or "
            "REVERT_INVOCATION's regex no longer matches a renamed or "
            "reshaped revert line — which is a broken check, not a clean "
            "estate. A run that examined nothing does not get to claim a "
            "clean bill of health.",
            file=sys.stderr,
        )
        return 2

    if problems:
        print("\nFAIL — a host-checkout revert can discard un-captured secret material:\n", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    print("PASS — every host-checkout revert is gated on its copy-back step's outcome.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
