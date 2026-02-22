import express, { Application } from 'express';
import { createRequireAuth, createJwksKeyResolver } from './middleware/auth';
import type { JwtHeader } from 'jsonwebtoken';
import agentsRouter from './routes/agents';

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

  return app;
}

// Default app instance for production
const app = createApp();
export { app };
