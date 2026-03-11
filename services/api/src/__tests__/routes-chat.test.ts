import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate RSA keypair for test signing
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

// Mock docker service (needed because agents.ts is imported transitively)
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

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

// Mock chat dispatch
const mockDispatchChatWork = jest.fn().mockResolvedValue({ accepted: true, work_id: 'work-123' });
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: any[]) => mockDispatchChatWork(...args),
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
const otherUserToken = makeToken('other-user', ['user']);
const noRoleToken = makeToken('no-role-user', []);

// ── Thread CRUD ──

describe('Chat thread CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /chat/threads requires auth', async () => {
    const res = await request(app).get('/chat/threads');
    expect(res.status).toBe(401);
  });

  it('GET /chat/threads requires user role', async () => {
    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /chat/threads returns threads for participant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
          created_at: new Date(), updated_at: new Date(), last_message: 'Hello', last_author_type: 'human' },
      ],
    });

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('thread-1');

    // Verify participant-scoped query
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('chat_participants');
    expect(sql).toContain('participant_id = $1');
  });

  it('GET /chat/threads admin sees all', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // Admin query should NOT join participants
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain('participant_id = $1');
  });

  it('POST /chat/threads creates thread and dispatches', async () => {
    mockQuery
      .mockResolvedValueOnce({  // getAgentForDispatch
        rows: [{
          id: 'agent-uuid', agent_id: 'test-agent', status: 'running',
          work_token: 'wt-123', models: ['gpt-4o-mini'],
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // getAgentElevatedScope
      .mockResolvedValueOnce({  // INSERT thread
        rows: [{
          id: 'thread-uuid', type: 'direct', title: null,
          created_by: 'regular-user', created_at: new Date(), updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })  // INSERT participants
      .mockResolvedValueOnce({ rows: [] })  // INSERT user message
      .mockResolvedValueOnce({  // INSERT assistant placeholder
        rows: [{ id: 'placeholder-uuid' }],
      });

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello agent' });

    expect(res.status).toBe(201);
    expect(res.body.thread.id).toBe('thread-uuid');
    expect(res.body.message_id).toBe('placeholder-uuid');

    // Verify dispatch was called
    await new Promise(r => setTimeout(r, 10)); // let fire-and-forget resolve
    expect(mockDispatchChatWork).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'test-agent',
      workToken: 'wt-123',
      threadId: 'thread-uuid',
      messageId: 'placeholder-uuid',
      model: 'gpt-4o-mini',
    }));
  });

  it('POST /chat/threads rejects missing agent_id', async () => {
    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent_id');
  });

  it('POST /chat/threads rejects missing message', async () => {
    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message');
  });

  it('POST /chat/threads returns 409 if agent not running', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'stopped', work_token: null, models: [] }],
    });

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello' });
    expect(res.status).toBe(409);
  });

  it('POST /chat/threads returns 403 for elevated agent + non-admin', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] }); // elevated scope found

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
  });

  it('GET /chat/threads/:id returns thread with messages', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({  // thread
        rows: [{ id: 'thread-1', type: 'direct', title: 'Test', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [  // participants
        { participant_id: 'regular-user', participant_type: 'human', role: 'owner', joined_at: new Date() },
      ]})
      .mockResolvedValueOnce({ rows: [  // messages
        { id: 'msg-1', seq: 1, author_id: 'regular-user', author_type: 'human', role: 'user',
          content: 'Hello', status: 'complete', created_at: new Date().toISOString() },
      ]});

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it('GET /chat/threads/:id returns 404 for non-participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a participant

    const res = await request(app)
      .get('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /chat/threads/:id updates title for owner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({  // UPDATE
        rows: [{ id: 'thread-1', type: 'direct', title: 'New Title', created_by: 'regular-user',
                 created_at: new Date(), updated_at: new Date() }],
      });

    const res = await request(app)
      .put('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ title: 'New Title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New Title');
  });

  it('DELETE /chat/threads/:id works for owner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isThreadOwner
      .mockResolvedValueOnce({ rowCount: 1 });  // DELETE

    const res = await request(app)
      .delete('/chat/threads/thread-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── Send message ──

describe('Chat send message', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('POST /chat/threads/:id/messages sends and dispatches', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })  // getThreadAgent
      .mockResolvedValueOnce({  // getAgentForDispatch
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [] })  // concurrency guard
      .mockResolvedValueOnce({ rows: [] })  // getAgentElevatedScope
      .mockResolvedValueOnce({ rows: [] })  // INSERT user message
      .mockResolvedValueOnce({ rows: [{ id: 'placeholder-uuid' }] })  // INSERT placeholder
      .mockResolvedValueOnce({ rows: [] })  // UPDATE thread timestamp
      .mockResolvedValueOnce({ rows: [  // message history
        { role: 'user', content: 'Hello' },
      ]});

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'How are you?' });
    expect(res.status).toBe(201);
    expect(res.body.message_id).toBe('placeholder-uuid');
  });

  it('POST /chat/threads/:id/messages returns 409 for concurrent send', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })  // isParticipant
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })  // getThreadAgent
      .mockResolvedValueOnce({  // getAgentForDispatch
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'pending-msg' }] });  // concurrency guard finds pending

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Hello again' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('still responding');
  });

  it('POST /chat/threads/:id/messages returns 409 for idempotency duplicate', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ participant_id: 'agent-uuid' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'running', work_token: 'wt', models: [] }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'idx_chat_messages_idempotency' }));

    const res = await request(app)
      .post('/chat/threads/thread-1/messages')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ message: 'Retry', idempotency_key: 'key-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Duplicate');
  });
});

