import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { encryptProviderKey } from '../services/provider-key-crypto';
import axios from 'axios';

const router = Router();

function getEncryptionKey(): string {
  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) throw new Error('PROVIDER_KEY_ENCRYPTION_KEY not configured');
  return key;
}

// All routes require at least 'user' role
router.use(requireRole('user'));

// GET /provider-connections — list own connections
router.get('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const result = await pool.query(
    `SELECT id, name, provider, api_base_url, is_valid, created_at, updated_at
     FROM provider_connections
     WHERE created_by = $1
     ORDER BY created_at DESC`,
    [user.sub]
  );
  res.json(result.rows);
});

// POST /provider-connections — create connection with encrypted key
router.post('/', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { name, provider, api_key, api_base_url } = req.body;

  if (!name || !provider || !api_key) {
    res.status(400).json({ error: 'name, provider, and api_key are required' });
    return;
  }

  try {
    const { encrypted, nonce } = encryptProviderKey(api_key, getEncryptionKey());

    const result = await pool.query(
      `INSERT INTO provider_connections (name, provider, api_key_encrypted, api_key_nonce, api_base_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, provider, api_base_url, is_valid, created_at, updated_at`,
      [name, provider, encrypted, nonce, api_base_url || null, user.sub]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Connection named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// PUT /provider-connections/:id — update own connection
router.put('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;
  const { name, provider, api_key, api_base_url } = req.body;

  // Verify ownership
  const existing = await pool.query(
    'SELECT id FROM provider_connections WHERE id = $1 AND created_by = $2',
    [id, user.sub]
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`);
    params.push(name);
  }
  if (provider !== undefined) {
    setClauses.push(`provider = $${paramIdx++}`);
    params.push(provider);
  }
  if (api_key !== undefined) {
    const { encrypted, nonce } = encryptProviderKey(api_key, getEncryptionKey());
    setClauses.push(`api_key_encrypted = $${paramIdx++}`);
    params.push(encrypted);
    setClauses.push(`api_key_nonce = $${paramIdx++}`);
    params.push(nonce);
    // Reset validation status when key changes
    setClauses.push(`is_valid = NULL`);
  }
  if ('api_base_url' in req.body) {
    setClauses.push(`api_base_url = $${paramIdx++}`);
    params.push(api_base_url || null);
  }

  if (setClauses.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  setClauses.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE provider_connections SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, name, provider, api_base_url, is_valid, created_at, updated_at`,
      params
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: `Connection named '${name}' already exists` });
      return;
    }
    throw err;
  }
});

// DELETE /provider-connections/:id — delete own connection (cascades to user_models)
router.delete('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;

  const result = await pool.query(
    'DELETE FROM provider_connections WHERE id = $1 AND created_by = $2 RETURNING id',
    [id, user.sub]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  res.json({ deleted: true });
});

// POST /provider-connections/:id/validate — validate connection via AI service
router.post('/:id/validate', async (req: Request, res: Response) => {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }

  const user = (req as any).user;
  const { id } = req.params;

  // Fetch encrypted key (owner-scoped)
  const conn = await pool.query(
    `SELECT id, provider, api_key_encrypted, api_key_nonce, api_base_url
     FROM provider_connections
     WHERE id = $1 AND created_by = $2`,
    [id, user.sub]
  );

  if (conn.rows.length === 0) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const row = conn.rows[0];
  const aiServiceUrl = process.env.AI_SERVICE_URL || process.env.MODEL_ROUTER_URL || 'http://ai:8000';
  const serviceToken = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

  if (!serviceToken) {
    res.status(503).json({ error: 'Internal service token not configured' });
    return;
  }

  try {
    const response = await axios.post(
      `${aiServiceUrl}/internal/validate-provider`,
      {
        provider: row.provider,
        api_key_encrypted: Buffer.from(row.api_key_encrypted).toString('base64'),
        api_key_nonce: Buffer.from(row.api_key_nonce).toString('base64'),
        api_base_url: row.api_base_url,
      },
      {
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const isValid = response.data?.valid === true;
    await pool.query(
      'UPDATE provider_connections SET is_valid = $1, updated_at = NOW() WHERE id = $2',
      [isValid, id]
    );
    res.json({ id, is_valid: isValid });
  } catch (err: any) {
    // AI service returned an error or was unreachable
    const errorMsg = err.response?.data?.error || err.message;
    await pool.query(
      'UPDATE provider_connections SET is_valid = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    res.json({ id, is_valid: false, error: errorMsg });
  }
});

export default router;
