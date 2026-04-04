-- Agent tasks table — Kanban-style task tracking for agents
CREATE TABLE IF NOT EXISTS agent_tasks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    TEXT NOT NULL,
    title       VARCHAR(255) NOT NULL,
    description TEXT DEFAULT '',
    status      VARCHAR(20) NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled')),
    priority    SMALLINT NOT NULL DEFAULT 3
                CHECK (priority BETWEEN 1 AND 4),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    tags        TEXT[] DEFAULT '{}',
    created_by  VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks (status) WHERE status NOT IN ('done', 'cancelled');
