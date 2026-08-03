#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_tenant_baseline_agrees.py.
#
# The tenant copies our container list (hill90-app#176) because deriving it from
# our compose would have it reading our internals. That leaves the list in two
# repos, and this check is the one that compares them — here, because this repo
# is the one that changes the number.
#
# THE LOAD-BEARING CASES are the two that would otherwise be silent:
#   - we ADD a container and the tenant's copy simply lacks it. Their check keeps
#     passing; nothing anywhere says a new platform service is unmonitored.
#   - the tenant file cannot be read. Reporting agreement then would be agreeing
#     with a file we never opened.

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_tenant_baseline_agrees.py"
    TENANT="$BATS_TEST_TMPDIR/baseline.txt"
    # The real platform set, derived the same way the check does, so these tests
    # do not hardcode a number that will drift.
    OURS=$(cd "$(dirname "$CHECK")/../.." && python3 - <<'PY'
import re, pathlib
d = pathlib.Path("deploy/compose/prod")
names = set()
for p in sorted(d.glob("*.yml")):
    for block in re.split(r"\n(?=  [A-Za-z0-9_.-]+:\n)", p.read_text()):
        m = re.search(r"^\s*container_name:\s*(\S+)", block, re.M)
        if not m:
            continue
        r = re.search(r"^\s*restart:\s*(\S+)", block, re.M)
        if r and r.group(1).strip('"\'') == "no":
            continue
        names.add(re.sub(r"\$\{[^}]*\}", "", m.group(1)).strip().strip('"\''))
print("\n".join(sorted(n for n in names if n)))
PY
)
    printf '%s\n' "$OURS" > "$TENANT"
}

@test "agrees when the tenant's copy matches this platform" {
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"agrees"* ]]
}

@test "FIRES, and this is the silent direction: WE ADDED a container the tenant does not list" {
    # The tenant's check still passes in this state — it simply never asserts the
    # new name. Nothing but this reports it.
    printf '%s\n' "$OURS" | grep -Fxv traefik > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"WE ADDED"* ]]
    [[ "$output" == *"traefik"* ]]
}

@test "FIRES: WE REMOVED a container the tenant still expects" {
    printf '%s\nghost-service\n' "$OURS" > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"WE REMOVED"* ]]
    [[ "$output" == *"ghost-service"* ]]
}

@test "FIRES in both directions at once, and names both" {
    printf '%s\nghost-service\n' "$OURS" | grep -Fxv traefik > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"WE ADDED"* ]]
    [[ "$output" == *"traefik"* ]]
    [[ "$output" == *"WE REMOVED"* ]]
    [[ "$output" == *"ghost-service"* ]]
}

@test "NEVER A PASS: a tenant file that does not exist exits 2" {
    run python3 "$CHECK" "$BATS_TEST_TMPDIR/absent.txt"
    [ "$status" -eq 2 ]
    [[ "$output" == *"NOTHING WAS COMPARED"* ]]
}

@test "NEVER A PASS: no path supplied at all exits 2" {
    run env -u TENANT_BASELINE python3 "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"NOTHING WAS COMPARED"* ]]
}

@test "NEVER A PASS: a tenant file of only comments exits 2, not 0" {
    printf '# all comment\n\n' > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 2 ]
}

@test "the path can come from TENANT_BASELINE as well as argv" {
    run env TENANT_BASELINE="$TENANT" python3 "$CHECK"
    [ "$status" -eq 0 ]
}

@test "comments and blank lines in the tenant file are ignored, not treated as names" {
    { echo "# a header"; echo; printf '%s\n' "$OURS"; } > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 0 ]
}

@test "one-shot containers are excluded — openbao-init must not be demanded of the tenant" {
    # It is restart:"no" running a chown and exits, so it never appears in the
    # tenant's `docker ps`. Demanding it would fail their deploy forever.
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 0 ]
    [[ "$output" != *"openbao-init"* ]]
}

@test "names are compared exactly — a prefix does not satisfy a longer name" {
    # We declare postgres AND postgres-exporter. A substring comparison would
    # call the tenant's list agreeing when it is missing one of them.
    printf '%s\n' "$OURS" | grep -Fxv postgres > "$TENANT"
    run python3 "$CHECK" "$TENANT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"postgres"* ]]
}
