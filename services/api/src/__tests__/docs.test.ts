import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool — docs routes don't use DB but agents router does at import time
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock docker service — same reason
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  execInContainer: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
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

// ---------------------------------------------------------------------------
// /openapi.json — auth + RBAC + schema shape
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(401);
  });

  it('returns 403 for user role (not admin)', async () => {
    const res = await request(app)
      .get('/openapi.json')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with admin token', async () => {
    const res = await request(app)
      .get('/openapi.json')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('returns valid OpenAPI 3.0 spec', async () => {
    const res = await request(app)
      .get('/openapi.json')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.openapi).toMatch(/^3\.0/);
    expect(res.body.info).toBeDefined();
    expect(res.body.info.title).toBe('Hill90 API');
    expect(res.body.paths).toBeDefined();
    expect(res.body.components).toBeDefined();
    expect(res.body.components.securitySchemes).toBeDefined();
    expect(res.body.components.securitySchemes.bearerAuth).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// /docs — auth + RBAC + HTML response
// ---------------------------------------------------------------------------

describe('GET /docs/', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(401);
  });

  it('returns 403 for user role (not admin)', async () => {
    const res = await request(app)
      .get('/docs/')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with HTML for admin', async () => {
    const res = await request(app)
      .get('/docs/')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

// ---------------------------------------------------------------------------
// Root route non-regression
// ---------------------------------------------------------------------------

describe('Root route non-regression', () => {
  it('GET /health returns 200 without auth (still public)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy', service: 'api' });
  });

  it('GET /nonexistent returns 404, not 401 or 403', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI drift protection — spec contract enforcement
// ---------------------------------------------------------------------------

// Contract scope: runtime business endpoints only.
// /docs and /openapi.json are infrastructure endpoints — intentionally excluded
// from drift enforcement. They are tested for auth/RBAC above, not contract coverage.
const EXPECTED_PATHS = [
  '/health',
  '/health/detailed',
  '/me',
  '/agents',
  '/agents/{id}',
  '/agents/{id}/start',
  '/agents/{id}/stop',
  '/agents/{id}/status',
  '/agents/{id}/tool-installs',
  '/agents/{id}/reconcile-tools',
  '/agents/{id}/events',
  '/agents/{id}/logs',
  '/model-policies',
  '/model-policies/{id}',
  '/provider-connections',
  '/provider-connections/health',
  '/provider-connections/validate-all',
  '/provider-connections/{id}',
  '/provider-connections/{id}/validate',
  '/provider-connections/{id}/models',
  '/eligible-models',
  '/user-models',
  '/user-models/{id}',
  '/usage',
  '/container-profiles',
  '/container-profiles/{id}',
  '/knowledge/agents',
  '/knowledge/entries',
  '/knowledge/entries/{agentId}/{path}',
  '/knowledge/search',
  '/profile',
  '/profile/avatar',
  '/profile/password',
  '/profile/preferences',
  '/shared-knowledge/stats',
  '/shared-knowledge/collections',
  '/shared-knowledge/collections/{id}',
  '/shared-knowledge/sources',
  '/shared-knowledge/sources/{id}',
  '/shared-knowledge/search',
  '/skills',
  '/skills/{id}',
  '/tools',
  '/tools/{id}',
  '/agents/{id}/skills',
  '/agents/{id}/skills/{skillId}',
  '/agents/{id}/stats',
  '/agents/{id}/artifacts',
  '/chat/threads',
  '/chat/threads/{id}',
  '/chat/threads/{id}/participants',
  '/chat/threads/{id}/messages',
  '/chat/threads/{id}/cancel',
  '/chat/threads/{id}/stream',
  '/chat/threads/{id}/events',
  '/chat/threads/{id}/screenshot',
  '/tasks',
  '/tasks/{id}',
  '/tasks/{id}/transition',
  '/storage/buckets',
  '/storage/buckets/{name}/objects',
  '/admin/secrets',
  '/admin/secrets/status',
  '/admin/secrets/kv',
];

const INFRA_PATHS = ['/docs', '/openapi.json', '/internal/delegation-token', '/internal/chat/callback', '/internal/model-router/refresh-token'];

// Compat alias paths — same handler as canonical /skills routes, not in OpenAPI spec
const COMPAT_PATHS: string[] = [];

/**
 * Introspect Express app._router.stack to extract all registered route paths.
 * Normalizes Express param syntax (:id) to OpenAPI syntax ({id}).
 */
function getRegisteredRoutes(expressApp: any): string[] {
  const routes: string[] = [];
  const stack = expressApp._router?.stack || [];

  for (const layer of stack) {
    // Direct routes (app.get, app.post, etc.)
    if (layer.route) {
      routes.push(layer.route.path);
      continue;
    }

    // Sub-routers (app.use('/prefix', router))
    if (layer.name === 'router' && layer.handle?.stack) {
      // Extract base path from layer.regexp — handle escaped dots and slashes
      const src = layer.regexp?.source || '';
      const match = src.match(/^\^\\\/(.+?)(?:\\\/?(?:\?|$)|\?)/);
      const base = match
        ? '/' + match[1].replace(/\\\//g, '/').replace(/\\\./g, '.')
        : '';

      for (const subLayer of layer.handle.stack) {
        if (subLayer.route) {
          const subPath = subLayer.route.path === '/' ? '' : subLayer.route.path;
          routes.push(base + subPath);
        }
      }
    }
    // Middleware-only layers (no .route, not a router): skip
  }

  // Normalize :param to {param}, strip Express regex suffixes like (*), and deduplicate
  return [...new Set(routes.map(r =>
    r.replace(/:(\w+)/g, '{$1}').replace(/\(\*\)$/, '')
  ))];
}

describe('Spec contract enforcement', () => {
  let spec: any;

  beforeAll(async () => {
    const res = await request(app)
      .get('/openapi.json')
      .set('Authorization', `Bearer ${adminToken}`);
    spec = res.body;
  });

  it('spec documents all API routes', () => {
    const specPaths = Object.keys(spec.paths || {});
    for (const path of EXPECTED_PATHS) {
      expect(specPaths).toContain(path);
    }
  });

  it('spec does not contain phantom paths', () => {
    const specPaths = Object.keys(spec.paths || {});
    for (const path of specPaths) {
      expect(EXPECTED_PATHS).toContain(path);
    }
  });

  it('every registered Express route maps to EXPECTED_PATHS or INFRA_PATHS', () => {
    const registered = getRegisteredRoutes(app);
    const allKnown = [...EXPECTED_PATHS, ...INFRA_PATHS, ...COMPAT_PATHS];
    for (const route of registered) {
      expect(allKnown).toContain(route);
    }
  });

  it('every path except /health has security defined', () => {
    for (const [pathKey, pathItem] of Object.entries((spec.paths || {}) as Record<string, any>)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === 'parameters') continue;
        const op = operation as any;
        if (pathKey === '/health' || pathKey === '/health/detailed') {
          expect(op.security).toEqual([]);
        } else {
          expect(op.security).toBeDefined();
          expect(op.security.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
