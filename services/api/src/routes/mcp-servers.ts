/**
 * MCP Server management routes.
 *
 *   GET    /mcp-servers              — list MCP servers
 *   POST   /mcp-servers              — create MCP server
 *   GET    /mcp-servers/:id          — get MCP server
 *   PUT    /mcp-servers/:id          — update MCP server
 *   DELETE /mcp-servers/:id          — delete MCP server
 *   POST   /agents/:id/mcp-servers   — assign to agent (in agents.ts)
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';

const router = Router();

// ── List MCP servers ────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT ms.*,
              (SELECT count(*) FROM agent_mcp_servers ams WHERE ams.mcp_server_id = ms.id) AS agent_count
       FROM mcp_servers ms
       ${admin ? '' : 'WHERE ms.created_by = $1 OR ms.is_platform = true'}
       ORDER BY ms.name`,
      admin ? [] : [user.sub]
    );

    res.json(rows);
  } catch (err: any) {
    console.error('[mcp-servers] List error:', err);
    res.status(500).json({ error: 'Failed to list MCP servers' });
  }
});

// ── Create MCP server ───────────────────────────────────────────────
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { name, description, transport, connection_config, is_platform } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const validTransports = ['stdio', 'sse', 'http'];
    if (transport && !validTransports.includes(transport)) {
      res.status(400).json({ error: `transport must be one of: ${validTransports.join(', ')}` });
      return;
    }

    // Only admins can create platform MCP servers
    if (is_platform && !isAdmin(req)) {
      res.status(403).json({ error: 'Only admins can create platform MCP servers' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO mcp_servers (name, description, transport, connection_config, is_platform, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name,
        description || null,
        transport || 'stdio',
        JSON.stringify(connection_config || {}),
        is_platform || false,
        user.sub,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    console.error('[mcp-servers] Create error:', err);
    res.status(500).json({ error: 'Failed to create MCP server' });
  }
});

// ── Get MCP server ──────────────────────────────────────────────────
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT ms.*,
              (SELECT count(*) FROM agent_mcp_servers ams WHERE ams.mcp_server_id = ms.id) AS agent_count
       FROM mcp_servers ms
       WHERE ms.id = $1 ${admin ? '' : 'AND (ms.created_by = $2 OR ms.is_platform = true)'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    // Include assigned agents
    const { rows: agents } = await getPool().query(
      `SELECT a.id, a.name, a.agent_id, a.status, ams.enabled, ams.added_at
       FROM agent_mcp_servers ams
       JOIN agents a ON ams.agent_id = a.id
       WHERE ams.mcp_server_id = $1
       ORDER BY ams.added_at`,
      [req.params.id]
    );

    res.json({ ...rows[0], agents });
  } catch (err: any) {
    console.error('[mcp-servers] Get error:', err);
    res.status(500).json({ error: 'Failed to get MCP server' });
  }
});

// ── Update MCP server ───────────────────────────────────────────────
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);
    const { name, description, transport, connection_config } = req.body;

    const { rows } = await getPool().query(
      `UPDATE mcp_servers SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        transport = COALESCE($3, transport),
        connection_config = COALESCE($4, connection_config),
        updated_at = NOW()
       WHERE id = $5 ${admin ? '' : 'AND created_by = $6'}
       RETURNING *`,
      admin
        ? [name, description, transport, connection_config ? JSON.stringify(connection_config) : null, req.params.id]
        : [name, description, transport, connection_config ? JSON.stringify(connection_config) : null, req.params.id, user.sub]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    console.error('[mcp-servers] Update error:', err);
    res.status(500).json({ error: 'Failed to update MCP server' });
  }
});

// ── Delete MCP server ───────────────────────────────────────────────
router.delete('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM mcp_servers WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'MCP server not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[mcp-servers] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete MCP server' });
  }
});

export default router;
