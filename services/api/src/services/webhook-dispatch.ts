import crypto from 'node:crypto';
import { getPool } from '../db/pool';

export type WebhookEvent = 'start' | 'stop' | 'error';

interface WebhookRow {
  id: string;
  url: string;
  secret: string | null;
}

/**
 * Fire-and-forget: POST event payload to all active webhooks for an agent.
 * Runs in background — never throws to caller.
 */
export function dispatchWebhooks(
  agentId: string,
  agentUuid: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): void {
  // Run async but don't await — caller should not block on webhook delivery
  void dispatchAsync(agentId, agentUuid, event, payload);
}

async function dispatchAsync(
  agentId: string,
  agentUuid: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { rows } = await getPool().query<WebhookRow>(
      `SELECT id, url, secret FROM agent_webhooks
       WHERE agent_id = $1 AND active = TRUE AND $2 = ANY(events)`,
      [agentUuid, event]
    );

    if (rows.length === 0) return;

    const body = JSON.stringify({
      event,
      agent_id: agentId,
      agent_uuid: agentUuid,
      timestamp: new Date().toISOString(),
      ...payload,
    });

    const deliveries = rows.map((hook) => deliverWebhook(hook, body));
    await Promise.allSettled(deliveries);
  } catch (err) {
    console.error(`[webhooks] Failed to dispatch ${event} for ${agentId}:`, err);
  }
}

async function deliverWebhook(hook: WebhookRow, body: string): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Hill90-Webhooks/1.0',
  };

  if (hook.secret) {
    const signature = crypto
      .createHmac('sha256', hook.secret)
      .update(body)
      .digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[webhooks] Delivery to ${hook.url} returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`[webhooks] Delivery to ${hook.url} failed:`, err);
  }
}
