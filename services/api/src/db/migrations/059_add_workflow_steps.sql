-- Workflow steps: ordered sequence of agent actions within a workflow.
-- Each step has its own agent and prompt. The output of step N is appended
-- to the prompt of step N+1 as context.
CREATE TABLE IF NOT EXISTS workflow_steps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_order      INTEGER NOT NULL DEFAULT 0,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    prompt          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id, step_order);

-- Track per-step execution in workflow runs
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS total_steps INTEGER NOT NULL DEFAULT 1;
