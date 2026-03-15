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
  createAndStartContainer: jest.fn().mockResolvedValue('container-id'),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  inspectContainer: jest.fn().mockResolvedValue({ status: 'running' }),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
  reconcileAgentStatuses: jest.fn().mockResolvedValue(undefined),
  resolveAgentNetwork: jest.requireActual('../services/docker').resolveAgentNetwork,
  AGENT_NETWORK: 'hill90_agent_internal',
  AGENT_SANDBOX_NETWORK: 'hill90_agent_sandbox',
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn().mockResolvedValue(undefined),
  reconcileToolInstalls: jest.fn().mockResolvedValue({ installed: [], alreadyInstalled: [], failed: [] }),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, realm_roles: roles },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' },
  );
}

const userToken = makeToken('user-1', ['user']);
const user2Token = makeToken('user-2', ['user']);
const adminToken = makeToken('admin-1', ['admin', 'user']);

const AGENT_BASE = { agent_id: 'test-agent', name: 'Test Agent' };

// Helper: mock a successful INSERT INTO agents returning a row
function mockInsertAgent(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      id: 'agent-uuid-1', agent_id: 'test-agent', name: 'Test Agent',
      description: '', status: 'stopped', tools_config: '{}',
      cpus: '1.0', mem_limit: '1g', pids_limit: 200,
      soul_md: '', rules_md: '', container_id: null,
      model_policy_id: null, container_profile_id: null,
      error_message: null, created_at: new Date(), updated_at: new Date(),
      created_by: 'user-1',
      ...overrides,
    }],
  };
}

// Helper: mock a SELECT for existing agent (PUT path)
function mockExistingAgent(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      id: 'agent-uuid-1', agent_id: 'test-agent', name: 'Test Agent',
      description: '', status: 'stopped', tools_config: '{}',
      cpus: '1.0', mem_limit: '1g', pids_limit: 200,
      soul_md: '', rules_md: '', container_id: null,
      model_policy_id: null, container_profile_id: null,
      error_message: null, created_at: new Date(), updated_at: new Date(),
      created_by: 'user-1',
      ...overrides,
    }],
  };
}

