import { app } from './app';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';
import { reconcileAgentStatuses } from './services/docker';
import { getS3Client, ensureBucket, AVATAR_BUCKET } from './services/s3';
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
    await ensureBucket(getS3Client(), AVATAR_BUCKET);
    console.log('[startup] Avatar bucket ready');
  } catch (err) {
    console.error('[startup] Avatar bucket init failed, avatar routes may error:', err);
  }

  // Start chat stale message sweeper (§9, cleanup path 2)
  startStaleSweeper();
  console.log('[startup] Chat stale message sweeper started');

  const server = app.listen(PORT, () => {
    console.log(`Hill90 API service listening on port ${PORT}`);
  });

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
