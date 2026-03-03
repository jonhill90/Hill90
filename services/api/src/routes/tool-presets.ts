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

// List all presets — all authenticated users see all presets (no ownership scoping in Phase 1)
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM tool_presets ORDER BY is_platform DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[tool-presets] List error:', err);
    res.status(500).json({ error: 'Failed to list tool presets' });
  }
});

// Get single preset
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM tool_presets WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Tool preset not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[tool-presets] Get error:', err);
    res.status(500).json({ error: 'Failed to get tool preset' });
  }
});

// Create preset — admin only
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
      `INSERT INTO tool_presets (name, description, tools_config, instructions_md, scope, is_platform, created_by)
       VALUES ($1, $2, $3, $4, $5, false, NULL)
       RETURNING *`,
      [name, description || '', JSON.stringify(tools_config), instructions_md || '', scope || 'container_local']
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A tool preset with this name already exists' });
      return;
    }
    console.error('[tool-presets] Create error:', err);
    res.status(500).json({ error: 'Failed to create tool preset' });
  }
});

// Update preset — admin only, platform presets immutable
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM tool_presets WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Tool preset not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot modify a platform preset' });
      return;
    }

    const { name, description, tools_config, instructions_md, scope } = req.body;

    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE tool_presets SET
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
      res.status(409).json({ error: 'A tool preset with this name already exists' });
      return;
    }
    console.error('[tool-presets] Update error:', err);
    res.status(500).json({ error: 'Failed to update tool preset' });
  }
});

// Delete preset — admin only, platform presets undeletable, assigned presets undeletable
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM tool_presets WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Tool preset not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform preset' });
      return;
    }

    // Check for agents using this preset
    const { rows: agents } = await getPool().query(
      'SELECT id, agent_id FROM agents WHERE tool_preset_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (agents.length > 0) {
      res.status(409).json({
        error: 'Cannot delete preset while agents are assigned to it',
        agent_id: agents[0].agent_id,
      });
      return;
    }

    await getPool().query('DELETE FROM tool_presets WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[tool-presets] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete tool preset' });
  }
});

export default router;
