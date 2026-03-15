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
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
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

const userToken = makeToken('regular-user', ['user']);

describe('Eligible Models (GET /eligible-models)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // C1: Returns caller's own user_models only
  it('returns only the caller own user_models (created_by = sub)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'my-gpt4', description: 'My GPT-4', connection_id: 'conn-1', is_active: true },
      ],
    });

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].name).toBe('my-gpt4');

    // Verify query scopes to caller's sub
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
  });

  // C2: Excludes inactive user models by default
  it('excludes inactive user models by default (is_active = true filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('is_active = true');
  });

  // C3: ?include_inactive=true includes inactive models
  it('includes inactive models when include_inactive=true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/eligible-models?include_inactive=true')
      .set('Authorization', `Bearer ${userToken}`);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).not.toContain('is_active = true');
  });

  // C4: Does NOT return platform models (no model_catalog query)
  it('does not query model_catalog — only one DB call issued', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('user_models');
    expect(mockQuery.mock.calls[0][0]).not.toContain('model_catalog');
  });

  // C5: Requires user role — 403 without role
  it('returns 403 without user role', async () => {
    const noRoleToken = jwt.sign(
      { sub: 'no-role-user', realm_roles: [] },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
    );

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${noRoleToken}`);

    expect(res.status).toBe(403);
  });

  // C6: Returns 401 without auth
  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/eligible-models');

    expect(res.status).toBe(401);
  });

  // C7: Returns 503 without DATABASE_URL
  it('returns 503 when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('Database not configured');
  });
});
