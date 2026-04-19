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

const userToken = makeToken('user-123', ['user']);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

describe('Notifications routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /notifications', () => {
    it('returns notifications and unread count', async () => {
      const mockNotifs = [
        { id: 'n1', message: 'Agent started', type: 'agent_start', read: false, metadata: {}, created_at: '2026-04-19T00:00:00Z' },
        { id: 'n2', message: 'Agent error', type: 'agent_error', read: true, metadata: {}, created_at: '2026-04-18T00:00:00Z' },
      ];
      mockQuery
        .mockResolvedValueOnce({ rows: mockNotifs })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const res = await request(app)
        .get('/notifications')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(2);
      expect(res.body.unread_count).toBe(1);
    });

    it('respects limit parameter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] });

      await request(app)
        .get('/notifications?limit=10')
        .set('Authorization', `Bearer ${userToken}`);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(10); // limit param
    });

    it('caps limit at 200', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] });

      await request(app)
        .get('/notifications?limit=999')
        .set('Authorization', `Bearer ${userToken}`);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(200);
    });

    it('filters unread only when unread=true', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] });

      await request(app)
        .get('/notifications?unread=true')
        .set('Authorization', `Bearer ${userToken}`);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[0]).toContain('read = FALSE');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/notifications');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /notifications/:id/read', () => {
    it('marks notification as read', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .put('/notifications/n1/read')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.read).toBe(true);
    });

    it('returns 404 for non-existent notification', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .put('/notifications/bad-id/read')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
    });

    it('scopes to current user', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .put('/notifications/n1/read')
        .set('Authorization', `Bearer ${userToken}`);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('user-123');
    });
  });

  describe('PUT /notifications/read-all', () => {
    it('marks all unread as read', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });

      const res = await request(app)
        .put('/notifications/read-all')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(5);
    });

    it('returns 0 when no unread notifications', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .put('/notifications/read-all')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(0);
    });

    it('scopes to current user', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await request(app)
        .put('/notifications/read-all')
        .set('Authorization', `Bearer ${userToken}`);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('user-123');
    });
  });
});
