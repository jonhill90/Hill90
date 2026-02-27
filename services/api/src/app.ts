import express, { Application } from 'express';
import { createRequireAuth, createJwksKeyResolver } from './middleware/auth';
import type { JwtHeader } from 'jsonwebtoken';
import agentsRouter from './routes/agents';
import knowledgeRouter from './routes/knowledge';
import profileRouter from './routes/profile';
import { requireRole } from './middleware/role';
import { docsRouter, specRouter } from './routes/docs';

interface AppOptions {
  issuer?: string;
  getSigningKey?: (header: JwtHeader) => Promise<string>;
}

export function createApp(opts: AppOptions = {}): Application {
  const app = express();

  app.use(express.json());

  // Health check — public
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'api' });
  });

  // Protected routes
  const issuer = opts.issuer || process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/hill90';
  const jwksUri = process.env.KEYCLOAK_JWKS_URI || `${issuer}/protocol/openid-connect/certs`;

  const requireAuth = createRequireAuth({
    issuer,
    getSigningKey: opts.getSigningKey || createJwksKeyResolver(jwksUri),
  });

  app.get('/me', requireAuth, (req, res) => {
    res.json((req as any).user);
  });

  // Agent management routes
  app.use('/agents', requireAuth, agentsRouter);

  // Knowledge proxy routes (read-only, owner-scoped)
  app.use('/knowledge', requireAuth, knowledgeRouter);

  // User profile routes
  app.use('/profile', requireAuth, profileRouter);

  // API documentation (admin-only)
  app.use('/docs', requireAuth, requireRole('admin'), docsRouter);
  app.use('/openapi.json', requireAuth, requireRole('admin'), specRouter);

  return app;
}

// Default app instance for production
const app = createApp();
export { app };
