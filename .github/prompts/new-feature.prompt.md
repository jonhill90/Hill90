---
description: "Full PR workflow for adding a new feature: orient, plan, TDD, verify, PR"
---

# New Feature: $DESCRIPTION

## Workflow

Follow the required PR workflow from `AGENTS.md`:

### 1. Orient

Run `/primer` to understand current project state and conventions.

### 2. Plan

Use the `planner` agent (or Claude Code's built-in plan mode) to:
- Explore affected files and existing patterns
- Produce a structured implementation plan
- Identify risks and verification steps
- Get user approval before proceeding

### 3. Implement with TDD

Follow Red-Green-Refactor using the TDD agent chain:

1. **Red** (`tdd-red`): Write failing tests in `tests/` that define the expected behavior for $DESCRIPTION
2. **Green** (`tdd-green`): Run the tests to confirm failure, then write minimum code to make them pass
3. **Refactor** (`tdd-refactor`): Improve structure while keeping tests green
4. Repeat for each requirement

### 4. Verify Locally

Run all relevant checks before creating a PR:
- `shellcheck --severity=error scripts/*.sh` (if shell scripts changed)
- `bats tests/scripts/` (if bats tests exist)
- `npm test` (if Node.js services changed)
- `pytest` (if Python services changed)
- `docker compose config` or `bash scripts/validate.sh` (if compose/edge config changed)

### 5. Create Branch and PR

```bash
git checkout -b feat/<feature-name>
git add <files>
git commit -m "feat: <description>"
git push -u origin feat/<feature-name>
gh pr create --title "feat: <description>" --body "..."
```

## Constraints

- Do not skip TDD steps — write tests before implementation
- Do not deploy locally — deployments run on VPS via SSH
- Do not add speculative features outside the described scope
- Use MCP docs tools (`context7`, `microsoft-learn`, `deepwiki`) for fresh API references
