import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock shared-knowledge-proxy
const mockGetStats = jest.fn();
jest.mock('../services/shared-knowledge-proxy', () => ({
  ...jest.requireActual('../services/shared-knowledge-proxy'),
  getStats: (...args: unknown[]) => mockGetStats(...args),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, realm_roles: roles },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);
const noRoleToken = makeToken('no-role-user', []);

describe('Shared knowledge stats routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetStats.mockReset();
  });

  it('GET /shared-knowledge/stats returns 401 without auth', async () => {
    const res = await request(app).get('/shared-knowledge/stats');
    expect(res.status).toBe(401);
  });

  it('GET /shared-knowledge/stats returns 403 without user role', async () => {
    const res = await request(app)
      .get('/shared-knowledge/stats')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /shared-knowledge/stats proxies correctly', async () => {
    const statsData = {
      total_collections: 5,
      total_sources: 42,
      total_chunks: 318,
    };
    mockGetStats.mockResolvedValueOnce({ status: 200, data: statsData });

    const res = await request(app)
      .get('/shared-knowledge/stats')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(statsData);
    expect(mockGetStats).toHaveBeenCalledWith(undefined);
  });

  it('GET /shared-knowledge/stats handles 502', async () => {
    mockGetStats.mockResolvedValueOnce({
      status: 502,
      data: { error: 'Knowledge service unavailable' },
    });

    const res = await request(app)
      .get('/shared-knowledge/stats')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(502);
  });
});
