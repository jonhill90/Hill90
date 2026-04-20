/**
 * Hill90 API client for the CLI.
 */

export class Hill90Client {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path}: ${res.status} ${text}`);
    }
    return res.json();
  }

  async health(): Promise<any> {
    return this.request('GET', '/health');
  }

  async listAgents(): Promise<any[]> {
    return this.request('GET', '/agents');
  }

  async getAgent(id: string): Promise<any> {
    return this.request('GET', `/agents/${id}`);
  }

  async listThreads(): Promise<any[]> {
    return this.request('GET', '/chat/threads');
  }

  async createThread(agentId: string, title?: string): Promise<any> {
    return this.request('POST', '/chat/threads', {
      agent_id: agentId,
      title: title || `CLI session`,
    });
  }

  async sendMessage(threadId: string, content: string): Promise<any> {
    return this.request('POST', `/chat/threads/${threadId}/messages`, { content });
  }

  async *streamResponse(threadId: string, lastSeq?: number): AsyncGenerator<string> {
    const url = `${this.baseUrl}/chat/threads/${threadId}/stream${lastSeq ? `?after=${lastSeq}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) yield parsed.content;
            } catch { /* ignore parse errors */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
