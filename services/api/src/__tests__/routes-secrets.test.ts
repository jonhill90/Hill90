import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-123' }),
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

describe('Secrets vault inventory', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /admin/secrets returns grouped inventory (T1)', async () => {
    const res = await request(app)
      .get('/admin/secrets')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.paths).toBeDefined();
    expect(Array.isArray(res.body.paths)).toBe(true);
    expect(res.body.totalPaths).toBeGreaterThan(0);
    expect(res.body.totalKeys).toBeGreaterThan(0);
    expect(res.body.approleServices).toBeDefined();

    // Verify structure of first path
    const first = res.body.paths[0];
    expect(first.path).toBeDefined();
    expect(first.keys).toBeDefined();
    expect(first.keyCount).toBeGreaterThan(0);
    expect(first.keys[0].key).toBeDefined();
    expect(first.keys[0].consumers).toBeDefined();

    // Verify known paths from schema
    const paths = res.body.paths.map((p: any) => p.path);
    expect(paths).toContain('secret/shared/database');
    expect(paths).toContain('secret/auth/config');
    expect(paths).toContain('secret/ai/config');
  });

  it('GET /admin/secrets rejects non-admin (T2)', async () => {
    const res = await request(app)
      .get('/admin/secrets')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it('GET /admin/secrets requires auth', async () => {
    const res = await request(app)
      .get('/admin/secrets');

    expect(res.status).toBe(401);
  });

  it('GET /admin/secrets/status returns vault status (T3)', async () => {
    const res = await request(app)
      .get('/admin/secrets/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // In test env, vault is not running so expect degraded response
    expect(res.body).toHaveProperty('available');
    expect(res.body).toHaveProperty('sealed');
    expect(res.body).toHaveProperty('version');
  });

  it('GET /admin/secrets/status rejects non-admin', async () => {
    const res = await request(app)
      .get('/admin/secrets/status')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it('GET /admin/secrets includes consumer service names', async () => {
    const res = await request(app)
      .get('/admin/secrets')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    // DB_PASSWORD should list db, auth, api, ai, knowledge as consumers
    const dbPath = res.body.paths.find((p: any) => p.path === 'secret/shared/database');
    expect(dbPath).toBeDefined();
    const dbPasswordKey = dbPath.keys.find((k: any) => k.key === 'DB_PASSWORD');
    expect(dbPasswordKey).toBeDefined();
    expect(dbPasswordKey.consumers).toContain('db');
    expect(dbPasswordKey.consumers).toContain('api');
  });

  it('GET /admin/secrets groups keys by vault path', async () => {
    const res = await request(app)
      .get('/admin/secrets')
      .set('Authorization', `Bearer ${adminToken}`);

    // Paths should be unique
    const paths = res.body.paths.map((p: any) => p.path);
    expect(new Set(paths).size).toBe(paths.length);

    // Each path should have correct keyCount
    for (const p of res.body.paths) {
      expect(p.keyCount).toBe(p.keys.length);
    }
  });
});
