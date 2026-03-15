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
const userBToken = makeToken('user-b', ['user']);

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

  it('GET /model-policies returns 403 for no-role user', async () => {
    const noRoleToken = makeToken('no-role-user', []);
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /model-policies returns 503 when DATABASE_URL not set', async () => {
    delete process.env.DATABASE_URL;
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(503);
  });

  // List — admin sees all
  it('GET /model-policies lists all policies for admin', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'p1', name: 'default', allowed_models: ['gpt-4o-mini'], created_by: null },
        { id: 'p2', name: 'user-policy', allowed_models: ['my-model'], created_by: 'regular-user' },
      ],
    });
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // List — user sees own + platform
  it('GET /model-policies lists own + platform policies for user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'p1', name: 'default', created_by: null },
        { id: 'p2', name: 'my-policy', created_by: 'regular-user' },
      ],
    });
    const res = await request(app)
      .get('/model-policies')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Verify the query scopes to own + platform
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1 OR created_by IS NULL');
    expect(call[1]).toEqual(['regular-user']);
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

  it('GET /model-policies/:id user can see platform policy', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'default', created_by: null }],
    });
    const res = await request(app)
      .get('/model-policies/p1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Verify scoped query
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $2 OR created_by IS NULL');
  });

  // Create — admin (validates allowed_models against admin's user_models)
  it('POST /model-policies creates platform policy for admin', async () => {
    // validateAllowedModels: check user_models for "gpt-4o" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-admin-1' }] });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p2', name: 'premium', allowed_models: ['gpt-4o'], created_by: null }],
    });
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'premium', allowed_models: ['gpt-4o'], max_requests_per_minute: 10, max_tokens_per_day: 100000 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('premium');
    // Admin policies get created_by = null
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][7]).toBeNull(); // created_by param
  });

  // Create — user (validates allowed_models against user_models only)
  it('POST /model-policies user creates own policy', async () => {
    // validateAllowedModels: check user_models for "my-gpt4" (found)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-1' }] });
    // validateAllowedModels: check user_models for "gpt-4o-mini" (found)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-2' }] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p3', name: 'my-policy', allowed_models: ['my-gpt4', 'gpt-4o-mini'], created_by: 'regular-user' }],
    });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'my-policy', allowed_models: ['my-gpt4', 'gpt-4o-mini'] });
    expect(res.status).toBe(201);
    expect(res.body.created_by).toBe('regular-user');
  });

  it('POST /model-policies user policy rejects other users models', async () => {
    // validateAllowedModels: check user_models for "user-b-model" (not found)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'bad-policy', allowed_models: ['user-b-model'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'user-b-model' not found in user models for policy owner");
  });

  it('POST /model-policies user policy rejects platform-only models not in user_models', async () => {
    // validateAllowedModels: check user_models for "gpt-4o-mini" (not found — platform models no longer accepted)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'platform-only', allowed_models: ['gpt-4o-mini'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'gpt-4o-mini' not found in user models for policy owner");
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

  // Update — admin can update any (validates allowed_models against admin's user_models)
  it('PUT /model-policies/:id updates policy (admin)', async () => {
    // existence check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini'] }] });
    // validateAllowedModels: check user_models for "gpt-4o" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-a1' }] });
    // validateAllowedModels: check user_models for "gpt-4o-mini" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-a2' }] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'default', allowed_models: ['gpt-4o', 'gpt-4o-mini'], max_requests_per_minute: 20, max_tokens_per_day: null }],
    });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowed_models: ['gpt-4o', 'gpt-4o-mini'], max_requests_per_minute: 20 });
    expect(res.status).toBe(200);
    expect(res.body.max_requests_per_minute).toBe(20);
  });

  // Update — user can only update own
  it('PUT /model-policies/:id user can update own policy', async () => {
    // Ownership check returns the policy (created_by matches)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p3', allowed_models: ['my-gpt4'], created_by: 'regular-user' }] });
    // Update
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p3', name: 'updated', allowed_models: ['my-gpt4'], created_by: 'regular-user' }],
    });
    const res = await request(app)
      .put('/model-policies/p3')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'updated' });
    expect(res.status).toBe(200);
    // Verify ownership-scoped query
    const checkCall = mockQuery.mock.calls[0];
    expect(checkCall[0]).toContain('created_by = $2');
    expect(checkCall[1]).toEqual(['p3', 'regular-user']);
  });

  it('PUT /model-policies/:id user cannot update platform policy', async () => {
    // Ownership check returns nothing (platform policy has created_by = NULL, user query won't match)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'hijack' });
    expect(res.status).toBe(404);
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

  // Aliases — admin-only boundary
  it('POST /model-policies user cannot set model_aliases', async () => {
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'user-alias-attempt',
        allowed_models: ['gpt-4o-mini'],
        model_aliases: { fast: 'gpt-4o-mini' },
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('model_aliases can only be set by admins');
  });

  it('PUT /model-policies/:id user cannot set model_aliases', async () => {
    // Ownership check passes
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p3', allowed_models: ['gpt-4o-mini'], created_by: 'regular-user' }] });
    const res = await request(app)
      .put('/model-policies/p3')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ model_aliases: { fast: 'gpt-4o-mini' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('model_aliases can only be set by admins');
  });

  it('POST /model-policies creates policy with aliases', async () => {
    // validateAllowedModels: check user_models for "gpt-4o-mini" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-a1' }] });
    // validateAllowedModels: check user_models for "gpt-4o" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-a2' }] });
    // INSERT
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

  // Delete — admin
  it('DELETE /model-policies/:id deletes policy (admin)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no agents assigned
      .mockResolvedValueOnce({ rowCount: 1 }); // delete succeeds
    const res = await request(app)
      .delete('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  // Delete — user can delete own
  it('DELETE /model-policies/:id user deletes own policy', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no agents assigned
      .mockResolvedValueOnce({ rowCount: 1 }); // delete succeeds
    const res = await request(app)
      .delete('/model-policies/p3')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    // Verify ownership-scoped delete
    const deleteCall = mockQuery.mock.calls[1];
    expect(deleteCall[0]).toContain('created_by = $2');
    expect(deleteCall[1]).toEqual(['p3', 'regular-user']);
  });

  it('DELETE /model-policies/:id user cannot delete platform policy', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no agents assigned
      .mockResolvedValueOnce({ rowCount: 0 }); // delete finds nothing (scoped by created_by)
    const res = await request(app)
      .delete('/model-policies/p1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
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

  // AI-120: admin model eligibility enforcement
  it('POST /model-policies admin with model in own user_models passes', async () => {
    // validateAllowedModels: check user_models for "gpt-4o" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-admin-1' }] });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p5', name: 'admin-eligible', allowed_models: ['gpt-4o'], created_by: null }],
    });
    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'admin-eligible', allowed_models: ['gpt-4o'] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('admin-eligible');
  });

  it('POST /model-policies admin with model NOT in own user_models is rejected', async () => {
    // validateAllowedModels: check user_models for "unknown-model" (not found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'admin-ineligible', allowed_models: ['unknown-model'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'unknown-model' not found in user models for policy owner");
  });

  it('PUT /model-policies/:id admin update with new allowed_models validates each model', async () => {
    // existence check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', allowed_models: ['gpt-4o-mini'] }] });
    // validateAllowedModels: check user_models for "gpt-4o" (found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'um-a1' }] });
    // validateAllowedModels: check user_models for "claude-3" (not found for admin-user)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowed_models: ['gpt-4o', 'claude-3'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'claude-3' not found in user models for policy owner");
  });
});
