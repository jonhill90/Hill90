/**
 * Thin HTTP client for proxying requests to the knowledge service's
 * internal admin endpoints. Authenticated with AKM_INTERNAL_SERVICE_TOKEN.
 */

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_INTERNAL_SERVICE_TOKEN = process.env.AKM_INTERNAL_SERVICE_TOKEN;

export interface ProxyResponse {
  status: number;
  data: unknown;
}

async function proxyGet(path: string, params?: Record<string, string>): Promise<ProxyResponse> {
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

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
      },
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' } };
  }

  const data = await resp.json();
  return { status: resp.status, data };
}

export async function listAgents(): Promise<ProxyResponse> {
  return proxyGet('/internal/admin/agents');
}

export async function listEntries(agentId: string, type?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = { agent_id: agentId };
  if (type) params.type = type;
  return proxyGet('/internal/admin/entries', params);
}

export async function readEntry(agentId: string, path: string): Promise<ProxyResponse> {
  return proxyGet(`/internal/admin/entries/${encodeURIComponent(agentId)}/${path}`);
}

export async function searchEntries(q: string, agentId?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = { q };
  if (agentId) params.agent_id = agentId;
  return proxyGet('/internal/admin/search', params);
}

export async function createEntry(agentId: string, path: string, content: string): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' } };
  }

  const url = `${AKM_SERVICE_URL}/internal/admin/entries/${encodeURIComponent(agentId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, content }),
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' } };
  }

  const data = await resp.json();
  return { status: resp.status, data };
}

export async function appendJournal(agentId: string, content: string): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' } };
  }

  const url = `${AKM_SERVICE_URL}/internal/admin/journal/${encodeURIComponent(agentId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' } };
  }

  const data = await resp.json();
  return { status: resp.status, data };
}
