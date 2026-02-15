---
description: "Bug fix workflow: reproduce, failing test, fix, verify, PR"
---

# Fix Bug: $DESCRIPTION

## Workflow

### 1. Reproduce

Understand the bug by:
- Reading the bug report or description
- Exploring the affected code with Read, Grep, Glob
- Identifying the root cause (not just symptoms)

### 2. Write a Failing Test

Use `tdd-red` (or write directly) to create a test that:
- Reproduces the exact bug condition
- Fails with the current code
- Will pass when the bug is fixed
- Lives in `tests/` following existing conventions

### 3. Fix the Bug

Use `tdd-green` (or fix directly) to:
- Make the minimum change to fix the bug
- Run the failing test to confirm it passes
- Run the full test suite to ensure no regressions

### 4. Refactor (if needed)

Use `tdd-refactor` if the fix reveals code that should be cleaned up. Keep tests green throughout.

### 5. Verify Locally

Run all relevant checks:
- `shellcheck --severity=error scripts/*.sh` (if shell scripts changed)
- `bats tests/scripts/` (if bats tests exist)
- `npm test` (if Node.js services changed)
- `pytest` (if Python services changed)

### 6. Create Branch and PR

```bash
git checkout -b fix/<bug-name>
git add <files>
git commit -m "fix: <description>"
git push -u origin fix/<bug-name>
gh pr create --title "fix: <description>" --body "..."
```

## Constraints

- Always write a regression test before fixing the bug
- Fix the root cause, not the symptom
- Do not add unrelated changes to the fix
- Do not deploy locally — deployments run on VPS via SSH
