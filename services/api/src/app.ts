import express, { Application } from 'express';
import { createRequireAuth, createJwksKeyResolver } from './middleware/auth';
import { correlationId } from './middleware/correlation-id';
import type { JwtHeader } from 'jsonwebtoken';
import agentsRouter from './routes/agents';
import knowledgeRouter from './routes/knowledge';
import sharedKnowledgeRouter from './routes/shared-knowledge';
import modelPoliciesRouter from './routes/model-policies';
import skillsRouter from './routes/skills';
import toolsRouter from './routes/tools';
import containerProfilesRouter from './routes/container-profiles';
import providerConnectionsRouter from './routes/provider-connections';
import userModelsRouter from './routes/user-models';
import eligibleModelsRouter from './routes/eligible-models';
import profileRouter from './routes/profile';
import usageRouter from './routes/usage';
import { requireRole } from './middleware/role';
import { docsRouter, specRouter } from './routes/docs';
import secretsRouter from './routes/secrets';
import { delegationTokenHandler } from './services/model-router-delegation';
import chatRouter, { chatCallbackHandler, startStaleSweeper } from './routes/chat';
import tasksRouter from './routes/tasks';
import storageRouter from './routes/storage';
import notificationsRouter from './routes/notifications';
import workflowsRouter from './routes/workflows';
import mcpServersRouter from './routes/mcp-servers';
import { modelRouterRefreshHandler } from './services/model-router-refresh';
import discordInternalRouter from './routes/discord-internal';
import discordRouter from './routes/discord';

interface AppOptions {
  issuer?: string;
  getSigningKey?: (header: JwtHeader) => Promise<string>;
}

export function createApp(opts: AppOptions = {}): Application {
  const app = express();

  app.use(express.json());
  app.use(correlationId);

  // Health check — public
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'api' });
  });

  // Detailed health — public, includes DB check + runtime stats
  app.get('/health/detailed', async (_req, res) => {
    const mem = process.memoryUsage();
    let dbStatus: 'connected' | 'error' = 'error';
    let dbLatencyMs: number | null = null;

    try {
      const { getPool } = await import('./db/pool');
      const start = Date.now();
      await getPool().query('SELECT 1');
      dbLatencyMs = Date.now() - start;
      dbStatus = 'connected';
    } catch { /* db unreachable */ }

    // Fetch platform stats (best-effort)
    let platformStats: Record<string, unknown> = {};
    if (dbStatus === 'connected') {
      try {
        const { getPool } = await import('./db/pool');
        const pool = getPool();
        const [agents, threads, workflows] = await Promise.all([
          pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'running') AS running FROM agents`),
          pool.query(`SELECT count(*) AS total FROM chat_threads`),
          pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE enabled = true) AS enabled FROM workflows`).catch(() => ({ rows: [{ total: 0, enabled: 0 }] })),
        ]);
        platformStats = {
          agents: { total: Number(agents.rows[0].total), running: Number(agents.rows[0].running) },
          threads: Number(threads.rows[0].total),
          workflows: { total: Number(workflows.rows[0].total), enabled: Number(workflows.rows[0].enabled) },
        };
      } catch { /* best-effort */ }
    }

    res.json({
      status: dbStatus === 'connected' ? 'healthy' : 'degraded',
      service: 'api',
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      database: {
        status: dbStatus,
        latency_ms: dbLatencyMs,
      },
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      platform: platformStats,
    });
  });

  // Internal service-to-service endpoints (service-token auth, not Keycloak)
  app.post('/internal/delegation-token', delegationTokenHandler);
  app.post('/internal/chat/callback', chatCallbackHandler);
  app.post('/internal/model-router/refresh-token', modelRouterRefreshHandler);
  app.use('/internal/discord', discordInternalRouter);

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

  // Model policy management routes (admin-only, enforced in router)
  app.use('/model-policies', requireAuth, modelPoliciesRouter);

  // Skill management routes (admin-only mutations, enforced in router)
  app.use('/skills', requireAuth, skillsRouter);

  // Tools catalog routes (admin-only mutations, enforced in router)
  app.use('/tools', requireAuth, toolsRouter);

  // Container profiles (read-only list, user role)
  app.use('/container-profiles', requireAuth, containerProfilesRouter);

  // Provider connections (user-scoped BYOK credentials)
  app.use('/provider-connections', requireAuth, providerConnectionsRouter);

  // User-defined models (user-scoped BYOK model definitions)
  app.use('/user-models', requireAuth, userModelsRouter);

  // Eligible models discovery (AI-120: user's own connection-derived models only)
  app.use('/eligible-models', requireAuth, eligibleModelsRouter);

  // Usage query routes (enforced in router)
  app.use('/usage', requireAuth, usageRouter);

  // Knowledge proxy routes (read-only, owner-scoped)
  app.use('/knowledge', requireAuth, knowledgeRouter);

  // Shared knowledge proxy routes (user-scoped CRUD)
  app.use('/shared-knowledge', requireAuth, sharedKnowledgeRouter);

  // Task management routes (user-scoped Kanban)
  app.use('/tasks', requireAuth, tasksRouter);

  // Chat routes (user-scoped, participant-enforced in router)
  app.use('/chat', requireAuth, chatRouter);

  // User profile routes
  app.use('/profile', requireAuth, profileRouter);

  // Storage routes (admin-only, MinIO bucket operations)
  app.use('/storage', requireAuth, storageRouter);

  // Notifications
  app.use('/notifications', requireAuth, notificationsRouter);
  app.use('/workflows', requireAuth, workflowsRouter);
  app.use('/mcp-servers', requireAuth, mcpServersRouter);
  app.use('/discord', requireAuth, discordRouter);

  // Secrets vault inventory (admin-only, AI-147)
  app.use('/admin/secrets', requireAuth, requireRole('admin'), secretsRouter);

  // API documentation (admin-only)
  app.use('/docs', requireAuth, requireRole('admin'), docsRouter);
  app.use('/openapi.json', requireAuth, requireRole('admin'), specRouter);

  return app;
}

// Default app instance for production
const app = createApp();
export { app };
