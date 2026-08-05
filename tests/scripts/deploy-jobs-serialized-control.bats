#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_deploy_jobs_serialized.py.
#
# Two of the mutations below are the workflow AS IT STOOD when each of the two
# 2026-08-05 failures happened, restored one at a time — so this control is
# anchored to what actually broke rather than to a rule invented afterwards.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_deploy_jobs_serialized.py" "$CTL/scripts/checks/"
  cp "$ROOT/.github/workflows/deploy.yml" "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_deploy_jobs_serialized.py"
  WF="$CTL/.github/workflows/deploy.yml"
}

@test "CONTROL: passes on the real tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: it counts the real jobs, not zero" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"the 5 deploy jobs form a single chain"* ]]
}

# RUN 31039334078, replayed: deploy-observability hanging off `changes` alone,
# which put it alongside deploy-db. Both started at 19:25:45Z and raced.
@test "observability parallel to the db chain — the git-race run — is caught" {
  python3 - "$WF" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["jobs"]["deploy-observability"]["needs"] = ["changes"]
yaml.safe_dump(d, open(p, "w"), sort_keys=False)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"can run at the same time"* ]]
  [[ "$output" == *"deploy-observability"* ]]
}

# RUN 31040415190, replayed: vault off `changes` alone, running beside the
# chain that restarts Keycloak underneath observability's login check.
@test "vault parallel to the chain — the Keycloak-restart run — is caught" {
  python3 - "$WF" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["jobs"]["deploy-vault"]["needs"] = ["changes"]
yaml.safe_dump(d, open(p, "w"), sort_keys=False)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"deploy-vault"* ]]
}

# A FORK is the case an eyeball check misses: both jobs have a `needs`, both
# look chained, and they still run together because neither needs the other.
@test "a fork — two jobs sharing an ancestor but not each other — is caught" {
  python3 - "$WF" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
# Both hang off deploy-db. Neither is reachable from the other.
d["jobs"]["deploy-vault"]["needs"] = ["changes", "deploy-db"]
d["jobs"]["deploy-observability"]["needs"] = ["changes", "deploy-db"]
d["jobs"]["deploy-auth"]["needs"] = ["changes", "deploy-db"]
d["jobs"]["deploy-minio"]["needs"] = ["changes", "deploy-auth"]
yaml.safe_dump(d, open(p, "w"), sort_keys=False)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
}

# Reordering while keeping ONE chain is allowed on purpose — the check asserts
# mutual exclusion, not a particular order. Without this test, a later reshuffle
# would be blocked by a check that was never meant to own the ordering.
@test "a different but still-serial order passes" {
  python3 - "$WF" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["jobs"]["deploy-vault"]["needs"] = ["changes"]
d["jobs"]["deploy-db"]["needs"] = ["changes", "deploy-vault"]
d["jobs"]["deploy-auth"]["needs"] = ["changes", "deploy-db"]
d["jobs"]["deploy-minio"]["needs"] = ["changes", "deploy-auth"]
d["jobs"]["deploy-observability"]["needs"] = ["changes", "deploy-minio"]
yaml.safe_dump(d, open(p, "w"), sort_keys=False)
PY

  run python3 "$CHECK"
  [ "$status" -eq 0 ]
}

# Blindness must not read as health.
@test "a workflow with no deploy-* jobs is CANNOT DETERMINE, not a pass" {
  python3 - "$WF" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["jobs"] = {"changes": d["jobs"]["changes"]}
yaml.safe_dump(d, open(p, "w"), sort_keys=False)
PY

  run python3 "$CHECK"
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
}

# WIRING, not logic (h#736/h#758).
@test "ci.yml genuinely invokes this check, not just mentions it" {
  run grep -n "run: python3 scripts/checks/check_deploy_jobs_serialized.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}
