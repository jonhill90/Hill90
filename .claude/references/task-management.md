# Task Management Reference

**Use Linear MCP tools for task tracking instead of TodoWrite.**

## Why Linear Over TodoWrite

**Context Reset Problem**:
- Development workflow: PLAN → DOC → **Clear conversation** → EXEC
- TodoWrite state is **wiped** when conversation clears
- Linear issues **persist** across context resets (like PRD.md persists)
- Tasks need to survive the planning → execution boundary

**When Each Tool Applies:**
- **Linear** (persistent): Real work items, team-visible tasks, cross-session tracking
- **TodoWrite** (ephemeral): ONLY in plan mode for immediate decomposition (rare)

## Linear Workflow

### Create Issue for New Work
```python
# At start of feature development
mcp__MCP_DOCKER__create_issue(
    title="Deploy new API endpoint",
    description="Implement /api/v1/health endpoint with Docker health checks",
    team="AI",
    project="Hill90",
    state="todo",
    labels=["backend", "infrastructure"]
)
```

### Update Status as You Work
```python
# Mark as in-progress
mcp__MCP_DOCKER__update_issue(
    id="HILL-123",
    state="doing"
)

# Mark for review
mcp__MCP_DOCKER__update_issue(
    id="HILL-123",
    state="review"
)

# Complete
mcp__MCP_DOCKER__update_issue(
    id="HILL-123",
    state="done"
)
```

### Query Existing Tasks
```python
# Find your current work
mcp__MCP_DOCKER__list_issues(
    assignee="me",
    state="doing"
)

# Find pending work
mcp__MCP_DOCKER__list_issues(
    project="Hill90",
    state="todo"
)
```

## Task Status Flow

`todo` → `doing` → `review` → `done`

## Integration with Development Workflow

1. Break work into granular features/tasks
2. Each task → Linear issue in Hill90 project
3. Context reset between planning & execution → Linear persists
4. Update Linear issue with learnings as work progresses

## Examples

**VPS Rebuild Task**:
```python
create_issue(
    title="VPS Rebuild: Optimize from 30min to 5min",
    description="Replace Terraform with Tailscale API, consolidate Ansible playbooks",
    team="AI",
    project="Hill90",
    state="doing",
    labels=["infrastructure", "optimization"]
)
```

**API Deployment Task**:
```python
create_issue(
    title="Deploy Hill90 API to production",
    description="SSH to VPS via Tailscale, run deploy script, verify health checks",
    team="AI",
    project="Hill90",
    state="todo",
    labels=["deployment", "api"]
)
```

## Key Principle

**If the user will ask "what happened?" later, use Linear.**
**If it's throwaway planning for immediate execution, use TodoWrite (rare).**
