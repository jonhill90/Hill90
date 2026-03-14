import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

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
              default_pids_limit, is_platform, created_at, updated_at
       FROM container_profiles
       ORDER BY is_platform DESC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[container-profiles] List error:', err);
    res.status(500).json({ error: 'Failed to list container profiles' });
  }
});

export default router;
