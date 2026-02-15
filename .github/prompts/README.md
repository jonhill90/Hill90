# Prompts

This directory contains prompt templates and evaluation tools for Hill90 AI workflows.

## Workflow Prompts

| File | Purpose |
|------|---------|
| `new-feature.prompt.md` | Full PR workflow: orient, plan, TDD, verify, PR |
| `fix-bug.prompt.md` | Bug fix workflow: reproduce, failing test, fix, verify, PR |

Use `$DESCRIPTION` in prompts — it is replaced by user input when invoked.

## Evaluation

| File | Purpose |
|------|---------|
| `eval-checklist.prompt.md` | Score prompt/agent outputs for quality |

### Evaluation Workflow

1. Add or update fixtures in `fixtures/`
2. Run the prompt/agent with each fixture input
3. Score results with `eval-checklist.prompt.md`
4. Record failures and adjust prompt/context
5. Re-run until all required checks pass

### Minimum Gate

- No critical checklist failures
- No regressions on previously passing fixtures
- At least one fixture covering an edge case
