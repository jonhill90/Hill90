/**
 * Secrets Vault UI — inventory + CRUD surface.
 *
 * Parses platform/vault/secrets-schema.yaml to produce a grouped
 * inventory of vault paths, key names, and consumer services.
 *
 * CRUD operations talk directly to OpenBao KV v2 API via BAO_TOKEN.
 * Secret values are write-only — the read endpoint returns key names,
 * never values.
 *
 * Endpoints:
 *   GET    /admin/secrets           — grouped inventory from schema
 *   GET    /admin/secrets/status    — vault seal status
 *   PUT    /admin/secrets/kv       — create or update a secret key
 *   DELETE /admin/secrets/kv       — delete a secret key
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { kvPut, kvDeleteKey, isVaultConfigured, getVaultAddr } from '../helpers/vault-client';

const router = Router();

// ───────────────────────────────────────────────────────────────────
// Schema loading
// ───────────────────────────────────────────────────────────────────

interface SchemaEntry {
  key: string;
  vault_path: string;
  compose_refs: string[];
  dedup?: string[];
}

interface SecretsSchema {
  runtime_secrets: SchemaEntry[];
  bootstrap_secrets?: string[];
  vault_management_secrets?: string[];
  vault_approle_services?: string[];
}

interface VaultPathGroup {
  path: string;
  keys: { key: string; consumers: string[] }[];
  keyCount: number;
}

let cachedSchema: SecretsSchema | null = null;

function loadSchema(): SecretsSchema {
  if (cachedSchema) return cachedSchema;

  const schemaPath = process.env.SECRETS_SCHEMA_PATH
    || path.resolve(__dirname, '../../../../platform/vault/secrets-schema.yaml');

  const raw = fs.readFileSync(schemaPath, 'utf8');
  cachedSchema = yaml.load(raw) as SecretsSchema;
  return cachedSchema;
}

/** Extract service name from compose filename (e.g., docker-compose.api.yml -> api). */
function extractService(composeRef: string): string {
  const match = composeRef.match(/docker-compose\.(.+)\.yml/);
  return match ? match[1] : composeRef;
}

/** Group schema entries by vault_path. */
function groupByPath(schema: SecretsSchema): VaultPathGroup[] {
  const grouped = new Map<string, { key: string; consumers: string[] }[]>();

  for (const entry of schema.runtime_secrets) {
    if (!grouped.has(entry.vault_path)) {
      grouped.set(entry.vault_path, []);
    }
    const consumers = [...new Set(entry.compose_refs.map(extractService))];
    grouped.get(entry.vault_path)!.push({ key: entry.key, consumers });
  }

  return Array.from(grouped.entries())
    .map(([vaultPath, keys]) => ({
      path: vaultPath,
      keys,
      keyCount: keys.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ───────────────────────────────────────────────────────────────────
// GET /admin/secrets — inventory
// ───────────────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  try {
    const schema = loadSchema();
    const inventory = groupByPath(schema);
    res.json({
      paths: inventory,
      totalPaths: inventory.length,
      totalKeys: schema.runtime_secrets.length,
      approleServices: schema.vault_approle_services || [],
    });
  } catch (err) {
    console.error('[secrets] Failed to load schema:', err);
    res.status(503).json({ error: 'Failed to load secrets schema' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /admin/secrets/status — vault health
// ───────────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  const vaultAddr = getVaultAddr();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    // OpenBao /sys/health returns non-200 for sealed (503), standby (429),
    // uninitialized (501), etc. — but always returns JSON body with status
    // fields. Use ?sealedcode=200&uninitcode=200&standbycode=200 to force
    // 200 for all states so fetch + json parsing always succeeds.
    const response = await fetch(
      `${vaultAddr}/v1/sys/health?sealedcode=200&uninitcode=200&standbycode=200`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON response — vault is reachable but returned unexpected content
      res.json({
        available: true,
        sealed: null,
        initialized: null,
        version: null,
        cluster_name: null,
        error: `Unexpected response (HTTP ${response.status})`,
      });
      return;
    }

    res.json({
      available: true,
      sealed: body.sealed ?? null,
      initialized: body.initialized ?? null,
      version: body.version ?? null,
      cluster_name: body.cluster_name ?? null,
    });
  } catch {
    res.json({
      available: false,
      sealed: null,
      initialized: null,
      version: null,
      cluster_name: null,
    });
  }
});

// ───────────────────────────────────────────────────────────────────
// PUT /admin/secrets/kv — create or update a secret key
// ───────────────────────────────────────────────────────────────────

router.put('/kv', async (req: Request, res: Response) => {
  if (!isVaultConfigured()) {
    res.status(503).json({ error: 'Vault token not configured' });
    return;
  }

  const { path: secretPath, key, value } = req.body as {
    path?: string;
    key?: string;
    value?: string;
  };

  if (!secretPath || !key || value === undefined || value === null) {
    res.status(400).json({ error: 'path, key, and value are required' });
    return;
  }

  // Normalize: strip secret/ prefix since KV v2 API path adds it
  const normalizedPath = secretPath.startsWith('secret/')
    ? secretPath.slice('secret/'.length)
    : secretPath;

  try {
    await kvPut(normalizedPath, key, value);
    const user = (req as any).user;
    console.log(
      `[secrets] Key written: ${secretPath}/${key} by ${user?.preferred_username || 'unknown'}`,
    );
    res.json({ ok: true, path: secretPath, key });
  } catch (err) {
    console.error('[secrets] Write failed:', err);
    res.status(502).json({
      error: 'Vault write failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ───────────────────────────────────────────────────────────────────
// DELETE /admin/secrets/kv — delete a secret key
// ───────────────────────────────────────────────────────────────────

router.delete('/kv', async (req: Request, res: Response) => {
  if (!isVaultConfigured()) {
    res.status(503).json({ error: 'Vault token not configured' });
    return;
  }

  const { path: secretPath, key } = req.body as {
    path?: string;
    key?: string;
  };

  if (!secretPath || !key) {
    res.status(400).json({ error: 'path and key are required' });
    return;
  }

  const normalizedPath = secretPath.startsWith('secret/')
    ? secretPath.slice('secret/'.length)
    : secretPath;

  try {
    await kvDeleteKey(normalizedPath, key);
    const user = (req as any).user;
    console.log(
      `[secrets] Key deleted: ${secretPath}/${key} by ${user?.preferred_username || 'unknown'}`,
    );
    res.json({ ok: true, path: secretPath, key });
  } catch (err) {
    console.error('[secrets] Delete failed:', err);
    res.status(502).json({
      error: 'Vault delete failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;

// For testing
export { loadSchema, groupByPath, extractService };
