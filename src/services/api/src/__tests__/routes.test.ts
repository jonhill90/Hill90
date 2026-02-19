import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import express, { Application } from 'express';
import { createRequireAuth } from '../middleware/auth';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Build a test app that mirrors src/app.ts wiring but with a test key resolver
function buildTestApp(): Application {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'api' });
  });

  const requireAuth = createRequireAuth({
    issuer: TEST_ISSUER,
    getSigningKey: async () => publicKey,
  });

  app.get('/me', requireAuth, (req, res) => {
    res.json((req as any).user);
  });

  return app;
}

const app = buildTestApp();

describe('API routes', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy', service: 'api' });
  });

  it('GET /me returns 401 without Authorization header', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
  });

  it('GET /me returns 401 with invalid token', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('GET /me returns 200 with valid JWT and decoded claims', async () => {
    const token = jwt.sign(
      { sub: 'user1', realm_roles: ['admin', 'user'] },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
    );

    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('user1');
    expect(res.body.realm_roles).toEqual(['admin', 'user']);
  });
});
