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

const mockS3Send = jest.fn();
jest.mock('../services/s3', () => ({
  getS3Client: () => ({ send: mockS3Send }),
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

describe('Storage routes', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
  });

  it('GET /storage/buckets requires admin role', async () => {
    const res = await request(app)
      .get('/storage/buckets')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /storage/buckets lists buckets', async () => {
    mockS3Send.mockResolvedValueOnce({
      Buckets: [
        { Name: 'user-avatars', CreationDate: new Date('2026-01-01T00:00:00Z') },
        { Name: 'agent-data', CreationDate: new Date('2026-02-01T00:00:00Z') },
      ],
    });

    const res = await request(app)
      .get('/storage/buckets')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('user-avatars');
    expect(res.body[1].name).toBe('agent-data');
    expect(res.body[0].created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('GET /storage/buckets returns 502 on S3 error', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app)
      .get('/storage/buckets')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('storage service');
  });

  it('GET /storage/buckets/:name/objects requires admin role', async () => {
    const res = await request(app)
      .get('/storage/buckets/test-bucket/objects')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /storage/buckets/:name/objects lists objects', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'file1.txt', Size: 1234, LastModified: new Date('2026-03-01'), ETag: '"abc"' },
      ],
      CommonPrefixes: [{ Prefix: 'subdir/' }],
      IsTruncated: false,
      KeyCount: 1,
    });

    const res = await request(app)
      .get('/storage/buckets/my-bucket/objects')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0].key).toBe('file1.txt');
    expect(res.body.objects[0].size).toBe(1234);
    expect(res.body.prefixes).toEqual(['subdir/']);
    expect(res.body.is_truncated).toBe(false);
  });

  it('GET /storage/buckets/:name/objects supports prefix query', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
      KeyCount: 0,
    });

    const res = await request(app)
      .get('/storage/buckets/my-bucket/objects?prefix=logs/')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // Verify the S3 command received the prefix
    const sendCall = mockS3Send.mock.calls[0][0];
    expect(sendCall.input.Prefix).toBe('logs/');
    expect(sendCall.input.Delimiter).toBe('/');
  });

  it('GET /storage/buckets/:name/objects returns 404 for missing bucket', async () => {
    const err: any = new Error('NoSuchBucket');
    err.name = 'NoSuchBucket';
    mockS3Send.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/storage/buckets/nonexistent/objects')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nonexistent');
  });
});
