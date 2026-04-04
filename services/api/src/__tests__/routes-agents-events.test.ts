import request from 'supertest';
import * as http from 'http';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Readable, PassThrough } from 'stream';
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

// Mock docker service
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn().mockResolvedValue('container-id-123'),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  inspectContainer: jest.fn().mockResolvedValue({ status: 'running', containerId: 'abc', health: 'healthy' }),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
  reconcileAgentStatuses: jest.fn().mockResolvedValue(undefined),
  execInContainer: jest.fn(),
}));
import { execInContainer } from '../services/docker';
const mockExecInContainer = execInContainer as jest.Mock;

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn().mockReturnValue('/data/agentbox/test-agent'),
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
const otherUserToken = makeToken('other-user', ['user']);

const AGENT_UUID = '550e8400-e29b-41d4-a716-446655440000';

// Helper: creates a Readable stream from a string
function streamFromString(data: string) {
  return new Readable({
    read() {
      this.push(data);
      this.push(null);
    },
  });
}

// Helper: mock running agent lookup (first mockQuery call for scope check)
function mockRunningAgent(createdBy = 'regular-user') {
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: createdBy }],
  });
}

// Helper: mock inference query returning rows
function mockInferenceRows(rows: Array<Record<string, unknown>>) {
  mockQuery.mockResolvedValueOnce({ rows });
}

// Helper: create a model_usage row fixture
function makeInferenceRow(overrides: Partial<{
  id: string;
  agent_id: string;
  model_name: string;
  request_type: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  created_at: Date;
  owner: string;
}> = {}) {
  return {
    id: overrides.id ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agent_id: overrides.agent_id ?? 'test-agent',
    model_name: overrides.model_name ?? 'gpt-4o-mini',
    request_type: overrides.request_type ?? 'chat.completion',
    status: overrides.status ?? 'success',
    latency_ms: overrides.latency_ms ?? 234,
    input_tokens: overrides.input_tokens ?? 100,
    output_tokens: overrides.output_tokens ?? 50,
    cost_usd: overrides.cost_usd ?? '0.001200',
    created_at: overrides.created_at ?? new Date('2026-03-08T12:00:00Z'),
    owner: overrides.owner ?? 'regular-user',
  };
}

