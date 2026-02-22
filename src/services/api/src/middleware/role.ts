import { Request, Response, NextFunction } from 'express';

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const roles: string[] = user.realm_roles || [];
    if (!roles.includes(role)) {
      res.status(403).json({ error: `Requires ${role} role` });
      return;
    }

    next();
  };
}
