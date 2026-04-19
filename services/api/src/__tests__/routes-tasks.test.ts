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

const mockListTasks = jest.fn();
const mockGetTask = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockTransitionTask = jest.fn();
const mockCancelTask = jest.fn();
jest.mock('../services/task-proxy', () => ({
  listTasks: (...args: any[]) => mockListTasks(...args),
  getTask: (...args: any[]) => mockGetTask(...args),
  createTask: (...args: any[]) => mockCreateTask(...args),
  updateTask: (...args: any[]) => mockUpdateTask(...args),
  transitionTask: (...args: any[]) => mockTransitionTask(...args),
  cancelTask: (...args: any[]) => mockCancelTask(...args),
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

const MOCK_TASK = {
  id: 'task-1',
  agent_id: 'bot-1',
  title: 'Fix bug',
  description: 'Fix the login bug',
  status: 'open',
  priority: 'high',
  tags: ['bug'],
  created_by: 'regular-user',
};

describe('Tasks routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockListTasks.mockReset();
    mockGetTask.mockReset();
    mockCreateTask.mockReset();
    mockUpdateTask.mockReset();
    mockTransitionTask.mockReset();
    mockCancelTask.mockReset();
  });

  describe('GET /tasks', () => {
    it('lists tasks for user (filtered to owned agents)', async () => {
      mockListTasks.mockResolvedValueOnce({ status: 200, data: [MOCK_TASK] });
      // getAllowedAgentIds query
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'bot-1' }] });

      const res = await request(app)
        .get('/tasks')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('admin sees all tasks unfiltered', async () => {
      mockListTasks.mockResolvedValueOnce({ status: 200, data: [MOCK_TASK] });

      const res = await request(app)
        .get('/tasks')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      // Admin should NOT trigger getAllowedAgentIds query
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('filters out tasks for agents user does not own', async () => {
      mockListTasks.mockResolvedValueOnce({ status: 200, data: [MOCK_TASK] });
      // User owns no agents
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/tasks')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/tasks');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /tasks', () => {
    it('creates a task', async () => {
      // getAllowedAgentIds
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'bot-1' }] });
      mockCreateTask.mockResolvedValueOnce({ status: 201, data: MOCK_TASK });

      const res = await request(app)
        .post('/tasks')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ agent_id: 'bot-1', title: 'Fix bug' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Fix bug');
    });

    it('rejects missing required fields', async () => {
      const res = await request(app)
        .post('/tasks')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ title: 'No agent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('rejects task for unowned agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // owns no agents

      const res = await request(app)
        .post('/tasks')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ agent_id: 'bot-1', title: 'Unauthorized' });

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /tasks/:id/transition', () => {
    it('transitions task status', async () => {
      mockGetTask.mockResolvedValueOnce({ status: 200, data: MOCK_TASK });
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'bot-1' }] });
      mockTransitionTask.mockResolvedValueOnce({ status: 200, data: { ...MOCK_TASK, status: 'done' } });

      const res = await request(app)
        .patch('/tasks/task-1/transition')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ status: 'done' });

      expect(res.status).toBe(200);
    });

    it('rejects missing status', async () => {
      const res = await request(app)
        .patch('/tasks/task-1/transition')
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('status');
    });
  });

  describe('DELETE /tasks/:id', () => {
    it('cancels a task', async () => {
      mockGetTask.mockResolvedValueOnce({ status: 200, data: MOCK_TASK });
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'bot-1' }] });
      mockCancelTask.mockResolvedValueOnce({ status: 200, data: { cancelled: true } });

      const res = await request(app)
        .delete('/tasks/task-1')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(200);
    });
  });
});
