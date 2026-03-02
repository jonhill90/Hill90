import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate a throwaway RSA keypair for test signing (Keycloak user auth)
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';
const SERVICE_TOKEN = 'test-internal-service-token-xyz';

// Mock pg pool
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock docker service
const mockExecInContainer = jest.fn();
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn().mockResolvedValue('container-id-123'),
  stopAndRemoveContainer: jest.fn().mockResolvedValue(undefined),
  inspectContainer: jest.fn().mockResolvedValue({ status: 'running', containerId: 'abc', health: 'healthy' }),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn().mockResolvedValue(undefined),
  reconcileAgentStatuses: jest.fn().mockResolvedValue(undefined),
  execInContainer: (...args: any[]) => mockExecInContainer(...args),
}));

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn().mockReturnValue('/data/agentbox/test-agent'),
  removeAgentFiles: jest.fn(),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

const AGENT_ID = 'phase4-orchestrator';

describe('POST /internal/agents/:agentId/events', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecInContainer.mockReset();
    mockExecInContainer.mockResolvedValue({ on: jest.fn(), destroy: jest.fn() });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = SERVICE_TOKEN;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
  });

  it('appends base64-encoded event to container', async () => {
    // Agent exists and is running
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_id: AGENT_ID, status: 'running' }],
    });

    const eventBody = {
      type: 'inference_start',
      tool: 'inference',
      input_summary: 'model=gpt-4o-mini',
    };

    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(eventBody);

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();

    // Verify execInContainer was called with base64-encoded command
    expect(mockExecInContainer).toHaveBeenCalledTimes(1);
    const [agentId, cmd] = mockExecInContainer.mock.calls[0];
    expect(agentId).toBe(AGENT_ID);
    expect(cmd[0]).toBe('sh');
    expect(cmd[1]).toBe('-c');

    // Decode the base64 payload from the command and verify it's valid JSON
    const shCmd = cmd[2] as string;
    const b64Match = shCmd.match(/echo\s+(\S+)\s+\|\s+base64\s+-d/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], 'base64').toString('utf-8');
    const event = JSON.parse(decoded);
    expect(event.type).toBe('inference_start');
    expect(event.tool).toBe('inference');
    expect(event.input_summary).toBe('model=gpt-4o-mini');
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it('rejects missing service token', async () => {
    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .send({ type: 'inference_start', tool: 'inference', input_summary: 'model=gpt-4o-mini' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/service token/i);
  });

  it('rejects invalid service token', async () => {
    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .set('Authorization', 'Bearer wrong-token')
      .send({ type: 'inference_start', tool: 'inference', input_summary: 'model=gpt-4o-mini' });

    expect(res.status).toBe(403);
  });

  it('returns 409 for stopped agent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_id: AGENT_ID, status: 'stopped' }],
    });

    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ type: 'inference_start', tool: 'inference', input_summary: 'model=gpt-4o-mini' });

    expect(res.status).toBe(409);
  });

  it('rejects invalid event body', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_id: AGENT_ID, status: 'running' }],
    });

    // Missing required 'type' field
    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ tool: 'inference', input_summary: 'model=gpt-4o-mini' });

    expect(res.status).toBe(400);
  });

  it('handles JSON with quotes, newlines, and unicode in base64 round-trip', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ agent_id: AGENT_ID, status: 'running' }],
    });

    const eventBody = {
      type: 'inference_complete',
      tool: 'inference',
      input_summary: 'model="gpt-4o"\nwith newline',
      output_summary: 'tokens_in=100, tokens_out=50, cost=$0.001',
      duration_ms: 500,
      success: true,
      metadata: { model: 'gpt-4o', unicode: '日本語テスト', dollars: '$100' },
    };

    const res = await request(app)
      .post(`/internal/agents/${AGENT_ID}/events`)
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send(eventBody);

    expect(res.status).toBe(200);

    // Verify base64 round-trip preserves special characters
    const shCmd = mockExecInContainer.mock.calls[0][1][2] as string;
    const b64Match = shCmd.match(/echo\s+(\S+)\s+\|\s+base64\s+-d/);
    const decoded = Buffer.from(b64Match![1], 'base64').toString('utf-8');
    const event = JSON.parse(decoded);
    expect(event.input_summary).toBe('model="gpt-4o"\nwith newline');
    expect(event.metadata.unicode).toBe('日本語テスト');
    expect(event.metadata.dollars).toBe('$100');
  });
});
