import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Acquire advisory lock to prevent concurrent migration runs
    await client.query('SELECT pg_advisory_lock(42)');

    // Create tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const appliedSet = new Set(applied.map((r: { filename: string }) => r.filename));

    // Read migration files from disk
    let files: string[];
    try {
      files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
    } catch {
      // No migrations directory in compiled output — try relative to source
      console.log('[migrate] No migrations directory found, skipping');
      return;
    }

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      console.log(`[migrate] Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(42)');
    client.release();
  }
}
