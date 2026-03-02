/**
 * Internal event injection endpoint.
 *
 * Called by the AI service to append inference events to a running agent's
 * events.jsonl file. Authenticated via MODEL_ROUTER_INTERNAL_SERVICE_TOKEN
 * (same pattern as /internal/delegation-token).
 *
 * Not reachable externally — only on hill90_internal Docker network.
 */

import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { execInContainer } from '../services/docker';

const router = Router();

function validateServiceToken(req: Request, res: Response): boolean {
  const serviceToken = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
  if (!serviceToken) {
    res.status(503).json({ error: 'Service token not configured' });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(403).json({ error: 'Missing service token' });
    return false;
  }

  const token = authHeader.slice(7);
  const expected = Buffer.from(serviceToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(403).json({ error: 'Invalid service token' });
    return false;
  }

  return true;
}

router.post('/:agentId/events', async (req: Request, res: Response) => {
  try {
    if (!validateServiceToken(req, res)) return;

    const { agentId } = req.params;
    const { type, tool, input_summary, output_summary, duration_ms, success, metadata } = req.body;

    // Validate required fields
    if (!type || typeof type !== 'string' || !tool || typeof tool !== 'string' || !input_summary || typeof input_summary !== 'string') {
      res.status(400).json({ error: 'Missing required fields: type, tool, input_summary (all strings)' });
      return;
    }

    // Look up agent by agent_id slug
    const { rows } = await getPool().query(
      'SELECT agent_id, status FROM agents WHERE agent_id = $1',
      [agentId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    if (rows[0].status !== 'running') {
      res.status(409).json({ error: 'Agent is not running' });
      return;
    }

    // Build event with server-generated id and timestamp
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const event: Record<string, unknown> = {
      id: eventId,
      timestamp,
      type,
      tool,
      input_summary: input_summary.length > 200 ? input_summary.slice(0, 200) : input_summary,
      output_summary: output_summary ?? null,
      duration_ms: duration_ms ?? null,
      success: success ?? null,
    };
    if (metadata) {
      event.metadata = metadata;
    }

    const jsonLine = JSON.stringify(event);
    const b64 = Buffer.from(jsonLine + '\n').toString('base64');

    // Append via base64-encoded docker exec — safe from shell injection
    await execInContainer(agentId, [
      'sh', '-c', `echo ${b64} | base64 -d >> /var/log/agentbox/events.jsonl`,
    ]);

    res.json({ id: eventId });
  } catch (err: any) {
    console.error('[internal-events] Error:', err);
    res.status(500).json({ error: 'Failed to inject event' });
  }
});

export default router;
