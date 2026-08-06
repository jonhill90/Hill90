#!/usr/bin/env bats
#
# h#747: cleanup-branches.sh has no `set -e` (unlike every sibling script
# swept the same day), and its two `git push` call sites — the one
# write-shaped, irreversible operation in the file — trusted the exit code
# of nothing. A rejected ref, a network blip, or a permission error fell
# straight through to an unconditional "Deleted N branch(es)." or "Done...
# now reversible", identical to what a genuine success prints.
#
# These tests force a REAL git push rejection (a bare repo with a
# pre-receive hook that refuses everything) rather than mocking git, so the
# assertion is against the actual exit-status/output shape a real failure
# produces, not an assumption about what git does.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  UPSTREAM="$BATS_TEST_TMPDIR/upstream.git"
  WORK="$BATS_TEST_TMPDIR/work"

  git init --bare -q "$UPSTREAM"
  git init -q "$WORK"
  git -C "$WORK" config user.email test@example.com
  git -C "$WORK" config user.name test
  echo hi > "$WORK/f.txt"
  git -C "$WORK" add f.txt
  git -C "$WORK" commit -q -m init
  git -C "$WORK" remote add origin "$UPSTREAM"
  git -C "$WORK" push -q origin HEAD:refs/heads/main

  git -C "$WORK" branch test-branch-a
  git -C "$WORK" branch test-branch-b
  git -C "$WORK" push -q origin test-branch-a test-branch-b
  # `git push` alone does not update the pusher's own refs/remotes/* — the
  # script's git rev-parse -q --verify "refs/remotes/${REMOTE}/${b}" checks
  # need a fetch to have populated them, exactly as a real clone would have.
  git -C "$WORK" fetch -q origin
}

reject_all_pushes() {
  cat > "$UPSTREAM/hooks/pre-receive" <<'EOF'
#!/bin/sh
echo "rejected by test hook — simulated remote rejection" >&2
exit 1
EOF
  chmod +x "$UPSTREAM/hooks/pre-receive"
}

@test "delete_batch: a real push rejection is reported as failure, not printed as success" {
  reject_all_pushes

  run bash -c "
    cd '$WORK'
    REMOTE=origin
    YES=true
    source '$ROOT/scripts/cleanup-branches.sh' help --yes >/dev/null 2>&1
    cd '$WORK'
    delete_batch 'TEST' test-branch-a test-branch-b
  "

  [ "$status" -ne 0 ]
  [[ "$output" != *'Deleted 2 branch(es).'* ]]
  [[ "$output" == *'may NOT have been deleted'* ]]

  # The branches must genuinely still be on the remote — the push really
  # failed, this isn't just a message change with the delete going through.
  run git ls-remote "$UPSTREAM" refs/heads/test-branch-a
  [ -n "$output" ]
  run git ls-remote "$UPSTREAM" refs/heads/test-branch-b
  [ -n "$output" ]
}

@test "delete_batch: a real successful push still reports success and actually deletes" {
  run bash -c "
    cd '$WORK'
    REMOTE=origin
    YES=true
    source '$ROOT/scripts/cleanup-branches.sh' help --yes >/dev/null 2>&1
    cd '$WORK'
    delete_batch 'TEST' test-branch-a test-branch-b
  "

  [ "$status" -eq 0 ]
  [[ "$output" == *'Deleted 2 branch(es).'* ]]

  run git ls-remote "$UPSTREAM" refs/heads/test-branch-a
  [ -z "$output" ]
  run git ls-remote "$UPSTREAM" refs/heads/test-branch-b
  [ -z "$output" ]
}

@test "cmd_tag_unmerged: a real push rejection refuses the 'now reversible / safe' claim" {
  reject_all_pushes

  run bash -c "
    cd '$WORK'
    REMOTE=origin
    source '$ROOT/scripts/cleanup-branches.sh' help --yes >/dev/null 2>&1
    cd '$WORK'
    CATEGORY_C=(test-branch-a)
    cmd_tag_unmerged
  "

  [ "$status" -ne 0 ]
  [[ "$output" != *'delete-unmerged is safe.'* ]]
  [[ "$output" == *'NOT yet reversible'* ]]
}

@test "cmd_delete_safe: a failed batch A is not masked by a successful batch B" {
  # The exact silent-partial-success shape: two independent delete_batch
  # calls with no status aggregation meant a caller checking only the final
  # exit code could see 0 even though the first batch's push failed.
  reject_all_pushes

  run bash -c "
    cd '$WORK'
    REMOTE=origin
    source '$ROOT/scripts/cleanup-branches.sh' help --yes >/dev/null 2>&1
    cd '$WORK'
    CATEGORY_A=(test-branch-a)
    CATEGORY_B=()
    cmd_delete_safe
  "

  [ "$status" -ne 0 ]

  run git ls-remote "$UPSTREAM" refs/heads/test-branch-a
  [ -n "$output" ]
}

@test "STATIC: both git push call sites check their own exit status" {
  run bash -c "grep -A3 'git push \"\$REMOTE\" --tags' '$ROOT/scripts/cleanup-branches.sh' | grep -F 'return 1'"
  [ "$status" -eq 0 ]
  run bash -c "grep -B1 -A4 'git push \"\$REMOTE\" \"\${refs\[@\]}\"' '$ROOT/scripts/cleanup-branches.sh' | grep -F 'return 1'"
  [ "$status" -eq 0 ]
}
