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

// Mock docker service
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn().mockResolvedValue('container-id-123'),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
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
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
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

  it('POST /agents/:id/stop requires admin role', async () => {
    const res = await request(app)
      .post('/agents/some-id/stop')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
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

  it('GET /agents/:id/logs requires admin role', async () => {
    const res = await request(app)
      .get('/agents/some-id/logs')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});