// ── Callback ──

describe('Chat callback', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CHAT_CALLBACK_TOKEN = 'test-callback-secret';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CHAT_CALLBACK_TOKEN;
  });

  it('POST /internal/chat/callback accepts valid token and updates message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] });     // UPDATE thread timestamp

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-uuid',
        content: 'Agent response',
        model: 'gpt-4o-mini',
        input_tokens: 42,
        output_tokens: 128,
        duration_ms: 1200,
        status: 'complete',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    // Verify guarded UPDATE uses nextval
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('nextval');
    expect(sql).toContain("status = 'pending'");
  });

  it('POST /internal/chat/callback rejects invalid token (401)', async () => {
    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer wrong-token')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(401);
  });

  it('POST /internal/chat/callback rejects missing auth header (401)', async () => {
    const res = await request(app)
      .post('/internal/chat/callback')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(401);
  });

  it('POST /internal/chat/callback returns 503 when token not configured', async () => {
    delete process.env.CHAT_CALLBACK_TOKEN;

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer any-token')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('callback_not_configured');
  });

  it('POST /internal/chat/callback returns 200 no-op for terminal message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })  // guarded UPDATE matches nothing
      .mockResolvedValueOnce({ rows: [{ status: 'complete' }] });  // SELECT finds terminal

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-uuid', content: 'late response', status: 'complete' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
  });

  it('POST /internal/chat/callback returns 404 for unknown message_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })  // guarded UPDATE
      .mockResolvedValueOnce({ rows: [] });     // SELECT finds nothing

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'nonexistent', content: 'test', status: 'complete' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_message');
  });

  it('POST /internal/chat/callback rejects idempotency_key in body', async () => {
    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({ message_id: 'msg-uuid', content: 'test', status: 'complete', idempotency_key: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('idempotency_key');
  });

  it('POST /internal/chat/callback handles error status', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/internal/chat/callback')
      .set('Authorization', 'Bearer test-callback-secret')
      .send({
        message_id: 'msg-uuid',
        status: 'error',
        error_message: 'Inference failed',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    // Verify status='error' was passed
    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBe('error');
  });
});

// ── Stale sweeper ──

describe('Chat stale sweeper', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('sweeper function is exported and can be started/stopped', async () => {
    const { startStaleSweeper, stopStaleSweeper } = await import('../routes/chat');
    // Just verify they don't throw
    expect(typeof startStaleSweeper).toBe('function');
    expect(typeof stopStaleSweeper).toBe('function');
  });
});

// ── SSE stream ──

describe('Chat SSE stream', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('GET /chat/threads/:id/stream requires participant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a participant

    const res = await request(app)
      .get('/chat/threads/thread-1/stream')
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('GET /chat/threads/:id/stream returns SSE headers and initial data', async () => {
    // isParticipant
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    // Initial poll
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'msg-1', seq: 5, author_id: 'user-1', author_type: 'human',
        role: 'user', content: 'Hello', status: 'complete', model: null,
        input_tokens: null, output_tokens: null, duration_ms: null,
        error_message: null, created_at: new Date().toISOString(),
      }],
    });

    const res = await request(app)
      .get('/chat/threads/thread-1/stream')
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true)
      .parse((res: any, callback: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // Abort after receiving first event
          res.destroy();
        });
        res.on('end', () => callback(null, data));
        res.on('error', () => callback(null, data));
        // Force close after 500ms if no data
        setTimeout(() => { res.destroy(); callback(null, data); }, 500);
      });

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('event: message');
    expect(res.body).toContain('id: 5');
    expect(res.body).toContain('msg-1');
  });
});

// ── RBAC ──

describe('Chat RBAC', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDispatchChatWork.mockReset();
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-123' });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('POST /chat/threads allows admin to send to elevated agent', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-uuid', agent_id: 'test-agent', status: 'running', work_token: 'wt', models: ['gpt-4o-mini'] }],
      })
      .mockResolvedValueOnce({ rows: [{ scope: 'host_docker' }] })  // elevated scope found — but admin
      .mockResolvedValueOnce({
        rows: [{ id: 'thread-uuid', type: 'direct', title: null, created_by: 'admin-user',
                 created_at: new Date(), updated_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [] })  // participants
      .mockResolvedValueOnce({ rows: [] })  // user message
      .mockResolvedValueOnce({ rows: [{ id: 'ph-uuid' }] });  // placeholder

    const res = await request(app)
      .post('/chat/threads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agent_id: 'agent-uuid', message: 'Run docker' });
    expect(res.status).toBe(201);
  });
});