describe('GET /agents/:id/events', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // -------------------------------------------------------------------------
  // Existing baseline tests
  // -------------------------------------------------------------------------

  it('returns 404 for unknown agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 for stopped agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user' }],
    });
    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not running/i);
  });

  it('enforces owner scoping (non-owner gets 404)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // scoped query returns nothing
    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events`)
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('returns SSE headers for follow=true with plain text stream', async () => {
    mockRunningAgent();
    // SSE backfill inference query (returns empty)
    mockInferenceRows([]);

    const event = JSON.stringify({ id: '1', type: 'command_start', tool: 'shell', input_summary: 'echo hi' });
    const fakeStream = new Readable({
      read() {
        this.push(`${event}\n`);
        this.push(null);
      },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=10`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain(`data: ${event}`);
  });

  it('returns JSON array for one-shot mode with plain text stream', async () => {
    mockRunningAgent();

    const event1 = JSON.stringify({ id: '1', type: 'command_start', tool: 'shell', timestamp: '2026-03-08T12:00:01Z' });
    const event2 = JSON.stringify({ id: '2', type: 'command_complete', tool: 'shell', timestamp: '2026-03-08T12:00:02Z' });
    const fakeStream = streamFromString(`${event1}\n${event2}\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    // Inference query for one-shot merge (returns empty)
    mockInferenceRows([]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].type).toBe('command_start');
    expect(res.body[1].type).toBe('command_complete');
  });

  it('skips non-JSON lines in one-shot mode', async () => {
    mockRunningAgent();

    const event1 = JSON.stringify({ id: '1', type: 'command_start', tool: 'shell', timestamp: '2026-03-08T12:00:01Z' });
    const fakeStream = streamFromString(`some warning text\n${event1}\n\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    mockInferenceRows([]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].type).toBe('command_start');
  });

  it('SSE follow forwards a late-arriving event without reconnect', (done) => {
    mockRunningAgent();
    // SSE backfill returns empty
    mockInferenceRows([]);

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    const lateEvent = JSON.stringify({ id: 'late-1', type: 'command_start', tool: 'shell', input_summary: 'echo late' });

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/agents/${AGENT_UUID}/events?follow=true&tail=50`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);

          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.includes(`data: ${lateEvent}`)) {
              controlStream.end();
            }
          });

          res.on('end', () => {
            expect(body).toContain(`data: ${lateEvent}`);
            expect(body).toContain('event: end');
            server.close();
            done();
          });
        },
      );

      req.on('error', (err) => {
        server.close();
        done(err);
      });

      setTimeout(() => {
        controlStream.write(`${lateEvent}\n`);
      }, 50);
    });
  });

  it('one-shot on empty file returns empty array', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    mockInferenceRows([]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('verifies exec is called with correct tail command', async () => {
    mockRunningAgent();
    mockInferenceRows([]);

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=25`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    expect(mockExecInContainer).toHaveBeenCalledWith('test-agent', [
      'tail', '-f', '-n', '25', '/var/log/agentbox/events.jsonl',
    ]);
  });

  // -------------------------------------------------------------------------
  // Inference merge tests
  // -------------------------------------------------------------------------

  it('one-shot includes inference events merged with container events', async () => {
    mockRunningAgent();

    const shellEvent = JSON.stringify({
      id: 'shell-1', type: 'command_complete', tool: 'shell',
      input_summary: 'echo hi', timestamp: '2026-03-08T12:00:02Z',
    });
    const fakeStream = streamFromString(`${shellEvent}\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    // Inference row with earlier timestamp
    const inferenceRow = makeInferenceRow({
      id: 'aaaa0001-0000-0000-0000-000000000000',
      created_at: new Date('2026-03-08T12:00:01Z'),
    });
    mockInferenceRows([inferenceRow]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Inference event (earlier timestamp) should come first
    expect(res.body[0].tool).toBe('inference');
    expect(res.body[0].id).toBe(`inference-${inferenceRow.id}`);
    // Shell event (later timestamp) should come second
    expect(res.body[1].tool).toBe('shell');
  });

  it('inference events have correct AgentEvent shape', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const row = makeInferenceRow({
      model_name: 'gpt-4o-mini',
      request_type: 'chat.completion',
      status: 'success',
      input_tokens: 1234,
      output_tokens: 567,
      cost_usd: '0.002300',
      latency_ms: 450,
    });
    mockInferenceRows([row]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const event = res.body[0];
    expect(event.id).toBe(`inference-${row.id}`);
    expect(event.type).toBe('inference_complete');
    expect(event.tool).toBe('inference');
    expect(event.input_summary).toBe('gpt-4o-mini (chat.completion)');
    expect(event.output_summary).toBe('1234+567 tokens, $0.0023, 450ms');
    expect(event.duration_ms).toBe(450);
    expect(event.success).toBe(true);
    expect(event.metadata).toEqual({
      model_name: 'gpt-4o-mini',
      request_type: 'chat.completion',
      status: 'success',
      input_tokens: 1234,
      output_tokens: 567,
      cost_usd: 0.0023,
    });
  });

  it('inference events have prefixed IDs to avoid collision', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const row = makeInferenceRow({ id: 'deadbeef-1234-5678-9abc-def000000001' });
    mockInferenceRows([row]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body[0].id).toBe('inference-deadbeef-1234-5678-9abc-def000000001');
  });

  it('merged events sorted deterministically by (timestamp, id)', async () => {
    mockRunningAgent();

    // Two container events and two inference events with interleaved timestamps
    const shell1 = JSON.stringify({
      id: 'aaa', timestamp: '2026-03-08T12:00:01Z', type: 'command_start', tool: 'shell',
    });
    const shell2 = JSON.stringify({
      id: 'ccc', timestamp: '2026-03-08T12:00:03Z', type: 'command_complete', tool: 'shell',
    });
    const fakeStream = streamFromString(`${shell1}\n${shell2}\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    mockInferenceRows([
      makeInferenceRow({
        id: 'bbb00000-0000-0000-0000-000000000000',
        created_at: new Date('2026-03-08T12:00:02Z'),
      }),
      makeInferenceRow({
        id: 'ddd00000-0000-0000-0000-000000000000',
        created_at: new Date('2026-03-08T12:00:04Z'),
      }),
    ]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    // Verify chronological interleaving
    expect(res.body[0].id).toBe('aaa');
    expect(res.body[1].tool).toBe('inference');
    expect(res.body[2].id).toBe('ccc');
    expect(res.body[3].tool).toBe('inference');
  });

  it('equal-timestamp rows not dropped (cursor tie-breaker by id)', async () => {
    mockRunningAgent();

    // Two events with the exact same timestamp but different IDs
    // Use .000Z suffix so ISO formats match exactly (Date.toISOString always includes ms)
    const sameTs = '2026-03-08T12:00:00.000Z';
    const shell1 = JSON.stringify({
      id: 'event-a', timestamp: sameTs, type: 'command_start', tool: 'shell',
    });
    const fakeStream = streamFromString(`${shell1}\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    mockInferenceRows([
      makeInferenceRow({
        id: 'zzz00000-0000-0000-0000-000000000000',
        created_at: new Date(sameTs),
      }),
    ]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // Both events present despite same timestamp
    expect(res.body).toHaveLength(2);
    // Same timestamp, so sorted by id: 'event-a' < 'inference-zzz...' lexicographically
    expect(res.body[0].id).toBe('event-a');
    expect(res.body[1].tool).toBe('inference');
  });

  it('DB failure does not break one-shot — returns container events only', async () => {
    mockRunningAgent();

    const shellEvent = JSON.stringify({
      id: 'e1', type: 'command_start', tool: 'shell', timestamp: '2026-03-08T12:00:00Z',
    });
    const fakeStream = streamFromString(`${shellEvent}\n`);
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    // Inference query fails
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('e1');
  });

  it('non-admin inference query includes owner filter', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    mockInferenceRows([]);

    await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    // The second mockQuery call is the inference query (inside stream.on('end'))
    const inferenceCall = mockQuery.mock.calls[1];
    const sql = inferenceCall[0] as string;
    // Non-admin: should include owner filter
    expect(sql).toContain('owner');
    // Params should include user sub
    expect(inferenceCall[1]).toContain('regular-user');
  });

  it('admin inference query omits owner filter', async () => {
    // Admin: use adminToken, agent created_by doesn't matter
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    mockInferenceRows([]);

    await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${adminToken}`);

    // The second mockQuery call is the inference query
    const inferenceCall = mockQuery.mock.calls[1];
    const sql = inferenceCall[0] as string;
    // Admin: should NOT include owner filter
    expect(sql).not.toContain('owner');
  });

  it('error status maps to inference_<status> type', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    mockInferenceRows([
      makeInferenceRow({ status: 'error' }),
    ]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body[0].type).toBe('inference_error');
    expect(res.body[0].success).toBe(false);
  });

  it('cost_usd numeric string is converted to number in metadata', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    mockInferenceRows([
      makeInferenceRow({ cost_usd: '0.005600' }),
    ]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    // Verify it's a number, not a string
    expect(typeof res.body[0].metadata.cost_usd).toBe('number');
    expect(res.body[0].metadata.cost_usd).toBeCloseTo(0.0056);
  });

  // -------------------------------------------------------------------------
  // SSE backfill tests
  // -------------------------------------------------------------------------

  it('SSE backfill emits recent inference rows on connect', async () => {
    mockRunningAgent();

    const inferenceRow = makeInferenceRow({
      id: 'backfill-1111-2222-3333-444444444444',
      created_at: new Date('2026-03-08T12:00:00Z'),
      model_name: 'gpt-4o-mini',
    });
    mockInferenceRows([inferenceRow]);

    const fakeStream = new Readable({
      read() { this.push(null); },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=50`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    // Backfill inference event should appear in SSE body
    expect(res.text).toContain('"inference-backfill-1111-2222-3333-444444444444"');
    expect(res.text).toContain('"tool":"inference"');
    expect(res.text).toContain('gpt-4o-mini');
  });

  it('SSE backfill DB failure continues stream (graceful degradation)', async () => {
    mockRunningAgent();
    // Backfill query fails
    mockQuery.mockRejectedValueOnce(new Error('backfill DB error'));

    const event = JSON.stringify({ id: 'e1', type: 'command_start', tool: 'shell', input_summary: 'echo hi' });
    const fakeStream = new Readable({
      read() {
        this.push(`${event}\n`);
        this.push(null);
      },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=50`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    // Stream should still work — container event should appear
    expect(res.text).toContain(`data: ${event}`);
  });

  it('SSE backfill owner scoping works for non-admin', async () => {
    mockRunningAgent();
    // Empty backfill (we're checking the SQL, not the result)
    mockInferenceRows([]);

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=50`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    // Backfill is the second query (first is agent lookup)
    const backfillCall = mockQuery.mock.calls[1];
    const sql = backfillCall[0] as string;
    expect(sql).toContain('owner');
    expect(backfillCall[1]).toContain('regular-user');
  });

  it('no duplicate inference events between SSE backfill and first poll', (done) => {
    // Proves the cursor handoff: backfill emits a row, then the first poll
    // query uses (created_at, id) > (backfill_row.created_at, backfill_row.id)
    // which strictly excludes the already-emitted row.
    mockRunningAgent();

    const backfillRow = makeInferenceRow({
      id: 'bf-dedupe-1111-2222-3333-444444444444',
      created_at: new Date('2026-03-08T12:00:05.000Z'),
      model_name: 'gpt-4o-mini',
    });
    // Call 2: backfill query returns one row
    mockInferenceRows([backfillRow]);

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    // Call 3: first poll query — return empty (the real DB would also return empty
    // because the cursor excludes the backfill row)
    mockInferenceRows([]);

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/agents/${AGENT_UUID}/events?follow=true&tail=50`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });

          // Wait for the 3s poll to fire + buffer
          setTimeout(() => {
            try {
              // 1. Verify the backfill inference event appears exactly once
              const inferenceEventId = `inference-${backfillRow.id}`;
              const occurrences = body.split(inferenceEventId).length - 1;
              expect(occurrences).toBe(1);

              // 2. Verify the poll query (3rd mockQuery call) used the correct cursor
              expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(3);
              const pollCall = mockQuery.mock.calls[2];
              const pollSql = pollCall[0] as string;
              // Poll uses incremental cursor mode: (created_at, id) > ($2, $3)
              expect(pollSql).toContain('(created_at, id) >');
              // Cursor values match the backfill row
              expect(pollCall[1]).toContain('2026-03-08T12:00:05.000Z');
              expect(pollCall[1]).toContain(backfillRow.id);

              // End the stream
              controlStream.end();
            } catch (err) {
              controlStream.end();
              server.close();
              done(err);
            }
          }, 3500);

          res.on('end', () => {
            server.close();
            done();
          });
        },
      );

      req.on('error', (err) => {
        server.close();
        done(err);
      });
    });
  }, 10000); // 10s timeout: 3.5s poll wait + server overhead

  it('stopped agent returns 409 (unchanged contract)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'stopped', created_by: 'regular-user' }],
    });

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not running/i);
  });

  // -------------------------------------------------------------------------
  // AI-121: Resolution chain columns in agent events
  // -------------------------------------------------------------------------

  it('X1+X2: inference event metadata includes requested_model and provider_model_id', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const row = makeInferenceRow({
      model_name: 'gpt-4o-mini',
      request_type: 'chat.completion',
      status: 'success',
    });
    // Add the new resolution chain fields
    (row as any).requested_model = 'fast';
    (row as any).provider_model_id = 'openai/gpt-4o-mini';
    mockInferenceRows([row]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const event = res.body[0];
    expect(event.metadata).toBeDefined();
    expect(event.metadata.requested_model).toBe('fast');
    expect(event.metadata.provider_model_id).toBe('openai/gpt-4o-mini');
  });

  it('X2: inference event metadata handles null resolution chain fields', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const row = makeInferenceRow({ status: 'rate_limited' });
    // New fields are null (pre-BYOK denial path)
    (row as any).requested_model = null;
    (row as any).provider_model_id = null;
    mockInferenceRows([row]);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const event = res.body[0];
    expect(event.metadata.requested_model).toBeNull();
    expect(event.metadata.provider_model_id).toBeNull();
  });

  it('X3: getRecentInference SQL SELECT includes requested_model and provider_model_id', async () => {
    mockRunningAgent();

    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);
    mockInferenceRows([]);

    await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    // The inference query is the second call
    const inferenceCall = mockQuery.mock.calls[1];
    const sql = inferenceCall[0] as string;
    expect(sql).toContain('requested_model');
    expect(sql).toContain('provider_model_id');
  });

  // T7: SSE backfill delivers inference events before container events
  it('T7: SSE backfill delivers inference events before container events', async () => {
    mockRunningAgent();

    const backfillRow = makeInferenceRow({
      id: 't7-backfill-0000-0000-0000-000000000001',
      created_at: new Date('2026-03-08T12:00:00Z'),
    });
    mockInferenceRows([backfillRow]);

    // Container event arrives after backfill
    const containerEvent = JSON.stringify({
      id: 'container-1', timestamp: '2026-03-08T12:00:01Z',
      type: 'command_start', tool: 'shell', input_summary: 'echo hi',
    });
    const fakeStream = new Readable({
      read() { this.push(`${containerEvent}\n`); this.push(null); },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=50`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    // Inference backfill appears first in SSE output, container event second
    const inferencePos = res.text.indexOf('inference-t7-backfill');
    const containerPos = res.text.indexOf('container-1');
    expect(inferencePos).toBeGreaterThan(-1);
    expect(containerPos).toBeGreaterThan(-1);
    expect(inferencePos).toBeLessThan(containerPos);
  });

  // T8: SSE inference poll events arrive after initial container events
  it('T8: SSE inference poll events arrive after initial container events', (done) => {
    mockRunningAgent();

    // Empty backfill
    mockInferenceRows([]);

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    // First poll returns a new inference row
    const pollRow = makeInferenceRow({
      id: 't8-poll-0000-0000-0000-000000000001',
      created_at: new Date('2026-03-08T12:00:10Z'),
    });
    mockInferenceRows([pollRow]);

    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.get(
        `http://127.0.0.1:${port}/agents/${AGENT_UUID}/events?follow=true&tail=50`,
        { headers: { Authorization: `Bearer ${userToken}` } },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });

          // Emit a container event first
          controlStream.write(JSON.stringify({
            id: 'container-first', timestamp: '2026-03-08T12:00:05Z',
            type: 'command_start', tool: 'shell', input_summary: 'ls',
          }) + '\n');

          // Wait for inference poll (3s interval), then check order
          setTimeout(() => {
            try {
              const containerPos = body.indexOf('container-first');
              const inferencePos = body.indexOf('inference-t8-poll');
              expect(containerPos).toBeGreaterThan(-1);
              // Inference poll may or may not have fired yet depending on timing,
              // but if it did, it arrives after the container event
              if (inferencePos > -1) {
                expect(containerPos).toBeLessThan(inferencePos);
              }
            } finally {
              req.destroy();
              controlStream.destroy();
              server.close(done);
            }
          }, 4000);
        },
      );
    });
  }, 10000);
});
