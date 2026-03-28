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
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    }),
  }),
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

// Mock axios for validate endpoint
jest.mock('axios', () => ({
  post: jest.fn(),
}));
import axios from 'axios';
const mockAxiosPost = axios.post as jest.Mock;

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

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

describe('Provider Connections CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockAxiosPost.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = 'test-service-token';
    process.env.AI_SERVICE_URL = 'http://ai:8000';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    delete process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
    delete process.env.AI_SERVICE_URL;
  });

  it('POST /provider-connections creates connection', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', name: 'My OpenAI', provider: 'openai',
        api_base_url: null, is_valid: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'My OpenAI', provider: 'openai', api_key: 'sk-test123' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My OpenAI');
    expect(res.body.is_valid).toBeNull();

    // Verify encrypted key was passed to query (not plaintext)
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO provider_connections');
    // params[2] = encrypted (Buffer), params[3] = nonce (Buffer)
    expect(Buffer.isBuffer(insertCall[1][2])).toBe(true);
    expect(Buffer.isBuffer(insertCall[1][3])).toBe(true);
  });

  it('api_key never in GET response', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', name: 'My OpenAI', provider: 'openai',
        api_base_url: null, is_valid: true,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .get('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('api_key');
    expect(body).not.toContain('api_key_encrypted');
    expect(body).not.toContain('api_key_nonce');
  });

  it('list shows only own connections', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', name: 'My OpenAI', provider: 'openai' }],
    });

    const res = await request(app)
      .get('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // Verify query scopes to owner
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
  });

  it('delete cascades to user_models', async () => {
    // The CASCADE is DB-level via FK constraint; here we verify the delete query
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] }); // DELETE
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT router models (none)
    mockClientQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .delete('/provider-connections/uuid-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    // DELETE is the second client.query call (index 1, after BEGIN)
    const call = mockClientQuery.mock.calls[1];
    expect(call[0]).toContain('DELETE FROM provider_connections');
    expect(call[0]).toContain('created_by = $2');
    expect(call[1]).toEqual(['uuid-1', 'regular-user']);
  });

  it('validate connection success — delegates to AI service', async () => {
    // First query: fetch encrypted key
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', provider: 'openai',
        api_key_encrypted: Buffer.from('encrypted-data'),
        api_key_nonce: Buffer.from('nonce-data'),
        api_base_url: null,
      }],
    });
    // Second query: update is_valid
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockAxiosPost.mockResolvedValueOnce({ data: { valid: true } });

    const res = await request(app)
      .post('/provider-connections/uuid-1/validate')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.is_valid).toBe(true);

    // Verify AI service was called
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('http://ai:8000/internal/validate-provider');
    expect(body.provider).toBe('openai');
    expect(opts.headers.Authorization).toBe('Bearer test-service-token');
  });

  it('validate connection invalid key — AI returns error', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', provider: 'openai',
        api_key_encrypted: Buffer.from('encrypted-data'),
        api_key_nonce: Buffer.from('nonce-data'),
        api_base_url: null,
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockAxiosPost.mockRejectedValueOnce({
      response: { data: { error: 'Invalid API key' } },
    });

    const res = await request(app)
      .post('/provider-connections/uuid-1/validate')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.is_valid).toBe(false);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('update re-encrypts key', async () => {
    // Verify ownership query
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] });
    // Update query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'uuid-1', name: 'My OpenAI', provider: 'openai',
        api_base_url: null, is_valid: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .put('/provider-connections/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ api_key: 'sk-new-key' });

    expect(res.status).toBe(200);
    // Verify the update query includes encrypted key fields
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('api_key_encrypted');
    expect(updateCall[0]).toContain('api_key_nonce');
    expect(updateCall[0]).toContain('is_valid = NULL');
  });

  it('requires user role', async () => {
    const noRoleToken = jwt.sign(
      { sub: 'no-role-user', realm_roles: [] },
      privateKey,
      { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
    );
    const res = await request(app)
      .get('/provider-connections')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing required fields on create', async () => {
    const res = await request(app)
      .post('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Test' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent connection on delete', async () => {
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // DELETE returns empty (not found)
    mockClientQuery.mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app)
      .delete('/provider-connections/uuid-nonexistent')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });
});
