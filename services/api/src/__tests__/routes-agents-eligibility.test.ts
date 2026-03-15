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

const userToken = makeToken('user-a', ['user']);
const adminToken = makeToken('admin-user', ['admin', 'user']);

describe('Agent eligibility enforcement (AI-120)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // D1: POST - model_policy_id with model not in effective owner's user_models rejects (400)
  it('D1: POST rejects model_policy_id when policy model is not in owner user_models', async () => {
    // 1. Policy lookup: SELECT id, created_by FROM model_policies WHERE id = $1
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-a' }] });
    // 2. validatePolicyEligibility: SELECT allowed_models FROM model_policies WHERE id = $1
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 3. For model 'gpt-4o': SELECT id FROM user_models WHERE name=$1 AND created_by=$2 AND is_active=true
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not found

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
    expect(res.body.error).toContain('gpt-4o');
  });

  // D2: PUT - model_policy_id with model not in effective owner's user_models rejects (400)
  it('D2: PUT rejects model_policy_id when policy model is not in agent owner user_models', async () => {
    // 1. SELECT existing agent (with scope for user-a)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped',
        created_by: 'user-a', model_policy_id: null,
      }],
    });
    // 2. Policy lookup: SELECT id, created_by FROM model_policies WHERE id = $1
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-a' }] });
    // 3. validatePolicyEligibility: SELECT allowed_models FROM model_policies WHERE id = $1
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 4. For model 'gpt-4o': user_models check -> not found
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
    expect(res.body.error).toContain('gpt-4o');
  });

  // D3: POST - model_policy_id with own user model passes (201)
  it('D3: POST with model_policy_id passes when all models are in owner user_models', async () => {
    // 1. Policy lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-a' }] });
    // 2. validatePolicyEligibility: SELECT allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 3. user_models check for 'gpt-4o' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // 4. INSERT INTO agents
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new', agent_id: 'test-agent', name: 'Test',
        model_policy_id: 'policy-1', created_by: 'user-a',
        description: '', status: 'stopped', tools_config: '{}',
        cpus: '1.0', mem_limit: '1g', pids_limit: 200,
      }],
    });
    // 5. resolveAgentModels: SELECT allowed_models FROM model_policies WHERE id = $1
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 6. SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'test-agent', name: 'Test', model_policy_id: 'policy-1' });

    expect(res.status).toBe(201);
    expect(res.body.model_policy_id).toBe('policy-1');
  });

  // D4: PUT - model_policy_id with effective owner's user model passes (200)
  it('D4: PUT with model_policy_id passes when all models are in agent owner user_models', async () => {
    // 1. SELECT existing agent
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped',
        created_by: 'user-a', model_policy_id: null,
      }],
    });
    // 2. Policy lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-a' }] });
    // 3. validatePolicyEligibility: SELECT allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 4. user_models check for 'gpt-4o' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // 5. UPDATE agents
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'test-agent', name: 'Test', status: 'stopped',
        model_policy_id: 'policy-1', created_by: 'user-a',
      }],
    });
    // 6. SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. resolveAgentModels
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(200);
    expect(res.body.model_policy_id).toBe('policy-1');
  });

  // D5: POST - admin caller: eligibility checked against user.sub (admin is owner on create)
  it('D5: POST admin caller validates eligibility against admin sub (admin is agent owner)', async () => {
    // 1. Policy lookup (admin skips ownership check but eligibility still runs)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'someone-else' }] });
    // 2. validatePolicyEligibility: SELECT allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 3. user_models check for 'gpt-4o' with ownerSub='admin-user' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-admin-1' }] });
    // 4. INSERT INTO agents
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new', agent_id: 'admin-agent', name: 'Admin Agent',
        model_policy_id: 'policy-1', created_by: 'admin-user',
        description: '', status: 'stopped',
      }],
    });
    // 5. resolveAgentModels
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 6. SELECT skills
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_id: 'admin-agent', name: 'Admin Agent', model_policy_id: 'policy-1' });

    expect(res.status).toBe(201);
    // Verify user_models query used admin-user as the owner
    const userModelsCall = mockQuery.mock.calls[2];
    expect(userModelsCall[0]).toContain('user_models');
    expect(userModelsCall[1][1]).toBe('admin-user');
  });

  // D6: PUT - admin caller updating user-b's agent: eligibility checked against existing[0].created_by
  it('D6: PUT admin caller validates eligibility against agent owner (not admin sub)', async () => {
    // 1. SELECT existing agent (admin scope = no WHERE created_by filter)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'user-b-agent', name: 'User B Agent', status: 'stopped',
        created_by: 'user-b', model_policy_id: null,
      }],
    });
    // 2. Policy lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-b' }] });
    // 3. validatePolicyEligibility: SELECT allowed_models
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });
    // 4. user_models check for 'gpt-4o' with ownerSub='user-b' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-b-1' }] });
    // 5. UPDATE agents
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'user-b-agent', name: 'User B Agent', status: 'stopped',
        model_policy_id: 'policy-1', created_by: 'user-b',
      }],
    });
    // 6. SELECT skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. resolveAgentModels
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['gpt-4o'] }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(200);
    // Verify user_models query used 'user-b' (agent owner), not 'admin-user'
    const userModelsCall = mockQuery.mock.calls[3];
    expect(userModelsCall[0]).toContain('user_models');
    expect(userModelsCall[1][1]).toBe('user-b');
  });

  // D7: POST - model_names path: admin caller, model not in admin's user_models -> rejected (400)
  it('D7: POST model_names rejects when model is not in admin user_models', async () => {
    // 1. validateModelNames: user_models check for 'admin-only-model' with ownerSub='admin-user' -> not found
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_id: 'admin-agent', name: 'Admin Agent', model_names: ['admin-only-model'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'admin-only-model' not found in user models for agent owner");
  });

  // D8: PUT - model_names path: admin updating user-b's agent, validates against user-b's user_models
  it('D8: PUT model_names validates against agent owner user_models (not admin)', async () => {
    // 1. SELECT existing agent (admin scope)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'user-b-agent', name: 'User B Agent', status: 'stopped',
        created_by: 'user-b', model_policy_id: null,
      }],
    });
    // 2. validateModelNames: user_models check for 'some-model' with ownerSub='user-b' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-b-1' }] });
    // 3. model_names present, no existing policy -> upsertAutoAgentModelsPolicy:
    //    SELECT existing policy by name
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. INSERT new auto policy
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'auto-policy-1' }] });
    // 5. UPDATE agents SET model_policy_id (from upsert) -- wait, for PUT path it's different.
    //    Actually looking at PUT code: if model_names provided and normalizedModelNames.length > 0,
    //    it checks existing[0].model_policy_id (null here), so reusePolicyId = null,
    //    then calls upsertAutoAgentModelsPolicy which does SELECT + INSERT.
    //    Then resolvedModelPolicyId = auto-policy-1
    // 5. UPDATE agents (the main update)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', agent_id: 'user-b-agent', name: 'User B Agent', status: 'stopped',
        model_policy_id: 'auto-policy-1', created_by: 'user-b',
      }],
    });
    // 6. SELECT skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. resolveAgentModels
    mockQuery.mockResolvedValueOnce({ rows: [{ allowed_models: ['some-model'] }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_names: ['some-model'] });

    expect(res.status).toBe(200);
    // Verify user_models query used 'user-b' (agent owner), not 'admin-user'
    const userModelsCall = mockQuery.mock.calls[1];
    expect(userModelsCall[0]).toContain('user_models');
    expect(userModelsCall[1][1]).toBe('user-b');
  });

  // D9: POST - model_names path does not also trigger validatePolicyEligibility
  it('D9: POST model_names does not trigger validatePolicyEligibility', async () => {
    // 1. validateModelNames: user_models check for 'my-model' with ownerSub='user-a' -> found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // 2. INSERT INTO agents
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-new', agent_id: 'my-agent', name: 'My Agent',
        model_policy_id: null, created_by: 'user-a',
      }],
    });
    // 3. upsertAutoAgentModelsPolicy: SELECT existing policy
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. INSERT auto policy
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'auto-policy-1' }] });
    // 5. UPDATE agents SET model_policy_id
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-new' }] });
    // 6. SELECT skills
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'my-agent', name: 'My Agent', model_names: ['my-model'] });

    expect(res.status).toBe(201);

    // Verify no validatePolicyEligibility queries ran.
    // validatePolicyEligibility would query 'SELECT allowed_models FROM model_policies WHERE id = $1'
    // followed by user_models checks. The only user_models query should be from validateModelNames (call 0).
    const allCalls = mockQuery.mock.calls;
    const userModelsCalls = allCalls.filter((call: any) =>
      typeof call[0] === 'string' && call[0].includes('user_models')
    );
    // Only 1 user_models query (from validateModelNames), not additional ones from validatePolicyEligibility
    expect(userModelsCalls).toHaveLength(1);

    // No query should fetch allowed_models from model_policies (which validatePolicyEligibility does)
    const policyEligibilityCalls = allCalls.filter((call: any) =>
      typeof call[0] === 'string' &&
      call[0].includes('SELECT allowed_models FROM model_policies')
    );
    expect(policyEligibilityCalls).toHaveLength(0);
  });
});
