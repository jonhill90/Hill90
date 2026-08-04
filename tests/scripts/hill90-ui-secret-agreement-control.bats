#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/check_hill90_ui_secret_agreement.sh.
#
# A comparison that has only ever seen agreement has not been shown to notice
# disagreement. This is the scratch-copy proof: fabricated hashes, never
# production, one deliberately flipped per FAIL case — so this file is red
# on the exact defect the script exists to catch before the script is ever
# trusted to run unattended on a schedule.

CHECK=""

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_hill90_ui_secret_agreement.sh"
}

@test "AGREE: identical hashes exit 0" {
    run bash "$CHECK" "abc123def456" "abc123def456"
    [ "$status" -eq 0 ]
    [[ "$output" == *"AGREE"* ]]
}

@test "AGREE: a real-shaped sha256 pair still agrees" {
    h=$(printf 'the-same-secret' | sha256sum | cut -d' ' -f1)
    run bash "$CHECK" "$h" "$h"
    [ "$status" -eq 0 ]
}

@test "FAILS RED: one side flipped — this is the outage case" {
    # The scratch-copy proof: two hashes that would have come from a real
    # rotation of only one side. Nothing here touches Keycloak or app-ui.
    kc=$(printf 'keycloak-secret-v1' | sha256sum | cut -d' ' -f1)
    ui=$(printf 'app-ui-secret-v1-but-rotated' | sha256sum | cut -d' ' -f1)
    run bash "$CHECK" "$kc" "$ui"
    [ "$status" -eq 1 ]
    [[ "$output" == *"DISAGREE"* ]]
    [[ "$output" == *"outage"* ]]
}

@test "FAILS RED: a single differing character is still a disagreement" {
    run bash "$CHECK" "0081deadbeef" "0081deadbeee"
    [ "$status" -eq 1 ]
}

@test "CANNOT DETERMINE: the keycloak side missing exits 2, not 0 or 1" {
    run bash "$CHECK" "" "abc123"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CANNOT DETERMINE"* ]]
    [[ "$output" == *"NOT a pass"* ]]
}

@test "CANNOT DETERMINE: the app-ui side missing exits 2, not 0 or 1" {
    run bash "$CHECK" "abc123" ""
    [ "$status" -eq 2 ]
}

@test "CANNOT DETERMINE: both missing exits 2" {
    run bash "$CHECK" "" ""
    [ "$status" -eq 2 ]
}

@test "CANNOT DETERMINE: no arguments at all exits 2" {
    run bash "$CHECK"
    [ "$status" -eq 2 ]
}

@test "the failing message names the consequence, not just the fact" {
    run bash "$CHECK" "aaa" "bbb"
    [[ "$output" == *"every login will fail token exchange"* ]]
}

@test "CONTROL: exit codes are genuinely different states, not one collapsed into another" {
    run bash "$CHECK" "same" "same"
    agree_status="$status"
    run bash "$CHECK" "one" "two"
    disagree_status="$status"
    run bash "$CHECK" "" ""
    unknown_status="$status"

    [ "$agree_status" -ne "$disagree_status" ]
    [ "$agree_status" -ne "$unknown_status" ]
    [ "$disagree_status" -ne "$unknown_status" ]
}

@test "CONTROL: neither plaintext secret nor a script-internal value leaks into the output" {
    # The script only ever receives hashes, so this also guards against a
    # future edit accidentally threading a plaintext argument through.
    run bash "$CHECK" "abc123" "abc123"
    [[ "$output" != *"AUTH_KEYCLOAK_SECRET="* ]]
}
