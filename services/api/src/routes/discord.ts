/**
 * User-facing Discord management routes (Keycloak auth).
 *
 *   GET    /discord/bindings       — list channel-agent bindings
 *   POST   /discord/bindings       — create/update binding
 *   DELETE /discord/bindings/:id   — remove binding
 *   GET    /discord/user-links     — list user links
 *   POST   /discord/user-links     — link Discord user to Hill90 user
 *   DELETE /discord/user-links/:id — remove user link
 *   GET    /discord/status         — bot connection status
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { isAdmin } from '../helpers/elevated-scope';

const router = Router();

// ── List bindings ────────────────────────────────────────────────────
router.get('/bindings', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rows } = await getPool().query(
      `SELECT dcb.*, a.name AS agent_name, a.agent_id AS agent_slug
       FROM discord_channel_bindings dcb
       JOIN agents a ON dcb.agent_id = a.id
       ${admin ? '' : 'WHERE dcb.created_by = $1'}
       ORDER BY dcb.created_at DESC`,
      admin ? [] : [user.sub],
    );
    res.json(rows);
  } catch (err) {
    console.error('[discord] List bindings error:', err);
    res.status(500).json({ error: 'Failed to list bindings' });
  }
});

// ── Create binding ───────────────────────────────────────────────────
router.post('/bindings', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { channel_id, guild_id, agent_id } = req.body;

    if (!channel_id || !guild_id || !agent_id) {
      res.status(400).json({ error: 'channel_id, guild_id, and agent_id are required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_channel_bindings (channel_id, guild_id, agent_id, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id) DO UPDATE SET agent_id = $3
       RETURNING *`,
      [channel_id, guild_id, agent_id, user.sub],
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[discord] Create binding error:', err);
    res.status(500).json({ error: 'Failed to create binding' });
  }
});

// ── Delete binding ───────────────────────────────────────────────────
router.delete('/bindings/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const admin = isAdmin(req);

    const { rowCount } = await getPool().query(
      `DELETE FROM discord_channel_bindings WHERE id = $1 ${admin ? '' : 'AND created_by = $2'}`,
      admin ? [req.params.id] : [req.params.id, user.sub],
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Binding not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[discord] Delete binding error:', err);
    res.status(500).json({ error: 'Failed to delete binding' });
  }
});

// ── List user links ──────────────────────────────────────────────────
router.get('/user-links', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM discord_user_links ORDER BY created_at DESC',
    );
    res.json(rows);
  } catch (err) {
    console.error('[discord] List user links error:', err);
    res.status(500).json({ error: 'Failed to list user links' });
  }
});

// ── Link Discord user ────────────────────────────────────────────────
router.post('/user-links', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { discord_user_id } = req.body;

    if (!discord_user_id) {
      res.status(400).json({ error: 'discord_user_id is required' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO discord_user_links (discord_user_id, hill90_user_id)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE SET hill90_user_id = $2
       RETURNING *`,
      [discord_user_id, user.sub],
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[discord] Link user error:', err);
    res.status(500).json({ error: 'Failed to link user' });
  }
});

// ── Delete user link ─────────────────────────────────────────────────
router.delete('/user-links/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM discord_user_links WHERE id = $1',
      [req.params.id],
    );
    if (!rowCount) {
      res.status(404).json({ error: 'User link not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[discord] Delete user link error:', err);
    res.status(500).json({ error: 'Failed to delete user link' });
  }
});

// ── Bot status ───────────────────────────────────────────────────────
router.get('/status', requireRole('user'), async (_req: Request, res: Response) => {
  const configured = !!process.env.DISCORD_BOT_SERVICE_TOKEN;
  res.json({
    configured,
    status: configured ? 'ready' : 'not_configured',
    message: configured ? 'Discord bot service token is configured' : 'DISCORD_BOT_SERVICE_TOKEN not set',
  });
});

export default router;
