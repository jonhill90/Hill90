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

const EVENT_COLORS: Record<string, number> = {
  start: 0x5b9a2f,   // brand green
  stop: 0xf59e0b,    // amber
  error: 0xef4444,   // red
};

const EVENT_EMOJI: Record<string, string> = {
  start: '🟢',
  stop: '🟡',
  error: '🔴',
};

function isDiscordWebhook(url: string): boolean {
  return url.includes('discord.com/api/webhooks/') || url.includes('discordapp.com/api/webhooks/');
}

function formatDiscordPayload(event: string, parsed: Record<string, unknown>): string {
  return JSON.stringify({
    embeds: [{
      title: `${EVENT_EMOJI[event] || '⚪'} Agent ${event.charAt(0).toUpperCase() + event.slice(1)}`,
      description: `**${parsed.agent_id}** ${event === 'error' ? `failed: ${parsed.error || 'unknown error'}` : event === 'start' ? 'is now running' : 'has stopped'}`,
      color: EVENT_COLORS[event] || 0x6b7280,
      fields: [
        { name: 'Agent', value: String(parsed.agent_id || 'unknown'), inline: true },
        { name: 'Event', value: event, inline: true },
        ...(parsed.container_id ? [{ name: 'Container', value: String(parsed.container_id).slice(0, 12), inline: true }] : []),
      ],
      timestamp: parsed.timestamp || new Date().toISOString(),
      footer: { text: 'Hill90 Platform' },
    }],
  });
}

async function deliverWebhook(hook: WebhookRow, body: string): Promise<void> {
  const parsed = JSON.parse(body);
  const isDiscord = isDiscordWebhook(hook.url);

  // Discord webhooks get formatted as embeds
  const deliveryBody = isDiscord
    ? formatDiscordPayload(parsed.event || 'unknown', parsed)
    : body;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Hill90-Webhooks/1.0',
  };

  if (hook.secret && !isDiscord) {
    const signature = crypto
      .createHmac('sha256', hook.secret)
      .update(deliveryBody)
      .digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: deliveryBody,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[webhooks] Delivery to ${hook.url} returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`[webhooks] Delivery to ${hook.url} failed:`, err);
  }
}
