/**
 * Knowledge proxy routes — read-only access to agent knowledge.
 *
 * Auth pattern matches /agents router:
 * - requireAuth at mount (Keycloak JWT validation in app.ts)
 * - requireRole('user') per-route
 * - scopeToOwner(req) for admin bypass vs user scoping
 *
 * Users see knowledge from their own agents. Admins see all agents' knowledge.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { getPool } from '../db/pool';
import * as akmProxy from '../services/akm-proxy';

const router = Router();

/**
 * Given a request, return the list of agent_ids the user is allowed to see.
 * Admins: null (no filter — see all).
 * Users: list of agent_ids they created.
 */
async function getAllowedAgentIds(req: Request): Promise<string[] | null> {
  const scope = scopeToOwner(req);
  if (scope.where === '1=1') {
    return null; // admin — no filter
  }
  const { rows } = await getPool().query(
    `SELECT agent_id FROM agents WHERE ${scope.where}`,
    scope.params,
  );
  return rows.map((r: { agent_id: string }) => r.agent_id);
}

/**
 * Check if a specific agent_id is owned by the requesting user.
 */
async function isAgentOwned(req: Request, agentId: string): Promise<boolean> {
  const allowed = await getAllowedAgentIds(req);
  if (allowed === null) return true; // admin
  return allowed.includes(agentId);
}

// List agents with knowledge stats
router.get('/agents', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const result = await akmProxy.listAgents();
    if (result.status !== 200) {
      res.status(result.status).json(result.data);
      return;
    }

    // Filter to owned agents for non-admin users
    const allowed = await getAllowedAgentIds(req);
    let agents = result.data as Array<{ agent_id: string }>;
    if (allowed !== null) {
      agents = agents.filter(a => allowed.includes(a.agent_id));
    }

    res.json(agents);
  } catch (err) {
    console.error('[knowledge] List agents error:', err);
    res.status(500).json({ error: 'Failed to list knowledge agents' });
  }
});

// List entries for an agent
router.get('/entries', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agent_id as string;
    if (!agentId) {
      res.status(400).json({ error: 'agent_id query parameter is required' });
      return;
    }

    if (!await isAgentOwned(req, agentId)) {
      res.status(403).json({ error: 'Not authorized to view this agent\'s knowledge' });
      return;
    }

    const type = req.query.type as string | undefined;
    const result = await akmProxy.listEntries(agentId, type);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] List entries error:', err);
    res.status(500).json({ error: 'Failed to list knowledge entries' });
  }
});

// Read a specific entry
router.get('/entries/:agentId/:path(*)', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const path = req.params.path || req.params[0];

    if (!await isAgentOwned(req, agentId)) {
      res.status(403).json({ error: 'Not authorized to view this agent\'s knowledge' });
      return;
    }

    const result = await akmProxy.readEntry(agentId, path);
    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('[knowledge] Read entry error:', err);
    res.status(500).json({ error: 'Failed to read knowledge entry' });
  }
});

// Search entries
router.get('/search', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: 'q query parameter is required' });
      return;
    }

    const agentId = req.query.agent_id as string | undefined;

    // If agent_id specified, verify ownership
    if (agentId) {
      if (!await isAgentOwned(req, agentId)) {
        res.status(403).json({ error: 'Not authorized to search this agent\'s knowledge' });
        return;
      }
      const result = await akmProxy.searchEntries(q, agentId);
      res.status(result.status).json(result.data);
      return;
    }

    // No agent_id — admin searches all, user searches own agents only
    const allowed = await getAllowedAgentIds(req);
    if (allowed === null) {
      // Admin: search all
      const result = await akmProxy.searchEntries(q);
      res.status(result.status).json(result.data);
      return;
    }

    // User: search each owned agent and merge results
    const allResults: Array<Record<string, unknown>> = [];
    for (const aid of allowed) {
      const result = await akmProxy.searchEntries(q, aid);
      if (result.status === 200) {
        const data = result.data as { results: Array<Record<string, unknown>> };
        allResults.push(...data.results);
      }
    }

    // Sort by score descending, limit to 20
    allResults.sort((a, b) => ((b.score as number) || 0) - ((a.score as number) || 0));
    const limited = allResults.slice(0, 20);

    res.json({
      query: q,
      results: limited,
      count: limited.length,
      search_type: 'fts',
      score_type: 'ts_rank',
    });
  } catch (err) {
    console.error('[knowledge] Search error:', err);
    res.status(500).json({ error: 'Failed to search knowledge' });
  }
});

export default router;
