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

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);
const userBToken = makeToken('user-b', ['user']);

describe('Agent PUT model_policy_id behavior', () => {
  const agentRow = {
    id: 'uuid-1',
    agent_id: 'test-agent',
    name: 'Test',
    status: 'stopped',
    created_by: 'regular-user',
    model_policy_id: null,
  };

  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('user assigns own policy to own agent', async () => {
    // ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // FK validation returns policy with created_by = user
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'regular-user' }] });
    // validatePolicyEligibility: fetch allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });
    // validatePolicyEligibility: user_models check for each model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'policy-1' }] });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Resolve models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(200);
    expect(res.body.model_policy_id).toBe('policy-1');
  });

  it('user assigns platform policy to own agent', async () => {
    // ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // FK validation returns platform policy (created_by = null)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-policy', created_by: null }] });
    // validatePolicyEligibility: fetch allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });
    // validatePolicyEligibility: user_models check for each model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'platform-policy' }] });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Resolve models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'platform-policy' });

    expect(res.status).toBe(200);
  });

  it('user cannot assign another users policy', async () => {
    // ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // FK validation returns policy owned by user-b
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-b-policy', created_by: 'user-b' }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'user-b-policy' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another user's policy");
  });

  it('allows model_policy_id from admin with valid FK', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow] }) // ownership check
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'someone' }] }) // FK validation
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] }) // validatePolicyEligibility: fetch allowed_models
      .mockResolvedValueOnce({ rows: [{ id: 'um-1' }] }) // validatePolicyEligibility: user_models check
      .mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'policy-1' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // SELECT skills for response
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] }); // Resolve models

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(200);
    // Verify the CASE WHEN boolean flag is true (model_policy_id was provided)
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[1][8]).toBe(true); // modelPolicyProvided flag
    expect(updateCall[1][9]).toBe('policy-1'); // model_policy_id value
  });

  it('rejects invalid model_policy_id FK', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow] }) // ownership check
      .mockResolvedValueOnce({ rows: [] }); // FK validation fails

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_policy_id: 'nonexistent-policy' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found');
  });

  it('allows clearing model_policy_id to null', async () => {
    const agentWithPolicy = { ...agentRow, model_policy_id: 'policy-1' };
    mockQuery
      .mockResolvedValueOnce({ rows: [agentWithPolicy] }) // ownership check
      .mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: null }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // SELECT skills for response

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_policy_id: null });

    expect(res.status).toBe(200);
    // Verify the CASE WHEN flag is true and value is null
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][8]).toBe(true); // modelPolicyProvided flag
    expect(updateCall[1][9]).toBeNull(); // model_policy_id value is null (clearing)
  });

  it('does not touch model_policy_id when not in body', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow] }) // ownership check
      .mockResolvedValueOnce({ rows: [agentRow] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // SELECT skills for response
      .mockResolvedValueOnce({ rows: [] }); // Resolve models

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    // Verify the CASE WHEN flag is false (model_policy_id not in body)
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][8]).toBe(false); // modelPolicyProvided flag
  });

  it('allows non-admin to update other fields without model_policy_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [agentRow] }) // ownership check
      .mockResolvedValueOnce({ rows: [{ ...agentRow, name: 'New Name' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // SELECT skills for response
      .mockResolvedValueOnce({ rows: [] }); // Resolve models

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
  });
});

describe('Agent POST model_policy_id behavior', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('POST /agents with model_policy_id assigns policy', async () => {
    // FK validation returns policy owned by user
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'regular-user' }] });
    // validatePolicyEligibility: fetch allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });
    // validatePolicyEligibility: user_models check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new',
        agent_id: 'test-agent',
        name: 'Test',
        model_policy_id: 'policy-1',
        created_by: 'regular-user',
      }],
    });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Resolve models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'policy-1' });

    expect(res.status).toBe(201);
    expect(res.body.model_policy_id).toBe('policy-1');
  });

  it('POST /agents rejects other user policy for non-admin', async () => {
    // FK validation returns policy owned by user-b
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-b-policy', created_by: 'user-b' }] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'user-b-policy' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("another user's policy");
  });

  it('POST /agents admin can assign any policy', async () => {
    // FK validation returns policy owned by someone else
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'any-policy', created_by: 'someone' }] });
    // validatePolicyEligibility: fetch allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });
    // validatePolicyEligibility: user_models check (admin's own models)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-admin' }] });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new',
        agent_id: 'test-agent',
        name: 'Test',
        model_policy_id: 'any-policy',
        created_by: 'admin-user',
      }],
    });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Resolve models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o-mini'] }] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'any-policy' });

    expect(res.status).toBe(201);
    expect(res.body.model_policy_id).toBe('any-policy');
  });

  it('POST /agents rejects invalid model_policy_id FK', async () => {
    // FK validation returns no rows
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'nonexistent' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found');
  });

  it('POST /agents without model_policy_id works as before', async () => {
    // INSERT (no FK check needed)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new',
        agent_id: 'test-agent',
        name: 'Test',
        model_policy_id: null,
        created_by: 'regular-user',
      }],
    });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test' });

    expect(res.status).toBe(201);
    expect(res.body.model_policy_id).toBeNull();
  });
});
