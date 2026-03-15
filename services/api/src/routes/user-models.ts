import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { detectModelType } from '../helpers/model-type-detect';

const router = Router();

const RETURNING_COLS = `id, name, connection_id, litellm_model, description, is_active,
  model_type, detected_type, capabilities, routing_config, icon_emoji, icon_url,
  created_at, updated_at`;

// All routes require at least 'user' role
router.use(requireRole('user'));

interface RouteEntry {
  key: string;
  connection_id: string;
  litellm_model: string;
  detected_type?: string;
  capabilities?: string[];
  task_types?: string[];
  priority: number;
}

interface RoutingConfig {
  strategy: 'fallback' | 'task_routing';
  default_route: string;
  routes: RouteEntry[];
}

function validateRoutingConfig(config: any): { valid: boolean; error?: string } {
  if (!config || typeof config !== 'object') return { valid: false, error: 'routing_config is required for router models' };
  if (!['fallback', 'task_routing'].includes(config.strategy)) {
    return { valid: false, error: 'routing_config.strategy must be "fallback" or "task_routing"' };
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    return { valid: false, error: 'routing_config.routes must be a non-empty array' };
  }

  const keys = new Set<string>();
  for (const route of config.routes) {
    if (!route.key || !route.connection_id || !route.litellm_model) {
      return { valid: false, error: 'Each route must have key, connection_id, and litellm_model' };
    }
    if (typeof route.priority !== 'number') {
      return { valid: false, error: 'Each route must have a numeric priority' };
    }
    if (keys.has(route.key)) {
      return { valid: false, error: `Duplicate route key: ${route.key}` };
    }
    keys.add(route.key);
  }

  if (!config.default_route || !keys.has(config.default_route)) {
    return { valid: false, error: 'default_route must reference an existing route key' };
  }

  return { valid: true };
}

async function validateRouteConnectionOwnership(pool: any, routes: RouteEntry[], ownerSub: string): Promise<string | null> {
  const connectionIds = [...new Set(routes.map(r => r.connection_id))];
  const placeholders = connectionIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await pool.query(
    `SELECT id FROM provider_connections WHERE id IN (${placeholders}) AND created_by = $${connectionIds.length + 1}`,
    [...connectionIds, ownerSub]
  );
  const ownedIds = new Set(result.rows.map((r: any) => r.id));
  for (const cid of connectionIds) {
    if (!ownedIds.has(cid)) return cid;
  }
  return null;
}

function enrichRoutesWithDetection(routes: RouteEntry[]): RouteEntry[] {
  return routes.map(route => {
    const detected = detectModelType(route.litellm_model);
    return {
      ...route,
      detected_type: route.detected_type || detected.detected_type,
      capabilities: route.capabilities || detected.capabilities,
    };
  });
}

// GET /user-models — list own models
router.get('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const result = await pool.query(
    `SELECT ${RETURNING_COLS}
     FROM user_models
     WHERE created_by = $1
     ORDER BY created_at DESC`,
    [user.sub]
  );
  res.json(result.rows);
});

