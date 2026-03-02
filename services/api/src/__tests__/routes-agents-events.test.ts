import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Readable } from 'stream';
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

  it('returns SSE headers for follow=true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

    // Mock execInContainer to return a readable stream that ends immediately
    const fakeStream = new Readable({ read() { this.push(null); } });
    mockExecInContainer.mockResolvedValueOnce(fakeStream);

    const res = await request(app)
      .get(`/agents/${AGENT_UUID}/events?follow=true&tail=10`)
      .set('Authorization', `Bearer ${userToken}`)
      .buffer(true);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('returns JSON array for one-shot mode', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: AGENT_UUID, agent_id: 'test-agent', status: 'running', created_by: 'regular-user' }],
    });

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
});
