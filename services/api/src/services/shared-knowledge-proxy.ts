/**
 * Thin HTTP client for proxying requests to the knowledge service's
 * shared knowledge internal admin endpoints.
 * Authenticated with AKM_INTERNAL_SERVICE_TOKEN (same token as AKM proxy).
 */

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_INTERNAL_SERVICE_TOKEN = process.env.AKM_INTERNAL_SERVICE_TOKEN;

export interface ProxyResponse {
  status: number;
  data: unknown;
}

async function proxyRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' } };
  }

  const url = new URL(`${AKM_SERVICE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' } };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return { status: 502, data: { error: 'Knowledge service returned non-JSON response' } };
  }
  return { status: resp.status, data };
}

// Collections

export async function listCollections(owner?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = {};
  if (owner) params.owner = owner;
  return proxyRequest('GET', '/internal/admin/shared/collections', params);
}

export async function getCollection(id: string): Promise<ProxyResponse> {
  return proxyRequest('GET', `/internal/admin/shared/collections/${id}`);
}

export async function createCollection(body: {
  name: string;
  description?: string;
  visibility?: string;
  created_by: string;
}): Promise<ProxyResponse> {
  return proxyRequest('POST', '/internal/admin/shared/collections', undefined, body);
}

export async function updateCollection(
  id: string,
  body: { name?: string; description?: string; visibility?: string },
): Promise<ProxyResponse> {
  return proxyRequest('PUT', `/internal/admin/shared/collections/${id}`, undefined, body);
}

export async function deleteCollection(id: string): Promise<ProxyResponse> {
  return proxyRequest('DELETE', `/internal/admin/shared/collections/${id}`);
}

// Sources

export async function listSources(collectionId: string): Promise<ProxyResponse> {
  return proxyRequest('GET', '/internal/admin/shared/sources', {
    collection_id: collectionId,
  });
}

export async function getSource(id: string): Promise<ProxyResponse> {
  return proxyRequest('GET', `/internal/admin/shared/sources/${id}`);
}

export async function createSource(body: {
  collection_id: string;
  title: string;
  source_type: string;
  raw_content?: string;
  source_url?: string;
  created_by: string;
}): Promise<ProxyResponse> {
  return proxyRequest('POST', '/internal/admin/shared/sources', undefined, body);
}

export async function deleteSource(id: string): Promise<ProxyResponse> {
  return proxyRequest('DELETE', `/internal/admin/shared/sources/${id}`);
}

// Search

export async function searchShared(params: {
  q: string;
  collection_id?: string;
  owner?: string;
  requester_id: string;
  requester_type?: string;
  limit?: string;
}): Promise<ProxyResponse> {
  return proxyRequest('GET', '/internal/admin/shared/search', params as Record<string, string>);
}

// Stats

export async function getStats(since?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = {};
  if (since) params.since = since;
  return proxyRequest('GET', '/internal/admin/shared/stats', params);
}
