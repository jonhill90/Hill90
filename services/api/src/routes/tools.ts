import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

const VALID_INSTALL_METHODS = ['builtin', 'apt', 'binary'] as const;

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

// List all tools
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, install_method, install_ref, is_platform, created_at
       FROM tools ORDER BY is_platform DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[tools] List error:', err);
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

// Get single tool
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, install_method, install_ref, is_platform, created_at
       FROM tools WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[tools] Get error:', err);
    res.status(500).json({ error: 'Failed to get tool' });
  }
});

// Create tool — admin only
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, install_method, install_ref } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const resolvedMethod = install_method || 'builtin';
    if (!(VALID_INSTALL_METHODS as readonly string[]).includes(resolvedMethod)) {
      res.status(400).json({ error: `Invalid install_method. Must be one of: ${VALID_INSTALL_METHODS.join(', ')}` });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO tools (name, description, install_method, install_ref, is_platform)
       VALUES ($1, $2, $3, $4, false)
       RETURNING *`,
      [name, description || '', resolvedMethod, install_ref || '']
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A tool with this name already exists' });
      return;
    }
    console.error('[tools] Create error:', err);
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

// Update tool — admin only, platform tools immutable
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM tools WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot modify a platform tool' });
      return;
    }

    const { name, description, install_method, install_ref } = req.body;

    if (install_method !== undefined && !(VALID_INSTALL_METHODS as readonly string[]).includes(install_method)) {
      res.status(400).json({ error: `Invalid install_method. Must be one of: ${VALID_INSTALL_METHODS.join(', ')}` });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE tools SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        install_method = COALESCE($3, install_method),
        install_ref = COALESCE($4, install_ref)
       WHERE id = $5
       RETURNING *`,
      [
        name || null,
        description ?? null,
        install_method || null,
        install_ref ?? null,
        req.params.id,
      ]
    );

    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A tool with this name already exists' });
      return;
    }
    console.error('[tools] Update error:', err);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

// Delete tool — admin only, platform tools undeletable
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM tools WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform tool' });
      return;
    }

    await getPool().query('DELETE FROM tools WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err: any) {
    // FK RESTRICT from skill_tools
    if (err.code === '23503') {
      res.status(409).json({ error: 'Cannot delete tool while skills reference it' });
      return;
    }
    console.error('[tools] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

export default router;
