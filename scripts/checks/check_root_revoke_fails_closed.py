#!/usr/bin/env python3
"""A run that mints a root token must revoke it even when it fails.

    python3 scripts/checks/check_root_revoke_fails_closed.py

WHY THIS EXISTS. Run 30791332461 dispatched vault-regain-root with
revoke_root_at_end=true, failed at the final verification step, and left a VALID
root token on the production host. The revoke was not attempted-and-failed; it
was never attempted. Its condition read

    if: ${{ inputs.revoke_root_at_end }}

and a custom `if:` does NOT replace GitHub's implicit success() — it is ANDed
with it unless the expression contains always(), failure() or cancelled(). So
the revoke ran only when nothing before it had failed, which inverts the intent:
the run that goes wrong is exactly the run you least want leaving a standing
root token.

The workflow already asserted that unauthenticated root generation was shut
again, and that assertion passed. Shutting the door and holding a key are
different things, and only one of them was checked.

WHAT THIS CHECKS, AND WHY IT SIMULATES RATHER THAN READS. Reading the YAML and
looking for `always()` would re-encode the same assumption that was wrong the
first time. Instead this models GitHub's skip rule once, in runs_after_failure()
below, and then DERIVES the answer: inject a failure at every step from the mint
onwards, and assert the revoke still executes in each case. If the rule is
modelled wrongly the control tests in tests/scripts/root-revoke-fails-closed-control.bats
catch it, because they mutate a copy and require this to go red.

The gated inputs are taken as TRUE: the property is "when the operator asks for
the token to be revoked, a failure cannot silently skip it". An operator who
passes revoke_root=false is choosing to keep the token and is not this check's
business.

Exit 0 if every root-minting workflow fails closed.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"

# Steps are identified by the vault.sh subcommand they invoke, not by their
# display name — a name is prose and gets edited, an invocation is behaviour.
MINT = ("vault.sh regain-root", "vault.sh init")
REVOKE = "vault.sh revoke-root"

# A step that verifies the token is actually gone. cmd_revoke_root already
# refuses to report success on a live token, but a workflow-level confirmation
# is what makes a failed revoke fail the RUN rather than a log line nobody reads.
CONFIRM_MARKERS = ("openbao-root.token", "root token is gone", "token lookup")

STATUS_FUNCTIONS = ("always(", "failure(", "cancelled(")

# A workflow may deliberately hand the root token to a human instead of revoking
# it — vault-reinitialize.yml does, and says "Deliberately not automated" for a
# stated reason. That is a decision, and this check has no business overturning
# it. But it must be DECLARED in the file, so that a workflow which simply forgot
# still fails. Silence is the failure; an explicit line is the exemption.
OPT_OUT = "ROOT-TOKEN-DISPOSAL: deliberate"


def runs_after_failure(cond) -> bool:
    """GitHub's rule, modelled in one place.

    A step with no `if:` carries an implicit success(). A step WITH an `if:`
    still carries it — the custom expression is ANDed with success() — unless
    the expression names a status function. That last clause is the whole bug.
    """
    if cond is None:
        return False
    return any(fn in str(cond) for fn in STATUS_FUNCTIONS)


def invocations(step: dict) -> str:
    """The commands a step RUNS, with prose stripped out.

    Necessary because these workflows end in a step that echoes the remaining
    manual steps into the job summary, and that prose names `vault.sh
    revoke-root`. Matching it read a instruction to a human as a revoke the
    workflow performs — a summary line is not an action, and counting it as one
    would have reported vault-reinitialize.yml as revoking a token it never
    touches. Caught by inspecting the first red run rather than trusting it.
    """
    body = str(step.get("run", ""))
    lines = [
        ln
        for ln in body.splitlines()
        if not ln.lstrip().startswith(("echo", "printf", "#"))
    ]
    return "\n".join(lines)


def step_text(step: dict) -> str:
    """Everything that identifies a step, for the confirmation heuristics."""
    return " ".join(str(step.get(k, "")) for k in ("name", "uses", "with")) + "\n" + invocations(step)


def simulate(steps: list[dict], fail_at: int) -> set[int]:
    """Which step indices execute, given the step at fail_at fails?

    Steps before it already ran. It ran, and failed. Everything after runs only
    if its condition survives a failed job status.
    """
    executed = set(range(fail_at + 1))
    for i in range(fail_at + 1, len(steps)):
        if runs_after_failure(steps[i].get("if")):
            executed.add(i)
    return executed


def audit(path: Path) -> list[str]:
    raw = path.read_text()
    doc = yaml.safe_load(raw)
    problems: list[str] = []
    opted_out = OPT_OUT in raw

    for job_name, job in (doc.get("jobs") or {}).items():
        steps = job.get("steps") or []
        texts = [step_text(s) for s in steps]
        runs = [invocations(s) for s in steps]

        mints = [i for i, t in enumerate(runs) if any(m in t for m in MINT)]
        if not mints:
            continue
        mint = mints[0]

        revokes = [i for i, t in enumerate(runs) if REVOKE in t]
        if not revokes:
            if opted_out:
                continue
            problems.append(
                f"{path.name}:{job_name} mints a root token at step {mint + 1} "
                f"({steps[mint].get('name')!r}) and never revokes it. If that is "
                f"intended, say so in the file with a comment containing "
                f"{OPT_OUT!r} and the reason."
            )
            continue
        revoke = revokes[0]

        # THE PROPERTY. Fail at each step from the mint onwards; the revoke must
        # still execute every time.
        for fail_at in range(mint, len(steps)):
            if fail_at >= revoke:
                # A failure at or after the revoke cannot skip it.
                continue
            if revoke not in simulate(steps, fail_at):
                problems.append(
                    f"{path.name}:{job_name} step {fail_at + 1} "
                    f"({steps[fail_at].get('name')!r}) fails "
                    f"-> step {revoke + 1} ({steps[revoke].get('name')!r}) is SKIPPED, "
                    f"leaving a live root token. Its condition is "
                    f"{steps[revoke].get('if')!r}; it needs always()."
                )
                break  # one report per job is enough; the cause is the condition

        # A revoke that is never verified at the workflow level can fail quietly.
        confirms = [
            i
            for i, t in enumerate(texts)
            if i > revoke and any(m in t.lower() for m in CONFIRM_MARKERS)
        ]
        if not confirms:
            problems.append(
                f"{path.name}:{job_name} revokes at step {revoke + 1} but never "
                f"confirms the token is dead afterwards"
            )
        else:
            for c in confirms:
                if not runs_after_failure(steps[c].get("if")):
                    problems.append(
                        f"{path.name}:{job_name} step {c + 1} "
                        f"({steps[c].get('name')!r}) confirms the token is gone but is "
                        f"skipped on failure — the confirmation disappears exactly when "
                        f"it matters. Its condition is {steps[c].get('if')!r}."
                    )
    return problems


def main() -> int:
    files = sorted(WORKFLOWS.glob("*.yml"))
    if not files:
        print(f"no workflows found under {WORKFLOWS}")
        return 1

    problems: list[str] = []
    minting: list[str] = []
    for f in files:
        try:
            doc = yaml.safe_load(f.read_text())
        except yaml.YAMLError as e:
            print(f"FAIL — {f.name} is not valid YAML: {e}")
            return 1
        if not isinstance(doc, dict):
            continue
        mints_here = any(
            any(m in invocations(s) for m in MINT)
            for job in (doc.get("jobs") or {}).values()
            for s in (job.get("steps") or [])
        )
        if mints_here:
            minting.append(f.name)
        problems.extend(audit(f))

    print("Root-token cleanup must survive a failed run")
    print("===========================================")
    print(f"  workflows that mint a root token: {', '.join(minting) or 'none'}")
    print()

    if problems:
        print(f"FAIL — {len(problems)} problem(s):\n")
        for p in problems:
            print(f"  {p}")
        print(
            "\nA custom `if:` is ANDed with success(). To run after a failure the\n"
            "expression must name always(), failure() or cancelled(). This is not a\n"
            "style point: it is how run 30791332461 left root live on production."
        )
        return 1

    print("PASS — every root-minting workflow revokes and verifies on failure")
    return 0


if __name__ == "__main__":
    sys.exit(main())
