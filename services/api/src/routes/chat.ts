/**
 * Chat Lane Phase 1 — Direct threads.
 *
 * Endpoints:
 *   GET    /chat/threads                  — list threads (participant-scoped)
 *   POST   /chat/threads                  — create thread + send first message
 *   GET    /chat/threads/:id              — thread detail with messages
 *   PUT    /chat/threads/:id              — update title
 *   DELETE /chat/threads/:id              — delete thread (owner/admin)
 *   POST   /chat/threads/:id/messages     — send message
 *   GET    /chat/threads/:id/stream       — SSE stream with cursor
 *
 * Internal:
 *   POST   /internal/chat/callback        — agentbox delivers response
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin, getAgentElevatedScope } from '../helpers/elevated-scope';
import { dispatchChatWork } from '../services/chat-dispatch';

const router = Router();

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

const MESSAGE_HISTORY_LIMIT = 50;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Check if user is a participant in a thread (or admin). */
async function isParticipant(threadId: string, userId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'human'
     LIMIT 1`,
    [threadId, userId]
  );
  return rows.length > 0;
}

/** Check if user is the thread owner (or admin). */
async function isThreadOwner(threadId: string, userId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2
       AND participant_type = 'human' AND role = 'owner'
     LIMIT 1`,
    [threadId, userId]
  );
  return rows.length > 0;
}

