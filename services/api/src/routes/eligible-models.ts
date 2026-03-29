import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

router.use(requireRole('user'));

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

// GET /eligible-models — returns caller's own user_models + platform models (AI-123)
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const includeInactive = req.query.include_inactive === 'true';

    const activeClause = includeInactive ? '' : 'AND is_active = true';
    const { rows } = await getPool().query(
      `SELECT name, description, connection_id, is_active, model_type, detected_type,
              CASE WHEN created_by IS NULL THEN true ELSE false END AS is_platform
       FROM user_models
       WHERE (created_by = $1 OR created_by IS NULL) ${activeClause}
       ORDER BY name ASC`,
      [user.sub]
    );

    res.json({ models: rows });
  } catch (err) {
    console.error('[eligible-models] List error:', err);
    res.status(500).json({ error: 'Failed to list eligible models' });
  }
});

export default router;
