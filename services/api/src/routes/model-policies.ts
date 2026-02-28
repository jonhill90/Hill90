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

// All model-policy endpoints require admin role
router.use(requireRole('admin'));

// List all policies
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
              created_at, updated_at, updated_by
       FROM model_policies ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[model-policies] List error:', err);
    res.status(500).json({ error: 'Failed to list model policies' });
  }
});

// Get single policy
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
              created_at, updated_at, updated_by
       FROM model_policies WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Model policy not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[model-policies] Get error:', err);
    res.status(500).json({ error: 'Failed to get model policy' });
  }
});

// Create policy
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, allowed_models, max_requests_per_minute, max_tokens_per_day, model_aliases } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!Array.isArray(allowed_models)) {
      res.status(400).json({ error: 'allowed_models must be an array' });
      return;
    }

    // Validate model_aliases: each alias target must be in allowed_models
    const aliases = model_aliases || {};
    if (typeof aliases !== 'object' || Array.isArray(aliases)) {
      res.status(400).json({ error: 'model_aliases must be an object' });
      return;
    }
    for (const [alias, target] of Object.entries(aliases)) {
      if (!allowed_models.includes(target)) {
        res.status(400).json({ error: `Alias '${alias}' target '${target}' is not in allowed_models` });
        return;
      }
    }

    const { rows } = await getPool().query(
      `INSERT INTO model_policies (name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        name,
        description || '',
        JSON.stringify(allowed_models),
        JSON.stringify(aliases),
        max_requests_per_minute ?? null,
        max_tokens_per_day ?? null,
        user.sub,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A policy with this name already exists' });
      return;
    }
    console.error('[model-policies] Create error:', err);
    res.status(500).json({ error: 'Failed to create model policy' });
  }
});

// Update policy
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, allowed_models, max_requests_per_minute, max_tokens_per_day, model_aliases } = req.body;

    if (allowed_models !== undefined && !Array.isArray(allowed_models)) {
      res.status(400).json({ error: 'allowed_models must be an array' });
      return;
    }

    const { rows: existing } = await getPool().query(
      'SELECT id, allowed_models FROM model_policies WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Model policy not found' });
      return;
    }

    // Validate model_aliases if provided
    if (model_aliases !== undefined) {
      if (typeof model_aliases !== 'object' || Array.isArray(model_aliases)) {
        res.status(400).json({ error: 'model_aliases must be an object' });
        return;
      }
      // Validate against the effective allowed_models (new list if provided, otherwise existing)
      const effectiveModels = allowed_models || existing[0].allowed_models;
      for (const [alias, target] of Object.entries(model_aliases)) {
        if (!effectiveModels.includes(target)) {
          res.status(400).json({ error: `Alias '${alias}' target '${target}' is not in allowed_models` });
          return;
        }
      }
    }

    // Use CASE for nullable limit fields to allow clearing to NULL (unlimited)
    const rpmProvided = 'max_requests_per_minute' in req.body;
    const tpdProvided = 'max_tokens_per_day' in req.body;
    const aliasesProvided = 'model_aliases' in req.body;

    const { rows } = await getPool().query(
      `UPDATE model_policies SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        allowed_models = COALESCE($3, allowed_models),
        max_requests_per_minute = CASE WHEN $4::boolean THEN $5::integer ELSE max_requests_per_minute END,
        max_tokens_per_day = CASE WHEN $6::boolean THEN $7::integer ELSE max_tokens_per_day END,
        model_aliases = CASE WHEN $8::boolean THEN $9::jsonb ELSE model_aliases END,
        updated_by = $10,
        updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        name || null,
        description ?? null,
        allowed_models ? JSON.stringify(allowed_models) : null,
        rpmProvided,
        rpmProvided ? (max_requests_per_minute ?? null) : null,
        tpdProvided,
        tpdProvided ? (max_tokens_per_day ?? null) : null,
        aliasesProvided,
        aliasesProvided ? JSON.stringify(model_aliases) : null,
        user.sub,
        req.params.id,
      ]
    );

    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'A policy with this name already exists' });
      return;
    }
    console.error('[model-policies] Update error:', err);
    res.status(500).json({ error: 'Failed to update model policy' });
  }
});

// Delete policy
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    // Check for agents using this policy
    const { rows: agents } = await getPool().query(
      'SELECT id, agent_id FROM agents WHERE model_policy_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (agents.length > 0) {
      res.status(409).json({
        error: 'Cannot delete policy while agents are assigned to it',
        agent_id: agents[0].agent_id,
      });
      return;
    }

    const { rowCount } = await getPool().query(
      'DELETE FROM model_policies WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Model policy not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('[model-policies] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete model policy' });
  }
});

export default router;
