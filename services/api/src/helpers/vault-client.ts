/**
 * Vault (OpenBao) KV v2 client for secrets CRUD operations.
 *
 * Authenticates via BAO_TOKEN env var. The token must have
 * appropriate policy permissions (policy-secrets-admin).
 */

const getVaultAddr = () =>
  process.env.VAULT_ADDR || process.env.BAO_ADDR || 'http://openbao:8200';

const getVaultToken = () => process.env.BAO_TOKEN || '';

interface VaultKvResponse {
  data: {
    data: Record<string, string>;
    metadata: {
      version: number;
      created_time: string;
      destroyed: boolean;
    };
  };
}

async function vaultFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getVaultToken();
  if (!token) {
    throw new Error('BAO_TOKEN not configured — vault write operations unavailable');
  }

  const url = `${getVaultAddr()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'X-Vault-Token': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Read all keys at a KV v2 path. Returns key-value pairs (values masked). */
export async function kvRead(
  secretPath: string,
): Promise<{ data: Record<string, string>; version: number } | null> {
  const res = await vaultFetch(`/v1/secret/data/${secretPath}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vault read failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as VaultKvResponse;
  return {
    data: json.data.data,
    version: json.data.metadata.version,
  };
}

/** Write/update a key within a KV v2 path. Merges with existing keys via patch. */
export async function kvPut(
  secretPath: string,
  key: string,
  value: string,
): Promise<void> {
  // Read existing data first to merge
  const existing = await kvRead(secretPath);
  const data = existing ? { ...existing.data } : {};
  data[key] = value;

  const res = await vaultFetch(`/v1/secret/data/${secretPath}`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vault write failed (${res.status}): ${body}`);
  }
}

/** Delete a single key from a KV v2 path. Rewrites remaining keys. */
export async function kvDeleteKey(
  secretPath: string,
  key: string,
): Promise<void> {
  const existing = await kvRead(secretPath);
  if (!existing) {
    throw new Error(`Path not found: ${secretPath}`);
  }
  if (!(key in existing.data)) {
    throw new Error(`Key not found: ${key} in ${secretPath}`);
  }

  const data = { ...existing.data };
  delete data[key];

  if (Object.keys(data).length === 0) {
    // Delete entire path if no keys remain
    const res = await vaultFetch(`/v1/secret/metadata/${secretPath}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vault delete failed (${res.status}): ${body}`);
    }
  } else {
    // Rewrite without the deleted key
    const res = await vaultFetch(`/v1/secret/data/${secretPath}`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vault rewrite failed (${res.status}): ${body}`);
    }
  }
}

/** List secret paths under a prefix. */
export async function kvList(prefix: string): Promise<string[]> {
  const res = await vaultFetch(`/v1/secret/metadata/${prefix}?list=true`);
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vault list failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { keys: string[] } };
  return json.data.keys;
}

export function isVaultConfigured(): boolean {
  return !!getVaultToken();
}
