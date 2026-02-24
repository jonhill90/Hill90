import { createRequireAuth } from '../auth';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Helper to build mock Express req/res/next
function mockExpress(headers: Record<string, string> = {}) {
  const req = { headers, user: undefined } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

// Create middleware with a static key resolver (no JWKS fetch in tests)
function buildMiddleware() {
  return createRequireAuth({
    issuer: TEST_ISSUER,
    getSigningKey: async () => publicKey,
  });
}

describe('JWT auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const middleware = buildMiddleware();
    const { req, res, next } = mockExpress();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed Bearer token', async () => {
    const middleware = buildMiddleware();
    const { req, res, next } = mockExpress({ authorization: 'Bearer not.a.jwt' });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when issuer does not match', async () => {
    const token = jwt.sign({ sub: 'user1' }, privateKey, {
      algorithm: 'RS256',
      issuer: 'https://wrong-issuer.com',
      expiresIn: '5m',
    });
    const middleware = buildMiddleware();
    const { req, res, next } = mockExpress({ authorization: `Bearer ${token}` });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is missing exp claim', async () => {
    const token = jwt.sign({ sub: 'user1' }, privateKey, {
      algorithm: 'RS256',
      issuer: TEST_ISSUER,
      noTimestamp: true,
    });
    const middleware = buildMiddleware();
    const { req, res, next } = mockExpress({ authorization: `Bearer ${token}` });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for valid token with correct issuer and signature', async () => {
    const token = jwt.sign({ sub: 'user1' }, privateKey, {
      algorithm: 'RS256',
      issuer: TEST_ISSUER,
      expiresIn: '5m',
    });
    const middleware = buildMiddleware();
    const { req, res, next } = mockExpress({ authorization: `Bearer ${token}` });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
