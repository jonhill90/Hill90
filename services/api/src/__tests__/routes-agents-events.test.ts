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

/** Build a Docker multiplexed stream frame (8-byte header + payload).
 *  Type 1 = stdout. This is what exec produces when Tty: false. */
function dockerFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = 1; // stdout stream
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
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
    // otherUserToken has sub='other-user', agent created_by='regular-user'
    // scopeToOwner for non-admin adds WHERE created_by = $1 with sub
    mockQuery.mockResolvedValueOnce({ rows: [] }); // scoped query returns nothing
    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events`)
      .set('Authorization', `Bearer ${otherUserToken}`);
    expect(res.status).toBe(404);
  });

  it('returns SSE headers for follow=true with plain text stream', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    // Simulate Tty: true output — plain UTF-8 text, no Docker frame headers
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
    // The SSE body should contain the event as a parseable JSON data line
    expect(res.text).toContain(`data: ${event}`);
  });

  it('returns JSON array for one-shot mode with plain text stream', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    // Tty: true gives plain UTF-8 lines
    const event1 = JSON.stringify({ id: '1', type: 'command_start', tool: 'shell' });
    const event2 = JSON.stringify({ id: '2', type: 'command_complete', tool: 'shell' });
    const fakeStream = new Readable({
      read() {
        this.push(`${event1}\n${event2}\n`);
        this.push(null);
      },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].type).toBe('command_start');
    expect(res.body[1].type).toBe('command_complete');
  });

  it('Docker-framed data (Tty: false) would corrupt JSON parsing', async () => {
    // This test proves WHY Tty: true is required.
    // Docker multiplexed frames have 8-byte binary headers that would
    // appear as garbage bytes in the UTF-8 text, causing JSON.parse to fail.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    const event1 = JSON.stringify({ id: '1', type: 'command_start', tool: 'shell' });
    const event2 = JSON.stringify({ id: '2', type: 'command_complete', tool: 'shell' });
    // Simulate what Tty: false would produce: Docker frame headers around each line
    const framedData = Buffer.concat([
      dockerFrame(event1 + '\n'),
      dockerFrame(event2 + '\n'),
    ]);
    const fakeStream = new Readable({
      read() {
        this.push(framedData);
        this.push(null);
      },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    // With framed data hitting the plain-text parser, the 8-byte headers
    // corrupt the JSON lines. JSON.parse fails, events are filtered out as null.
    // This demonstrates the route relies on clean text from Tty: true.
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0); // All events corrupted — none parse
  });

  it('SSE follow forwards a late-arriving event without reconnect', (done) => {
    // Models the real behavior: tail -f holds the stream open on an empty file,
    // then forwards the first line when an event is appended later.
    // Uses a PassThrough stream to control timing: open → idle → push event → end.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    const controlStream = new PassThrough();
    mockExecInContainer.mockResolvedValueOnce(controlStream);

    const lateEvent = JSON.stringify({ id: 'late-1', type: 'command_start', tool: 'shell', input_summary: 'echo late' });

    // Start a real HTTP server so we can read the SSE response incrementally
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

            // Once we see the late event forwarded as SSE data, the test passes
            if (body.includes(`data: ${lateEvent}`)) {
              // End the stream (simulates tail -f closing when container stops)
              controlStream.end();
            }
          });

          res.on('end', () => {
            // Final assertion: the late event appeared in the SSE body
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

      // After a short delay (simulating idle time on empty file),
      // push the event line — this is what tail -f does when a line is appended.
      setTimeout(() => {
        controlStream.write(`${lateEvent}\n`);
      }, 50);
    });
  });

  it('one-shot on empty file returns empty array', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    // Empty events file
    const fakeStream = new Readable({
      read() {
        this.push(null);
      },
    });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?tail=50`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('verifies exec is called with correct tail command', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

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
});
