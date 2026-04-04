import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { auditLog } from '../helpers/audit';

const router = Router();

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

// List container profiles (read-only, user role)
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, docker_image, default_cpus, default_mem_limit,
              default_pids_limit, is_platform, metadata, created_at, updated_at
       FROM container_profiles
       ORDER BY is_platform DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[container-profiles] List error:', err);
    res.status(500).json({ error: 'Failed to list container profiles' });
  }
});

// Get single container profile
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, docker_image, default_cpus, default_mem_limit,
              default_pids_limit, is_platform, metadata, created_at, updated_at
       FROM container_profiles WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Container profile not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[container-profiles] Get error:', err);
    res.status(500).json({ error: 'Failed to get container profile' });
  }
});

// Create container profile — admin only
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, metadata } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!docker_image) {
      res.status(400).json({ error: 'docker_image is required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO container_profiles (name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, metadata, is_platform)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       RETURNING *`,
      [name, description || '', docker_image, default_cpus || '1.0', default_mem_limit || '1g', default_pids_limit || 200, JSON.stringify(metadata || {})]
    );

    const profile = rows[0];
    const user = (req as any).user;
    auditLog('container_profile_create', profile.id, user.sub, 'human', { profile_name: profile.name });

    res.status(201).json(profile);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A container profile with this name already exists' });
      return;
    }
    console.error('[container-profiles] Create error:', err);
    res.status(500).json({ error: 'Failed to create container profile' });
  }
});

// Update container profile — admin only, is_platform immutable
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, name FROM container_profiles WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Container profile not found' });
      return;
    }

    const { name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, metadata } = req.body;

    const { rows } = await getPool().query(
      `UPDATE container_profiles SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         docker_image = COALESCE($4, docker_image),
         default_cpus = COALESCE($5, default_cpus),
         default_mem_limit = COALESCE($6, default_mem_limit),
         default_pids_limit = COALESCE($7, default_pids_limit),
         metadata = COALESCE($8, metadata),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, metadata !== undefined ? JSON.stringify(metadata) : null]
    );

    const profile = rows[0];
    const user = (req as any).user;
    auditLog('container_profile_update', profile.id, user.sub, 'human', { profile_name: profile.name });

    res.json(profile);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A container profile with this name already exists' });
      return;
    }
    console.error('[container-profiles] Update error:', err);
    res.status(500).json({ error: 'Failed to update container profile' });
  }
});

// Delete container profile — admin only, platform guard + agent-reference guard
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, name, is_platform FROM container_profiles WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Container profile not found' });
      return;
    }

    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform profile' });
      return;
    }

    const { rows: agents } = await getPool().query(
      `SELECT a.id, a.agent_id FROM agents a WHERE a.container_profile_id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (agents.length > 0) {
      res.status(409).json({
        error: 'Cannot delete profile while agents are assigned to it',
        agent_id: agents[0].agent_id,
      });
      return;
    }

    await getPool().query('DELETE FROM container_profiles WHERE id = $1', [req.params.id]);

    const user = (req as any).user;
    auditLog('container_profile_delete', existing[0].id, user.sub, 'human', { profile_name: existing[0].name });

    res.json({ deleted: true });
  } catch (err) {
    console.error('[container-profiles] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete container profile' });
  }
});

export default router;
