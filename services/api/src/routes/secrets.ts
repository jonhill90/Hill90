/**
 * Secrets Vault UI — read-only inventory surface (Phase 1, AI-147).
 *
 * Parses platform/vault/secrets-schema.yaml to produce a grouped
 * inventory of vault paths, key names, and consumer services.
 * NEVER exposes secret values — metadata only.
 *
 * Endpoints:
 *   GET /admin/secrets        — grouped inventory from schema
 *   GET /admin/secrets/status — vault seal status (degrades gracefully)
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

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

/** Extract service name from compose filename (e.g., docker-compose.api.yml → api). */
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
  const vaultAddr = process.env.VAULT_ADDR || process.env.BAO_ADDR || 'http://127.0.0.1:8200';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${vaultAddr}/v1/sys/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const body = await response.json() as Record<string, unknown>;
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

export default router;

// For testing
export { loadSchema, groupByPath, extractService };
