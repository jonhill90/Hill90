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

const MOCK_WORKFLOW = {
  id: 'wf-1',
  name: 'Daily Health Check',
  description: 'Run health checks',
  agent_id: 'agent-uuid',
  schedule_cron: '0 9 * * *',
  prompt: 'Check system health',
  output_type: 'none',
  output_config: '{}',
  enabled: true,
  trigger_type: 'cron',
  webhook_token: null,
  created_by: 'regular-user',
  created_at: '2026-04-19T00:00:00Z',
  agent_name: 'HealthBot',
  agent_slug: 'health-bot',
  agent_status: 'stopped',
};

describe('Workflows routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('GET /workflows', () => {
    it('lists workflows for user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      const res = await request(app)
        .get('/workflows')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Daily Health Check');
    });

    it('admin sees all workflows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      await request(app)
        .get('/workflows')
        .set('Authorization', `Bearer ${adminToken}`);

      const queryStr = mockQuery.mock.calls[0][0];
      expect(queryStr).not.toContain('created_by');
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/workflows');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /workflows', () => {
    it('creates a cron workflow', async () => {
      // Agent exists check
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
      // Insert
      mockQuery.mockResolvedValueOnce({ rows: [MOCK_WORKFLOW] });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Daily Health Check',
          agent_id: 'agent-uuid',
          schedule_cron: '0 9 * * *',
          prompt: 'Check system health',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Daily Health Check');
    });

    it('creates a webhook-triggered workflow', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-uuid' }] });
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...MOCK_WORKFLOW, trigger_type: 'webhook', webhook_token: 'abc123' }],
      });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Webhook Trigger',
          agent_id: 'agent-uuid',
          schedule_cron: '* * * * *',
          prompt: 'Handle webhook',
          trigger_type: 'webhook',
        });

      expect(res.status).toBe(201);
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'Missing fields' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('validates cron expression', async () => {
      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Bad Cron',
          agent_id: 'agent-uuid',
          schedule_cron: 'invalid',
          prompt: 'test',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cron');
    });

    it('returns 404 for non-existent agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/workflows')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          name: 'Test',
          agent_id: 'bad-agent',
          schedule_cron: '0 * * * *',
          prompt: 'test',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /workflows/:id', () => {
    it('deletes a workflow', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .delete('/workflows/wf-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 for non-existent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .delete('/workflows/bad-id')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /workflows/:id/runs', () => {
    it('returns run history', async () => {
      const mockRuns = [
        { id: 'r1', status: 'completed', started_at: '2026-04-19T09:00:00Z', finished_at: '2026-04-19T09:01:00Z' },
      ];
      // Access check + runs query
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'wf-1' }] });
      mockQuery.mockResolvedValueOnce({ rows: mockRuns });

      const res = await request(app)
        .get('/workflows/wf-1/runs')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe('completed');
    });
  });
});
