import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

// GET /notifications — list notifications for current user
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const unreadOnly = req.query.unread === 'true';

    const whereClause = unreadOnly
      ? 'WHERE user_id = $1 AND read = FALSE'
      : 'WHERE user_id = $1';

    const { rows } = await getPool().query(
      `SELECT id, message, type, read, metadata, created_at
       FROM notifications ${whereClause}
       ORDER BY created_at DESC LIMIT $2`,
      [user.sub, limit]
    );

    // Include unread count in response
    const { rows: [{ count }] } = await getPool().query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE`,
      [user.sub]
    );

    res.json({ notifications: rows, unread_count: count });
  } catch (err) {
    console.error('[notifications] List error:', err);
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

// PUT /notifications/:id/read — mark a notification as read
router.put('/:id/read', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rowCount } = await getPool().query(
      `UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, user.sub]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ read: true });
  } catch (err) {
    console.error('[notifications] Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// PUT /notifications/read-all — mark all notifications as read
router.put('/read-all', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rowCount } = await getPool().query(
      `UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [user.sub]
    );
    res.json({ updated: rowCount || 0 });
  } catch (err) {
    console.error('[notifications] Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

export default router;
