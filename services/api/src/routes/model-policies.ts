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

// All model-policy endpoints require at least user role
router.use(requireRole('user'));

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = user?.realm_roles || [];
  return roles.includes('admin');
}

// List policies — users see own + platform, admins see all
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    let query: string;
    let params: any[];

    if (isAdmin(req)) {
      query = `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
                      created_by, created_at, updated_at, updated_by
               FROM model_policies ORDER BY created_at ASC`;
      params = [];
    } else {
      query = `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
                      created_by, created_at, updated_at, updated_by
               FROM model_policies
               WHERE created_by = $1 OR created_by IS NULL
               ORDER BY created_at ASC`;
      params = [user.sub];
    }

    const { rows } = await getPool().query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[model-policies] List error:', err);
    res.status(500).json({ error: 'Failed to list model policies' });
  }
});

// Get single policy — users can see own + platform, admins see all
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    let query: string;
    let params: any[];

    if (isAdmin(req)) {
      query = `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
                      created_by, created_at, updated_at, updated_by
               FROM model_policies WHERE id = $1`;
      params = [req.params.id];
    } else {
      query = `SELECT id, name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day,
                      created_by, created_at, updated_at, updated_by
               FROM model_policies WHERE id = $1 AND (created_by = $2 OR created_by IS NULL)`;
      params = [req.params.id, user.sub];
    }

    const { rows } = await getPool().query(query, params);
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

/**
 * Validate that each model in allowed_models exists in the user's own
 * user_models (active). No admin bypass — AI-120 enforcement.
 */
async function validateAllowedModels(
  allowedModels: string[],
  userSub: string
): Promise<string | null> {
  for (const modelName of allowedModels) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND created_by = $2 AND is_active = true`,
      [modelName, userSub]
    );
    if (userRows.length > 0) continue;

    return `Model '${modelName}' not found in user models for policy owner`;
  }

  return null;
}

// Create policy
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, allowed_models, max_requests_per_minute, max_tokens_per_day, model_aliases } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!Array.isArray(allowed_models)) {
      res.status(400).json({ error: 'allowed_models must be an array' });
      return;
    }

    // model_aliases are admin/platform-scoped only (Phase 5 design decision 3H)
    if (model_aliases !== undefined && !admin) {
      res.status(403).json({ error: 'model_aliases can only be set by admins' });
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

    // Validate allowed_models exist (user-scoped check, no admin bypass — AI-120)
    const modelError = await validateAllowedModels(allowed_models, user.sub);
    if (modelError) {
      res.status(400).json({ error: modelError });
      return;
    }

    // User-created policies get created_by = user.sub
    // Admin platform policies get created_by = NULL
    const createdBy = admin ? null : user.sub;

    const { rows } = await getPool().query(
      `INSERT INTO model_policies (name, description, allowed_models, model_aliases, max_requests_per_minute, max_tokens_per_day, updated_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        description || '',
        JSON.stringify(allowed_models),
        JSON.stringify(aliases),
        max_requests_per_minute ?? null,
        max_tokens_per_day ?? null,
        user.sub,
        createdBy,
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

// Update policy — users can only update own, admins can update any
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, allowed_models, max_requests_per_minute, max_tokens_per_day, model_aliases } = req.body;

    if (allowed_models !== undefined && !Array.isArray(allowed_models)) {
      res.status(400).json({ error: 'allowed_models must be an array' });
      return;
    }

    // Ownership check: users can only update their own policies (not platform ones)
    let existingQuery: string;
    let existingParams: any[];

    if (admin) {
      existingQuery = 'SELECT id, allowed_models FROM model_policies WHERE id = $1';
      existingParams = [req.params.id];
    } else {
      existingQuery = 'SELECT id, allowed_models FROM model_policies WHERE id = $1 AND created_by = $2';
      existingParams = [req.params.id, user.sub];
    }

    const { rows: existing } = await getPool().query(existingQuery, existingParams);
    if (existing.length === 0) {
      res.status(404).json({ error: 'Model policy not found' });
      return;
    }

    // model_aliases are admin/platform-scoped only (Phase 5 design decision 3H)
    if (model_aliases !== undefined && !admin) {
      res.status(403).json({ error: 'model_aliases can only be set by admins' });
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

    // Validate allowed_models if provided (user-scoped check, no admin bypass — AI-120)
    if (allowed_models !== undefined) {
      const modelError = await validateAllowedModels(allowed_models, user.sub);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
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

// Delete policy — users can only delete own, admins can delete any
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

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

    let deleteQuery: string;
    let deleteParams: any[];

    if (admin) {
      deleteQuery = 'DELETE FROM model_policies WHERE id = $1';
      deleteParams = [req.params.id];
    } else {
      // Users can only delete their own policies (not platform ones)
      deleteQuery = 'DELETE FROM model_policies WHERE id = $1 AND created_by = $2';
      deleteParams = [req.params.id, user.sub];
    }

    const { rowCount } = await getPool().query(deleteQuery, deleteParams);
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
