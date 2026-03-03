import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

const VALID_SCOPES = ['container_local', 'host_docker', 'vps_system'] as const;

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = user?.realm_roles || [];
  return roles.includes('admin');
}

// List all skills — all authenticated users see all skills
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills ORDER BY is_platform DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[skills] List error:', err);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

// Get single skill
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[skills] Get error:', err);
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

// Create skill — admin only
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, tools_config, instructions_md, scope } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!tools_config || typeof tools_config !== 'object') {
      res.status(400).json({ error: 'tools_config is required and must be an object' });
      return;
    }
    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform, created_by)
       VALUES ($1, $2, $3, $4, $5, false, NULL)
       RETURNING *`,
      [name, description || '', JSON.stringify(tools_config), instructions_md || '', scope || 'container_local']
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Create error:', err);
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

// Update skill — admin only, platform skills immutable
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot modify a platform skill' });
      return;
    }

    const { name, description, tools_config, instructions_md, scope } = req.body;

    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE skills SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        tools_config = COALESCE($3, tools_config),
        instructions_md = COALESCE($4, instructions_md),
        scope = COALESCE($5, scope),
        updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        name || null,
        description ?? null,
        tools_config ? JSON.stringify(tools_config) : null,
        instructions_md ?? null,
        scope || null,
        req.params.id,
      ]
    );

    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Update error:', err);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

// Delete skill — admin only, platform skills undeletable, assigned skills undeletable
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform skill' });
      return;
    }

    // Check for agents using this skill via agent_skills join table
    const { rows: assignments } = await getPool().query(
      `SELECT as2.agent_id, a.agent_id AS agent_slug
       FROM agent_skills as2
       JOIN agents a ON a.id = as2.agent_id
       WHERE as2.skill_id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (assignments.length > 0) {
      res.status(409).json({
        error: 'Cannot delete skill while agents are assigned to it',
        agent_id: assignments[0].agent_slug,
      });
      return;
    }

    await getPool().query('DELETE FROM skills WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[skills] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

export default router;
