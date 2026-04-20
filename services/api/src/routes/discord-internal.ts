/**
 * Internal Discord bot endpoints.
 *
 * Authenticated via DISCORD_BOT_SERVICE_TOKEN (timing-safe comparison).
 * Used by the discord-bot service to relay messages between Discord and Hill90 chat.
 *
 *   POST  /internal/discord/message         — relay a Discord message to a chat thread
 *   GET   /internal/discord/poll/:messageId  — poll for agent response status
 *   GET   /internal/discord/bindings         — list channel-agent bindings
 *   POST  /internal/discord/bindings         — create a channel-agent binding (admin)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';

const router = Router();

function verifyServiceToken(req: Request, res: Response): boolean {
  const configuredToken = process.env.DISCORD_BOT_SERVICE_TOKEN;
  if (!configuredToken) {
    res.status(503).json({ error: 'Discord bot not configured' });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }

  const token = authHeader.slice(7);
  const expected = Buffer.from(configuredToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }

  return true;
}

// ── Relay a Discord message to a chat thread ─────────────────────────
router.post('/message', async (req: Request, res: Response) => {
  if (!verifyServiceToken(req, res)) return;

  try {
    const { channel_id, discord_user_id, content } = req.body;
    if (!channel_id || !content) {
      res.status(400).json({ error: 'channel_id and content are required' });
      return;
    }

    // Look up channel binding
    const { rows: bindings } = await getPool().query(
      'SELECT agent_id, thread_id FROM discord_channel_bindings WHERE channel_id = $1',
      [channel_id],
    );

    if (bindings.length === 0) {
      res.status(404).json({ error: 'Channel not bound to an agent' });
      return;
    }

    const binding = bindings[0];
    let threadId = binding.thread_id;

    // Look up Hill90 user (optional — fall back to discord user ID)
    let userId = discord_user_id || 'discord-user';
    if (discord_user_id) {
      const { rows: userLinks } = await getPool().query(
        'SELECT hill90_user_id FROM discord_user_links WHERE discord_user_id = $1',
        [discord_user_id],
      );
      if (userLinks.length > 0) {
        userId = userLinks[0].hill90_user_id;
      }
    }

    // Create thread if none exists
    if (!threadId) {
      const { rows: newThread } = await getPool().query(
        `INSERT INTO chat_threads (title, created_by)
         VALUES ($1, $2) RETURNING id`,
        [`Discord: ${channel_id}`, userId],
      );
      threadId = newThread[0].id;

      // Update binding with thread ID
      await getPool().query(
        'UPDATE discord_channel_bindings SET thread_id = $1 WHERE channel_id = $2',
        [threadId, channel_id],
      );

      // Add participants
      await getPool().query(
        `INSERT INTO chat_participants (thread_id, participant_type, participant_id)
         VALUES ($1, 'user', $2), ($1, 'agent', $3)
         ON CONFLICT DO NOTHING`,
        [threadId, userId, binding.agent_id],
      );
    }

    // Insert user message
    const { rows: msgs } = await getPool().query(
      `INSERT INTO chat_messages (thread_id, author_type, author_id, content, status, seq)
       VALUES ($1, 'user', $2, $3, 'delivered', nextval('chat_messages_seq'))
       RETURNING id`,
      [threadId, userId, content],
    );

    const messageId = msgs[0].id;

    // Insert pending assistant message (agent will fill via callback)
    const { rows: assistantMsgs } = await getPool().query(
      `INSERT INTO chat_messages (thread_id, author_type, author_id, content, status, seq)
       VALUES ($1, 'agent', $2, '', 'pending', nextval('chat_messages_seq'))
       RETURNING id`,
      [threadId, binding.agent_id],
    );

    const assistantMessageId = assistantMsgs[0].id;

    // Update thread timestamp
    await getPool().query(
      'UPDATE chat_threads SET updated_at = NOW() WHERE id = $1',
      [threadId],
    );

    res.json({
      thread_id: threadId,
      user_message_id: messageId,
      assistant_message_id: assistantMessageId,
      agent_id: binding.agent_id,
    });
  } catch (err) {
    console.error('[discord-internal] message error:', err);
    res.status(500).json({ error: 'Failed to relay message' });
  }
});

// ── Poll for agent response ──────────────────────────────────────────
router.get('/poll/:messageId', async (req: Request, res: Response) => {
  if (!verifyServiceToken(req, res)) return;

  try {
    const { rows } = await getPool().query(
      'SELECT status, content, error_message FROM chat_messages WHERE id = $1',
      [req.params.messageId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const msg = rows[0];
    res.json({
      status: msg.status,
      content: msg.content || '',
      error: msg.error_message || null,
    });
  } catch (err) {
    console.error('[discord-internal] poll error:', err);
    res.status(500).json({ error: 'Failed to poll message' });
  }
});

// ── List bindings ────────────────────────────────────────────────────
router.get('/bindings', async (req: Request, res: Response) => {
  if (!verifyServiceToken(req, res)) return;

  try {
    const { rows } = await getPool().query(
      `SELECT dcb.*, a.name AS agent_name, a.agent_id AS agent_slug
       FROM discord_channel_bindings dcb
       JOIN agents a ON dcb.agent_id = a.id
       ORDER BY dcb.created_at DESC`,
    );
    res.json(rows);
  } catch (err) {
    console.error('[discord-internal] bindings error:', err);
    res.status(500).json({ error: 'Failed to list bindings' });
  }
});

// ── Create binding ───────────────────────────────────────────────────
router.post('/bindings', async (req: Request, res: Response) => {
  if (!verifyServiceToken(req, res)) return;

  try {
    const { channel_id, guild_id, agent_id, created_by } = req.body;
    if (!channel_id || !guild_id || !agent_id) {
      res.status(400).json({ error: 'channel_id, guild_id, and agent_id are required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_channel_bindings (channel_id, guild_id, agent_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id) DO UPDATE SET agent_id = $3
       RETURNING *`,
      [channel_id, guild_id, agent_id, created_by || 'admin'],
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[discord-internal] create binding error:', err);
    res.status(500).json({ error: 'Failed to create binding' });
  }
});

export default router;
