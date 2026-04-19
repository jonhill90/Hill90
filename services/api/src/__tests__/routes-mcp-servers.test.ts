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

function makeToken(sub: string, roles: string[]): string {
  return jwt.sign(
    { sub, realm_roles: roles },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

const MOCK_SERVER = {
  id: 'mcp-1',
  name: 'GitHub MCP',
  description: 'GitHub API tools',
  transport: 'stdio',
  connection_config: '{"command":"npx","args":["-y","@modelcontextprotocol/server-github"]}',
  is_platform: false,
  agent_count: '2',
  created_by: 'regular-user',
  created_at: '2026-04-19T00:00:00Z',
};

describe('MCP Servers routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /mcp-servers', () => {
    it('lists servers for user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('GitHub MCP');
    });

    it('admin sees all servers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // Admin query should NOT contain created_by filter
      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).not.toContain('created_by');
    });

    it('user query scopes to own + platform', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`);

      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).toContain('created_by');
      expect(queryStr).toContain('is_platform');
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/mcp-servers');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /mcp-servers', () => {
    it('creates a server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_SERVER] });

      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'GitHub MCP', transport: 'stdio', connection_config: { command: 'npx' } });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('GitHub MCP');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ transport: 'stdio' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('rejects invalid transport', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Test', transport: 'grpc' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('transport');
    });

    it('non-admin cannot create platform server', async () => {
      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Platform', is_platform: true });

      expect(res.status).toBe(403);
    });

    it('admin can create platform server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_SERVER, is_platform: true }] });

      const res = await request(app)
        .post('/mcp-servers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Platform', is_platform: true });

      expect(res.status).toBe(201);
    });
  });

  describe('PUT /mcp-servers/:id', () => {
    it('updates a server', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_SERVER, name: 'Updated' }] });

      const res = await request(app)
        .put('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/mcp-servers/bad-id')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /mcp-servers/:id', () => {
    it('deletes a server', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .delete('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .delete('/mcp-servers/bad-id')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
    });

    it('user can only delete own servers', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .delete('/mcp-servers/mcp-1')
        .set('Authorization', `Bearer ${userToken}`);

      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).toContain('created_by');
    });
  });
});
