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
    // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'policy-1' }] });

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
    // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'platform-policy' }] });

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
      .mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: 'policy-1' }] }); // UPDATE

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(200);
    // Verify the CASE WHEN boolean flag is true (model_policy_id was provided)
    const updateCall = mockQuery.mock.calls[2];
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
      .mockResolvedValueOnce({ rows: [{ ...agentRow, model_policy_id: null }] }); // UPDATE

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
      .mockResolvedValueOnce({ rows: [agentRow] }); // UPDATE

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
      .mockResolvedValueOnce({ rows: [{ ...agentRow, name: 'New Name' }] }); // UPDATE

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
  });
});