// POST /user-models — create user model (single or router)
router.post('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const {
    name, connection_id, litellm_model, description,
    model_type, routing_config, icon_url,
    detected_type: overrideDetectedType, capabilities: overrideCapabilities,
  } = req.body;
  // icon_emoji is deprecated — ignored on writes, retained in reads for compatibility

  const effectiveType = model_type || 'single';

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  if (effectiveType === 'router') {
    // Router model validation
    if (connection_id || litellm_model) {
      res.status(400).json({ error: 'Router models must not have connection_id or litellm_model' });
      return;
    }
    const validation = validateRoutingConfig(routing_config);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // Validate all route connection_ids are owned by caller
    const unownedId = await validateRouteConnectionOwnership(pool, routing_config.routes, user.sub);
    if (unownedId) {
      res.status(400).json({ error: 'Connection not found or not owned by you' });
      return;
    }
    // Enrich routes with auto-detection
    const enrichedConfig: RoutingConfig = {
      ...routing_config,
      routes: enrichRoutesWithDetection(routing_config.routes),
    };

    // Check platform model name collision
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
        `INSERT INTO user_models (name, model_type, routing_config, description, icon_url, created_by)
         VALUES ($1, 'router', $2, $3, $4, $5)
         RETURNING ${RETURNING_COLS}`,
        [name, JSON.stringify(enrichedConfig), description || '', icon_url || null, user.sub]
      );
      res.status(201).json(result.rows[0]);
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ error: `Model named '${name}' already exists` });
        return;
      }
      throw err;
    }
  } else {
    // Single model (existing behavior + detection)
    if (!connection_id || !litellm_model) {
      res.status(400).json({ error: 'name, connection_id, and litellm_model are required' });
      return;
    }
    if (routing_config) {
      res.status(400).json({ error: 'Single models must not have routing_config' });
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

    // Check platform model name collision
    const platformCollision = await pool.query(
      'SELECT name FROM model_catalog WHERE name = $1 AND is_active = true',
      [name]
    );
    if (platformCollision.rows.length > 0) {
      res.status(409).json({ error: `Name '${name}' conflicts with a platform model` });
      return;
    }

    // Auto-detect type from litellm_model, allow manual override
    const detected = detectModelType(litellm_model);
    const finalDetectedType = overrideDetectedType || detected.detected_type;
    const finalCapabilities = overrideCapabilities || detected.capabilities;

    try {
      const result = await pool.query(
        `INSERT INTO user_models (name, connection_id, litellm_model, description, model_type, detected_type, capabilities, icon_url, created_by)
         VALUES ($1, $2, $3, $4, 'single', $5, $6, $7, $8)
         RETURNING ${RETURNING_COLS}`,
        [name, connection_id, litellm_model, description || '', finalDetectedType, finalCapabilities, icon_url || null, user.sub]
      );
      res.status(201).json(result.rows[0]);
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ error: `Model named '${name}' already exists` });
        return;
      }
      throw err;
    }
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
  const {
    name, connection_id, litellm_model, description, is_active,
    model_type, routing_config, icon_url,
    detected_type: overrideDetectedType, capabilities: overrideCapabilities,
  } = req.body;

  // Verify ownership and get current model_type
  const existing = await pool.query(
    'SELECT id, model_type FROM user_models WHERE id = $1 AND created_by = $2',
    [id, user.sub]
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }

  const currentType = existing.rows[0].model_type;
  const newType = model_type || currentType;

  // Type transition: validate complete fields for new type
  if (newType === 'router') {
    if (routing_config !== undefined) {
      const validation = validateRoutingConfig(routing_config);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }
      const unownedId = await validateRouteConnectionOwnership(pool, routing_config.routes, user.sub);
      if (unownedId) {
        res.status(400).json({ error: 'Connection not found or not owned by you' });
        return;
      }
    }
  }

  // If changing connection on a single model, verify ownership of new connection
  if (connection_id !== undefined && newType === 'single') {
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
  if (model_type !== undefined) {
    setClauses.push(`model_type = $${paramIdx++}`);
    params.push(model_type);
  }
  if (connection_id !== undefined) {
    setClauses.push(`connection_id = $${paramIdx++}`);
    params.push(newType === 'router' ? null : connection_id);
  }
  if (litellm_model !== undefined) {
    setClauses.push(`litellm_model = $${paramIdx++}`);
    params.push(newType === 'router' ? null : litellm_model);
    // Re-detect when litellm_model changes on single models
    if (newType === 'single' && litellm_model) {
      const detected = detectModelType(litellm_model);
      setClauses.push(`detected_type = $${paramIdx++}`);
      params.push(overrideDetectedType || detected.detected_type);
      setClauses.push(`capabilities = $${paramIdx++}`);
      params.push(overrideCapabilities || detected.capabilities);
    }
  }
  if (routing_config !== undefined) {
    const enrichedConfig = newType === 'router' && routing_config
      ? { ...routing_config, routes: enrichRoutesWithDetection(routing_config.routes) }
      : routing_config;
    setClauses.push(`routing_config = $${paramIdx++}`);
    params.push(newType === 'single' ? null : JSON.stringify(enrichedConfig));
  }
  if (description !== undefined) {
    setClauses.push(`description = $${paramIdx++}`);
    params.push(description);
  }
  if (is_active !== undefined) {
    setClauses.push(`is_active = $${paramIdx++}`);
    params.push(is_active);
  }
  if (overrideDetectedType !== undefined && litellm_model === undefined) {
    setClauses.push(`detected_type = $${paramIdx++}`);
    params.push(overrideDetectedType);
  }
  if (overrideCapabilities !== undefined && litellm_model === undefined) {
    setClauses.push(`capabilities = $${paramIdx++}`);
    params.push(overrideCapabilities);
  }
  // icon_emoji is deprecated — ignored on writes, retained in reads for compatibility
  if ('icon_url' in req.body) {
    setClauses.push(`icon_url = $${paramIdx++}`);
    params.push(icon_url || null);
  }

  // Handle type transitions: clear fields for old type
  if (model_type !== undefined && model_type !== currentType) {
    if (newType === 'router') {
      setClauses.push(`connection_id = NULL`);
      setClauses.push(`litellm_model = NULL`);
    } else {
      setClauses.push(`routing_config = NULL`);
    }
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
       RETURNING ${RETURNING_COLS}`,
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
