import express, { Application } from 'express';
import { createRequireAuth, createJwksKeyResolver } from './middleware/auth';

const app: Application = express();

app.use(express.json());

// Health check — public
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'api' });
});

// Protected routes
const KEYCLOAK_ISSUER = process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/hill90';
const KEYCLOAK_JWKS_URI = process.env.KEYCLOAK_JWKS_URI || `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs`;

const requireAuth = createRequireAuth({
  issuer: KEYCLOAK_ISSUER,
  getSigningKey: createJwksKeyResolver(KEYCLOAK_JWKS_URI),
});

app.get('/me', requireAuth, (req, res) => {
  res.json((req as any).user);
});

export { app };
