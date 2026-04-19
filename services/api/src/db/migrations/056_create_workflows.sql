-- Workflows: scheduled agent tasks with prompt, output config, and run history.
CREATE TABLE IF NOT EXISTS workflows (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    schedule_cron   VARCHAR(128) NOT NULL,
    prompt          TEXT NOT NULL,
    output_type     VARCHAR(32) NOT NULL DEFAULT 'none',
    output_config   JSONB NOT NULL DEFAULT '{}',
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_agent ON workflows(agent_id);
CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled, next_run_at) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_workflows_created_by ON workflows(created_by);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    thread_id       UUID,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,
    result_summary  TEXT,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status) WHERE status IN ('pending', 'running');