/** Get agent info needed for dispatch. */
async function getAgentForDispatch(agentUuid: string): Promise<{
  id: string;
  agent_id: string;
  status: string;
  work_token: string | null;
  models: string[];
} | null> {
  const { rows } = await getPool().query(
    `SELECT a.id, a.agent_id, a.status, a.work_token,
            COALESCE(mp.allowed_models, '[]'::jsonb) AS models
     FROM agents a
     LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
     WHERE a.id = $1`,
    [agentUuid]
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Find the agent participant UUID for a direct thread. */
async function getThreadAgent(threadId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT participant_id FROM chat_participants
     WHERE thread_id = $1 AND participant_type = 'agent'
     LIMIT 1`,
    [threadId]
  );
  return rows.length > 0 ? rows[0].participant_id : null;
}

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads — list threads for current user
// ───────────────────────────────────────────────────────────────────

router.get('/threads', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    let query: string;
    let params: any[];

    if (admin) {
      query = `SELECT t.id, t.type, t.title, t.created_by, t.created_at, t.updated_at,
                      (SELECT content FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_message,
                      (SELECT author_type FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_author_type
               FROM chat_threads t
               ORDER BY t.updated_at DESC`;
      params = [];
    } else {
      query = `SELECT t.id, t.type, t.title, t.created_by, t.created_at, t.updated_at,
                      (SELECT content FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_message,
                      (SELECT author_type FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_author_type
               FROM chat_threads t
               JOIN chat_participants cp ON cp.thread_id = t.id
               WHERE cp.participant_id = $1 AND cp.participant_type = 'human'
               ORDER BY t.updated_at DESC`;
      params = [user.sub];
    }

    const { rows } = await getPool().query(query, params);

    // Truncate last_message for preview
    const threads = rows.map((r: any) => ({
      ...r,
      last_message: r.last_message
        ? r.last_message.length > 100 ? r.last_message.slice(0, 100) + '...' : r.last_message
        : null,
    }));

    res.json(threads);
  } catch (err) {
    console.error('[chat] List threads error:', err);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads — create thread + first message + dispatch
// ───────────────────────────────────────────────────────────────────

router.post('/threads', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { agent_id, message, title, idempotency_key } = req.body;

    if (!agent_id) {
      res.status(400).json({ error: 'agent_id is required' });
      return;
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    // Look up agent by UUID
    const agent = await getAgentForDispatch(agent_id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Dispatch pre-checks (§4 ordered)
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running' });
      return;
    }
    if (!agent.work_token) {
      res.status(409).json({ error: 'Agent is not ready for work' });
      return;
    }

    // Elevated scope check
    const elevatedScope = await getAgentElevatedScope(agent.id);
    if (elevatedScope && !isAdmin(req)) {
      res.status(403).json({ error: `Sending to agents with ${elevatedScope} skills requires admin role` });
      return;
    }

    // Pick model (first allowed model, fallback to gpt-4o-mini)
    const models: string[] = Array.isArray(agent.models) ? agent.models : [];
    const model = models[0] || 'gpt-4o-mini';

    const pool = getPool();

    // Create thread
    const { rows: [thread] } = await pool.query(
      `INSERT INTO chat_threads (type, title, created_by)
       VALUES ('direct', $1, $2)
       RETURNING id, type, title, created_by, created_at, updated_at`,
      [title || null, user.sub]
    );

    // Add participants
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
       VALUES ($1, $2, 'human', 'owner'), ($1, $3, 'agent', 'member')`,
      [thread.id, user.sub, agent.id]
    );

    // Create user message
    await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key)
       VALUES ($1, $2, 'human', 'user', $3, 'complete', $4)`,
      [thread.id, user.sub, message.trim(), idempotency_key || null]
    );

    // Create assistant placeholder
    const { rows: [placeholder] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status)
       VALUES ($1, $2, 'agent', 'assistant', '', 'pending')
       RETURNING id`,
      [thread.id, agent.id]
    );

    // Dispatch to agentbox (fire-and-forget style — don't block response)
    const callbackUrl = 'http://api:3000/internal/chat/callback';
    const messages = [{ role: 'user', content: message.trim() }];

    dispatchChatWork({
      agentId: agent.agent_id,
      workToken: agent.work_token,
      threadId: thread.id,
      messageId: placeholder.id,
      messages,
      model,
      callbackUrl,
    }).catch(err => {
      console.error(`[chat] Dispatch failed for thread=${thread.id}:`, err);
    });

    res.status(201).json({
      thread: {
        ...thread,
        agent: { id: agent.id, agent_id: agent.agent_id },
      },
      message_id: placeholder.id,
    });
  } catch (err: any) {
    // Handle idempotency violation
    if (err.code === '23505' && err.constraint === 'idx_chat_messages_idempotency') {
      res.status(409).json({ error: 'Duplicate message (idempotency key already used)' });
      return;
    }
    console.error('[chat] Create thread error:', err);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id — thread detail with messages
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isParticipant(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const pool = getPool();

    // Get thread
    const { rows: threadRows } = await pool.query(
      `SELECT id, type, title, created_by, created_at, updated_at
       FROM chat_threads WHERE id = $1`,
      [req.params.id]
    );
    if (threadRows.length === 0) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Get participants
    const { rows: participants } = await pool.query(
      `SELECT participant_id, participant_type, role, joined_at
       FROM chat_participants WHERE thread_id = $1`,
      [req.params.id]
    );

    // Get messages
    const { rows: messages } = await pool.query(
      `SELECT id, seq, author_id, author_type, role, content, status,
              model, input_tokens, output_tokens, duration_ms,
              error_message, created_at
       FROM chat_messages WHERE thread_id = $1
       ORDER BY seq ASC`,
      [req.params.id]
    );

    // Reconcile stale pending messages (cleanup path 3: thread load)
    const now = Date.now();
    const staleIds = messages
      .filter((m: any) => m.status === 'pending' && (now - new Date(m.created_at).getTime()) > STALE_TIMEOUT_MS)
      .map((m: any) => m.id);

    if (staleIds.length > 0) {
      await pool.query(
        `UPDATE chat_messages
         SET status = 'error', error_message = 'Response timed out',
             seq = nextval('chat_messages_seq')
         WHERE id = ANY($1) AND status = 'pending'`,
        [staleIds]
      );
      // Update local copies for response
      for (const msg of messages) {
        if (staleIds.includes(msg.id)) {
          msg.status = 'error';
          msg.error_message = 'Response timed out';
        }
      }
    }

    res.json({
      ...threadRows[0],
      participants,
      messages,
    });
  } catch (err) {
    console.error('[chat] Get thread error:', err);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// PUT /chat/threads/:id — update title
// ───────────────────────────────────────────────────────────────────

router.put('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isThreadOwner(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { title } = req.body;
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE chat_threads SET title = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, type, title, created_by, created_at, updated_at`,
      [title ?? null, req.params.id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[chat] Update thread error:', err);
    res.status(500).json({ error: 'Failed to update thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// DELETE /chat/threads/:id — delete thread (owner/admin)
// ───────────────────────────────────────────────────────────────────

router.delete('/threads/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    if (!(await isThreadOwner(req.params.id, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { rowCount } = await getPool().query(
      `DELETE FROM chat_threads WHERE id = $1`,
      [req.params.id]
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('[chat] Delete thread error:', err);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/messages — send message
// ───────────────────────────────────────────────────────────────────

router.post('/threads/:id/messages', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { message, idempotency_key } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    // Find agent for this thread
    const agentUuid = await getThreadAgent(threadId);
    if (!agentUuid) {
      res.status(400).json({ error: 'No agent participant found in thread' });
      return;
    }

    const agent = await getAgentForDispatch(agentUuid);
    if (!agent) {
      res.status(409).json({ error: 'Agent not found' });
      return;
    }

    // Dispatch pre-checks (§4 ordered)
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running' });
      return;
    }
    if (!agent.work_token) {
      res.status(409).json({ error: 'Agent is not ready for work' });
      return;
    }

    // Concurrency guard: no pending assistant message in thread for this agent
    const { rows: pendingRows } = await getPool().query(
      `SELECT 1 FROM chat_messages
       WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'
       LIMIT 1`,
      [threadId, agent.id]
    );
    if (pendingRows.length > 0) {
      res.status(409).json({ error: 'Agent is still responding to a previous message' });
      return;
    }

    // Elevated scope check
    const elevatedScope = await getAgentElevatedScope(agent.id);
    if (elevatedScope && !isAdmin(req)) {
      res.status(403).json({ error: `Sending to agents with ${elevatedScope} skills requires admin role` });
      return;
    }

    const pool = getPool();

    // Create user message
    await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key)
       VALUES ($1, $2, 'human', 'user', $3, 'complete', $4)`,
      [threadId, user.sub, message.trim(), idempotency_key || null]
    );

    // Create assistant placeholder
    const { rows: [placeholder] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status)
       VALUES ($1, $2, 'agent', 'assistant', '', 'pending')
       RETURNING id`,
      [threadId, agent.id]
    );

    // Update thread timestamp
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`,
      [threadId]
    );

    // Load message history for dispatch (last N user/assistant messages)
    const { rows: history } = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE thread_id = $1 AND status = 'complete'
       ORDER BY seq DESC LIMIT $2`,
      [threadId, MESSAGE_HISTORY_LIMIT]
    );
    // Reverse to chronological order (query returns newest first)
    const messages = history.reverse();

    // Pick model
    const models: string[] = Array.isArray(agent.models) ? agent.models : [];
    const model = models[0] || 'gpt-4o-mini';

    // Dispatch to agentbox
    const callbackUrl = 'http://api:3000/internal/chat/callback';

    dispatchChatWork({
      agentId: agent.agent_id,
      workToken: agent.work_token,
      threadId,
      messageId: placeholder.id,
      messages,
      model,
      callbackUrl,
    }).catch(err => {
      console.error(`[chat] Dispatch failed for thread=${threadId}:`, err);
    });

    res.status(201).json({ message_id: placeholder.id });
  } catch (err: any) {
    if (err.code === '23505' && err.constraint === 'idx_chat_messages_idempotency') {
      res.status(409).json({ error: 'Duplicate message (idempotency key already used)' });
      return;
    }
    console.error('[chat] Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/stream — SSE with DB-backed cursor
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/stream', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Parse cursor from Last-Event-ID (default: 0)
    let cursor = 0;
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      const parsed = parseInt(lastEventId as string, 10);
      if (!isNaN(parsed)) cursor = parsed;
    }

    const poll = async () => {
      if (res.writableEnded || res.destroyed) return;

      try {
        const { rows } = await getPool().query(
          `SELECT id, seq, author_id, author_type, role, content, status,
                  model, input_tokens, output_tokens, duration_ms,
                  error_message, created_at
           FROM chat_messages
           WHERE thread_id = $1 AND seq > $2
           ORDER BY seq ASC`,
          [threadId, cursor]
        );

        for (const row of rows) {
          if (res.writableEnded || res.destroyed) return;
          res.write(`id: ${row.seq}\nevent: message\ndata: ${JSON.stringify(row)}\n\n`);
          cursor = row.seq;
        }
      } catch (err) {
        console.error('[chat] SSE poll error:', err);
      }
    };

    // Initial backfill
    await poll();

    // Poll loop
    const interval = setInterval(poll, 1000);

    // Keep-alive heartbeat (every 30s)
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(': heartbeat\n\n');
    }, 30000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
    });

  } catch (err) {
    console.error('[chat] SSE stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start stream' });
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// Internal callback handler (separate router, no Keycloak auth)
// ───────────────────────────────────────────────────────────────────

export async function chatCallbackHandler(req: Request, res: Response): Promise<void> {
  // Auth: CHAT_CALLBACK_TOKEN (timing-safe)
  const configuredToken = process.env.CHAT_CALLBACK_TOKEN;
  if (!configuredToken) {
    console.error('[chat-callback] CHAT_CALLBACK_TOKEN not configured');
    res.status(503).json({ error: 'callback_not_configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const expected = Buffer.from(configuredToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Parse callback body
  const { message_id, content, model, input_tokens, output_tokens, duration_ms, status, error_message } = req.body;

  if (!message_id) {
    res.status(400).json({ error: 'message_id is required' });
    return;
  }

  // Reject non-null idempotency_key from agent-authored messages (§D18)
  if (req.body.idempotency_key !== undefined && req.body.idempotency_key !== null) {
    res.status(400).json({ error: 'idempotency_key is not allowed in callback' });
    return;
  }

  const finalStatus = status === 'error' ? 'error' : 'complete';

  const pool = getPool();

  // Guarded UPDATE: only pending → terminal (§7.5 idempotency rules)
  // Advances seq so SSE cursor picks up the state transition
  const { rowCount } = await pool.query(
    `UPDATE chat_messages
     SET content = $2, status = $3, model = $4,
         input_tokens = $5, output_tokens = $6, duration_ms = $7,
         error_message = $8, seq = nextval('chat_messages_seq')
     WHERE id = $1 AND status = 'pending'`,
    [message_id, content || '', finalStatus, model || null,
     input_tokens || null, output_tokens || null, duration_ms || null,
     error_message || null]
  );

  if (rowCount === 0) {
    // Check if message exists at all
    const { rows } = await pool.query(
      `SELECT status FROM chat_messages WHERE id = $1`,
      [message_id]
    );

    if (rows.length === 0) {
      // Unknown message_id — case (c)
      console.warn(`[chat-callback] Unknown message_id: ${message_id}`);
      res.status(404).json({ error: 'unknown_message' });
      return;
    }

    // Already terminal — case (b): no-op
    console.info(`[chat-callback] Callback no-op: message ${message_id} already terminal (${rows[0].status})`);
    res.json({ updated: false });
    return;
  }

  // Successful update — case (a)
  console.info(`[chat-callback] Updated message ${message_id}: status=${finalStatus}`);

  // Update thread timestamp
  await pool.query(
    `UPDATE chat_threads SET updated_at = NOW()
     WHERE id = (SELECT thread_id FROM chat_messages WHERE id = $1)`,
    [message_id]
  );

  res.json({ updated: true });
}

// ───────────────────────────────────────────────────────────────────
// Stale message sweeper (§9, cleanup path 2)
// ───────────────────────────────────────────────────────────────────

let staleSweepInterval: ReturnType<typeof setInterval> | null = null;

export function startStaleSweeper(): void {
  if (staleSweepInterval) return;

  staleSweepInterval = setInterval(async () => {
    try {
      const { rowCount } = await getPool().query(
        `UPDATE chat_messages
         SET status = 'error', error_message = 'Response timed out',
             seq = nextval('chat_messages_seq')
         WHERE status = 'pending' AND created_at < NOW() - INTERVAL '2 minutes'`
      );
      if (rowCount && rowCount > 0) {
        console.log(`[chat-sweeper] Marked ${rowCount} stale pending message(s) as error`);
      }
    } catch (err) {
      console.error('[chat-sweeper] Error:', err);
    }
  }, 60_000);
}

export function stopStaleSweeper(): void {
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
    staleSweepInterval = null;
  }
}

export default router;
