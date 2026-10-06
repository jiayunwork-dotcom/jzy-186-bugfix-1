import { Pool } from 'pg';

/**
 * Jest global setup: the test database is provisioned externally (see
 * test/jest-env.sh / docker compose). Here we only apply migrations once,
 * before any test file runs.
 */
module.exports = async function globalSetup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_TEST ?? 'postgres://postgres@localhost:55432/ghg_test';
  const pool = new Pool({ connectionString });
  try {
    const { runMigrations } = await import('../src/database/database.module');
    const { join } = await import('path');
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'));
  } finally {
    await pool.end();
  }
};
