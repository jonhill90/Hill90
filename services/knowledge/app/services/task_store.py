"""Task store — CRUD and transition logic for agent tasks."""

from __future__ import annotations

from typing import Any

import asyncpg
import structlog

logger = structlog.get_logger()

VALID_STATUSES = frozenset({"backlog", "todo", "in_progress", "review", "done", "cancelled"})


async def create_task(
    pool: asyncpg.Pool,
    agent_id: str,
    title: str,
    created_by: str,
    description: str = "",
    status: str = "backlog",
    priority: int = 3,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Create a new task for an agent."""
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status '{status}'")
    if not 1 <= priority <= 4:
        raise ValueError(f"invalid priority {priority}")

    row = await pool.fetchrow(
        """INSERT INTO agent_tasks (agent_id, title, description, status, priority, tags, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *""",
        agent_id,
        title,
        description,
        status,
        priority,
        tags or [],
        created_by,
    )
    return _serialize(dict(row))


async def list_tasks(
    pool: asyncpg.Pool,
    agent_id: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """List tasks, optionally filtered by agent_id and/or status."""
    conditions = []
    params: list[Any] = []
    idx = 1

    if agent_id:
        conditions.append(f"agent_id = ${idx}")
        params.append(agent_id)
        idx += 1

    if status:
        conditions.append(f"status = ${idx}")
        params.append(status)
        idx += 1

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    rows = await pool.fetch(
        f"""SELECT * FROM agent_tasks {where}
            ORDER BY sort_order ASC, updated_at DESC""",
        *params,
    )
    return [_serialize(dict(r)) for r in rows]


async def get_task(pool: asyncpg.Pool, task_id: str) -> dict[str, Any] | None:
    """Get a single task by ID."""
    row = await pool.fetchrow("SELECT * FROM agent_tasks WHERE id = $1", task_id)
    if row is None:
        return None
    return _serialize(dict(row))


async def update_task(
    pool: asyncpg.Pool,
    task_id: str,
    **fields: Any,
) -> dict[str, Any] | None:
    """Update task fields. Only provided fields are updated."""
    allowed = {"title", "description", "status", "priority", "tags", "sort_order"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}

    if not updates:
        return await get_task(pool, task_id)

    if "status" in updates and updates["status"] not in VALID_STATUSES:
        raise ValueError(f"invalid status '{updates['status']}'")
    if "priority" in updates and not 1 <= updates["priority"] <= 4:
        raise ValueError(f"invalid priority {updates['priority']}")

    set_clauses = []
    params: list[Any] = []
    idx = 1

    for key, value in updates.items():
        set_clauses.append(f"{key} = ${idx}")
        params.append(value)
        idx += 1

    set_clauses.append(f"updated_at = NOW()")
    params.append(task_id)

    row = await pool.fetchrow(
        f"""UPDATE agent_tasks SET {', '.join(set_clauses)}
            WHERE id = ${idx}
            RETURNING *""",
        *params,
    )
    if row is None:
        return None
    return _serialize(dict(row))


async def transition_task(
    pool: asyncpg.Pool,
    task_id: str,
    new_status: str,
) -> dict[str, Any] | None:
    """Transition a task to a new status."""
    if new_status not in VALID_STATUSES:
        raise ValueError(f"invalid status '{new_status}'")

    row = await pool.fetchrow(
        """UPDATE agent_tasks SET status = $1, updated_at = NOW()
           WHERE id = $2
           RETURNING *""",
        new_status,
        task_id,
    )
    if row is None:
        return None
    return _serialize(dict(row))


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize DB row for JSON response."""
    result = {}
    for key, value in row.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result
