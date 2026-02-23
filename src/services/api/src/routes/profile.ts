import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/role';

const router = Router();

// GET /profile — fetch user profile
router.get('/', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// PATCH /profile — update display name
router.patch('/', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// POST /profile/avatar — upload avatar
router.post('/avatar', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// DELETE /profile/avatar — delete avatar
router.delete('/avatar', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// GET /profile/avatar — get avatar image
router.get('/avatar', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// POST /profile/password — change password
router.post('/password', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

export default router;
