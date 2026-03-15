import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

// All routes require at least 'user' role
router.use(requireRole('user'));

// GET /user-models — list own models
router.get('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const result = await pool.query(
    `SELECT id, name, connection_id, litellm_model, description, is_active, created_at, updated_at
     FROM user_models
     WHERE created_by = $1
     ORDER BY created_at DESC`,
    [user.sub]
  );
  res.json(result.rows);
});

// POST /user-models — create user model
router.post('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { name, connection_id, litellm_model, description } = req.body;

  if (!name || !connection_id || !litellm_model) {
    res.status(400).json({ error: 'name, connection_id, and litellm_model are required' });
    return;
  }

  // Verify connection ownership
  const conn = await pool.query(
    'SELECT id FROM provider_connections WHERE id = $1 AND created_by = $2',
    [connection_id, user.sub]
  );
  if (conn.rows.length === 0) {
    res.status(400).json({ error: 'Connection not found or not owned by you' });
    return;
  }

  // Check platform model name collision (Rule 1 from 3J)
  const platformCollision = await pool.query(
    'SELECT name FROM model_catalog WHERE name = $1 AND is_active = true',
    [name]
  );
  if (platformCollision.rows.length > 0) {
    res.status(409).json({ error: `Name '${name}' conflicts with a platform model` });
    return;
  }

  try {
    const result = await pool.query(
      `INSERT INTO user_models (name, connection_id, litellm_model, description, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, connection_id, litellm_model, description, is_active, created_at, updated_at`,
      [name, connection_id, litellm_model, description || '', user.sub]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Model named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// PUT /user-models/:id — update own model
router.put('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;
  const { name, connection_id, litellm_model, description, is_active } = req.body;

  // Verify ownership
  const existing = await pool.query(
    'SELECT id FROM user_models WHERE id = $1 AND created_by = $2',
    [id, user.sub]
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }

  // If changing connection, verify ownership of new connection
  if (connection_id !== undefined) {
    const conn = await pool.query(
      'SELECT id FROM provider_connections WHERE id = $1 AND created_by = $2',
      [connection_id, user.sub]
    );
    if (conn.rows.length === 0) {
      res.status(400).json({ error: 'Connection not found or not owned by you' });
      return;
    }
  }

  // If changing name, check platform model collision
  if (name !== undefined) {
    const platformCollision = await pool.query(
      'SELECT name FROM model_catalog WHERE name = $1 AND is_active = true',
      [name]
    );
    if (platformCollision.rows.length > 0) {
      res.status(409).json({ error: `Name '${name}' conflicts with a platform model` });
      return;
    }
  }

  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`);
    params.push(name);
  }
  if (connection_id !== undefined) {
    setClauses.push(`connection_id = $${paramIdx++}`);
    params.push(connection_id);
  }
  if (litellm_model !== undefined) {
    setClauses.push(`litellm_model = $${paramIdx++}`);
    params.push(litellm_model);
  }
  if (description !== undefined) {
    setClauses.push(`description = $${paramIdx++}`);
    params.push(description);
  }
  if (is_active !== undefined) {
    setClauses.push(`is_active = $${paramIdx++}`);
    params.push(is_active);
  }

  if (setClauses.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  setClauses.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE user_models SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, name, connection_id, litellm_model, description, is_active, created_at, updated_at`,
      params
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Model named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// DELETE /user-models/:id — delete own model
router.delete('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;

  const result = await pool.query(
    'DELETE FROM user_models WHERE id = $1 AND created_by = $2 RETURNING id, name',
    [id, user.sub]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }

  // Best-effort stale cleanup: scrub deleted model name from owner's policies
  const deletedModelName = result.rows[0].name;
  try {
    await pool.query(
      `UPDATE model_policies SET allowed_models = allowed_models - $1, updated_at = NOW()
       WHERE created_by = $2 AND allowed_models ? $1`,
      [deletedModelName, user.sub]
    );
  } catch (err) {
    console.error('[user-models] Stale policy cleanup failed (non-fatal):', err);
  }

  res.json({ deleted: true });
});

export default router;
