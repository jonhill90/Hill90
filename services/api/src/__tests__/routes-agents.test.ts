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
const mockCreateAndStartContainer = jest.fn().mockResolvedValue('container-id-123');
const mockStopAndRemoveContainer = jest.fn().mockResolvedValue(undefined);
const mockEnsureRequiredToolsInstalled = jest.fn().mockResolvedValue(undefined);
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock docker service
jest.mock('../services/docker', () => ({
  createAndStartContainer: (...args: any[]) => mockCreateAndStartContainer(...args),
  stopAndRemoveContainer: (...args: any[]) => mockStopAndRemoveContainer(...args),
  inspectContainer: jest.fn().mockResolvedValue({ status: 'running', containerId: 'abc', health: 'healthy' }),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
  reconcileAgentStatuses: jest.fn().mockResolvedValue(undefined),
}));

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn().mockReturnValue('/data/agentbox/test-agent'),
  removeAgentFiles: jest.fn(),
}));
const mockReconcileToolInstalls = jest.fn().mockResolvedValue({ installed: [], alreadyInstalled: [], failed: [] });
jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: (...args: any[]) => mockEnsureRequiredToolsInstalled(...args),
  reconcileToolInstalls: (...args: any[]) => mockReconcileToolInstalls(...args),
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

describe('Agent CRUD routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /agents returns 403 without user role', async () => {
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /agents returns 401 without auth', async () => {
    const res = await request(app).get('/agents');
    expect(res.status).toBe(401);
  });

  it('GET /agents returns 503 when DATABASE_URL not set', async () => {
    delete process.env.DATABASE_URL;
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(503);
  });

  it('GET /agents scopes to owner for user role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Check that query included ownership filter
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
  });

  it('GET /agents shows all for admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('1=1');
  });

  it('POST /agents creates agent with user role', async () => {
    const agentData = {
      agent_id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
    };
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'uuid-1', ...agentData, status: 'stopped', created_by: 'regular-user' }],
      })
      .mockResolvedValueOnce({ rows: [] }); // SELECT skills for response

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send(agentData);
    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe('test-agent');
  });

  it('POST /agents rejects invalid agent_id', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'INVALID ID!', name: 'Bad' });
    expect(res.status).toBe(400);
  });

  it('POST /agents rejects missing fields', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ description: 'missing agent_id and name' });
    expect(res.status).toBe(400);
  });

  it('POST /agents returns 409 on duplicate agent_id', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'dupe', name: 'Dupe' });
    expect(res.status).toBe(409);
  });

  it('DELETE /agents/:id requires admin role', async () => {
    const res = await request(app)
      .delete('/agents/some-id')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('DELETE /agents/:id works for admin', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test', status: 'stopped' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

describe('Agent lifecycle routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateAndStartContainer.mockReset();
    mockCreateAndStartContainer.mockResolvedValue('container-id-123');
    mockStopAndRemoveContainer.mockReset();
    mockStopAndRemoveContainer.mockResolvedValue(undefined);
    mockEnsureRequiredToolsInstalled.mockReset();
    mockEnsureRequiredToolsInstalled.mockResolvedValue(undefined);
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /agents/:id/start requires admin role', async () => {
    const res = await request(app)
      .post('/agents/some-id/start')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /agents/:id/start returns 503 without AGENTBOX_CONFIG_HOST_PATH', async () => {
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    const res = await request(app)
      .post('/agents/some-id/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
  });

  it('POST /agents/:id/start starts agent for admin', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills (no skill)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.container_id).toBe('container-id-123');
  });

  it('POST /agents/:id/start injects WORK_TOKEN env var', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const callArgs = mockCreateAndStartContainer.mock.calls[0][0];
    const workTokenEntry = callArgs.env.find((e: string) => e.startsWith('WORK_TOKEN='));
    expect(workTokenEntry).toBeDefined();
    // Token should be a UUID (36 chars: 8-4-4-4-12)
    const tokenValue = workTokenEntry.split('=')[1];
    expect(tokenValue).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('POST /agents/:id/start stores work_token in DB', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills
      .mockResolvedValueOnce({ rows: [] }); // UPDATE agents

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Find the UPDATE call that sets work_token
    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('work_token')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain('work_token = $');
    // work_token param should be a UUID
    const workTokenParam = updateCall![1].find(
      (p: any) => typeof p === 'string' && /^[0-9a-f]{8}-/.test(p)
    );
    expect(workTokenParam).toBeDefined();
  });

  it('POST /agents/:id/start injects CHAT_CALLBACK_TOKEN when configured', async () => {
    process.env.CHAT_CALLBACK_TOKEN = 'test-chat-callback-token';
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills
      .mockResolvedValueOnce({ rows: [] }); // UPDATE agents

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const callArgs = mockCreateAndStartContainer.mock.calls[0][0];
    const chatTokenEntry = callArgs.env.find((e: string) => e.startsWith('CHAT_CALLBACK_TOKEN='));
    expect(chatTokenEntry).toBe('CHAT_CALLBACK_TOKEN=test-chat-callback-token');
  });

  it('POST /agents/:id/start cleans up and marks error when tool install fails', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid-1', agent_id: 'test-agent', name: 'Test',
          tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
          soul_md: '', rules_md: '', description: '',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // SELECT agent_skills (no skill instructions)
      .mockResolvedValueOnce({ rows: [] }); // UPDATE status=error in catch block
    mockEnsureRequiredToolsInstalled.mockRejectedValueOnce(new Error('gh install failed'));

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to start agent');
    expect(res.body.detail).toContain('Tool installation failed');
    expect(mockStopAndRemoveContainer).toHaveBeenCalledWith('test-agent');
    expect(mockEnsureRequiredToolsInstalled).toHaveBeenCalledWith('uuid-1', 'test-agent');
  });

  it('POST /agents/:id/stop requires admin role', async () => {
    const res = await request(app)
      .post('/agents/some-id/stop')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /agents/:id/stop clears work_token and cleans stale chat messages', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'running' }] }) // SELECT agent
      .mockResolvedValueOnce({ rowCount: 2 }) // UPDATE chat_messages (stale cleanup)
      .mockResolvedValueOnce({ rows: [] }); // UPDATE agents

    const res = await request(app)
      .post('/agents/uuid-1/stop')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');

    // Verify stale chat message cleanup
    const cleanupCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('chat_messages')
    );
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall![0]).toContain("status = 'error'");
    expect(cleanupCall![0]).toContain("'Agent stopped'");
    expect(cleanupCall![1]).toEqual(['uuid-1']);

    // Verify work_token cleared in UPDATE
    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('work_token = NULL')
    );
    expect(updateCall).toBeDefined();
  });

  it('GET /agents/:id/status scopes to owner', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_id: 'test', status: 'running', container_id: 'abc', error_message: null }],
    });
    const res = await request(app)
      .get('/agents/uuid-1/status')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Verify ownership scoping in query
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $');
  });

  it('GET /agents/:id/tool-installs returns install statuses for owned agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] }) // ownership check
      .mockResolvedValueOnce({
        rows: [
          {
            tool_id: 'tool-gh',
            tool_name: 'gh',
            tool_description: 'GitHub CLI',
            status: 'installed',
            install_message: 'installed',
            installed_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
          },
        ],
      });

    const res = await request(app)
      .get('/agents/uuid-1/tool-installs')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tool_name).toBe('gh');
  });

  it('GET /agents/:id/tool-installs returns 404 for unowned agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/agents/uuid-1/tool-installs')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });

  it('GET /agents/:id/logs requires admin role', async () => {
    const res = await request(app)
      .get('/agents/some-id/logs')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /agents/:id/reconcile-tools', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockReconcileToolInstalls.mockReset();
    mockReconcileToolInstalls.mockResolvedValue({ installed: ['gh'], alreadyInstalled: [], failed: [] });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/agents/uuid-1/reconcile-tools');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .post('/agents/uuid-1/reconcile-tools')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/reconcile-tools')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Agent not found');
  });

  it('returns 409 when agent is not running', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'stopped' }] });

    const res = await request(app)
      .post('/agents/uuid-1/reconcile-tools')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('running');
  });

  it('returns 200 with reconcile result for running agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', agent_id: 'test-agent', status: 'running' }] });

    const res = await request(app)
      .post('/agents/uuid-1/reconcile-tools')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('installed');
    expect(res.body).toHaveProperty('alreadyInstalled');
    expect(res.body).toHaveProperty('failed');
    expect(Array.isArray(res.body.installed)).toBe(true);
    expect(mockReconcileToolInstalls).toHaveBeenCalledWith('uuid-1', 'test-agent');
  });
});
