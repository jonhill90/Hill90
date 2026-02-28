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

// Mock services required by agents router (imported transitively via app.ts)
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

describe('Model Policy CRUD routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // Auth / role enforcement
  it('GET /model-policies returns 401 without auth', async () => {
    const res = await request(app).get('/model-policies');
    expect(res.status).toBe(401);
  });

  it('GET /model-policies returns 403 for non-admin', async () => {
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /model-policies returns 503 when DATABASE_URL not set', async () => {
    delete process.env.DATABASE_URL;
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
  });

  // List
  it('GET /model-policies lists all policies for admin', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'p1', name: 'default', allowed_models: ['gpt-4o-mini'], max_requests_per_minute: null, max_tokens_per_day: null },
      ],
    });
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('default');
  });

  // Get single
  it('GET /model-policies/:id returns policy', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'default', allowed_models: ['gpt-4o-mini'] }],
    });
    const res = await request(app)
      .get('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('default');
  });

  it('GET /model-policies/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/model-policies/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // Create
  it('POST /model-policies creates policy', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p2', name: 'premium', allowed_models: ['gpt-4o'], max_requests_per_minute: 10, max_tokens_per_day: 100000 }],
    });
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'premium', allowed_models: ['gpt-4o'], max_requests_per_minute: 10, max_tokens_per_day: 100000 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('premium');
  });

  it('POST /model-policies rejects missing name', async () => {
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowed_models: ['gpt-4o'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('POST /model-policies rejects non-array allowed_models', async () => {
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'bad', allowed_models: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('allowed_models');
  });

  it('POST /model-policies returns 409 on duplicate name', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'default', allowed_models: [] });
    expect(res.status).toBe(409);
  });

  // Update
  it('PUT /model-policies/:id updates policy', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini'] }] }) // existence check
      .mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'default', allowed_models: ['gpt-4o', 'gpt-4o-mini'], max_requests_per_minute: 20, max_tokens_per_day: null }],
      });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowed_models: ['gpt-4o', 'gpt-4o-mini'], max_requests_per_minute: 20 });
    expect(res.status).toBe(200);
    expect(res.body.max_requests_per_minute).toBe(20);
  });

  it('PUT /model-policies/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .put('/model-policies/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'foo' });
    expect(res.status).toBe(404);
  });

  it('PUT /model-policies/:id rejects non-array allowed_models', async () => {
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowed_models: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('allowed_models');
  });

  it('PUT /model-policies/:id can clear limits to null', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini'] }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'default', max_requests_per_minute: null, max_tokens_per_day: null }],
      });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ max_requests_per_minute: null, max_tokens_per_day: null });
    expect(res.status).toBe(200);
    // Verify the CASE WHEN boolean flag is passed as true (field was provided)
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][3]).toBe(true);  // rpmProvided
    expect(updateCall[1][4]).toBeNull();  // rpm value = null
    expect(updateCall[1][5]).toBe(true);  // tpdProvided
    expect(updateCall[1][6]).toBeNull();  // tpd value = null
  });

  // Aliases
  it('POST /model-policies creates policy with aliases', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p3', name: 'aliased', allowed_models: ['gpt-4o-mini', 'gpt-4o'], model_aliases: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }],
    });
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'aliased',
        allowed_models: ['gpt-4o-mini', 'gpt-4o'],
        model_aliases: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
      });
    expect(res.status).toBe(201);
    expect(res.body.model_aliases).toEqual({ fast: 'gpt-4o-mini', smart: 'gpt-4o' });
  });

  it('POST /model-policies rejects alias target not in allowed_models', async () => {
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'bad-alias',
        allowed_models: ['gpt-4o-mini'],
        model_aliases: { smart: 'gpt-4o' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'smart'");
    expect(res.body.error).toContain("'gpt-4o'");
  });

  it('PUT /model-policies/:id updates aliases', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini', 'gpt-4o'] }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'default', model_aliases: { fast: 'gpt-4o-mini' } }],
      });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_aliases: { fast: 'gpt-4o-mini' } });
    expect(res.status).toBe(200);
  });

  it('PUT /model-policies/:id rejects alias target not in allowed_models', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini'] }] });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_aliases: { smart: 'gpt-4o' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'smart'");
  });

  it('GET /model-policies returns model_aliases', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'p1', name: 'default', allowed_models: ['gpt-4o-mini'], model_aliases: { fast: 'gpt-4o-mini' } },
      ],
    });
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body[0].model_aliases).toEqual({ fast: 'gpt-4o-mini' });
  });

  // Delete
  it('DELETE /model-policies/:id deletes policy', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no agents assigned
      .mockResolvedValueOnce({ rowCount: 1 }); // delete succeeds
    const res = await request(app)
      .delete('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('DELETE /model-policies/:id returns 409 when agents assigned', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', agent_id: 'my-agent' }],
    });
    const res = await request(app)
      .delete('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('agents');
  });

  it('DELETE /model-policies/:id returns 404 for unknown', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no agents
      .mockResolvedValueOnce({ rowCount: 0 }); // nothing deleted
    const res = await request(app)
      .delete('/model-policies/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
