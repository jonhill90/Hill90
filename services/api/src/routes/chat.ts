/**
 * Chat Lane Phase 1B — Group threads + multi-agent dispatch.
 *
 * Endpoints:
 *   GET    /chat/threads                  — list threads (participant-scoped)
 *   POST   /chat/threads                  — create thread + send first message
 *   GET    /chat/threads/:id              — thread detail with messages
 *   PUT    /chat/threads/:id              — update title
 *   DELETE /chat/threads/:id              — delete thread (owner/admin)
 *   PUT    /chat/threads/:id/participants — add/remove agent participants
 *   POST   /chat/threads/:id/messages     — send message (multi-agent dispatch)
 *   POST   /chat/threads/:id/cancel       — cancel all pending messages
 *   GET    /chat/threads/:id/stream       — SSE stream with cursor
 *   GET    /chat/threads/:id/events       — thread-scoped agent event stream (SSE)
 *
 * Internal:
 *   POST   /internal/chat/callback        — agentbox delivers response
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin, getAgentElevatedScope } from '../helpers/elevated-scope';
import { auditLog } from '../helpers/audit';
import { dispatchChatWork } from '../services/chat-dispatch';
import { execInContainer } from '../services/docker';
import { appendJournal } from '../services/akm-proxy';

const router = Router();

// ───────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────

const MESSAGE_HISTORY_LIMIT = 50;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_AGENTS_PER_GROUP = 8;
const MAX_CHAIN_HOPS = parseInt(process.env.MAX_CHAIN_HOPS || '5', 10);
const MAX_CHAIN_DURATION_MS = parseInt(process.env.MAX_CHAIN_DURATION_MS || '60000', 10);
const DEFAULT_CHAT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'claude-sonnet-4-20250514';

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

/** Check if user is a participant in a thread (or admin). */
async function isParticipant(threadId: string, userId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM chat_participants
     WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'human'
       AND left_at IS NULL
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
  name: string;
  status: string;
  work_token: string | null;
  models: string[];
} | null> {
  const { rows } = await getPool().query(
    `SELECT a.id, a.agent_id, a.name, a.status, a.work_token,
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
     WHERE thread_id = $1 AND participant_type = 'agent' AND left_at IS NULL
     LIMIT 1`,
    [threadId]
  );
  return rows.length > 0 ? rows[0].participant_id : null;
}

/** Get all active agent participant UUIDs for a thread. */
async function getThreadAgents(threadId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT participant_id FROM chat_participants
     WHERE thread_id = $1 AND participant_type = 'agent' AND left_at IS NULL`,
    [threadId]
  );
  return rows.map((r: any) => r.participant_id);
}

/** Get thread type and lead_agent_id. */
async function getThreadType(threadId: string): Promise<{ type: string; lead_agent_id: string | null } | null> {
  const { rows } = await getPool().query(
    `SELECT type, lead_agent_id FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  return rows.length > 0 ? { type: rows[0].type, lead_agent_id: rows[0].lead_agent_id } : null;
}

/**
 * Parse @-mentions from message content.
 * Returns { slugs: string[], cleanContent: string }.
 * Slugs are extracted from ^@slug or \s@slug patterns.
 */
function parseMentions(content: string): { slugs: string[]; cleanContent: string } {
  const mentionPattern = /(?:^|\s)@([a-z0-9][a-z0-9-]*)/g;
  const slugs: string[] = [];
  let match;
  while ((match = mentionPattern.exec(content)) !== null) {
    slugs.push(match[1]);
  }
  // Strip @-mentions from content sent to agents
  const cleanContent = content.replace(/(?:^|\s)@([a-z0-9][a-z0-9-]*)/g, '').trim();
  return { slugs: [...new Set(slugs)], cleanContent: cleanContent || content.trim() };
}

/**
 * Resolve agent slugs to participant UUIDs in a thread.
 * Returns Map<slug, uuid> or throws with unknown slug.
 */
async function resolveAgentSlugs(threadId: string, slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();

  const { rows } = await getPool().query(
    `SELECT a.agent_id AS slug, cp.participant_id
     FROM chat_participants cp
     JOIN agents a ON a.id = cp.participant_id::uuid
     WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL
       AND a.agent_id = ANY($2)`,
    [threadId, slugs]
  );

  const resolved = new Map<string, string>();
  for (const row of rows) {
    resolved.set(row.slug, row.participant_id);
  }
  return resolved;
}

/**
 * Dispatch chat work to a set of agents. Shared by human-send and agent-to-agent orchestration.
 * Creates assistant placeholder messages (sequential), then fires dispatch calls (parallel).
 */