describe('Agent model ownership enforcement', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // -----------------------------------------------------------------------
  // model_names path
  // -----------------------------------------------------------------------

  // A1: POST with platform model not in user_models → 400
  it('A1: POST with platform model not in user_models returns 400', async () => {
    // validateModelNames: user_models check returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_names: ['gpt-4o-mini'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // A2: POST with user's own active model → 201
  it('A2: POST with own active model succeeds', async () => {
    mockQuery
      // validateModelNames: user_models check succeeds
      .mockResolvedValueOnce({ rows: [{ id: 'um-1' }] })
      // INSERT INTO agents
      .mockResolvedValueOnce(mockInsertAgent())
      // upsertAutoAgentModelsPolicy: SELECT existing policy
      .mockResolvedValueOnce({ rows: [] })
      // INSERT INTO model_policies
      .mockResolvedValueOnce({ rows: [{ id: 'policy-uuid-1' }] })
      // UPDATE agents SET model_policy_id
      .mockResolvedValueOnce({ rows: [] })
      // SELECT skills for response
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_names: ['my-model'] });

    expect(res.status).toBe(201);
  });

  // A3: POST with another user's model → 400
  it('A3: POST with another user\'s model returns 400', async () => {
    // validateModelNames: user_models check returns empty (not owned by user-1)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_names: ['other-user-model'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // A4: PUT with platform model not in owner's user_models → 400
  it('A4: PUT with platform model not in owner user_models returns 400', async () => {
    mockQuery
      // SELECT existing agent (ownership check)
      .mockResolvedValueOnce(mockExistingAgent())
      // validateModelNames: user_models check returns empty
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/agent-uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_names: ['gpt-4o-mini'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // A5: PUT with owner's active model → 200
  it('A5: PUT with owner active model succeeds', async () => {
    mockQuery
      // SELECT existing agent
      .mockResolvedValueOnce(mockExistingAgent({ model_policy_id: 'existing-policy' }))
      // validateModelNames: user_models check succeeds
      .mockResolvedValueOnce({ rows: [{ id: 'um-1' }] })
      // SELECT existing auto-policy check
      .mockResolvedValueOnce({ rows: [{ id: 'existing-policy', description: '[auto-agent-models] test-agent' }] })
      // UPDATE model_policies
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE agents SET ...
      .mockResolvedValueOnce(mockExistingAgent())
      // SELECT skills for response
      .mockResolvedValueOnce({ rows: [] })
      // resolveAgentModels: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['my-model'] }] });

    const res = await request(app)
      .put('/agents/agent-uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_names: ['my-model'] });

    expect(res.status).toBe(200);
  });

  // A6: Admin POST with non-owned model → 400 (no admin bypass)
  it('A6: admin POST with non-owned model returns 400', async () => {
    // validateModelNames: user_models check returns empty — admin-1 doesn't own it
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...AGENT_BASE, model_names: ['unowned-model'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // A7: POST with owned but inactive model → 400
  it('A7: POST with owned but inactive model returns 400', async () => {
    // validateModelNames: is_active=true filter means inactive model is not returned
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_names: ['inactive-model'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // A8: PUT with owned but inactive model → 400
  it('A8: PUT with owned but inactive model returns 400', async () => {
    mockQuery
      // SELECT existing agent
      .mockResolvedValueOnce(mockExistingAgent())
      // validateModelNames: is_active=true filter means inactive not returned
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/agent-uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_names: ['inactive-model'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });

  // -----------------------------------------------------------------------
  // model_policy_id path
  // -----------------------------------------------------------------------

  // A9: POST with policy whose allowed_models are all owned+active → 201
  it('A9: POST with policy containing all owned models succeeds', async () => {
    mockQuery
      // SELECT policy (FK + ownership check)
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-1', allowed_models: ['my-model'] }] })
      // validatePolicyEligibility: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['my-model'] }] })
      // validatePolicyEligibility: user_models check for 'my-model'
      .mockResolvedValueOnce({ rows: [{ id: 'um-1' }] })
      // INSERT INTO agents
      .mockResolvedValueOnce(mockInsertAgent({ model_policy_id: 'policy-1' }))
      // SELECT skills for response
      .mockResolvedValueOnce({ rows: [] })
      // resolveAgentModels: SELECT allowed_models FROM model_policies
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['my-model'] }] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_policy_id: 'policy-1' });

    expect(res.status).toBe(201);
  });

  // A10: POST with policy whose allowed_models include non-owned model → 400
  it('A10: POST with policy containing non-owned model returns 400', async () => {
    mockQuery
      // SELECT policy (FK + ownership)
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-1', allowed_models: ['not-mine'] }] })
      // validatePolicyEligibility: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['not-mine'] }] })
      // validatePolicyEligibility: user_models check — not found
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
  });

  // A11: PUT with policy whose allowed_models include non-owned model → 400
  it('A11: PUT with policy containing non-owned model returns 400', async () => {
    mockQuery
      // SELECT existing agent
      .mockResolvedValueOnce(mockExistingAgent())
      // SELECT policy (FK + ownership)
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-1', allowed_models: ['not-owned'] }] })
      // validatePolicyEligibility: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['not-owned'] }] })
      // validatePolicyEligibility: user_models check — not found
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/agent-uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
  });

  // A12: Admin POST with policy containing non-owned model → 400 (no admin bypass)
  it('A12: admin POST with policy containing non-owned model returns 400', async () => {
    mockQuery
      // SELECT policy — owned by admin-1
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'admin-1', allowed_models: ['unowned-model'] }] })
      // validatePolicyEligibility: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['unowned-model'] }] })
      // validatePolicyEligibility: user_models check — not found
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...AGENT_BASE, model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
  });

  // A13: POST with policy containing owned but inactive model → 400
  it('A13: POST with policy containing inactive model returns 400', async () => {
    mockQuery
      // SELECT policy
      .mockResolvedValueOnce({ rows: [{ id: 'policy-1', created_by: 'user-1', allowed_models: ['inactive-model'] }] })
      // validatePolicyEligibility: SELECT allowed_models
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['inactive-model'] }] })
      // validatePolicyEligibility: user_models check — is_active=true filter excludes inactive
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_policy_id: 'policy-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not accessible to agent owner');
  });

  // -----------------------------------------------------------------------
  // Defense-in-depth
  // -----------------------------------------------------------------------

  // A14: POST with model_names containing a model visible nowhere in user's list → 400
  it('A14: POST with completely unknown model returns 400', async () => {
    // validateModelNames: no match
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ...AGENT_BASE, model_names: ['totally-unknown-model-xyz'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in user models for agent owner');
  });
});
