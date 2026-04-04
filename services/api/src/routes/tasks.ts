/**
 * Task routes — user-facing Kanban task management.
 *
 * Auth: requireAuth at mount (Keycloak JWT) + requireRole('user') per-route.
 * Ownership: scopeToOwner for admin bypass vs user scoping.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { getPool } from '../db/pool';
import * as taskProxy from '../services/task-proxy';

const router = Router();

/**
 * Get allowed agent_ids for the requesting user.
 * Admins: null (no filter). Users: their owned agent_ids.
 */
async function getAllowedAgentIds(req: Request): Promise<string[] | null> {
  const scope = scopeToOwner(req);
  if (scope.where === '1=1') return null;
  const { rows } = await getPool().query(
    `SELECT agent_id FROM agents WHERE ${scope.where}`,
    scope.params,
  );
  return rows.map((r: { agent_id: string }) => r.agent_id);
}

// List tasks (optional ?agent_id=, ?status=)
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agent_id as string | undefined;
    const status = req.query.status as string | undefined;

    const result = await taskProxy.listTasks(agentId, status);
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    // Filter to owned agents
    const allowed = await getAllowedAgentIds(req);
    let tasks = result.data as Array<{ agent_id: string }>;
    if (allowed !== null) {
      tasks = tasks.filter(t => allowed.includes(t.agent_id));
    }

    res.json(tasks);
  } catch (err) {
    console.error('[tasks] List error:', err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// Get task detail
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const result = await taskProxy.getTask(req.params.id);
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    const task = result.data as { agent_id: string };
    const allowed = await getAllowedAgentIds(req);
    if (allowed !== null && !allowed.includes(task.agent_id)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    res.json(result.data);
  } catch (err) {
    console.error('[tasks] Get error:', err);
    res.status(500).json({ error: 'Failed to get task' });
  }
});

// Create task
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { agent_id, title, description, status, priority, tags } = req.body;
    if (!agent_id || !title) {
      res.status(400).json({ error: 'agent_id and title are required' });
      return;
    }

    // Verify ownership
    const allowed = await getAllowedAgentIds(req);
    if (allowed !== null && !allowed.includes(agent_id)) {
      res.status(403).json({ error: 'Not authorized to create tasks for this agent' });
      return;
    }

    const userSub = (req as any).user?.sub || 'unknown';
    const result = await taskProxy.createTask({
      agent_id,
      title,
      description,
      status,
      priority,
      tags,
      created_by: userSub,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[tasks] Create error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update task
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Verify ownership first
    const getResult = await taskProxy.getTask(req.params.id);
    if (getResult.status !== 200) {
      res.status(getResult.status).json(getResult.data);
      return;
    }
    const task = getResult.data as { agent_id: string };
    const allowed = await getAllowedAgentIds(req);
    if (allowed !== null && !allowed.includes(task.agent_id)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const { title, description, status, priority, tags } = req.body;
    const result = await taskProxy.updateTask(req.params.id, {
      title, description, status, priority, tags,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[tasks] Update error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Transition task status
router.patch('/:id/transition', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    // Verify ownership
    const getResult = await taskProxy.getTask(req.params.id);
    if (getResult.status !== 200) {
      res.status(getResult.status).json(getResult.data);
      return;
    }
    const task = getResult.data as { agent_id: string };
    const allowed = await getAllowedAgentIds(req);
    if (allowed !== null && !allowed.includes(task.agent_id)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const result = await taskProxy.transitionTask(req.params.id, status);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[tasks] Transition error:', err);
    res.status(500).json({ error: 'Failed to transition task' });
  }
});

// Cancel task (soft delete)
router.delete('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const getResult = await taskProxy.getTask(req.params.id);
    if (getResult.status !== 200) {
      res.status(getResult.status).json(getResult.data);
      return;
    }
    const task = getResult.data as { agent_id: string };
    const allowed = await getAllowedAgentIds(req);
    if (allowed !== null && !allowed.includes(task.agent_id)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const result = await taskProxy.cancelTask(req.params.id);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[tasks] Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel task' });
  }
});

export default router;
