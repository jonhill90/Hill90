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

describe('Tools CRUD routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // T1: GET /tools returns tools
  it('GET /tools returns tools', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'tool-1', name: 'bash', description: 'Bourne Again Shell', install_method: 'builtin', install_ref: '', is_platform: true, created_at: '2026-01-01T00:00:00Z' },
        { id: 'tool-2', name: 'gh', description: 'GitHub CLI', install_method: 'binary', install_ref: 'https://github.com/cli/cli', is_platform: false, created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    const res = await request(app)
      .get('/tools')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('bash');
    expect(res.body[1].install_method).toBe('binary');
  });

  // T2: POST /tools creates tool with install_method (admin)
  it('POST /tools creates tool with install_method (admin)', async () => {
    const created = { id: 'tool-new', name: 'ripgrep', description: 'Fast grep', install_method: 'binary', install_ref: 'https://github.com/BurntSushi/ripgrep', is_platform: false, created_at: '2026-01-01T00:00:00Z' };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/tools')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ripgrep', description: 'Fast grep', install_method: 'binary', install_ref: 'https://github.com/BurntSushi/ripgrep' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('ripgrep');
    expect(res.body.install_method).toBe('binary');
  });

  // T3: POST /tools rejects non-admin
  it('POST /tools rejects non-admin', async () => {
    const res = await request(app)
      .post('/tools')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'test-tool' });
    expect(res.status).toBe(403);
  });

  // T4: POST /tools rejects duplicate name
  it('POST /tools rejects duplicate name', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await request(app)
      .post('/tools')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'bash', description: 'duplicate' });
    expect(res.status).toBe(409);
  });

  // T5: POST /tools rejects invalid install_method
  it('POST /tools rejects invalid install_method', async () => {
    const res = await request(app)
      .post('/tools')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'something', install_method: 'pip' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('install_method');
  });

  // T6: PUT /tools/:id updates tool (admin)
  it('PUT /tools/:id updates tool (admin)', async () => {
    const existing = { id: 'tool-1', is_platform: false };
    const updated = { id: 'tool-1', name: 'renamed', description: 'Updated', install_method: 'apt', install_ref: 'ripgrep', is_platform: false, created_at: '2026-01-01T00:00:00Z' };
    mockQuery
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app)
      .put('/tools/tool-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'renamed', description: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('renamed');
  });

  // T7: PUT /tools/:id rejects platform tool mutation
  it('PUT /tools/:id rejects platform tool mutation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tool-1', is_platform: true }] });
    const res = await request(app)
      .put('/tools/tool-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'renamed' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  // T8: DELETE /tools/:id deletes non-platform tool
  it('DELETE /tools/:id deletes non-platform tool', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'tool-1', is_platform: false }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app)
      .delete('/tools/tool-1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });

  // T9: DELETE /tools/:id rejects platform tool
  it('DELETE /tools/:id rejects platform tool', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tool-1', is_platform: true }] });
    const res = await request(app)
      .delete('/tools/tool-1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  // T10: DELETE /tools/:id rejects tool referenced by skill
  it('DELETE /tools/:id rejects tool referenced by skill', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'tool-1', is_platform: false }] })
      .mockRejectedValueOnce({ code: '23503' });
    const res = await request(app)
      .delete('/tools/tool-1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('skills');
  });
});
