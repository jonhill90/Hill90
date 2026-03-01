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
const userBToken = makeToken('user-b', ['user']);

describe('User Models CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('POST /user-models creates model', async () => {
    // Check connection ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Check platform name collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'my-gpt4', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-gpt4',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-gpt4');
    expect(res.body.litellm_model).toBe('openai/gpt-4o');
  });

  it('rejects unowned connection_id', async () => {
    // Connection ownership check fails
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-model',
        connection_id: 'other-users-conn',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });

  it('list shows only own models', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'my-gpt4' }],
    });

    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
  });

  it('rejects name colliding with active platform model', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision found
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o-mini' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'gpt-4o-mini',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o-mini',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  it('allows name matching inactive platform model', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision check — no active match
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'old-model', connection_id: 'conn-1',
        litellm_model: 'openai/old-model', description: '', is_active: true,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'old-model',
        connection_id: 'conn-1',
        litellm_model: 'openai/old-model',
      });

    expect(res.status).toBe(201);
  });

  it('requires user role', async () => {
    const noRoleToken = jwt.sign(
      { sub: 'no-role-user', realm_roles: [] },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
    );
    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'test' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent model on delete', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/user-models/uuid-nonexistent')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT rejects name collision with platform model', async () => {
    // Ownership check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1' }] });
    // Platform collision found
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o' }] });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'gpt-4o' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  it('PUT verifies ownership of new connection', async () => {
    // Model ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1' }] });
    // Connection ownership fails
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ connection_id: 'other-users-conn' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });
});
