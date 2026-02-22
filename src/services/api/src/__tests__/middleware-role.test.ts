import { requireRole } from '../middleware/role';
import { Request, Response, NextFunction } from 'express';

function mockExpress(user: any = undefined) {
  const req = { user } as unknown as Request;
  (req as any).user = user;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('requireRole middleware', () => {
  it('returns 401 when no user on request', () => {
    const middleware = requireRole('user');
    const { req, res, next } = mockExpress();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user lacks required role', () => {
    const middleware = requireRole('admin');
    const { req, res, next } = mockExpress({ sub: 'user1', realm_roles: ['user'] });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when user has required role', () => {
    const middleware = requireRole('user');
    const { req, res, next } = mockExpress({ sub: 'user1', realm_roles: ['user', 'admin'] });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when realm_roles is missing', () => {
    const middleware = requireRole('user');
    const { req, res, next } = mockExpress({ sub: 'user1' });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