async function dispatchToAgents(opts: {
  threadId: string;
  agents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[];
  replyTo: string;
  historyMessages: { role: string; content: string }[];
  chainId?: string | null;
  chainHop?: number | null;
  triggeredBy?: string | null;
  threadType?: string;
  participants?: { agent_id: string; name: string }[];
  leadAgentId?: string | null;
}): Promise<{
  dispatched: { agent_id: string; message_id: string }[];
  failed: { agent_id: string; message_id: string; reason: string }[];
}> {
  const pool = getPool();
  const callbackUrl = 'http://api:3000/internal/chat/callback';
  const dispatched: { agent_id: string; message_id: string }[] = [];
  const failed: { agent_id: string; message_id: string; reason: string }[] = [];

  // Phase 1: Create all placeholders sequentially (DB inserts are fast, seq ordering matters)
  const placeholders: { agent: typeof opts.agents[0]; placeholderId: string; model: string }[] = [];
  for (const agent of opts.agents) {
    const models: string[] = Array.isArray(agent.models) ? agent.models : [];
    const model = models[0] || DEFAULT_CHAT_MODEL;

    const chainCols = opts.chainId ? ', chain_id, chain_hop, triggered_by' : '';
    const chainPlaceholders = opts.chainId ? ', $4, $5, $6' : '';
    const chainParams = opts.chainId
      ? [opts.chainId, opts.chainHop ?? null, opts.triggeredBy ?? null]
      : [];

    const { rows: [placeholder] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, reply_to${chainCols})
       VALUES ($1, $2, 'agent', 'assistant', '', 'pending', $3${chainPlaceholders})
       RETURNING id`,
      [opts.threadId, agent.id, opts.replyTo, ...chainParams]
    );

    placeholders.push({ agent, placeholderId: placeholder.id, model });
  }

  // Phase 2: Dispatch all work items in parallel
  // In collaborative mode (leadAgentId set), the lead agent gets collaborator
  // context so it knows which agents are available for consultation.
  const collaboratorList = opts.leadAgentId
    ? opts.agents
        .filter(a => a.id !== opts.leadAgentId)
        .map(a => ({ agent_id: a.agent_id, name: a.name || a.agent_id }))
    : undefined;

  const results = await Promise.allSettled(
    placeholders.map(({ agent, placeholderId, model }) =>
      dispatchChatWork({
        agentId: agent.agent_id,
        workToken: agent.work_token!,
        threadId: opts.threadId,
        messageId: placeholderId,
        messages: opts.historyMessages,
        model,
        callbackUrl,
        threadType: opts.threadType,
        participants: opts.participants,
        isLead: opts.leadAgentId ? agent.id === opts.leadAgentId : undefined,
        collaborators: opts.leadAgentId && agent.id === opts.leadAgentId ? collaboratorList : undefined,
      })
    )
  );

  // Phase 3: Map settled results to dispatched/failed
  for (let i = 0; i < results.length; i++) {
    const { agent, placeholderId } = placeholders[i];
    const result = results[i];

    if (result.status === 'fulfilled' && result.value.accepted) {
      dispatched.push({ agent_id: agent.id, message_id: placeholderId });
    } else {
      const reason = result.status === 'rejected'
        ? String(result.reason)
        : (result.value.error || 'not accepted');
      console.error(`[chat] Dispatch failed for agent=${agent.agent_id}: ${reason}`);
      try {
        await pool.query(
          `UPDATE chat_messages SET status = 'error', error_message = 'Dispatch failed',
           seq = nextval('chat_messages_seq')
           WHERE id = $1 AND status = 'pending'`,
          [placeholderId]
        );
      } catch (updateErr) {
        console.error(`[chat] Failed to mark dispatch error:`, updateErr);
      }
      failed.push({ agent_id: agent.id, message_id: placeholderId, reason: 'dispatch_failed' });
    }
  }

  return { dispatched, failed };
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
      query = `SELECT t.id, t.type, t.title, t.created_by, t.lead_agent_id, t.created_at, t.updated_at,
                      (SELECT content FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_message,
                      (SELECT author_type FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_author_type
               FROM chat_threads t
               ORDER BY t.updated_at DESC`;
      params = [];
    } else {
      query = `SELECT t.id, t.type, t.title, t.created_by, t.lead_agent_id, t.created_at, t.updated_at,
                      (SELECT content FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_message,
                      (SELECT author_type FROM chat_messages
                       WHERE thread_id = t.id ORDER BY seq DESC LIMIT 1) AS last_author_type
               FROM chat_threads t
               JOIN chat_participants cp ON cp.thread_id = t.id
               WHERE cp.participant_id = $1 AND cp.participant_type = 'human' AND cp.left_at IS NULL
               ORDER BY t.updated_at DESC`;
      params = [user.sub];
    }

    const { rows } = await getPool().query(query, params);

    // Enrich with participant info
    const threadIds = rows.map((r: any) => r.id);
    let participantMap = new Map<string, any[]>();
    if (threadIds.length > 0) {
      const { rows: participants } = await getPool().query(
        `SELECT cp.thread_id, cp.participant_id, cp.participant_type, cp.role, cp.left_at,
                a.agent_id, a.name AS agent_name, a.status AS agent_status
         FROM chat_participants cp
         LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
         WHERE cp.thread_id = ANY($1) AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
        [threadIds]
      );
      for (const p of participants) {
        const list = participantMap.get(p.thread_id) || [];
        list.push(p);
        participantMap.set(p.thread_id, list);
      }
    }

    const threads = rows.map((r: any) => {
      const agents = participantMap.get(r.id) || [];
      return {
        ...r,
        last_message: r.last_message
          ? r.last_message.length > 100 ? r.last_message.slice(0, 100) + '...' : r.last_message
          : null,
        agent_count: agents.length,
        agents: agents.map((a: any) => ({
          id: a.participant_id,
          agent_id: a.agent_id,
          name: a.agent_name,
          status: a.agent_status,
        })),
        // Backward compat: single agent field for direct threads
        agent: agents.length === 1 ? {
          id: agents[0].participant_id,
          agent_id: agents[0].agent_id,
          name: agents[0].agent_name,
          status: agents[0].agent_status,
        } : undefined,
      };
    });

    res.json(threads);
  } catch (err) {
    console.error('[chat] List threads error:', err);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads — create thread + first message + dispatch
// Supports both direct (single agent_id) and group (agent_ids[]) creation
// ───────────────────────────────────────────────────────────────────

router.post('/threads', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { agent_id, agent_ids, message, title, idempotency_key, lead_agent_id } = req.body;

    // Resolve agent UUIDs: support both single agent_id and array agent_ids
    let agentUuids: string[];
    if (agent_ids && Array.isArray(agent_ids) && agent_ids.length > 0) {
      agentUuids = agent_ids;
    } else if (agent_id) {
      agentUuids = [agent_id];
    } else {
      res.status(400).json({ error: 'agent_id or agent_ids is required' });
      return;
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    // Determine thread type
    const threadType = agentUuids.length === 1 ? 'direct' : 'group';

    // Validate agent count for groups
    if (threadType === 'group' && agentUuids.length > MAX_AGENTS_PER_GROUP) {
      res.status(400).json({ error: `Maximum ${MAX_AGENTS_PER_GROUP} agents per group thread` });
      return;
    }

    // Validate lead_agent_id for collaborative mode
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (lead_agent_id) {
      if (typeof lead_agent_id !== 'string' || !UUID_RE.test(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be a valid UUID' });
        return;
      }
      if (threadType !== 'group') {
        res.status(400).json({ error: 'lead_agent_id is only valid for group threads (requires agent_ids with 2+ agents)' });
        return;
      }
      if (!agentUuids.includes(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be one of the agent_ids' });
        return;
      }
    }

    // Look up all agents
    const agents: Awaited<ReturnType<typeof getAgentForDispatch>>[] = [];
    for (const uuid of agentUuids) {
      const agent = await getAgentForDispatch(uuid);
      if (!agent) {
        res.status(404).json({ error: `Agent not found: ${uuid}` });
        return;
      }
      agents.push(agent);
    }

    // Pre-flight: elevated scope strict deny (D1a)
    for (const agent of agents) {
      const elevatedScope = await getAgentElevatedScope(agent!.id);
      if (elevatedScope && !admin) {
        auditLog('chat_elevated_denied', agent!.agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /chat/threads' });
        res.status(403).json({
          error: `Elevated agent ${agent!.name || agent!.agent_id} (${elevatedScope}) requires admin privileges`,
        });
        return;
      }
    }

    // Classify agents for dispatch (before DB writes to avoid orphans)
    const dispatchableAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];
    const skipped: { agent_id: string; reason: string }[] = [];

    for (const agent of agents) {
      if (agent!.status !== 'running' || !agent!.work_token) {
        skipped.push({ agent_id: agent!.id, reason: 'not_running' });
      } else {
        dispatchableAgents.push(agent!);
      }
    }

    // Pre-flight: at least one agent must be running
    if (dispatchableAgents.length === 0) {
      res.status(400).json({ error: 'No available agents — all selected agents are not running' });
      return;
    }

    // In collaborative mode, only dispatch to the lead agent (others are collaborators)
    const agentsToDispatch = lead_agent_id
      ? dispatchableAgents.filter(a => a.id === lead_agent_id)
      : dispatchableAgents;

    if (lead_agent_id && agentsToDispatch.length === 0) {
      // Lead agent isn't running — reject before creating thread
      res.status(409).json({ error: 'Lead agent is not running' });
      return;
    }

    const pool = getPool();

    // Create thread
    const { rows: [thread] } = await pool.query(
      `INSERT INTO chat_threads (type, title, created_by, lead_agent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, title, created_by, lead_agent_id, created_at, updated_at`,
      [threadType, title || null, user.sub, lead_agent_id || null]
    );

    // Add participants: human owner + all agents
    const participantValues: string[] = [];
    const participantParams: any[] = [thread.id, user.sub];
    participantValues.push(`($1, $2, 'human', 'owner')`);
    let paramIdx = 3;
    for (const agent of agents) {
      participantValues.push(`($1, $${paramIdx}, 'agent', 'member')`);
      participantParams.push(agent!.id);
      paramIdx++;
    }
    await pool.query(
      `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
       VALUES ${participantValues.join(', ')}`,
      participantParams
    );

    // Create user message
    const { rows: [userMsg] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key)
       VALUES ($1, $2, 'human', 'user', $3, 'complete', $4)
       RETURNING id, seq`,
      [thread.id, user.sub, message.trim(), idempotency_key || null]
    );

    // Build participant list for group context (all agents, not just dispatch targets)
    const participantList = threadType === 'group'
      ? agents.map(a => ({ agent_id: a!.agent_id, name: a!.name || a!.agent_id }))
      : undefined;

    // Dispatch via shared helper (parallel dispatch, §7a placeholder-then-dispatch pattern)
    const historyMessages = [{ role: 'user', content: message.trim() }];
    const { dispatched, failed } = await dispatchToAgents({
      threadId: thread.id,
      agents: agentsToDispatch,
      replyTo: userMsg.id,
      historyMessages,
      threadType: threadType || undefined,
      participants: participantList,
      leadAgentId: lead_agent_id || null,
    });

    // Direct thread backward compat response
    if (threadType === 'direct') {
      res.status(201).json({
        thread: {
          ...thread,
          agent: { id: agents[0]!.id, agent_id: agents[0]!.agent_id },
        },
        message_id: dispatched[0]?.message_id || failed[0]?.message_id || null,
      });
      return;
    }

    // Group thread response with three-array contract
    res.status(201).json({
      thread,
      user_message: { id: userMsg.id, seq: userMsg.seq },
      dispatched,
      skipped,
      failed,
    });
  } catch (err: any) {
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
      `SELECT id, type, title, created_by, lead_agent_id, created_at, updated_at
       FROM chat_threads WHERE id = $1`,
      [req.params.id]
    );
    if (threadRows.length === 0) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Get participants with agent info
    const { rows: participants } = await pool.query(
      `SELECT cp.participant_id, cp.participant_type, cp.role, cp.joined_at, cp.left_at,
              a.agent_id, a.name AS agent_name, a.status AS agent_status
       FROM chat_participants cp
       LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1`,
      [req.params.id]
    );

    // Get messages (include reply_to, target_agents, chain columns for group threads)
    const { rows: messages } = await pool.query(
      `SELECT id, seq, author_id, author_type, role, content, status,
              reply_to, target_agents,
              chain_id, chain_hop, triggered_by,
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

    const { title, lead_agent_id } = req.body;
    if (title !== undefined && title !== null && typeof title !== 'string') {
      res.status(400).json({ error: 'title must be a string or null' });
      return;
    }

    // Validate lead_agent_id if provided
    if (lead_agent_id !== undefined && lead_agent_id !== null) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (typeof lead_agent_id !== 'string' || !UUID_RE.test(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be a valid UUID or null' });
        return;
      }
      // Verify it's an active agent participant in this thread
      const agentUuids = await getThreadAgents(req.params.id);
      if (!agentUuids.includes(lead_agent_id)) {
        res.status(400).json({ error: 'lead_agent_id must be an active agent participant in the thread' });
        return;
      }
    }

    // Build dynamic SET clause
    const setClauses = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;

    if (title !== undefined) {
      setClauses.push(`title = $${idx}`);
      params.push(title ?? null);
      idx++;
    }
    if (lead_agent_id !== undefined) {
      setClauses.push(`lead_agent_id = $${idx}`);
      params.push(lead_agent_id ?? null);
      idx++;
    }

    params.push(req.params.id);
    const { rows } = await getPool().query(
      `UPDATE chat_threads SET ${setClauses.join(', ')}
       WHERE id = $${idx}
       RETURNING id, type, title, created_by, lead_agent_id, created_at, updated_at`,
      params
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

    auditLog('chat_thread_delete', req.params.id, user.sub, 'human', {
      thread_id: req.params.id,
      admin_override: admin && !(await isThreadOwner(req.params.id, user.sub, false)),
    });

    res.json({ deleted: true });
  } catch (err) {
    console.error('[chat] Delete thread error:', err);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ───────────────────────────────────────────────────────────────────
// PUT /chat/threads/:id/participants — add/remove agent participants
// ───────────────────────────────────────────────────────────────────

router.put('/threads/:id/participants', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isThreadOwner(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { add, remove } = req.body;
    const pool = getPool();

    // Validate add list
    if (add && Array.isArray(add)) {
      // Check agent count would not exceed limit
      const currentAgents = await getThreadAgents(threadId);
      const newCount = currentAgents.length + add.filter((id: string) => !currentAgents.includes(id)).length;
      if (newCount > MAX_AGENTS_PER_GROUP) {
        res.status(400).json({ error: `Maximum ${MAX_AGENTS_PER_GROUP} agents per group thread` });
        return;
      }

      // Elevated scope check for added agents
      for (const agentUuid of add) {
        const elevatedScope = await getAgentElevatedScope(agentUuid);
        if (elevatedScope && !admin) {
          auditLog('chat_elevated_denied', agentUuid, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'PUT /chat/threads/:id/participants' });
          res.status(403).json({
            error: `Elevated agent ${agentUuid} (${elevatedScope}) requires admin privileges`,
          });
          return;
        }
      }

      for (const agentUuid of add) {
        // Upsert: if already a participant, clear left_at. Otherwise, insert.
        await pool.query(
          `INSERT INTO chat_participants (thread_id, participant_id, participant_type, role)
           VALUES ($1, $2, 'agent', 'member')
           ON CONFLICT (thread_id, participant_id, participant_type)
           DO UPDATE SET left_at = NULL`,
          [threadId, agentUuid]
        );
      }

      // Auto-promote direct → group when more than 1 agent
      const postAddAgents = await getThreadAgents(threadId);
      if (postAddAgents.length > 1) {
        await pool.query(
          `UPDATE chat_threads SET type = 'group' WHERE id = $1 AND type = 'direct'`,
          [threadId]
        );
      }
    }

    // Process removals
    if (remove && Array.isArray(remove)) {
      for (const agentUuid of remove) {
        // Mark pending messages from this agent as error
        await pool.query(
          `UPDATE chat_messages
           SET status = 'error', error_message = 'Agent removed from thread',
               seq = nextval('chat_messages_seq')
           WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'`,
          [threadId, agentUuid]
        );

        // Set left_at
        await pool.query(
          `UPDATE chat_participants SET left_at = NOW()
           WHERE thread_id = $1 AND participant_id = $2 AND participant_type = 'agent'`,
          [threadId, agentUuid]
        );
      }
    }

    // Return updated participant list
    const { rows: participants } = await pool.query(
      `SELECT cp.participant_id, cp.participant_type, cp.role, cp.joined_at, cp.left_at,
              a.agent_id, a.name AS agent_name, a.status AS agent_status
       FROM chat_participants cp
       LEFT JOIN agents a ON cp.participant_type = 'agent' AND a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1`,
      [threadId]
    );

    res.json({ participants });
  } catch (err) {
    console.error('[chat] Update participants error:', err);
    res.status(500).json({ error: 'Failed to update participants' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/messages — send message (multi-agent dispatch)
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

    const threadInfo = await getThreadType(threadId);
    if (!threadInfo) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    const threadType = threadInfo.type;
    const leadAgentId = threadInfo.lead_agent_id;

    // Parse @-mentions
    const { slugs, cleanContent } = parseMentions(message.trim());

    // Get all active agent participants
    const allAgentUuids = await getThreadAgents(threadId);
    if (allAgentUuids.length === 0) {
      res.status(400).json({ error: 'No agent participant found in thread' });
      return;
    }

    // Resolve target agents
    let targetAgentUuids: string[];
    let targetAgentsJson: string[] | null = null;

    if (slugs.length > 0) {
      // @-mention routing
      const resolved = await resolveAgentSlugs(threadId, slugs);
      const unknown = slugs.filter(s => !resolved.has(s));
      if (unknown.length > 0) {
        res.status(400).json({ error: `Unknown agent: @${unknown[0]}` });
        return;
      }
      targetAgentUuids = [...resolved.values()];
      targetAgentsJson = targetAgentUuids;
    } else {
      // Dispatch to all active agents
      targetAgentUuids = allAgentUuids;
    }

    // Load agent info for all targets
    const targetAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];
    for (const uuid of targetAgentUuids) {
      const agent = await getAgentForDispatch(uuid);
      if (agent) targetAgents.push(agent);
    }

    if (targetAgents.length === 0) {
      res.status(400).json({ error: 'No available agents' });
      return;
    }

    // Pre-flight: elevated scope strict deny (D1a)
    for (const agent of targetAgents) {
      const elevatedScope = await getAgentElevatedScope(agent.id);
      if (elevatedScope && !admin) {
        auditLog('chat_elevated_denied', agent.agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /chat/threads/:id/messages' });
        res.status(403).json({
          error: `Elevated agent ${agent.name || agent.agent_id} (${elevatedScope}) requires admin privileges`,
        });
        return;
      }
    }

    // Classify agents
    const pool = getPool();
    const dispatchable: typeof targetAgents = [];
    const skipped: { agent_id: string; reason: string }[] = [];

    for (const agent of targetAgents) {
      if (agent.status !== 'running' || !agent.work_token) {
        skipped.push({ agent_id: agent.id, reason: 'not_running' });
        continue;
      }

      // Per-agent concurrency guard
      const { rows: pendingRows } = await pool.query(
        `SELECT 1 FROM chat_messages
         WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'
         LIMIT 1`,
        [threadId, agent.id]
      );
      if (pendingRows.length > 0) {
        skipped.push({ agent_id: agent.id, reason: 'has_pending' });
        continue;
      }

      dispatchable.push(agent);
    }

    // For direct threads: all-unavailable = error
    if (threadType === 'direct' && dispatchable.length === 0) {
      const reason = skipped[0]?.reason;
      if (reason === 'has_pending') {
        res.status(409).json({ error: 'Agent is still responding to a previous message' });
      } else {
        res.status(409).json({ error: 'Agent is not running' });
      }
      return;
    }

    // For group threads: at least one agent must be dispatchable
    if (threadType === 'group' && dispatchable.length === 0) {
      res.status(409).json({ error: 'No agents available for dispatch (all pending or not running)' });
      return;
    }

    // Create user message
    const { rows: [userMsg] } = await pool.query(
      `INSERT INTO chat_messages (thread_id, author_id, author_type, role, content, status, idempotency_key, target_agents)
       VALUES ($1, $2, 'human', 'user', $3, 'complete', $4, $5)
       RETURNING id, seq`,
      [threadId, user.sub, message.trim(), idempotency_key || null, targetAgentsJson ? JSON.stringify(targetAgentsJson) : null]
    );

    // Update thread timestamp
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`,
      [threadId]
    );

    // Load message history for dispatch
    const { rows: history } = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE thread_id = $1 AND status = 'complete'
       ORDER BY seq DESC LIMIT $2`,
      [threadId, MESSAGE_HISTORY_LIMIT]
    );
    const historyMessages = history.reverse();

    // Build participant list for group context (all thread agents, not just targets)
    let participantList: { agent_id: string; name: string }[] | undefined;
    if (threadType === 'group') {
      const allAgentInfos = await Promise.all(allAgentUuids.map(getAgentForDispatch));
      participantList = allAgentInfos
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map(a => ({ agent_id: a.agent_id, name: a.name || a.agent_id }));
    }

    // In collaborative mode, only dispatch to the lead agent
    const agentsToDispatch = leadAgentId
      ? dispatchable.filter(a => a.id === leadAgentId)
      : dispatchable;

    if (leadAgentId && agentsToDispatch.length === 0) {
      res.status(409).json({ error: 'Lead agent is not running or has a pending response' });
      return;
    }

    // Dispatch to each dispatchable agent via shared helper
    const { dispatched, failed: failedArr } = await dispatchToAgents({
      threadId,
      agents: agentsToDispatch,
      replyTo: userMsg.id,
      historyMessages,
      threadType: threadType || undefined,
      participants: participantList,
      leadAgentId,
    });

    // Direct thread backward compat response
    if (threadType === 'direct') {
      res.status(201).json({ message_id: dispatched[0]?.message_id || failedArr[0]?.message_id || null });
      return;
    }

    // Group thread three-array response
    res.status(201).json({
      user_message: { id: userMsg.id, seq: userMsg.seq },
      dispatched,
      skipped,
      failed: failedArr,
    });
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
// POST /chat/threads/:id/cancel — cancel all pending messages
// ───────────────────────────────────────────────────────────────────

router.post('/threads/:id/cancel', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const { rowCount } = await getPool().query(
      `UPDATE chat_messages
       SET status = 'error', error_message = 'Cancelled by user',
           seq = nextval('chat_messages_seq')
       WHERE thread_id = $1 AND status = 'pending'`,
      [threadId]
    );

    res.json({ cancelled: rowCount || 0 });
  } catch (err) {
    console.error('[chat] Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel messages' });
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
                  reply_to, target_agents,
                  chain_id, chain_hop, triggered_by,
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
// GET /chat/threads/:id/events — thread-scoped agent event stream (SSE)
// Server-side validated, correlation-filtered. No unfiltered bypass.
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/events', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // Resolve active agents in thread
    const pool = getPool();
    const { rows: agentParticipants } = await pool.query(
      `SELECT cp.participant_id, a.agent_id, a.status
       FROM chat_participants cp
       JOIN agents a ON a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
      [threadId]
    );

    const runningAgents = agentParticipants.filter((a: any) => a.status === 'running');
    if (runningAgents.length === 0) {
      res.status(409).json({ error: 'No running agents in thread' });
      return;
    }

    // Get message IDs in this thread for correlation filtering
    const { rows: messageRows } = await pool.query(
      `SELECT id FROM chat_messages WHERE thread_id = $1`,
      [threadId]
    );
    const threadMessageIds = new Set(messageRows.map((r: any) => r.id));

    const follow = req.query.follow === 'true';
    const parsedTail = parseInt(req.query.tail as string);
    const tail = Number.isNaN(parsedTail) ? 20 : Math.max(0, parsedTail);

    if (!follow) {
      // One-shot: collect events from all running agents, filter, return JSON
      const allEvents: any[] = [];

      for (const agent of runningAgents) {
        try {
          const stream = await execInContainer(agent.agent_id, [
            'tail', '-n', String(tail), '/var/log/agentbox/events.jsonl',
          ]);

          const events = await new Promise<any[]>((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf-8');
              const parsed = raw.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(line => { try { return JSON.parse(line); } catch { return null; } })
                .filter((e: any) => e !== null);
              resolve(parsed);
            });
            stream.on('error', reject);
          });

          // Correlation filter: match on top-level correlation_id or metadata.message_id
          for (const event of events) {
            const cid = event.correlation_id || event.metadata?.message_id;
            if (cid && threadMessageIds.has(cid)) {
              allEvents.push(event);
            }
          }
        } catch (err) {
          console.error(`[chat-events] Failed to read events from ${agent.agent_id}:`, err);
        }
      }

      // Sort by timestamp
      allEvents.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      res.json(allEvents);
      return;
    }

    // SSE mode: stream events from all running agents, correlation-filtered
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const streams: NodeJS.ReadableStream[] = [];
    const buffers = new Map<string, string>();

    for (const agent of runningAgents) {
      try {
        const stream = await execInContainer(agent.agent_id, [
          'tail', '-f', '-n', String(tail), '/var/log/agentbox/events.jsonl',
        ]);
        streams.push(stream);
        buffers.set(agent.agent_id, '');

        stream.on('data', (chunk: Buffer) => {
          if (res.writableEnded || res.destroyed) return;
          let buffer = (buffers.get(agent.agent_id) || '') + chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffers.set(agent.agent_id, lines.pop() || '');

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: any;
            try { event = JSON.parse(trimmed); } catch { continue; }
            // Correlation filter: match on top-level correlation_id or metadata.message_id
            const cid = event.correlation_id || event.metadata?.message_id;
            if (cid && threadMessageIds.has(cid)) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
        });

        stream.on('end', () => {
          // Flush remaining buffer
          const remaining = buffers.get(agent.agent_id)?.trim();
          if (remaining) {
            try {
              const event = JSON.parse(remaining);
              const cid = event.correlation_id || event.metadata?.message_id;
              if (cid && threadMessageIds.has(cid)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            } catch { /* skip */ }
          }
        });

        stream.on('error', (err: Error) => {
          console.error(`[chat-events] Stream error for ${agent.agent_id}:`, err);
        });
      } catch (err) {
        console.error(`[chat-events] Failed to open stream for ${agent.agent_id}:`, err);
      }
    }

    // Periodically refresh thread message IDs (new messages during conversation)
    const messageRefreshInterval = setInterval(async () => {
      if (res.writableEnded || res.destroyed) return;
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_messages WHERE thread_id = $1`,
          [threadId]
        );
        threadMessageIds.clear();
        for (const r of rows) threadMessageIds.add(r.id);
      } catch { /* ignore */ }
    }, 5000);

    // Keep-alive heartbeat
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(': heartbeat\n\n');
    }, 30000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(messageRefreshInterval);
      clearInterval(heartbeat);
      for (const stream of streams) {
        (stream as any).destroy?.();
      }
    });

  } catch (err) {
    console.error('[chat] Thread events error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to get thread events' });
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/screenshot — live browser screenshot from agentbox
// ───────────────────────────────────────────────────────────────────

const AGENTBOX_PORT = 8054;

router.get('/threads/:id/screenshot', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT a.agent_id
       FROM chat_participants cp
       JOIN agents a ON a.id = cp.participant_id::uuid
       WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND a.status = 'running'
       LIMIT 1`,
      [threadId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'No running agent in thread' });
      return;
    }

    const agentId = rows[0].agent_id;
    const url = `http://agentbox-${agentId}:${AGENTBOX_PORT}/screenshot`;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      res.status(504).json({ error: 'Agentbox screenshot timed out' });
      return;
    }
    console.error('[chat] Screenshot proxy error:', err);
    res.status(502).json({ error: 'Failed to get screenshot from agentbox' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /chat/threads/:id/browser/* — proxy browser control to agentbox
// ───────────────────────────────────────────────────────────────────

async function proxyBrowserAction(
  req: Request,
  res: Response,
  action: 'click' | 'element' | 'navigate' | 'history',
  body: any
): Promise<void> {
  const user = (req as any).user;
  const admin = isAdmin(req);
  const threadId = req.params.id;

  if (!(await isParticipant(threadId, user.sub, admin))) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.agent_id
     FROM chat_participants cp
     JOIN agents a ON a.id = cp.participant_id::uuid
     WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND a.status = 'running'
     LIMIT 1`,
    [threadId]
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'No running agent in thread' });
    return;
  }

  const agentId = rows[0].agent_id;
  const url = `http://agentbox-${agentId}:${AGENTBOX_PORT}/browser/${action}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    if (err.name === 'TimeoutError') {
      res.status(504).json({ error: `Browser ${action} timed out` });
      return;
    }
    console.error(`[chat] Browser ${action} proxy error:`, err);
    res.status(502).json({ error: `Failed to forward ${action} to agentbox` });
  }
}

router.post('/threads/:id/browser-click', requireRole('user'), async (req: Request, res: Response) => {
  const { x_percent, y_percent } = req.body;
  if (typeof x_percent !== 'number' || typeof y_percent !== 'number') {
    res.status(400).json({ error: 'x_percent and y_percent required' });
    return;
  }
  await proxyBrowserAction(req, res, 'click', { x_percent, y_percent });
});

router.post('/threads/:id/browser-element', requireRole('user'), async (req: Request, res: Response) => {
  const { x_percent, y_percent } = req.body;
  if (typeof x_percent !== 'number' || typeof y_percent !== 'number') {
    res.status(400).json({ error: 'x_percent and y_percent required' });
    return;
  }
  await proxyBrowserAction(req, res, 'element', { x_percent, y_percent });
});

router.post('/threads/:id/browser-navigate', requireRole('user'), async (req: Request, res: Response) => {
  const { url } = req.body;
  if (typeof url !== 'string' || !url) {
    res.status(400).json({ error: 'url required' });
    return;
  }
  await proxyBrowserAction(req, res, 'navigate', { url });
});

router.post('/threads/:id/browser-history', requireRole('user'), async (req: Request, res: Response) => {
  const { action } = req.body;
  if (!['back', 'forward', 'reload'].includes(action)) {
    res.status(400).json({ error: 'action must be back|forward|reload' });
    return;
  }
  await proxyBrowserAction(req, res, 'history', { action });
});

// ───────────────────────────────────────────────────────────────────
// GET /chat/threads/:id/search — full-text search messages
// ───────────────────────────────────────────────────────────────────

router.get('/threads/:id/search', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const threadId = req.params.id;

    if (!(await isParticipant(threadId, user.sub, admin))) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: 'q query parameter is required' });
      return;
    }

    const pool = getPool();

    // Use plainto_tsquery for safe user input (no special syntax needed)
    const { rows } = await pool.query(
      `SELECT id, seq, author_id, author_type, role, content, status,
              reply_to, target_agents,
              chain_id, chain_hop, triggered_by,
              model, input_tokens, output_tokens, duration_ms,
              error_message, created_at,
              ts_headline('english', content, plainto_tsquery('english', $2),
                'StartSel=**,StopSel=**,MaxFragments=3,MaxWords=40,MinWords=20') AS headline
       FROM chat_messages
       WHERE thread_id = $1
         AND status IN ('complete', 'thinking')
         AND content != ''
         AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) DESC
       LIMIT 50`,
      [threadId, q]
    );

    res.json({ results: rows, query: q, total: rows.length });
  } catch (err) {
    console.error('[chat] Search error:', err);
    res.status(500).json({ error: 'Search failed' });
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

  const pool = getPool();

  // Thinking callbacks are intermediate progress updates during tool loops.
  // They update content + advance seq (so SSE picks up) but stay non-terminal.
  if (status === 'thinking') {
    const { rowCount } = await pool.query(
      `UPDATE chat_messages
       SET content = $2, status = 'thinking', model = $3,
           input_tokens = $4, output_tokens = $5, duration_ms = $6,
           seq = nextval('chat_messages_seq')
       WHERE id = $1 AND status IN ('pending', 'thinking')`,
      [message_id, content || '', model || null,
       input_tokens || null, output_tokens || null, duration_ms || null]
    );

    if (rowCount === 0) {
      const { rows } = await pool.query(
        `SELECT status FROM chat_messages WHERE id = $1`,
        [message_id]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'unknown_message' });
        return;
      }
      // Already terminal — ignore thinking update
      res.json({ updated: false });
      return;
    }

    console.info(`[chat-callback] Thinking update for message ${message_id}`);
    // Update thread timestamp for thinking updates too
    await pool.query(
      `UPDATE chat_threads SET updated_at = NOW()
       WHERE id = (SELECT thread_id FROM chat_messages WHERE id = $1)`,
      [message_id]
    );
    res.json({ updated: true });
    return;
  }

  const finalStatus = status === 'error' ? 'error' : 'complete';

  // Guarded UPDATE: only non-terminal → terminal (§7.5 idempotency rules)
  // Advances seq so SSE cursor picks up the state transition
  const { rowCount } = await pool.query(
    `UPDATE chat_messages
     SET content = $2, status = $3, model = $4,
         input_tokens = $5, output_tokens = $6, duration_ms = $7,
         error_message = $8, seq = nextval('chat_messages_seq')
     WHERE id = $1 AND status IN ('pending', 'thinking')`,
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
      console.warn(`[chat-callback] Unknown message_id: ${message_id}`);
      res.status(404).json({ error: 'unknown_message' });
      return;
    }

    // Already terminal — no-op
    console.info(`[chat-callback] Callback no-op: message ${message_id} already terminal (${rows[0].status})`);
    res.json({ updated: false });
    return;
  }

  console.info(`[chat-callback] Updated message ${message_id}: status=${finalStatus}`);

  // Update thread timestamp + auto-name untitled threads from first user message
  await pool.query(
    `UPDATE chat_threads SET updated_at = NOW(),
       title = CASE
         WHEN title IS NULL THEN (
           SELECT LEFT(content, 50) FROM chat_messages
           WHERE thread_id = chat_threads.id AND author_type = 'human'
           ORDER BY created_at ASC LIMIT 1
         )
         ELSE title
       END
     WHERE id = (SELECT thread_id FROM chat_messages WHERE id = $1)`,
    [message_id]
  );

  // ── Auto-journal: persist interaction to agent memory (fire-and-forget) ──
  if (finalStatus === 'complete' && content && process.env.AKM_INTERNAL_SERVICE_TOKEN) {
    try {
      const { rows: journalRows } = await pool.query(
        `SELECT m.author_id, a.agent_id AS agent_slug
         FROM chat_messages m
         JOIN agents a ON a.id = m.author_id
         WHERE m.id = $1 AND m.author_type = 'agent'`,
        [message_id]
      );
      if (journalRows.length > 0) {
        const agentSlug = journalRows[0].agent_slug;
        const tokenCount = (input_tokens || 0) + (output_tokens || 0);
        const preview = (content || '').length > 300
          ? content.slice(0, 300) + '…'
          : content;
        const journalContent =
          `**Chat response** (${model || 'unknown'}, ${tokenCount} tokens, ${duration_ms || 0}ms)\n\n${preview}`;
        appendJournal(agentSlug, journalContent).catch((err: unknown) => {
          console.error('[chat-callback] Journal append failed (non-blocking):', err);
        });
      }
    } catch (journalErr) {
      console.error('[chat-callback] Journal lookup failed (non-blocking):', journalErr);
    }
  }

  // ── Batch completion detection for group threads ──
  // Check if all sibling messages (same reply_to) are terminal
  try {
    const { rows: batchRows } = await pool.query(
      `SELECT m.reply_to, t.type AS thread_type
       FROM chat_messages m
       JOIN chat_threads t ON t.id = m.thread_id
       WHERE m.id = $1`,
      [message_id]
    );
    if (batchRows.length > 0 && batchRows[0].thread_type === 'group' && batchRows[0].reply_to) {
      const replyTo = batchRows[0].reply_to;
      const { rows: siblingRows } = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('complete', 'error'))::int AS terminal
         FROM chat_messages
         WHERE reply_to = $1 AND author_type = 'agent'`,
        [replyTo]
      );
      if (siblingRows.length > 0 && siblingRows[0].total > 0 && siblingRows[0].terminal === siblingRows[0].total) {
        await pool.query(
          `UPDATE chat_messages SET batch_complete = true, seq = nextval('chat_messages_seq')
           WHERE id = $1`,
          [message_id]
        );
        console.info(`[chat-callback] Batch complete for reply_to=${replyTo} (${siblingRows[0].total} agents)`);
      }
    }
  } catch (batchErr) {
    console.error('[chat-callback] Batch completion check failed (non-blocking):', batchErr);
  }

  // Elevated-agent response tagging (D6): informational audit only
  try {
    const { rows: msgRows } = await pool.query(
      `SELECT author_id FROM chat_messages WHERE id = $1 AND author_type = 'agent'`,
      [message_id]
    );
    if (msgRows.length > 0) {
      const elevatedScope = await getAgentElevatedScope(msgRows[0].author_id);
      if (elevatedScope) {
        auditLog('elevated_agent_response', msgRows[0].author_id, 'service', 'service', { message_id, skill_scope: elevatedScope, status: finalStatus });
      }
    }
  } catch (tagErr) {
    console.error('[chat-callback] Elevated tagging failed (non-blocking):', tagErr);
  }

  // ── Agent-to-agent @mention orchestration (fire-and-forget) ──
  // Only on successful complete callbacks with non-empty content
  if (finalStatus === 'complete' && content && typeof content === 'string' && content.trim()) {
    try {
      const { slugs } = parseMentions(content);
      if (slugs.length > 0) {
        // Get triggering message metadata
        const { rows: trigRows } = await pool.query(
          `SELECT thread_id, author_id, chain_id, chain_hop FROM chat_messages WHERE id = $1`,
          [message_id]
        );
        if (trigRows.length > 0) {
          const trigMsg = trigRows[0];
          const threadId = trigMsg.thread_id;

          // Resolve mentioned slugs to participants in this thread (unknown silently ignored)
          const resolved = await resolveAgentSlugs(threadId, slugs);
          if (resolved.size > 0) {
            // Self-mention guard: remove the author from targets
            const targetUuids = [...resolved.values()].filter(uuid => uuid !== trigMsg.author_id);

            if (targetUuids.length > 0) {
              // Chain_id: reuse from triggering message, or generate new
              let chainId = trigMsg.chain_id;
              const currentHop = trigMsg.chain_hop ?? 0;

              if (!chainId) {
                chainId = crypto.randomUUID();
                // Backfill triggering message as hop 0
                await pool.query(
                  `UPDATE chat_messages SET chain_id = $1, chain_hop = 0 WHERE id = $2 AND chain_id IS NULL`,
                  [chainId, message_id]
                );
              }

              const newHop = currentHop + 1;

              // Hop budget guard
              if (newHop <= MAX_CHAIN_HOPS) {
                // Time budget guard
                const { rows: timeRows } = await pool.query(
                  `SELECT MIN(created_at) AS chain_start FROM chat_messages WHERE chain_id = $1`,
                  [chainId]
                );
                const chainStart = timeRows[0]?.chain_start ? new Date(timeRows[0].chain_start).getTime() : Date.now();
                const elapsed = Date.now() - chainStart;

                if (elapsed <= MAX_CHAIN_DURATION_MS) {
                  // Cycle detection: find agents already participating in this chain
                  const { rows: cycleRows } = await pool.query(
                    `SELECT DISTINCT author_id FROM chat_messages
                     WHERE chain_id = $1 AND author_type = 'agent' AND status IN ('complete', 'pending')`,
                    [chainId]
                  );
                  const chainParticipants = new Set(cycleRows.map((r: any) => r.author_id));

                  // Filter out agents already in the chain (cycle prevention)
                  const freshTargets = targetUuids.filter(uuid => !chainParticipants.has(uuid));

                  if (freshTargets.length > 0) {
                    // Load agent info, apply elevated scope gate + concurrency guard
                    const eligibleAgents: NonNullable<Awaited<ReturnType<typeof getAgentForDispatch>>>[] = [];

                    for (const uuid of freshTargets) {
                      // Elevated scope gate: agents cannot dispatch to elevated agents
                      const elevatedScope = await getAgentElevatedScope(uuid);
                      if (elevatedScope) {
                        auditLog('agent_to_agent_dispatch', uuid, trigMsg.author_id, 'agent', {
                          thread_id: threadId, chain_id: chainId, blocked: 'elevated_scope', scope: elevatedScope,
                        });
                        continue;
                      }

                      const agent = await getAgentForDispatch(uuid);
                      if (!agent || agent.status !== 'running' || !agent.work_token) continue;

                      // Per-agent concurrency guard
                      const { rows: pendingRows } = await pool.query(
                        `SELECT 1 FROM chat_messages
                         WHERE thread_id = $1 AND author_id = $2 AND author_type = 'agent' AND status = 'pending'
                         LIMIT 1`,
                        [threadId, agent.id]
                      );
                      if (pendingRows.length > 0) continue;

                      eligibleAgents.push(agent);
                    }

                    if (eligibleAgents.length > 0) {
                      // Load message history
                      const { rows: history } = await pool.query(
                        `SELECT role, content FROM chat_messages
                         WHERE thread_id = $1 AND status = 'complete'
                         ORDER BY seq DESC LIMIT $2`,
                        [threadId, MESSAGE_HISTORY_LIMIT]
                      );
                      const historyMessages = history.reverse();

                      // Build participant list for group context in chain dispatch
                      const { rows: threadInfoRows } = await pool.query(
                        `SELECT t.type FROM chat_threads t WHERE t.id = $1`, [threadId]
                      );
                      const chainThreadType = threadInfoRows[0]?.type;
                      let chainParticipantsList: { agent_id: string; name: string }[] | undefined;
                      if (chainThreadType === 'group') {
                        const { rows: pRows } = await pool.query(
                          `SELECT a.agent_id, a.name FROM chat_participants cp
                           JOIN agents a ON a.id = cp.participant_id::uuid
                           WHERE cp.thread_id = $1 AND cp.participant_type = 'agent' AND cp.left_at IS NULL`,
                          [threadId]
                        );
                        chainParticipantsList = pRows.map((r: any) => ({ agent_id: r.agent_id, name: r.name || r.agent_id }));
                      }

                      const { dispatched: chainDispatched } = await dispatchToAgents({
                        threadId,
                        agents: eligibleAgents,
                        replyTo: message_id,
                        historyMessages,
                        chainId,
                        chainHop: newHop,
                        triggeredBy: message_id,
                        threadType: chainThreadType || undefined,
                        participants: chainParticipantsList,
                      });

                      for (const d of chainDispatched) {
                        auditLog('agent_to_agent_dispatch', d.agent_id, trigMsg.author_id, 'agent', {
                          thread_id: threadId, chain_id: chainId, chain_hop: newHop,
                          triggered_by: message_id, message_id: d.message_id,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (orchErr) {
      console.error('[chat-callback] Agent-to-agent orchestration error (non-blocking):', orchErr);
    }
  }

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

// Export helpers for testing
export { parseMentions, resolveAgentSlugs, dispatchToAgents };

export default router;
