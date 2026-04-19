/**
 * Workflow CRUD and execution routes.
 *
 *   GET    /workflows              — list workflows
 *   POST   /workflows              — create workflow
 *   GET    /workflows/:id          — get workflow
 *   PUT    /workflows/:id          — update workflow
 *   DELETE /workflows/:id          — delete workflow
 *   POST   /workflows/:id/run      — manually trigger a workflow
 *   GET    /workflows/:id/runs     — get run history
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';

const router = Router();

// ── List workflows ──────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT w.*, a.name AS agent_name, a.agent_id AS agent_slug, a.status AS agent_status
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       ${admin ? '' : 'WHERE w.created_by = $1'}
       ORDER BY w.created_at DESC`,
      admin ? [] : [user.sub]
    );

    res.json(rows);
  } catch (err: any) {
    console.error('[workflows] List error:', err);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// ── Create workflow ─────────────────────────────────────────────────
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled } = req.body;

    if (!name || !agent_id || !schedule_cron || !prompt) {
      res.status(400).json({ error: 'name, agent_id, schedule_cron, and prompt are required' });
      return;
    }

    // Validate cron expression (basic check)
    const cronParts = schedule_cron.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      res.status(400).json({ error: 'Invalid cron expression — must have 5 or 6 fields' });
      return;
    }

    // Verify agent exists and user has access
    const { rows: agentRows } = await getPool().query(
      'SELECT id FROM agents WHERE id = $1',
      [agent_id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO workflows (name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name,
        description || null,
        agent_id,
        schedule_cron,
        prompt,
        output_type || 'none',
        JSON.stringify(output_config || {}),
        enabled !== false,
        user.sub,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    console.error('[workflows] Create error:', err);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// ── Get workflow ────────────────────────────────────────────────────
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT w.*, a.name AS agent_name, a.agent_id AS agent_slug, a.status AS agent_status
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       WHERE w.id = $1 ${admin ? '' : 'AND w.created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('[workflows] Get error:', err);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
});

// ── Update workflow ─────────────────────────────────────────────────
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, agent_id, schedule_cron, prompt, output_type, output_config, enabled } = req.body;

    if (schedule_cron) {
      const cronParts = schedule_cron.trim().split(/\s+/);
      if (cronParts.length < 5 || cronParts.length > 6) {
        res.status(400).json({ error: 'Invalid cron expression' });
        return;
      }
    }

    const { rows } = await getPool().query(
      `UPDATE workflows SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        agent_id = COALESCE($3, agent_id),
        schedule_cron = COALESCE($4, schedule_cron),
        prompt = COALESCE($5, prompt),
        output_type = COALESCE($6, output_type),
        output_config = COALESCE($7, output_config),
        enabled = COALESCE($8, enabled),
        updated_at = NOW()
       WHERE id = $9 ${admin ? '' : 'AND created_by = $10'}
       RETURNING *`,
      admin
        ? [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, req.params.id]
        : [name, description, agent_id, schedule_cron, prompt, output_type, output_config ? JSON.stringify(output_config) : null, enabled, req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('[workflows] Update error:', err);
    res.status(500).json({ error: 'Failed to update workflow' });
  }
});

// ── Delete workflow ─────────────────────────────────────────────────
router.delete('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[workflows] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// ── Manual trigger ──────────────────────────────────────────────────
router.post('/:id/run', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows: wfRows } = await getPool().query(
      `SELECT w.*, a.agent_id AS agent_slug, a.status AS agent_status, a.work_token
       FROM workflows w
       JOIN agents a ON w.agent_id = a.id
       WHERE w.id = $1 ${admin ? '' : 'AND w.created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (wfRows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const wf = wfRows[0];

    if (wf.agent_status !== 'running') {
      res.status(409).json({ error: `Agent ${wf.agent_slug} is not running (status: ${wf.agent_status})` });
      return;
    }

    // Create run record
    const { rows: runRows } = await getPool().query(
      `INSERT INTO workflow_runs (workflow_id, status) VALUES ($1, 'running') RETURNING *`,
      [wf.id]
    );
    const run = runRows[0];

    // Create a chat thread and send the prompt
    const pool = getPool();

    const { rows: threadRows } = await pool.query(
      `INSERT INTO chat_threads (title, created_by) VALUES ($1, $2) RETURNING id`,
      [`Workflow: ${wf.name}`, user.sub]
    );
    const threadId = threadRows[0].id;

    // Add agent as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type)
       VALUES ($1, $2, 'agent')`,
      [threadId, wf.agent_id]
    );

    // Add user as participant
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type)
       VALUES ($1, $2, 'human')`,
      [threadId, user.sub]
    );

    // Insert the message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO chat_messages (thread_id, sender_id, sender_type, content, status)
       VALUES ($1, $2, 'human', $3, 'delivered')
       RETURNING id`,
      [threadId, user.sub, wf.prompt]
    );

    // Fetch model for the agent
    const { rows: policyRows } = await pool.query(
      `SELECT mp.allowed_models FROM model_policies mp
       JOIN agents a ON a.model_policy_id = mp.id
       WHERE a.id = $1`,
      [wf.agent_id]
    );
    const model = policyRows[0]?.allowed_models?.[0] || 'default';

    // Build messages
    const messages = [{ role: 'user', content: wf.prompt }];

    // Callback URL
    const callbackUrl = `http://api:3000/internal/chat/callback`;

    // Dispatch to agent (fire-and-forget)
    const { dispatchChatWork } = await import('../services/chat-dispatch');
    void dispatchChatWork({
      agentId: wf.agent_slug,
      workToken: wf.work_token,
      threadId,
      messageId: msgRows[0].id,
      messages,
      model,
      callbackUrl,
    }).catch((err: any) => {
      console.error(`[workflows] Dispatch failed for workflow ${wf.id}:`, err);
      pool.query(
        `UPDATE workflow_runs SET status = 'error', error = $1, completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000
         WHERE id = $2`,
        [err.message || 'Dispatch failed', run.id]
      );
    });

    // Update workflow last_run_at
    await pool.query(
      `UPDATE workflows SET last_run_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [wf.id]
    );

    // Update run with thread reference
    await pool.query(
      `UPDATE workflow_runs SET thread_id = $1 WHERE id = $2`,
      [threadId, run.id]
    );

    res.json({ ...run, thread_id: threadId, status: 'running' });
  } catch (err: any) {
    console.error('[workflows] Run error:', err);
    res.status(500).json({ error: 'Failed to run workflow' });
  }
});

// ── Run history ─────────────────────────────────────────────────────
router.get('/:id/runs', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    // Verify access
    const { rows: wfRows } = await getPool().query(
      `SELECT id FROM workflows WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );
    if (wfRows.length === 0) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const { rows } = await getPool().query(
      `SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json(rows);
  } catch (err: any) {
    console.error('[workflows] Runs error:', err);
    res.status(500).json({ error: 'Failed to get run history' });
  }
});

export default router;
