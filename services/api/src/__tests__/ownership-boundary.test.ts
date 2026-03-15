/**
 * Ownership boundary regression tests.
 *
 * Verifies cross-user isolation: user A cannot access user B's resources.
 * All tests use mockQuery to mock database responses.
 */

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

const userAToken = makeToken('user-a', ['user']);

describe('Ownership boundary isolation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('F1: User A cannot list User B user_models', async () => {
    // GET /user-models scopes by created_by = user-a
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'model-a-1', name: 'my-model', created_by: 'user-a' }],
    });

    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    // Verify SQL includes created_by = $1 with user-a's sub
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['user-a']);
    // Only user-a's models returned
    expect(res.body).toHaveLength(1);
    expect(res.body[0].created_by).toBe('user-a');
  });

  it('F2: User A cannot delete User B user_model', async () => {
    // DELETE /user-models/:id scopes by created_by = user-a;
    // user-b's model not found for user-a
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/user-models/model-b-1')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
    // Verify DELETE query includes created_by scope
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $2');
    expect(call[1]).toContain('user-a');
  });

  it('F3: User A cannot list User B provider_connections', async () => {
    // GET /provider-connections scopes by created_by = user-a
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'conn-a-1', name: 'my-conn', provider: 'openai', created_by: 'user-a' }],
    });

    const res = await request(app)
      .get('/provider-connections')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    // Verify SQL uses created_by = $1 with user-a's sub
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['user-a']);
  });

  it('F4: User A cannot use User B connection_id for own model', async () => {
    // POST /user-models with user-a token, connection_id = user-b's connection
    // Connection ownership check: WHERE id = $1 AND created_by = $2 returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        name: 'stolen-model',
        connection_id: 'user-b-conn',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
    // Verify ownership check query
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $2');
    expect(call[1]).toEqual(['user-b-conn', 'user-a']);
  });

  it('F5: User A cannot update User B model_policy', async () => {
    // PUT /model-policies/:id ownership check for non-admin
    // WHERE id = $1 AND created_by = $2 returns empty (user-b's policy)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/model-policies/policy-b')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ name: 'hijacked-policy' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
    // Verify ownership-scoped query
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $2');
    expect(call[1]).toContain('user-a');
  });

  it('F6: User A cannot assign User B policy to own agent', async () => {
    // POST /agents with model_policy_id owned by user-b
    // 1. Policy lookup: found, but created_by = user-b
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'policy-b', created_by: 'user-b' }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        model_policy_id: 'policy-b',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another user's policy");
  });

  it('F7: User A creates policy referencing User B model', async () => {
    // POST /model-policies with allowed_models = ['user-b-model']
    // validateAllowedModels: user_models check for user-a returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userAToken}`)
      .send({
        name: 'stolen-policy',
        allowed_models: ['user-b-model'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models');
  });
});
