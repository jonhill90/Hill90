import * as jwt from 'jsonwebtoken';
import { app } from './app';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { createJwksKeyResolver } from './middleware/auth';
import { reconcileAgentStatuses } from './services/docker';
import { getS3Client, ensureBucket, AVATAR_BUCKET } from './services/s3';
import { attachTerminalProxy } from './services/terminal-proxy';
import { startStaleSweeper, stopStaleSweeper } from './routes/chat';

const PORT = process.env.PORT || 3000;

async function start() {
  // Run migrations (safe-fail: log error but continue starting)
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations(getPool());
      console.log('[startup] Database migrations complete');
    } catch (err) {
      console.error('[startup] Migration failed, agent routes may return 503:', err);
    }

    // Reconcile agent container statuses
    try {
      await reconcileAgentStatuses(
        async () => {
          const { rows } = await getPool().query(
            "SELECT id, agent_id FROM agents WHERE status = 'running'"
          );
          return rows;
        },
        async (id, status, containerId, error) => {
          await getPool().query(
            'UPDATE agents SET status = $1, container_id = $2, error_message = $3, updated_at = NOW() WHERE id = $4',
            [status, containerId, error, id]
          );
        }
      );
      console.log('[startup] Agent status reconciliation complete');
    } catch (err) {
      console.error('[startup] Agent reconciliation failed:', err);
    }
  } else {
    console.log('[startup] DATABASE_URL not set, skipping migrations');
  }

  // Ensure MinIO avatar bucket exists (safe-fail: log error but continue)
  try {
    const s3 = getS3Client();
    await ensureBucket(s3, AVATAR_BUCKET);
    await ensureBucket(s3, 'agent-avatars');
    console.log('[startup] Avatar buckets ready');
  } catch (err) {
    console.error('[startup] Avatar bucket init failed, avatar routes may error:', err);
  }

  // Start chat stale message sweeper (§9, cleanup path 2)
  startStaleSweeper();
  console.log('[startup] Chat stale message sweeper started');

  const server = app.listen(PORT, () => {
    console.log(`Hill90 API service listening on port ${PORT}`);
  });

  // Attach WebSocket terminal proxy for live agent terminal sessions
  const issuer = process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/hill90';
  const jwksUri = process.env.KEYCLOAK_JWKS_URI || `${issuer}/protocol/openid-connect/certs`;
  const getSigningKey = createJwksKeyResolver(jwksUri);

  attachTerminalProxy(server, async (token: string) => {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') return null;
      const signingKey = await getSigningKey(decoded.header);
      const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        issuer,
      }) as jwt.JwtPayload;
      if (typeof payload.exp !== 'number') return null;
      const roles: string[] =
        payload.realm_access?.roles ||
        payload.resource_access?.['hill90-ui']?.roles ||
        [];
      return { sub: payload.sub || '', roles };
    } catch {
      return null;
    }
  });
  console.log('[startup] WebSocket terminal proxy attached');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[shutdown] Closing server...');
    stopStaleSweeper();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();

