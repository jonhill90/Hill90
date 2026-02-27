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

// Mock akm-proxy
const mockListAgents = jest.fn();
const mockListEntries = jest.fn();
const mockReadEntry = jest.fn();
const mockSearchEntries = jest.fn();
jest.mock('../services/akm-proxy', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  listEntries: (...args: unknown[]) => mockListEntries(...args),
  readEntry: (...args: unknown[]) => mockReadEntry(...args),
  searchEntries: (...args: unknown[]) => mockSearchEntries(...args),
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

describe('Knowledge proxy routes — auth', () => {
  it('GET /knowledge/agents returns 401 without auth', async () => {
    const res = await request(app).get('/knowledge/agents');
    expect(res.status).toBe(401);
  });

  it('GET /knowledge/agents returns 403 without user role', async () => {
    const res = await request(app)
      .get('/knowledge/agents')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /knowledge/entries returns 401 without auth', async () => {
    const res = await request(app).get('/knowledge/entries?agent_id=test');
    expect(res.status).toBe(401);
  });

  it('GET /knowledge/search returns 401 without auth', async () => {
    const res = await request(app).get('/knowledge/search?q=test');
    expect(res.status).toBe(401);
  });
});

describe('Knowledge proxy routes — list agents', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockListAgents.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('admin sees all agents', async () => {
    mockListAgents.mockResolvedValueOnce({
      status: 200,
      data: [
        { agent_id: 'agent-a', entry_count: 5, last_updated: '2025-01-01T00:00:00Z' },
        { agent_id: 'agent-b', entry_count: 3, last_updated: '2025-01-01T00:00:00Z' },
      ],
    });

    const res = await request(app)
      .get('/knowledge/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('user sees only own agents', async () => {
    mockListAgents.mockResolvedValueOnce({
      status: 200,
      data: [
        { agent_id: 'agent-a', entry_count: 5, last_updated: '2025-01-01T00:00:00Z' },
        { agent_id: 'agent-b', entry_count: 3, last_updated: '2025-01-01T00:00:00Z' },
      ],
    });
    // Mock: user owns only agent-a
    mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-a' }] });

    const res = await request(app)
      .get('/knowledge/agents')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agent_id).toBe('agent-a');
  });

  it('returns 502 when knowledge service is down', async () => {
    mockListAgents.mockResolvedValueOnce({
      status: 502,
      data: { error: 'Knowledge service unavailable' },
    });

    const res = await request(app)
      .get('/knowledge/agents')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(502);
  });
});

describe('Knowledge proxy routes — list entries', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockListEntries.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 400 without agent_id', async () => {
    const res = await request(app)
      .get('/knowledge/entries')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(400);
  });

  it('user cannot list entries for unowned agent', async () => {
    // Mock: user owns no agents
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/knowledge/entries?agent_id=not-mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('user can list entries for owned agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'my-agent' }] });
    mockListEntries.mockResolvedValueOnce({
      status: 200,
      data: [{ id: '1', agent_id: 'my-agent', path: 'notes/test.md', title: 'Test' }],
    });

    const res = await request(app)
      .get('/knowledge/entries?agent_id=my-agent')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('admin can list entries for any agent', async () => {
    mockListEntries.mockResolvedValueOnce({
      status: 200,
      data: [{ id: '1', agent_id: 'any-agent', path: 'notes/test.md', title: 'Test' }],
    });

    const res = await request(app)
      .get('/knowledge/entries?agent_id=any-agent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('Knowledge proxy routes — read entry', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockReadEntry.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('user cannot read entry from unowned agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/knowledge/entries/not-mine/notes/test.md')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('user can read entry from owned agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'my-agent' }] });
    mockReadEntry.mockResolvedValueOnce({
      status: 200,
      data: { id: '1', agent_id: 'my-agent', path: 'notes/test.md', content: '# Test' },
    });

    const res = await request(app)
      .get('/knowledge/entries/my-agent/notes/test.md')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('notes/test.md');
  });

  it('returns 404 for nonexistent entry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'my-agent' }] });
    mockReadEntry.mockResolvedValueOnce({
      status: 404,
      data: { detail: 'entry not found' },
    });

    const res = await request(app)
      .get('/knowledge/entries/my-agent/notes/nope.md')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Knowledge proxy routes — search', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSearchEntries.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('returns 400 without q param', async () => {
    const res = await request(app)
      .get('/knowledge/search')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(400);
  });

  it('admin searches all agents without filter', async () => {
    mockSearchEntries.mockResolvedValueOnce({
      status: 200,
      data: { query: 'test', results: [{ id: '1', agent_id: 'a', score: 0.5 }], count: 1, search_type: 'fts', score_type: 'ts_rank' },
    });

    const res = await request(app)
      .get('/knowledge/search?q=test')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('user search scoped to owned agents', async () => {
    // Mock: user owns agent-a
    mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'agent-a' }] });
    mockSearchEntries.mockResolvedValueOnce({
      status: 200,
      data: { query: 'test', results: [{ id: '1', agent_id: 'agent-a', score: 0.5 }], count: 1, search_type: 'fts', score_type: 'ts_rank' },
    });

    const res = await request(app)
      .get('/knowledge/search?q=test')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Should have searched only for agent-a
    expect(mockSearchEntries).toHaveBeenCalledWith('test', 'agent-a');
  });

  it('user cannot search specific unowned agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/knowledge/search?q=test&agent_id=not-mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});
