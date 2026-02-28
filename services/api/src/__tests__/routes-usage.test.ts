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

describe('Usage query routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /usage returns 401 without auth', async () => {
    const res = await request(app).get('/usage');
    expect(res.status).toBe(401);
  });

  it('GET /usage returns 403 for non-admin', async () => {
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /usage returns summary without group_by', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        total_requests: '10',
        successful_requests: '8',
        total_input_tokens: '5000',
        total_output_tokens: '2000',
        total_tokens: '7000',
        total_cost_usd: '0.035000',
      }],
    });
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_requests).toBe('10');
    expect(res.body.total_cost_usd).toBe('0.035000');
  });

  it('GET /usage filters by agent_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_requests: '3', successful_requests: '3', total_input_tokens: '1000', total_output_tokens: '500', total_tokens: '1500', total_cost_usd: '0.010000' }],
    });
    const res = await request(app)
      .get('/usage?agent_id=my-agent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Verify agent_id filter is in the SQL
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('agent_id = $');
    expect(call[1]).toContain('my-agent');
  });

  it('GET /usage supports group_by=agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { agent_id: 'agent-1', total_requests: '5', successful_requests: '5', total_input_tokens: '2500', total_output_tokens: '1000', total_tokens: '3500', total_cost_usd: '0.020000' },
        { agent_id: 'agent-2', total_requests: '3', successful_requests: '2', total_input_tokens: '1500', total_output_tokens: '500', total_tokens: '2000', total_cost_usd: '0.010000' },
      ],
    });
    const res = await request(app)
      .get('/usage?group_by=agent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe('agent');
    expect(res.body.data).toHaveLength(2);
  });

  it('GET /usage supports group_by=model', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ model_name: 'gpt-4o-mini', total_requests: '10', successful_requests: '10', total_input_tokens: '5000', total_output_tokens: '2000', total_tokens: '7000', total_cost_usd: '0.035000' }],
    });
    const res = await request(app)
      .get('/usage?group_by=model')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe('model');
    // Verify GROUP BY model_name in SQL
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('GROUP BY model_name');
  });

  it('GET /usage supports date range filtering', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_requests: '0', successful_requests: '0', total_input_tokens: '0', total_output_tokens: '0', total_tokens: '0', total_cost_usd: '0.000000' }],
    });
    const res = await request(app)
      .get('/usage?from=2026-02-01&to=2026-02-28')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    // Verify explicit UTC offset on date params
    expect(call[1]).toContain('2026-02-01T00:00:00+00:00');
    expect(call[1]).toContain('2026-02-28T00:00:00+00:00');
  });

  it('GET /usage default from-date uses explicit UTC midnight', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_requests: '0', successful_requests: '0', total_input_tokens: '0', total_output_tokens: '0', total_tokens: '0', total_cost_usd: '0.000000' }],
    });
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    // Default from-date should be today with explicit UTC offset
    const todayPrefix = new Date().toISOString().slice(0, 10);
    expect(call[1]).toContain(`${todayPrefix}T00:00:00+00:00`);
  });

  it('GET /usage filters by request_type', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_requests: '5', successful_requests: '5', total_input_tokens: '500', total_output_tokens: '0', total_tokens: '500', total_cost_usd: '0.000005' }],
    });
    const res = await request(app)
      .get('/usage?request_type=embedding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('request_type = $');
    expect(call[1]).toContain('embedding');
  });

  it('GET /usage supports group_by=request_type', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { request_type: 'chat.completion', total_requests: '10', successful_requests: '10', total_input_tokens: '5000', total_output_tokens: '2000', total_tokens: '7000', total_cost_usd: '0.035000' },
        { request_type: 'embedding', total_requests: '5', successful_requests: '5', total_input_tokens: '500', total_output_tokens: '0', total_tokens: '500', total_cost_usd: '0.000005' },
      ],
    });
    const res = await request(app)
      .get('/usage?group_by=request_type')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe('request_type');
    expect(res.body.data).toHaveLength(2);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('GROUP BY request_type');
  });

  it('GET /usage combines request_type filter with agent_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_requests: '2', successful_requests: '2', total_input_tokens: '200', total_output_tokens: '0', total_tokens: '200', total_cost_usd: '0.000002' }],
    });
    const res = await request(app)
      .get('/usage?agent_id=my-agent&request_type=embedding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('agent_id = $');
    expect(call[0]).toContain('request_type = $');
    expect(call[1]).toContain('my-agent');
    expect(call[1]).toContain('embedding');
  });
});
